#!/usr/bin/env python3
"""Ask-Claude worker for the Planner phone app.

Answers messages the phone leaves in Dropbox (/Planner/.chat/phone/requests/, see
PROTOCOL.md): downloads the Planner's files, runs Claude Code on the message with
Jordan's Claude subscription, saves any changed files back to Dropbox (revision-checked:
never overwrites a newer copy), and writes the reply for the phone.

Runs anywhere with Python 3.9+ and Claude Code installed: as a GitHub job (the default;
see .github/workflows/ask-claude.yml), or on an always-on Mac/server with --loop.

Environment:
  DROPBOX_APP_KEY, DROPBOX_REFRESH_TOKEN   Dropbox access (PKCE app, offline refresh token)
  CLAUDE_CODE_OAUTH_TOKEN                  from `claude setup-token` (subscription, not API)
  PLANNER_DROPBOX_PATH                     default /Planner
  WORKER_NAME                              default "github"
  CLAUDE_BIN                               default: `claude` on PATH
Standard library only.
"""
import argparse
import glob
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

API = os.environ.get("DROPBOX_API", "https://api.dropboxapi.com")
CONTENT = os.environ.get("DROPBOX_CONTENT", "https://content.dropboxapi.com")
ROOT = os.environ.get("PLANNER_DROPBOX_PATH", "/Planner").rstrip("/")
BOX = ROOT + "/.chat/phone"
WORKER = os.environ.get("WORKER_NAME", "github")
TIMEOUT = int(os.environ.get("WORKER_TIMEOUT", str(12 * 60)))

# Which Planner files Claude gets to see (and may change). Never secrets or bulky history.
INCLUDE = re.compile(r"^(?:[^/]+\.md|data/.+|notes/.+|journal/.+|cache/calendar\.json|app/.+|tools/.+)$")
EXCLUDE = re.compile(r"(?:^|/)(?:__pycache__|\.~)|\.pyc$|^data/outline_state\.json$")

ALLOWED_TOOLS = [
    "Read", "Edit", "Write", "Glob", "Grep", "TodoWrite", "WebSearch", "WebFetch",
    "Bash(python3 *)", "Bash(ls *)", "Bash(head *)", "Bash(tail *)", "Bash(wc *)",
    "Bash(grep *)", "Bash(cat *)", "Bash(sort *)", "Bash(diff *)", "Bash(date *)",
]

PHONE_PROMPT = (
    "You are the Ask Claude chat in Jordan's Planner PHONE app. You run in a temporary copy "
    "of his Planner folder; files you change are saved back to his Dropbox when you finish "
    "(revision-checked). CLAUDE.md, AGENTS.md and notes/ describe the app, his schedule and "
    "how he wants to work: follow them, including the check-in routine. "
    "Differences from the desktop panel: (1) replies appear on a phone, so keep them short and "
    "scannable; (2) you cannot reach the desktop app's server, so do not use curl; his Google "
    "Calendar copy is cache/calendar.json — check its fetched_at and say so if it is more than "
    "a few hours old; (3) the current local time is given at the top of each message. "
    "Everything durable goes into files (data/, notes/), never only into the reply. Never tick "
    "or delete To-Do List items (data/tasks.md) without his okay. Say in one line which files "
    "you changed. If something needs the Mac, say so."
)


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# ---------------------------------------------------------------- Dropbox (stdlib)
class Dropbox:
    def __init__(self, app_key, refresh_token):
        self.app_key, self.refresh_token, self.token, self.expiry = app_key, refresh_token, None, 0

    def _access(self):
        if self.token and time.time() < self.expiry:
            return self.token
        body = urllib.parse.urlencode({"grant_type": "refresh_token", "refresh_token": self.refresh_token,
                                       "client_id": self.app_key}).encode()
        with urllib.request.urlopen(urllib.request.Request(API + "/oauth2/token", data=body), timeout=30) as r:
            j = json.loads(r.read())
        self.token, self.expiry = j["access_token"], time.time() + int(j.get("expires_in", 3600)) - 120
        return self.token

    def rpc(self, endpoint, args):
        req = urllib.request.Request(f"{API}/2/{endpoint}", data=json.dumps(args).encode(), headers={
            "Authorization": f"Bearer {self._access()}", "Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read())

    def list(self, path, recursive=False):
        out = []
        try:
            j = self.rpc("files/list_folder", {"path": path, "recursive": recursive, "limit": 2000})
        except urllib.error.HTTPError as e:
            if e.code == 409:          # folder doesn't exist yet
                return []
            raise
        while True:
            out += [e for e in j["entries"] if e[".tag"] == "file"]
            if not j.get("has_more"):
                return out
            j = self.rpc("files/list_folder/continue", {"cursor": j["cursor"]})

    @staticmethod
    def _arg(o):   # Dropbox-API-Arg must be ASCII
        return re.sub(r"[\u007f-￿]", lambda m: "\\u%04x" % ord(m.group()), json.dumps(o))

    def download(self, path):
        req = urllib.request.Request(CONTENT + "/2/files/download", method="POST", headers={
            "Authorization": f"Bearer {self._access()}", "Dropbox-API-Arg": self._arg({"path": path})})
        with urllib.request.urlopen(req, timeout=120) as r:
            meta = json.loads(r.headers.get("Dropbox-API-Result", "{}"))
            return r.read(), meta.get("rev", "")

    def upload(self, path, data, rev=None, overwrite=False):
        """rev: replace only that exact version; overwrite: our own files (mailbox).
        Returns the new rev, or None on a revision conflict."""
        mode = {".tag": "update", "update": rev} if rev else ("overwrite" if overwrite else "add")
        req = urllib.request.Request(CONTENT + "/2/files/upload", data=data, method="POST", headers={
            "Authorization": f"Bearer {self._access()}", "Content-Type": "application/octet-stream",
            "Dropbox-API-Arg": self._arg({"path": path, "mode": mode, "autorename": False, "mute": True})})
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                return json.loads(r.read()).get("rev")
        except urllib.error.HTTPError as e:
            if e.code == 409 and b"conflict" in e.read():
                return None
            raise

    def put_json(self, path, obj):
        self.upload(path, (json.dumps(obj, indent=1, ensure_ascii=False) + "\n").encode(), overwrite=True)

    def get_json(self, path):
        try:
            return json.loads(self.download(path)[0])
        except urllib.error.HTTPError as e:
            if e.code == 409:
                return None
            raise


# ---------------------------------------------------------------- one request
def pending(dbx):
    reqs = {Path(e["name"]).stem for e in dbx.list(BOX + "/requests")}
    done = {Path(e["name"]).stem for e in dbx.list(BOX + "/replies")}
    return sorted(reqs - done)


def fetch_planner(dbx, work):
    """Download the working set into `work`; returns {relpath: (rev, sha1)}."""
    revs = {}
    prefix = ROOT.lower() + "/"
    for e in dbx.list(ROOT, recursive=True):
        rel = e["path_display"][len(ROOT) + 1:] if e["path_lower"].startswith(prefix) else None
        if not rel or not INCLUDE.match(rel) or EXCLUDE.search(rel):
            continue
        data, rev = dbx.download(e["path_display"])
        dest = work / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(data)
        revs[rel] = (rev or e.get("rev", ""), hashlib.sha1(data).hexdigest())
    return revs


def changed_files(work, revs):
    out = []
    for p in work.rglob("*"):
        if not p.is_file():
            continue
        rel = p.relative_to(work).as_posix()
        if not INCLUDE.match(rel) or EXCLUDE.search(rel):
            continue
        sha = hashlib.sha1(p.read_bytes()).hexdigest()
        if rel not in revs or revs[rel][1] != sha:
            out.append(rel)
    return sorted(out)


def session_dir(work):
    # Claude Code keeps sessions in ~/.claude/projects/<cwd with non-alphanumerics as '-'>/
    return Path.home() / ".claude" / "projects" / re.sub(r"[^A-Za-z0-9]", "-", str(work))


def run_claude(work, text, session_id, progress):
    claude = os.environ.get("CLAUDE_BIN") or shutil.which("claude") or str(Path.home() / ".local/bin/claude")
    cmd = [claude, "-p", text, "--output-format", "stream-json", "--verbose",
           "--permission-mode", "acceptEdits", "--allowedTools", *ALLOWED_TOOLS,
           "--append-system-prompt", PHONE_PROMPT]
    if session_id:
        cmd += ["--resume", session_id]
    env = dict(os.environ)
    env.pop("ANTHROPIC_API_KEY", None)      # never fall back to API billing
    for k in ("DROPBOX_REFRESH_TOKEN", "DROPBOX_APP_KEY"):
        env.pop(k, None)                    # Claude doesn't need these
    proc = subprocess.Popen(cmd, cwd=str(work), env=env, text=True, stdin=subprocess.DEVNULL,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    texts, final, sid, err, start = [], None, session_id, None, time.time()
    for line in proc.stdout:
        if time.time() - start > TIMEOUT:
            proc.kill()
            err = f"Stopped after {TIMEOUT // 60} minutes."
            break
        try:
            ev = json.loads(line)
        except ValueError:
            continue
        sid = ev.get("session_id") or sid
        if ev.get("type") == "assistant":
            for b in ev.get("message", {}).get("content", []):
                if b.get("type") == "tool_use":
                    inp = b.get("input") or {}
                    progress(f"{b.get('name')} {Path(str(inp.get('file_path', ''))).name or str(inp.get('command', inp.get('pattern', '')))[:50]}".strip())
                elif b.get("type") == "text" and b.get("text", "").strip():
                    texts.append(b["text"])
        elif ev.get("type") == "result":
            final = ev.get("result")
            if ev.get("is_error") or ev.get("subtype", "success") != "success":
                err = final or ev.get("subtype")
    proc.wait()
    stderr = proc.stderr.read()
    if proc.returncode not in (0, None) and not err:
        err = (stderr or "").strip()[-1200:] or f"Claude Code stopped (code {proc.returncode})."
    return (final or "\n\n".join(texts) or ""), sid, err


def handle(dbx, rid):
    req = dbx.get_json(f"{BOX}/requests/{rid}.json") or {}
    conv = req.get("conversation") or "default"
    started = now_iso()
    state = {"id": rid, "worker": WORKER, "started": started, "progress": ["Getting your Planner files…"]}
    last_push = [0.0]

    def progress(msg):
        state["progress"] = (state["progress"] + [msg])[-8:]
        if time.time() - last_push[0] > 8:
            last_push[0] = time.time()
            try:
                dbx.put_json(f"{BOX}/working/{rid}.json", state)
            except Exception:
                pass

    dbx.put_json(f"{BOX}/working/{rid}.json", state)
    work = Path(tempfile.mkdtemp(prefix="planner-"))
    reply = {"id": rid, "conversation": conv, "worker": WORKER, "started": started,
             "text": "", "error": None, "changed": [], "conflicts": []}
    try:
        revs = fetch_planner(dbx, work)
        progress("Thinking…")
        # Continue the conversation: restore the saved Claude Code session file, if any.
        sess = dbx.get_json(f"{BOX}/sessions/{conv}.json") or {}
        sid = sess.get("session_id")
        if sid and sess.get("jsonl"):
            d = session_dir(work)
            d.mkdir(parents=True, exist_ok=True)
            (d / f"{sid}.jsonl").write_text(sess["jsonl"], encoding="utf-8")
        local = req.get("local_time") or ""
        text = (f"[Local time: {local}]\n" if local else "") + req.get("text", "")
        if req.get("voice"):   # asked through the Siri Shortcut "Ask planner": the reply is read aloud
            text = ("[Asked by voice through Siri, possibly while driving. Your reply will be read aloud: "
                    "answer in 2-4 short plain sentences, no lists, tables, symbols, IDs or file names. "
                    "If he asks you to add something, add it under \"INBOX (voice)\" at the top of the "
                    "To-Do List (create it if missing) and confirm in a few words.]\n" + text)
        answer, new_sid, err = run_claude(work, text, sid, progress)
        if err and sid and re.search(r"no conversation|not found|session", str(err), re.I):
            progress("Starting a fresh conversation…")
            answer, new_sid, err = run_claude(work, text, None, progress)
        reply.update(text=answer, error=err)
        # Save changed files back, never over a newer copy.
        for rel in changed_files(work, revs):
            data = (work / rel).read_bytes()
            target = f"{ROOT}/{rel}"
            rev = revs.get(rel, (None,))[0]
            if dbx.upload(target, data, rev=rev) is None:
                stem, dot, ext = rel.rpartition(".")
                alt = f"{ROOT}/{stem} (from phone chat).{ext}" if dot else f"{target} (from phone chat)"
                dbx.upload(alt, data, overwrite=True)
                reply["conflicts"].append(rel)
            else:
                reply["changed"].append(rel)
        # Keep the session for the next message in this conversation.
        if new_sid:
            files = glob.glob(str(Path.home() / ".claude" / "projects" / "*" / f"{new_sid}.jsonl"))
            if files:
                dbx.put_json(f"{BOX}/sessions/{conv}.json",
                             {"session_id": new_sid, "jsonl": Path(files[0]).read_text(encoding="utf-8")})
    except Exception as e:  # reported to the phone
        reply["error"] = f"{type(e).__name__}: {e}"
    finally:
        shutil.rmtree(work, ignore_errors=True)
    reply["finished"] = now_iso()
    dbx.put_json(f"{BOX}/replies/{rid}.json", reply)
    print(f"{rid}: {'error: ' + str(reply['error'])[:200] if reply['error'] else 'ok'}; changed {reply['changed']}; conflicts {reply['conflicts']}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--loop", action="store_true", help="always-on mode: keep polling (Mac or server)")
    ap.add_argument("--interval", type=int, default=5)
    args = ap.parse_args()
    dbx = Dropbox(os.environ["DROPBOX_APP_KEY"], os.environ["DROPBOX_REFRESH_TOKEN"])
    last_beat = 0.0
    while True:
        for rid in pending(dbx):
            handle(dbx, rid)
        if not args.loop:
            return
        if time.time() - last_beat > 120:      # "I'm alive" for the phone, every 2 minutes
            last_beat = time.time()
            try:
                dbx.put_json(f"{BOX}/heartbeat-{WORKER}.json", {"worker": WORKER, "time": now_iso()})
            except Exception as e:
                print("heartbeat failed:", e, file=sys.stderr)
        time.sleep(args.interval)


if __name__ == "__main__":
    main()
