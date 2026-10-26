/* Planner — phone app.
 *
 * A Home Screen web app (GitHub Pages) over the same files as the desktop Planner, read and
 * written directly in Dropbox (/Planner). Nothing is stored on any server.
 *   Today      calendar copy (cache/calendar.json) + school-pickup routine + planned blocks
 *              (data/plan.json, tick when done) + today's lines from This Week
 *   This Week  data/this-week.md, ticks sync with the planned blocks (same rule as desktop)
 *   Ask Claude chat via the Dropbox mailbox (worker/PROTOCOL.md); the phone starts the
 *              GitHub job that answers
 * Every write is revision-checked: a newer copy in Dropbox is never overwritten.
 */
"use strict";

const CFG = {
  appKey: "mw2vh3rfqkxtawf",           // Dropbox app "Planner phone" (Full Dropbox; separate from Finances)
  root: "/Planner",
  repo: "GansMorseNU/planner-app",
  workflow: "ask-claude.yml",
  published: "https://gansmorsenu.github.io/planner-app/",
};
const BOX = CFG.root + "/.chat/phone";
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// ---------------------------------------------------------------- local storage (best effort)
const LS = {
  get(k, d = null) { try { const v = localStorage.getItem("planner." + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { v === null ? localStorage.removeItem("planner." + k) : localStorage.setItem("planner." + k, JSON.stringify(v)); } catch { /* private mode */ } },
};

// ---------------------------------------------------------------- Dropbox
const DBX = {
  token: null, expiry: 0,
  redirect() { return location.hostname.endsWith("github.io") ? CFG.published : location.origin + location.pathname; },
  signedIn() { return !!LS.get("dbx_refresh"); },
  async pkce() {
    const b64 = (b) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const verifier = b64(crypto.getRandomValues(new Uint8Array(48)));
    const challenge = b64(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
    return { verifier, challenge };
  },
  async authUrl(paste) {
    const { verifier, challenge } = await this.pkce();
    LS.set(paste ? "dbx_verifier_paste" : "dbx_verifier", verifier);
    const p = new URLSearchParams({ client_id: CFG.appKey, response_type: "code", code_challenge: challenge,
      code_challenge_method: "S256", token_access_type: "offline" });
    if (!paste) p.set("redirect_uri", this.redirect());
    return "https://www.dropbox.com/oauth2/authorize?" + p;
  },
  async tokenRequest(body) {
    const r = await fetch("https://api.dropboxapi.com/oauth2/token", { method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: CFG.appKey, ...body }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error_description || j.error || `Dropbox sign-in failed (${r.status})`);
    this.token = j.access_token; this.expiry = Date.now() + (j.expires_in - 60) * 1000;
    if (j.refresh_token) LS.set("dbx_refresh", j.refresh_token);
  },
  async finishRedirect() {
    const code = new URLSearchParams(location.search).get("code");
    if (!code) return false;
    history.replaceState(null, "", location.pathname);
    const v = LS.get("dbx_verifier");
    if (!v) throw new Error("Sign-in expired. Please try again.");
    await this.tokenRequest({ code, grant_type: "authorization_code", code_verifier: v, redirect_uri: this.redirect() });
    LS.set("dbx_verifier", null);
    return true;
  },
  async finishPaste(code) {
    const v = LS.get("dbx_verifier_paste");
    if (!v) throw new Error("Start the sign-in again, then paste the new code.");
    await this.tokenRequest({ code: code.trim(), grant_type: "authorization_code", code_verifier: v });
    LS.set("dbx_verifier_paste", null);
  },
  async access() {
    if (this.token && Date.now() < this.expiry) return this.token;
    const rt = LS.get("dbx_refresh");
    if (!rt) throw new NeedSignIn();
    try { await this.tokenRequest({ grant_type: "refresh_token", refresh_token: rt }); }
    catch (e) { if (navigator.onLine) { LS.set("dbx_refresh", null); throw new NeedSignIn(); } throw e; }
    return this.token;
  },
  arg(o) { return JSON.stringify(o).replace(/[\u007f-￿]/g, (c) => "\\u" + ("000" + c.charCodeAt(0).toString(16)).slice(-4)); },
  async rpc(endpoint, body) {
    const r = await fetch("https://api.dropboxapi.com/2/" + endpoint, { method: "POST",
      headers: { Authorization: "Bearer " + await this.access(), "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (r.status === 401) { this.token = null; throw new NeedSignIn(); }
    if (r.status === 409) return { _missing: true, ...(await r.json().catch(() => ({}))) };
    if (!r.ok) throw new Error(`Dropbox ${endpoint} (${r.status}): ${(await r.text()).slice(0, 300)}`);
    return r.json();
  },
  async list(path) {
    let j = await this.rpc("files/list_folder", { path, recursive: false, limit: 2000 });
    if (j._missing) return [];
    const out = [...j.entries];
    while (j.has_more) { j = await this.rpc("files/list_folder/continue", { cursor: j.cursor }); out.push(...j.entries); }
    return out.filter((e) => e[".tag"] === "file");
  },
  /** {text, rev} or null when the file doesn't exist. */
  async read(path) {
    const r = await fetch("https://content.dropboxapi.com/2/files/download", { method: "POST",
      headers: { Authorization: "Bearer " + await this.access(), "Dropbox-API-Arg": this.arg({ path }) } });
    if (r.status === 409) return null;
    if (r.status === 401) { this.token = null; throw new NeedSignIn(); }
    if (!r.ok) throw new Error(`Couldn't read ${path} (${r.status}): ${(await r.text()).slice(0, 300)}`);
    const meta = JSON.parse(r.headers.get("Dropbox-API-Result") || "{}");
    return { text: await r.text(), rev: meta.rev || "" };
  },
  /** rev: replace exactly that version (throws Conflict otherwise); "add": new file; "overwrite": ours. */
  async write(path, text, mode) {
    const m = mode === "add" || mode === "overwrite" ? mode : { ".tag": "update", update: mode };
    const r = await fetch("https://content.dropboxapi.com/2/files/upload", { method: "POST",
      headers: { Authorization: "Bearer " + await this.access(), "Content-Type": "application/octet-stream",
        "Dropbox-API-Arg": this.arg({ path, mode: m, autorename: false, mute: true }) },
      body: new TextEncoder().encode(text) });
    if (r.status === 409) { const t = await r.text(); if (t.includes("conflict")) throw new Conflict(path); throw new Error(t); }
    if (r.status === 401) { this.token = null; throw new NeedSignIn(); }
    if (!r.ok) throw new Error(`Couldn't save ${path} (${r.status}): ${(await r.text()).slice(0, 300)}`);
    return (await r.json()).rev;
  },
};
class NeedSignIn extends Error { constructor() { super("Sign in to Dropbox"); } }
class Conflict extends Error { constructor(p) { super(p + " changed elsewhere"); } }

// ---------------------------------------------------------------- outline files (same format as desktop app/outline.py)
const ITEM_RE = /^([ \t]*)[-*+] (?:\[([ xX])\] ?)?(.*)$/;
const TRAIL_RE = /(?:^|\s+)(?:@(done|added)\((\d{4}-\d{2}-\d{2})\)|\^([a-z0-9]{6}))\s*$/;
function parseOutline(text) {
  const roots = [], stack = [];
  let last = null;
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith("<!--")) continue;
    const m = raw.match(ITEM_RE);
    if (m) {
      let rest = m[3].replace(/\s+$/, ""), id = "", done_on = "", t;
      while ((t = rest.match(TRAIL_RE))) {
        if (t[3] && !id) id = t[3];
        if (t[1] === "done" && !done_on) done_on = t[2];
        rest = rest.slice(0, t.index).replace(/\s+$/, "");
      }
      const width = m[1].replace(/\t/g, "  ").length;
      const node = { id, text: rest.trim(), done: (m[2] || " ").toLowerCase() === "x", done_on, note: "", children: [] };
      while (stack.length && stack[stack.length - 1].w >= width) stack.pop();
      (stack.length ? stack[stack.length - 1].n.children : roots).push(node);
      stack.push({ w: width, n: node });
      last = node;
      continue;
    }
    const note = raw.match(/^[ \t]*> ?(.*)$/);
    if (last) last.note = last.note ? last.note + "\n" + (note ? note[1] : raw.trim()) : (note ? note[1] : raw.trim());
  }
  return roots;
}
/** Tick / untick the line with ^id, editing only that line (keeps the file byte-identical otherwise). */
function setLineDone(text, id, done, date) {
  return text.split("\n").map((line) => {
    if (!new RegExp("\\^" + id + "\\s*$").test(line)) return line;
    let l = line.replace(/^([ \t]*[-*+] )\[[ xX]\]/, `$1[${done ? "x" : " "}]`).replace(/ @done\(\d{4}-\d{2}-\d{2}\)/, "");
    if (done) l = l.replace(new RegExp("( \\^" + id + "\\s*)$"), ` @done(${date})$1`);
    return l;
  }).join("\n");
}
const todayIso = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

// ---------------------------------------------------------------- data
const D = { cal: null, routine: null, plan: null, planRev: "", week: null, weekRev: "", weekTree: [], loadedAt: 0, lists: [] };
const PATHS = { cal: "/cache/calendar.json", routine: "/data/routine.json", plan: "/data/plan.json", lists: "/data/lists.json" };

async function loadAll() {
  setBusy(true);
  try {
    const lists = JSON.parse((await DBX.read(CFG.root + PATHS.lists))?.text || "[]");
    const weekFile = (lists.find((l) => l.id === "week") || {}).file || "this-week.md";
    const [cal, routine, plan, week] = await Promise.all([
      DBX.read(CFG.root + PATHS.cal), DBX.read(CFG.root + PATHS.routine), DBX.read(CFG.root + PATHS.plan), DBX.read(`${CFG.root}/data/${weekFile}`)]);
    D.weekPath = `${CFG.root}/data/${weekFile}`;
    D.cal = cal ? JSON.parse(cal.text) : { events: [], calendars: [] };
    D.routine = routine ? JSON.parse(routine.text) : {};
    D.plan = plan ? JSON.parse(plan.text) : { blocks: [] }; D.planRev = plan?.rev || "";
    D.week = week?.text || ""; D.weekRev = week?.rev || ""; D.weekTree = parseOutline(D.week);
    D.loadedAt = Date.now();
    LS.set("cache", { cal: D.cal, routine: D.routine, plan: D.plan, week: D.week, at: D.loadedAt });
    hideBanner();
  } catch (e) {
    if (e instanceof NeedSignIn) return showSignIn();
    const c = LS.get("cache");
    if (c && !D.loadedAt) { Object.assign(D, { cal: c.cal, routine: c.routine, plan: c.plan, week: c.week, weekTree: parseOutline(c.week || ""), loadedAt: c.at }); }
    showBanner(navigator.onLine ? `Couldn't load from Dropbox: ${esc(e.message)}` : "You're offline — showing the last loaded copy.");
  } finally { setBusy(false); }
  render();
}

/** Tick a planned block or a This Week line; keeps both in step (same rule as the desktop). */
async function tick({ block, item }, done) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const date = todayIso();
      let week = D.week, plan = JSON.parse(JSON.stringify(D.plan));
      const itemIds = block ? (plan.blocks.find((b) => b.id === block)?.items || []) : [item];
      if (block) plan.blocks.find((b) => b.id === block).done = done;
      for (const id of itemIds) week = setLineDone(week, id, done, date);
      const tree = parseOutline(week), state = {};
      (function walk(ns) { for (const n of ns) { state[n.id] = n.done; walk(n.children); } })(tree);
      for (const b of plan.blocks) {
        const ids = (b.items || []).filter((i) => i in state);
        if (ids.length) b.done = ids.every((i) => state[i]);
      }
      const planText = JSON.stringify(plan, null, 1) + "\n";
      if (week !== D.week) D.weekRev = await DBX.write(D.weekPath, week, D.weekRev);
      if (JSON.stringify(plan) !== JSON.stringify(D.plan)) D.planRev = await DBX.write(CFG.root + PATHS.plan, planText, D.planRev);
      D.week = week; D.weekTree = tree; D.plan = plan;
      render();
      return;
    } catch (e) {
      if (e instanceof Conflict && attempt === 0) { await loadAll(); continue; }   // changed on the Mac: reload, redo once
      showBanner(e instanceof Conflict ? "That changed on another device. Reloaded — please tick again." : `Not saved: ${esc(e.message)}`);
      render();
      return;
    }
  }
}

// ---------------------------------------------------------------- Today
let dayOffset = 0;
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
function dayDate() { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + dayOffset); return d; }
function ymd(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; }
function hm(d) { let h = d.getHours(), m = d.getMinutes(); const pm = h >= 12; h = h % 12 || 12; return `${h}${m ? ":" + String(m).padStart(2, "0") : ""}${pm ? "pm" : "am"}`; }
function at(dayStr, t) { const [y, mo, da] = dayStr.split("-").map(Number); const [h, mi] = t.split(":").map(Number); return new Date(y, mo - 1, da, h, mi); }
function ago(ms) { const m = Math.round((Date.now() - ms) / 60000); return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`; }

function dayItems(day) {
  const key = ymd(day), next = new Date(day); next.setDate(next.getDate() + 1);
  const cals = new Map((D.cal?.calendars || []).map((c) => [c.id, c]));
  const allDay = [], timed = [];
  for (const e of D.cal?.events || []) {
    if (e.declined) continue;
    const cal = cals.get(e.calendar) || {};
    if (e.all_day) {
      const [y, m, d] = e.start.split("-").map(Number), [y2, m2, d2] = e.end.split("-").map(Number);
      if (new Date(y, m - 1, d) <= day && new Date(y2, m2 - 1, d2) > day) allDay.push({ title: e.title, color: cal.color, busy: e.busy });
    } else {
      const s = new Date(e.start), en = new Date(e.end);
      if (s < next && en > day) timed.push({ kind: "event", title: e.title, s, e: en, color: cal.color, cal: cal.name });
    }
  }
  for (const t of D.routine?.templates || []) {
    if ((t.from && key < t.from) || (t.to && key > t.to)) continue;
    for (const b of t.blocks || []) {
      if (!(b.days || []).includes(DAYS[day.getDay()]) || (b.skip_dates || []).includes(key)) continue;
      timed.push({ kind: "routine", title: b.title, s: at(key, b.start), e: at(key, b.end) });
    }
  }
  for (const b of D.plan?.blocks || []) if (b.date === key) timed.push({ kind: "plan", id: b.id, title: b.title, s: at(key, b.start), e: at(key, b.end), done: b.done, k: b.kind });
  timed.sort((a, b) => a.s - b.s || a.e - b.e);
  return { allDay, timed };
}
/** The This Week section for that day ("Mon Oct 26"), if any. */
function weekSection(day) {
  const label = day.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }).replace(",", "");
  return D.weekTree.find((n) => n.text.startsWith(label));
}

function renderToday() {
  const day = dayDate(), { allDay, timed } = dayItems(day), now = new Date();
  const title = dayOffset === 0 ? "Today" : dayOffset === 1 ? "Tomorrow" : dayOffset === -1 ? "Yesterday" : day.toLocaleDateString("en-US", { weekday: "long" });
  $("#top-title").textContent = title;
  $("#top-sub").textContent = day.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  const calAge = D.cal?.fetched_at ? Date.now() - new Date(D.cal.fetched_at).getTime() : null;
  let h = `<div class="daynav"><button data-day="-1">‹</button><button data-day="0">Today</button><button data-day="1">›</button></div>`;
  if (calAge !== null && calAge > 6 * 3600e3) h += `<p class="note">Calendar copy is from ${ago(new Date(D.cal.fetched_at).getTime())} (it refreshes when the Planner runs on your Mac).</p>`;
  if (allDay.length) h += `<div class="allday">${allDay.map((a) => `<span class="chip${a.busy ? " busy" : ""}" style="--c:${esc(a.color || "#999")}">${esc(a.title)}</span>`).join("")}</div>`;
  h += '<ol class="timeline">';
  let nowShown = dayOffset !== 0;
  for (const t of timed) {
    if (!nowShown && t.s > now) { h += `<li class="now"><span>${hm(now)} — now</span></li>`; nowShown = true; }
    const time = `<span class="time">${hm(t.s)}<br><small>${hm(t.e)}</small></span>`;
    if (t.kind === "plan") {
      h += `<li class="plan ${esc(t.k || "work")}${t.done ? " done" : ""}">${time}<label><input type="checkbox" data-block="${esc(t.id)}"${t.done ? " checked" : ""}><span>${esc(t.title)}</span></label></li>`;
    } else if (t.kind === "routine") {
      h += `<li class="routine">${time}<span>${esc(t.title)}</span></li>`;
    } else {
      h += `<li class="event" style="--c:${esc(t.color || "#999")}">${time}<span>${esc(t.title)}<small>${esc(t.cal || "")}</small></span></li>`;
    }
  }
  if (!nowShown) h += `<li class="now"><span>${hm(now)} — now</span></li>`;
  h += "</ol>";
  if (!timed.length) h += '<p class="note">Nothing on the calendar or planned.</p>';
  const sec = weekSection(day);
  if (sec) h += `<h3>From This Week</h3>${renderNodes(sec.children)}`;
  const top = D.weekTree.find((n) => /^TOP 3/i.test(n.text)), must = D.weekTree.find((n) => /^MUST-DOS/i.test(n.text));
  if (dayOffset === 0 && top) h += `<h3>Top 3 this week</h3>${renderNodes(top.children)}`;
  if (dayOffset === 0 && must) h += `<h3>Must-dos this week</h3>${renderNodes(must.children)}`;
  h += `<p class="note small">Loaded ${D.loadedAt ? ago(D.loadedAt) : "—"}.</p>`;
  $("#view-today").innerHTML = h;
}

function renderNodes(nodes) {
  return "<ul class=\"outline\">" + nodes.map((n) =>
    `<li class="${n.done ? "done" : ""}"><label><input type="checkbox" data-item="${esc(n.id)}"${n.done ? " checked" : ""}><span>${esc(n.text)}</span></label>` +
    (n.children.length ? renderNodes(n.children) : "") + "</li>").join("") + "</ul>";
}

function renderWeek() {
  $("#top-title").textContent = "This Week";
  $("#top-sub").textContent = "";
  $("#view-week").innerHTML = D.weekTree.length
    ? D.weekTree.map((n) => `<details class="sect"${/^(TOP|MUST)/i.test(n.text) || weekSection(dayDate()) === n ? " open" : ""}><summary>${esc(n.text)}</summary>${renderNodes(n.children)}</details>`).join("")
    : '<p class="note">No This Week list yet.</p>';
}

// ---------------------------------------------------------------- Ask Claude (mailbox + GitHub job)
const CHAT = {
  conv() { let c = LS.get("chat_conv"); if (!c) { c = "c" + Date.now().toString(36); LS.set("chat_conv", c); } return c; },
  msgs() { return LS.get("chat_msgs", []); },
  save(m) { LS.set("chat_msgs", m.slice(-200)); },
  timer: null,
};
function newId() { const d = new Date(), p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${Math.random().toString(36).slice(2, 6)}`; }

function md(s) {   // small Markdown subset for replies
  const inline = (t) => esc(t).replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
  const out = []; let list = null;
  for (const line of String(s || "").split("\n")) {
    const li = line.match(/^\s*(?:[-*•]|\d+[.)])\s+(.*)/);
    if (li) { if (!list) { list = []; } list.push(`<li>${inline(li[1])}</li>`); continue; }
    if (list) { out.push(`<ul>${list.join("")}</ul>`); list = null; }
    if (/^\s*\|.*\|\s*$/.test(line)) { if (!/^\s*\|[\s:|-]+\|\s*$/.test(line)) out.push(`<div class="trow">${line.trim().replace(/^\||\|$/g, "").split("|").map((c) => `<span>${inline(c.trim())}</span>`).join("")}</div>`); continue; }
    const hh = line.match(/^#{1,4}\s+(.*)/);
    if (hh) { out.push(`<h4>${inline(hh[1])}</h4>`); continue; }
    if (line.trim()) out.push(`<p>${inline(line)}</p>`);
  }
  if (list) out.push(`<ul>${list.join("")}</ul>`);
  return out.join("");
}

function renderChat() {
  $("#top-title").textContent = "Ask Claude";
  const ghOk = !!LS.get("gh_token");
  $("#top-sub").textContent = ghOk ? "" : "set up in Settings";
  const msgs = CHAT.msgs().filter((m) => m.conv === CHAT.conv());
  $("#chat-log").innerHTML = (msgs.length ? "" : `<p class="note">Ask about your day or your lists, or tap a check-in. Replies take about a minute: a small computer at GitHub starts, reads your Planner files from Dropbox, and runs Claude Code with your subscription. Changes it makes are saved to your Planner.${ghOk ? "" : "<br><b>First, add the GitHub key in Settings.</b>"}</p>`) +
    msgs.map((m) => m.role === "user"
      ? `<div class="msg user">${esc(m.text)}</div>`
      : m.pending
        ? `<div class="msg bot working"><span class="dots"></span> ${esc(m.progress || "Waiting for Claude…")} <small>${m.since ? Math.round((Date.now() - m.since) / 1000) + " s" : ""}</small></div>`
        : `<div class="msg bot">${md(m.text)}${m.error ? `<p class="error">${esc(m.error)}</p>` : ""}` +
          `${(m.changed || []).length ? `<p class="small">Saved: ${m.changed.map(esc).join(", ")}</p>` : ""}` +
          `${(m.conflicts || []).length ? `<p class="small error">Changed elsewhere meanwhile, so saved as a copy: ${m.conflicts.map(esc).join(", ")}</p>` : ""}</div>`).join("");
  const log = $("#chat-log"); log.scrollTop = log.scrollHeight;
}

async function sendChat(text) {
  text = text.trim();
  if (!text) return;
  const token = LS.get("gh_token");
  if (!token) { showBanner("Add the GitHub key in Settings first."); return switchView("settings"); }
  const id = newId(), conv = CHAT.conv();
  const msgs = CHAT.msgs();
  msgs.push({ role: "user", text, conv, id }, { role: "bot", pending: true, id, conv, since: Date.now() });
  CHAT.save(msgs); renderChat();
  try {
    const local = new Date().toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    await DBX.write(`${BOX}/requests/${id}.json`, JSON.stringify({ id, conversation: conv, text, created: new Date().toISOString(), local_time: local }, null, 1), "add");
    const r = await fetch(`https://api.github.com/repos/${CFG.repo}/actions/workflows/${CFG.workflow}/dispatches`, {
      method: "POST", headers: { Authorization: "Bearer " + token, Accept: "application/vnd.github+json" },
      body: JSON.stringify({ ref: "main", inputs: { request: id } }) });
    if (!r.ok) throw new Error(`GitHub didn't start the job (${r.status}). Check the key in Settings.`);
  } catch (e) {
    finishMsg(id, { error: e.message });
  }
  pollChat();
}
function finishMsg(id, reply) {
  const msgs = CHAT.msgs(), i = msgs.findIndex((m) => m.role === "bot" && m.id === id);
  if (i >= 0) msgs[i] = { role: "bot", id, conv: msgs[i].conv, text: reply.text || "", error: reply.error, changed: reply.changed, conflicts: reply.conflicts };
  CHAT.save(msgs); renderChat();
}
async function pollChat() {
  clearTimeout(CHAT.timer);
  const pend = CHAT.msgs().filter((m) => m.pending);
  if (!pend.length) return;
  for (const m of pend) {
    try {
      const rep = await DBX.read(`${BOX}/replies/${m.id}.json`);
      if (rep) { finishMsg(m.id, JSON.parse(rep.text)); if (JSON.parse(rep.text).changed?.length) loadAll(); continue; }
      const w = await DBX.read(`${BOX}/working/${m.id}.json`);
      const msgs = CHAT.msgs(), k = msgs.findIndex((x) => x.pending && x.id === m.id);
      if (k >= 0) { msgs[k].progress = w ? (JSON.parse(w.text).progress || []).slice(-1)[0] : "Starting a computer at GitHub…"; CHAT.save(msgs); }
      if (Date.now() - m.since > 25 * 60e3) finishMsg(m.id, { error: "No reply after 25 minutes. Check Settings → recent jobs." });
    } catch (_) { /* offline: try again later */ }
  }
  if (!$("#view-chat").hidden) renderChat();
  CHAT.timer = setTimeout(pollChat, 4000);
}

// ---------------------------------------------------------------- Settings
function renderSettings() {
  $("#top-title").textContent = "Settings";
  $("#top-sub").textContent = "";
  const gh = LS.get("gh_token");
  $("#view-settings").innerHTML = `
    <h3>Ask Claude</h3>
    <p class="small">The chat needs a GitHub key that can start the "Ask Claude" job in <b>${CFG.repo}</b> (and nothing else). It stays on this phone.</p>
    <input id="gh-token" type="password" placeholder="${gh ? "Key saved — paste to replace" : "Paste GitHub key (github_pat_…)"}" autocomplete="off">
    <div class="row"><button id="gh-save" class="primary">Save key</button>${gh ? '<button id="gh-clear">Remove key</button>' : ""}</div>
    <p class="small"><a href="https://github.com/${CFG.repo}/actions" target="_blank" rel="noopener">Recent jobs at GitHub</a></p>
    <h3>Dropbox</h3>
    <p class="small">Signed in. Your Planner folder: ${CFG.root}</p>
    <button id="signout">Sign out of Dropbox</button>
    <h3>About</h3>
    <p class="small">Same files as the desktop Planner. Changes made here appear on the Mac within seconds when the Planner is open there.</p>`;
}

// ---------------------------------------------------------------- shell
let view = LS.get("view", "today");
function switchView(v) {
  view = v; LS.set("view", v);
  for (const s of ["today", "week", "chat", "settings"]) $("#view-" + s).hidden = s !== v;
  document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("on", b.dataset.view === v));
  render();
  if (v === "chat") pollChat();
}
function render() {
  if (view === "today") renderToday();
  else if (view === "week") renderWeek();
  else if (view === "chat") renderChat();
  else renderSettings();
}
function setBusy(b) { $("#refresh").classList.toggle("spin", b); }
function showBanner(html) { const b = $("#banner"); b.innerHTML = html; b.hidden = false; }
function hideBanner() { $("#banner").hidden = true; }
function showSignIn(err) { $("#main").hidden = true; $("#signin").hidden = false; $("#signin-error").textContent = err || ""; }

document.addEventListener("click", async (e) => {
  const t = e.target;
  if (t.closest(".tabs button")) return switchView(t.closest("button").dataset.view);
  if (t.dataset.day !== undefined && t.closest(".daynav")) { dayOffset = t.dataset.day === "0" ? 0 : dayOffset + Number(t.dataset.day); return renderToday(); }
  if (t.id === "refresh") return loadAll();
  if (t.dataset.say) return sendChat(t.dataset.say);
  if (t.id === "chat-send") { const v = $("#chat-input").value; $("#chat-input").value = ""; return sendChat(v); }
  if (t.id === "chat-new") { LS.set("chat_conv", null); return renderChat(); }
  if (t.id === "gh-save") { const v = $("#gh-token").value.trim(); if (v) { LS.set("gh_token", v); showBanner("GitHub key saved."); } return renderSettings(); }
  if (t.id === "gh-clear") { LS.set("gh_token", null); return renderSettings(); }
  if (t.id === "signout") { LS.set("dbx_refresh", null); return showSignIn(); }
  if (t.id === "signin-btn") { location.href = await DBX.authUrl(false); return; }
  if (t.id === "paste-start") { window.open(await DBX.authUrl(true), "_blank"); return; }
  if (t.id === "paste-finish") {
    try { await DBX.finishPaste($("#paste-code").value); start(); } catch (err) { $("#signin-error").textContent = err.message; }
  }
});
document.addEventListener("change", (e) => {
  const c = e.target;
  if (c.dataset.block) tick({ block: c.dataset.block }, c.checked);
  else if (c.dataset.item) tick({ item: c.dataset.item }, c.checked);
});
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && DBX.signedIn() && Date.now() - D.loadedAt > 60e3) loadAll(); });

async function start() {
  try { await DBX.finishRedirect(); } catch (e) { return showSignIn(e.message); }
  if (!DBX.signedIn()) return showSignIn();
  $("#signin").hidden = true; $("#main").hidden = false;
  switchView(view);
  const c = LS.get("cache");
  if (c) { Object.assign(D, { cal: c.cal, routine: c.routine, plan: c.plan, week: c.week, weekTree: parseOutline(c.week || ""), loadedAt: c.at }); render(); }
  await loadAll();
  pollChat();
}
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
start();
