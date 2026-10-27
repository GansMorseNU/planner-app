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
const TRAIL_RE = /(?:^|\s+)(?:@(done|added)\((\d{4}-\d{2}-\d{2})\)|\^([a-z0-9]{6})|@todo\(([a-z0-9]{6})\)|@carried\(([a-z0-9]{6})\))\s*$/;   // @todo(id): This Week line copied from that To-Do item; @carried(id): unfinished line carried forward, id = the new copy
function parseOutline(text) {
  const roots = [], stack = [];
  let last = null;
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith("<!--")) continue;
    const m = raw.match(ITEM_RE);
    if (m) {
      let rest = m[3].replace(/\s+$/, ""), id = "", done_on = "", todo = "", carried = "", t;
      while ((t = rest.match(TRAIL_RE))) {
        if (t[3] && !id) id = t[3];
        if (t[4] && !todo) todo = t[4];
        if (t[5] && !carried) carried = t[5];
        if (t[1] === "done" && !done_on) done_on = t[2];
        rest = rest.slice(0, t.index).replace(/\s+$/, "");
      }
      const width = m[1].replace(/\t/g, "  ").length;
      const node = { id, text: rest.trim(), done: (m[2] || " ").toLowerCase() === "x", done_on, todo, carried, note: "", children: [] };
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
// Planner day: before 4 a.m. counts as the previous day (DAY_START_HOUR in the desktop app's config.py).
const DAY_START_HOUR = 4;
const todayIso = () => { const d = new Date(Date.now() - DAY_START_HOUR * 3600e3); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

// ---------------------------------------------------------------- data
const D = { planText: "", files: {}, cal: null, routine: null, plan: null, planRev: "", week: null, weekRev: "", weekTree: [], loadedAt: 0, lists: [] };
const PATHS = { cal: "/cache/calendar.json", routine: "/data/routine.json", plan: "/data/plan.json", lists: "/data/lists.json" };

async function loadAll(force) {
  if (!force && (SAVE.running || SAVE.dirty.size || L.editing)) return;   // never reload over unsaved edits
  setBusy(true);
  try {
    const lists = JSON.parse((await DBX.read(CFG.root + PATHS.lists))?.text || "[]");
    const weekFile = (lists.find((l) => l.id === "week") || {}).file || "this-week.md";
    const [cal, routine, plan, week] = await Promise.all([
      DBX.read(CFG.root + PATHS.cal), DBX.read(CFG.root + PATHS.routine), DBX.read(CFG.root + PATHS.plan), DBX.read(`${CFG.root}/data/${weekFile}`)]);
    D.weekPath = `${CFG.root}/data/${weekFile}`;
    D.cal = cal ? JSON.parse(cal.text) : { events: [], calendars: [] };
    D.routine = routine ? JSON.parse(routine.text) : {};
    D.planText = plan?.text || '{"blocks": []}\n'; D.plan = JSON.parse(D.planText); D.planRev = plan?.rev || "";
    D.week = week?.text || ""; D.weekRev = week?.rev || ""; D.weekTree = parseOutline(D.week);
    D.lists = lists.filter((l) => l.id !== "week");
    const texts = await Promise.all(D.lists.map((l) => DBX.read(`${CFG.root}/data/${l.file}`)));
    D.files = {};
    D.lists.forEach((l, i) => { D.files[l.id] = { path: `${CFG.root}/data/${l.file}`, text: texts[i]?.text || "", rev: texts[i]?.rev || "" }; });
    D.loadedAt = Date.now();
    // Undo steps whose "after" text no longer matches the file (changed on the Mac) are dropped.
    UNDO.stack = UNDO.stack.filter((u) => u.files.every((f) => localGet(f.path)?.text === f.after));
    saveUndo(); cacheNow();
    hideBanner();
  } catch (e) {
    if (e instanceof NeedSignIn) return showSignIn();
    const c = LS.get("cache");
    if (c && !D.loadedAt) { Object.assign(D, { cal: c.cal, routine: c.routine, plan: c.plan, planText: c.planText || JSON.stringify(c.plan || { blocks: [] }, null, 1) + "\n", week: c.week, weekTree: parseOutline(c.week || ""), loadedAt: c.at, lists: c.lists || [], files: c.files || {} }); }
    showBanner(navigator.onLine ? `Couldn't load from Dropbox: ${esc(e.message)}` : "You're offline — showing the last loaded copy.");
  } finally { setBusy(false); }
  if (!L.editing) render();
}


// ---------------------------------------------------------------- saving + undo
// Every change is applied on screen at once and saved to Dropbox in the background, one file at a
// time, each write revision-checked. If the file changed on the Mac meanwhile, nothing is
// overwritten: the app reloads and says so. Undo restores the previous text of the files a change
// touched (last 30 changes; it survives closing the app).
function localGet(path) {
  if (path === D.weekPath) return { text: D.week, rev: D.weekRev };
  if (path === CFG.root + PATHS.plan) return { text: D.planText, rev: D.planRev };
  const f = Object.values(D.files).find((x) => x.path === path);
  return f ? { text: f.text, rev: f.rev } : null;
}
function localSet(path, text, rev) {
  if (path === D.weekPath) { D.week = text; D.weekTree = parseOutline(text); if (rev !== undefined) D.weekRev = rev; return; }
  if (path === CFG.root + PATHS.plan) { D.planText = text; D.plan = JSON.parse(text); if (rev !== undefined) D.planRev = rev; return; }
  const f = Object.values(D.files).find((x) => x.path === path);
  if (f) { f.text = text; if (rev !== undefined) f.rev = rev; }
}
const SAVE = { dirty: new Set(), running: null };
const UNDO = { stack: LS.get("undo", []) };
function saveUndo() { while (UNDO.stack.length > 30) UNDO.stack.shift(); try { LS.set("undo", UNDO.stack); } catch { UNDO.stack.splice(0, UNDO.stack.length - 3); LS.set("undo", UNDO.stack); } showUndo(); }
function showUndo() { const b = $("#undo"); if (b) b.hidden = !UNDO.stack.length; }
function cacheNow() { LS.set("cache", { cal: D.cal, routine: D.routine, plan: D.plan, planText: D.planText, week: D.week, at: D.loadedAt, lists: D.lists, files: D.files }); }

/** Apply changes ({path: newText}) locally, remember them for Undo, save in the background. */
function commit(changes, label, key) {
  const files = [];
  for (const [path, text] of Object.entries(changes)) {
    const cur = localGet(path);
    if (!cur || cur.text === text) continue;
    files.push({ path, before: cur.text, after: text });
    localSet(path, text);
    SAVE.dirty.add(path);
  }
  if (!files.length) return false;
  const top = UNDO.stack[UNDO.stack.length - 1];
  if (key && top && top.key === key && top.files.length === files.length && top.files.every((f, i) => f.path === files[i].path)) {
    top.files.forEach((f, i) => { f.after = files[i].after; });   // keep typing in one item as one undo step
  } else UNDO.stack.push({ label, key, files, at: Date.now() });
  saveUndo(); cacheNow(); flush();
  return true;
}
async function flush() {
  if (SAVE.running) return SAVE.running;
  setSaving(true);
  SAVE.running = (async () => {
    try {
      while (SAVE.dirty.size) {
        const path = [...SAVE.dirty][0];
        SAVE.dirty.delete(path);
        const cur = localGet(path);
        const rev = await DBX.write(path, cur.text, cur.rev);
        if (localGet(path).text === cur.text) localSet(path, cur.text, rev); else { localSet(path, localGet(path).text, rev); SAVE.dirty.add(path); }
      }
    } catch (e) {
      SAVE.dirty.clear();
      UNDO.stack = UNDO.stack.filter((u) => u.at > Date.now());   // texts no longer match: Undo can't be trusted
      saveUndo();
      SAVE.running = null; setSaving(false);
      const msg = e instanceof Conflict ? "That file had just changed on another device, so your last change was <b>not</b> saved. Reloaded — please redo it." : `Not saved: ${esc(e.message)}`;
      if (L.editing) { L.editing = null; document.activeElement?.blur?.(); }
      await loadAll(true);
      showBanner(msg);
      return;
    }
    SAVE.running = null; setSaving(false); cacheNow();
  })();
  return SAVE.running;
}
function undo() {
  if (L.editing) saveText(L.editing);
  const u = UNDO.stack.pop();
  if (!u) return;
  for (const f of u.files) if (localGet(f.path)?.text !== f.after) { saveUndo(); return showBanner("Can't undo that: the file has changed since."); }
  for (const f of u.files) { localSet(f.path, f.before); SAVE.dirty.add(f.path); }
  saveUndo(); cacheNow(); flush();
  // Redraw from the restored file. The line being edited still shows the undone text, so leaving
  // it must not save that text again (L.redrawing); keep typing there if the item still exists.
  const wasEditing = L.editing;
  L.redrawing = true;
  try { document.activeElement?.blur?.(); } finally { L.redrawing = false; }
  L.editing = null;
  if (wasEditing && view === "lists" && lineOf(listFile().text.split("\n"), wasEditing) >= 0) rerenderAndFocus(wasEditing, "end");
  else render();
  showBanner(`Undone: ${esc(u.label)}.`); setTimeout(hideBanner, 2500);
}
function setSaving(b) { const el = $("#saving"); if (el) el.textContent = b ? "Saving…" : ""; }

/** Tick a planned block or a This Week line; keeps both in step (same rule as the desktop). */
function tick({ block, item }, done) {
  const date = todayIso();
  let week = D.week, plan = JSON.parse(D.planText || '{"blocks":[]}');
  const b0 = block && plan.blocks.find((b) => b.id === block);
  const itemIds = block ? (b0?.items || []) : [item];
  if (b0) b0.done = done;
  for (const id of itemIds) week = setLineDone(week, id, done, date);
  const tree = parseOutline(week), state = {};
  (function walk(ns) { for (const n of ns) { state[n.id] = n.done; walk(n.children); } })(tree);
  for (const b of plan.blocks) {
    const ids = (b.items || []).filter((i) => i in state);
    if (ids.length) b.done = ids.every((i) => state[i]);
  }
  const planText = JSON.stringify(plan) === JSON.stringify(D.plan) ? D.planText : JSON.stringify(plan, null, 1) + "\n";
  const title = b0 ? b0.title : (findNode(D.weekTree, item)?.text || "item");
  commit({ [D.weekPath]: week, [CFG.root + PATHS.plan]: planText }, `${done ? "tick" : "untick"} “${title}”`);
  render();
}
function findNode(ns, id) { for (const n of ns) { if (n.id === id) return n; const f = findNode(n.children, id); if (f) return f; } return null; }

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
  const shownInBlocks = new Set();
  let nowShown = dayOffset !== 0;
  for (const t of timed) {
    if (!nowShown && t.s > now) { h += `<li class="now"><span>${hm(now)} — now</span></li>`; nowShown = true; }
    const time = `<span class="time">${hm(t.s)}<br><small>${hm(t.e)}</small></span>`;
    if (t.kind === "plan") {
      const its = (D.plan.blocks.find((b) => b.id === t.id)?.items || []).map((i) => findNode(D.weekTree, i)).filter(Boolean);
      its.forEach((n) => shownInBlocks.add(n.id));
      const nd = its.filter((n) => n.done).length, done = its.length ? nd === its.length : false;
      // One line: its tick box sits beside the block title. Several (e.g. an email batch): listed under it.
      h += `<li class="plan ${esc(t.k || "work")}${done ? " done" : ""}">${time}<div class="blk">` +
        (its.length === 1
          ? `<div class="row-item"><input type="checkbox" data-item="${esc(its[0].id)}"${its[0].done ? " checked" : ""}><b class="btitle">${esc(t.title)}</b></div>`
          : `<b class="btitle">${esc(t.title)}${its.length > 1 && !done ? ` <small>${nd}/${its.length}</small>` : ""}</b>` +
            (its.length ? renderNodes(its.map((n) => ({ ...n, children: [] }))) : "")) + `</div></li>`;
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
  const rest = sec ? sec.children.filter((n) => !shownInBlocks.has(n.id)) : [];
  if (rest.length) h += `<h3>Also today (This Week)</h3>${renderNodes(rest)}`;
  const top = D.weekTree.find((n) => /^TOP 3/i.test(n.text)), must = D.weekTree.find((n) => /^MUST-DOS/i.test(n.text));
  if (dayOffset === 0 && top) h += `<h3>Top 3 this week</h3>${renderNodes(top.children)}`;
  if (dayOffset === 0 && must) h += `<h3>Must-dos this week</h3>${renderNodes(must.children)}`;
  h += `<p class="note small">Loaded ${D.loadedAt ? ago(D.loadedAt) : "—"}.</p>`;
  $("#view-today").innerHTML = h;
}

/** "Tue" for a line carried to the copy filed under the "Tue Oct 27" section of This Week. */
function carriedDay(id) {
  for (const sect of D.weekTree) {
    const has = (ns) => ns.some((x) => x.id === id || has(x.children));
    if (has(sect.children)) return sect.text.split(/\s+/)[0];
  }
  return "";
}
function renderNodes(nodes) {
  return "<ul class=\"outline\">" + nodes.map((n) =>
    `<li class="${n.done ? "done" : n.carried ? "carried" : ""}"><div class="row-item"><input type="checkbox" data-item="${esc(n.id)}"${n.done ? " checked" : ""}><span>${esc(n.text)}${n.todo ? ' <small class="todo-link" title="From your To-Do List">↗</small>' : ""}${!n.done && n.carried ? ` <small class="carried-to">→ ${esc(carriedDay(n.carried) || "later")}</small>` : ""}</span></div>` +
    (n.children.length ? renderNodes(n.children) : "") + "</li>").join("") + "</ul>";
}

function renderWeek() {
  $("#top-title").textContent = "This Week";
  $("#top-sub").textContent = "";
  $("#view-week").innerHTML = D.weekTree.length
    ? D.weekTree.map((n) => `<details class="sect"${/^(TOP|MUST)/i.test(n.text) || weekSection(dayDate()) === n ? " open" : ""}><summary>${esc(n.text)}</summary>${renderNodes(n.children)}</details>`).join("")
    : '<p class="note">No This Week list yet.</p>';
}


// ---------------------------------------------------------------- Lists (To-Do List, Research Pipeline, Research Ideas)
// Edited in place like Workflowy: tap text to type; Return makes a new item below (or the first
// child of an open item); Backspace on an empty item removes it; the bar above the list indents,
// outdents and finishes. Open/closed state is kept on this phone only.
// (Claude never ticks the To-Do List without Jordan's okay; that rule is for the chat, not his taps.)
const L = { cur: LS.get("list_cur", "todo"), open: new Set(LS.get("list_open", [])), showDone: LS.get("list_done", false), editing: null, timer: null };
const saveOpen = () => LS.set("list_open", [...L.open].slice(-3000));
const isOpen = (id, depth) => L.open.has(id) || (depth === 0 && !L.open.has("-" + id));
function setOpen(id, depth, open) {
  if (depth === 0) { if (open) L.open.delete("-" + id); else L.open.add("-" + id); L.open.delete(id); }
  else if (open) L.open.add(id); else L.open.delete(id);
  saveOpen();
}

function renderLists() {
  const list = D.lists.find((l) => l.id === L.cur) || D.lists[0];
  $("#top-title").textContent = list ? list.title : "Lists";
  $("#top-sub").innerHTML = '<span id="saving"></span>';
  if (!list) { $("#view-lists").innerHTML = '<p class="note">No lists found.</p>'; return; }
  L.cur = list.id;
  const tree = parseOutline(D.files[list.id]?.text || "");
  const visible = (n) => L.showDone || !n.done;
  const node = (n, depth) => {
    const kids = n.children.filter(visible), open = isOpen(n.id, depth);
    return `<li class="${n.done ? "done" : ""}" data-depth="${depth}"><div class="row-item">` +
      (kids.length ? `<button class="caret${open ? " open" : ""}" data-toggle="${esc(n.id)}" data-depth="${depth}" aria-label="Expand">›</button>` : '<span class="caret-sp"></span>') +
      `<input type="checkbox" data-litem="${esc(n.id)}"${n.done ? " checked" : ""}>` +
      `<div class="txt" contenteditable="true" spellcheck="true" autocapitalize="sentences" data-edit="${esc(n.id)}" data-depth="${depth}" data-haskids="${kids.length ? 1 : 0}">${esc(n.text)}</div>` +
      (kids.length && !open ? `<small class="count">${kids.length}</small>` : "") + `</div>` +
      (n.note ? `<small class="nnote">${esc(n.note)}</small>` : "") +
      (kids.length && open ? `<ul class="outline">${kids.map((k) => node(k, depth + 1)).join("")}</ul>` : "") + "</li>";
  };
  const items = tree.filter(visible);
  L.redrawing = true;
  try { $("#view-lists").innerHTML =
    `<div class="listnav">${D.lists.map((l) => `<button data-list="${esc(l.id)}" class="${l.id === list.id ? "on" : ""}">${esc(l.title)}</button>`).join("")}</div>` +
    `<ul class="outline tree">${items.map((n) => node(n, 0)).join("")}</ul>` +
    (items.length ? "" : '<p><button data-op="first">＋ Start the list</button></p>') +
    `<p class="small"><label class="inline"><input type="checkbox" id="show-done"${L.showDone ? " checked" : ""}> Show completed items</label></p>`;
  } finally { L.redrawing = false; }
  showBar(!!L.editing);
}

// -- line-level operations on an outline file (everything else stays byte-identical)
const lineOf = (lines, id) => lines.findIndex((l) => ITEM_RE.test(l) && new RegExp("\\^" + id + "\\s*$").test(l));
const indentOf = (l) => l.match(/^[ \t]*/)[0].replace(/\t/g, "  ").length;
function blockEnd(lines, i) {            // index after item i's notes and descendants
  const ind = indentOf(lines[i]); let j = i + 1;
  for (; j < lines.length; j++) {
    const l = lines[j];
    if (ITEM_RE.test(l)) { if (indentOf(l) <= ind) break; }
    else if (!l.trim()) break;                    // a blank line ends the group
  }
  return j;
}
function splitLine(line) {               // {prefix, text, tags}
  const prefix = line.match(/^[ \t]*[-*+] (?:\[[ xX]\] ?)?/)[0];
  let rest = line.slice(prefix.length).replace(/\s+$/, ""), t, cut = rest.length;
  let probe = rest;
  while ((t = probe.match(TRAIL_RE))) { probe = probe.slice(0, t.index); cut = probe.length; }
  return { prefix: prefix.endsWith(" ") ? prefix : prefix + " ", text: rest.slice(0, cut).trim(), tags: rest.slice(cut).trim() };
}
const joinLine = (p) => p.prefix + [p.text, p.tags].filter(Boolean).join(" ");
const newLine = (indent, text) => " ".repeat(indent) + "- [ ] " + [text, `@added(${todayIso()})`, "^" + newItemId()].filter(Boolean).join(" ");
function allIds() {
  const ids = new Set();
  const take = (t) => { for (const m of String(t).matchAll(/\^([a-z0-9]{6})\s*$/gm)) ids.add(m[1]); };
  Object.values(D.files).forEach((f) => take(f.text)); take(D.week);
  return ids;
}
function newItemId() {
  const ids = allIds(), abc = "abcdefghijklmnopqrstuvwxyz0123456789";
  for (;;) { const id = Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => abc[b % 36]).join(""); if (!ids.has(id)) return id; }
}
const listFile = () => D.files[L.cur];
function editLines(fn, label, key) {
  const f = listFile(), lines = f.text.split("\n");
  const out = fn(lines);
  if (out === false) return false;
  return commit({ [f.path]: lines.join("\n") }, label, key);
}
const short = (t) => (t.length > 40 ? t.slice(0, 38) + "…" : t) || "empty item";

function saveText(id) {
  const el = document.querySelector(`[data-edit="${id}"]`);
  if (!el) return;
  const text = el.innerText.replace(/\s+/g, " ").trim();
  editLines((lines) => {
    const i = lineOf(lines, id); if (i < 0) return false;
    const p = splitLine(lines[i]); if (p.text === text) return false;
    p.text = text; lines[i] = joinLine(p);
  }, `edit “${short(text)}”`, "edit:" + id);
}
function caretOffset(el) {
  const sel = getSelection(); if (!sel.rangeCount) return el.innerText.length;
  const r = sel.getRangeAt(0).cloneRange(); r.selectNodeContents(el); r.setEnd(sel.getRangeAt(0).startContainer, sel.getRangeAt(0).startOffset);
  return r.toString().length;
}
function focusItem(id, offset) {
  const el = document.querySelector(`[data-edit="${id}"]`);
  if (!el) return;
  el.focus();
  const node = el.firstChild, r = document.createRange();
  if (node && node.nodeType === 3) { const o = offset === "end" || offset === undefined ? node.length : Math.min(offset, node.length); r.setStart(node, o); }
  else r.selectNodeContents(el), r.collapse(offset === 0);
  r.collapse(true);
  const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
  el.scrollIntoView({ block: "nearest" });
}
function rerenderAndFocus(id, offset) { L.editing = id; renderLists(); focusItem(id, offset); }

function onEnter(el) {
  const id = el.dataset.edit, full = el.innerText.replace(/\n/g, ""), at = caretOffset(el);
  const head = full.slice(0, at).replace(/\s+/g, " ").trim(), tail = full.slice(at).replace(/\s+/g, " ").trim();
  const asChild = el.dataset.haskids === "1" && isOpen(id, Number(el.dataset.depth)) && !tail;
  let newId = null;
  editLines((lines) => {
    const i = lineOf(lines, id); if (i < 0) return false;
    const p = splitLine(lines[i]); p.text = head; lines[i] = joinLine(p);
    const ind = indentOf(lines[i]);
    let at2 = i + 1;
    if (asChild) { while (at2 < lines.length && !ITEM_RE.test(lines[at2]) && lines[at2].trim()) at2++; }
    else at2 = blockEnd(lines, i);
    const nl = newLine(asChild ? ind + 2 : ind, tail);
    newId = nl.match(/\^([a-z0-9]{6})$/)[1];
    lines.splice(at2, 0, nl);
  }, tail ? `split “${short(head)}”` : "new item");
  if (newId) rerenderAndFocus(newId, 0);
}
function onBackspaceEmpty(el) {
  const id = el.dataset.edit;
  const all = [...document.querySelectorAll("[data-edit]")], k = all.indexOf(el), prev = all[k - 1];
  let ok = false;
  editLines((lines) => {
    const i = lineOf(lines, id); if (i < 0) return false;
    const end = blockEnd(lines, i);
    if (lines.slice(i + 1, end).some((l) => ITEM_RE.test(l))) return false;   // never delete an item that has children
    lines.splice(i, end - i); ok = true;
  }, "delete empty item");
  if (ok) { if (prev) rerenderAndFocus(prev.dataset.edit, "end"); else { L.editing = null; renderLists(); } }
}
function indent(id) {
  let parent = null;
  editLines((lines) => {
    const i = lineOf(lines, id); if (i < 0) return false;
    const ind = indentOf(lines[i]); let k = i - 1;
    while (k >= 0 && (!ITEM_RE.test(lines[k]) || indentOf(lines[k]) > ind)) k--;
    if (k < 0 || indentOf(lines[k]) !== ind) return false;          // no item above at the same level
    parent = lines[k].match(/\^([a-z0-9]{6})\s*$/)?.[1];
    const end = blockEnd(lines, i);
    for (let j = i; j < end; j++) if (lines[j].trim()) lines[j] = "  " + lines[j];
  }, "indent");
  if (parent) { const pe = document.querySelector(`[data-edit="${parent}"]`); setOpen(parent, pe ? Number(pe.dataset.depth) : 1, true); }
}
function outdent(id) {
  editLines((lines) => {
    const i = lineOf(lines, id); if (i < 0) return false;
    const ind = indentOf(lines[i]); if (ind < 2) return false;
    let p = i - 1;
    while (p >= 0 && (!ITEM_RE.test(lines[p]) || indentOf(lines[p]) >= ind)) p--;
    if (p < 0) return false;
    const end = blockEnd(lines, i), pEnd = blockEnd(lines, p);
    const block = lines.splice(i, end - i).map((l) => l.replace(/^  /, ""));
    lines.splice(pEnd - block.length, 0, ...block);                   // right after its old parent's group
  }, "outdent");
}
// The edit bar floats just above the iPhone keyboard (the keyboard has no Tab key and no "hide").
function showBar(on) {
  const bar = $("#editbar"); if (!bar) return;
  bar.hidden = !on; document.body.classList.toggle("editing", on);
  if (on) { placeBar(); setTimeout(placeBar, 350); }   // again once the keyboard has finished sliding up
}
function placeBar() {
  const bar = $("#editbar"); if (!bar || bar.hidden) return;
  const vv = window.visualViewport;
  bar.style.top = Math.round((vv ? vv.offsetTop + vv.height : innerHeight) - bar.offsetHeight) + "px";
}
if (window.visualViewport) { visualViewport.addEventListener("resize", placeBar); visualViewport.addEventListener("scroll", placeBar); }
window.addEventListener("scroll", placeBar);

function editOp(op) {
  const id = L.editing;
  if (op === "undo") return undo();
  if (op === "done") { if (id) saveText(id); L.editing = null; document.activeElement?.blur?.(); return renderLists(); }
  if (op === "first") {
    let nid = null;
    editLines((lines) => { let at = 0; while (at < lines.length && (!lines[at].trim() || lines[at].trim().startsWith("<!--"))) at++; const nl = newLine(0, ""); nid = nl.slice(-6); lines.splice(at, 0, nl); }, "new item");
    return nid && rerenderAndFocus(nid, 0);
  }
  if (!id) return;
  const el = document.querySelector(`[data-edit="${id}"]`), off = el ? caretOffset(el) : "end";
  saveText(id);
  if (op === "indent") indent(id); else outdent(id);
  rerenderAndFocus(id, off);
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
  VOICE.show();
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
  if (i >= 0 && msgs[i].pending && reply.text) VOICE.say(reply.text);
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

// ---------------------------------------------------------------- voice (🎤 and Read aloud in the chat)
const VOICE = {
  on: LS.get("read_aloud", false),
  rec: null,
  plain(t) {   // Markdown -> something that sounds right
    return String(t || "").replace(/```[\s\S]*?```/g, " ").replace(/`([^`]*)`/g, "$1").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/^[ \t]*\|?[ \t:|-]+\|[ \t]*$/gm, "").replace(/^[ \t]*\|(.*)\|[ \t]*$/gm, (_, r) => r.split("|").map((c) => c.trim()).join(", ") + ".")
      .replace(/[*_#>★]+/g, "").replace(/^\s*[-•]\s+/gm, "").replace(/[–→]/g, " to ").replace(/—/g, ", ");
  },
  say(text) {
    if (!this.on || !window.speechSynthesis) return;
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(this.plain(text)); u.lang = "en-US";
    speechSynthesis.speak(u);
  },
  show() { const b = $("#chat-speak"); if (b) { b.classList.toggle("on", this.on); b.textContent = this.on ? "🔊" : "🔈"; b.setAttribute("aria-pressed", String(this.on)); } },
  toggle() {
    this.on = !this.on; LS.set("read_aloud", this.on); this.show();
    if (window.speechSynthesis) { speechSynthesis.cancel(); if (this.on) speechSynthesis.speak(new SpeechSynthesisUtterance("")); }   // a tap unlocks speech on iPhone
  },
  listen() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition, box = $("#chat-input"), mic = $("#chat-mic");
    if (this.rec) { try { this.rec.stop(); } catch { /* already stopped */ } return; }
    const hint = () => { showBanner("Use the microphone on the keyboard instead: tap the message box, then the 🎤 key."); box.focus(); };
    if (!SR) return hint();
    window.speechSynthesis?.cancel();
    const r = this.rec = new SR(), base = box.value ? box.value.replace(/\s*$/, " ") : "";
    r.lang = "en-US"; r.interimResults = true; r.continuous = true;
    r.onresult = (e) => { let t = ""; for (let i = 0; i < e.results.length; i++) t += e.results[i][0].transcript; box.value = base + t.trim(); };
    r.onerror = (e) => { if (["not-allowed", "service-not-allowed", "audio-capture"].includes(e.error)) hint(); };
    r.onend = () => { this.rec = null; mic.classList.remove("listening"); };
    try { r.start(); mic.classList.add("listening"); } catch { this.rec = null; hint(); }
  },
};

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
    <h3>Siri</h3>
    <p class="small">For the Siri Shortcuts "Add to planner" and "Ask planner" (setup steps: README in ${CFG.repo}). Copies this phone's Dropbox and GitHub keys as one block to paste into the Shortcuts' setup step. Keep it private.</p>
    <button id="copy-siri"${gh ? "" : " disabled"}>Copy Siri setup</button>
    <h3>Dropbox</h3>
    <p class="small">Signed in. Your Planner folder: ${CFG.root}</p>
    <button id="signout">Sign out of Dropbox</button>
    <p class="small">For setting up the chat: copies this phone's Dropbox key so the GitHub job can reach your Planner folder. Paste it only into the GitHub secret DROPBOX_REFRESH_TOKEN.</p>
    <button id="copy-dbx">Copy Dropbox key for GitHub</button>
    <h3>About</h3>
    <p class="small">Same files as the desktop Planner. Changes made here appear on the Mac within seconds when the Planner is open there.</p>`;
}

// ---------------------------------------------------------------- shell
let view = LS.get("view", "today");
function switchView(v) {
  view = v; LS.set("view", v);
  for (const s of ["today", "week", "lists", "chat", "settings"]) $("#view-" + s).hidden = s !== v;
  document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("on", b.dataset.view === v));
  render();
  if (v === "chat") pollChat();
}
function render() {
  if (view === "today") renderToday();
  else if (view === "week") renderWeek();
  else if (view === "lists") renderLists();
  else if (view === "chat") renderChat();
  else renderSettings();
}
function setBusy(b) { $("#refresh").classList.toggle("spin", b); }
function showBanner(html) { const b = $("#banner"); b.innerHTML = html; b.hidden = false; }
function hideBanner() { $("#banner").hidden = true; }
function showSignIn(err) { $("#main").hidden = true; $("#signin").hidden = false; $("#signin-error").textContent = err || ""; }

document.addEventListener("click", async (e) => {
  const t = e.target;
  if (L.editing && !t.closest("[data-edit]") && !t.closest("#editbar")) { document.activeElement?.blur?.(); if (!t.closest("button, input, a")) return; }
  if (t.closest(".tabs button")) return switchView(t.closest("button").dataset.view);
  if (t.dataset.day !== undefined && t.closest(".daynav")) { dayOffset = t.dataset.day === "0" ? 0 : dayOffset + Number(t.dataset.day); return renderToday(); }
  if (t.id === "refresh") return loadAll();
  if (t.dataset.list) { L.cur = t.dataset.list; LS.set("list_cur", L.cur); return renderLists(); }
  if (t.dataset.toggle) { setOpen(t.dataset.toggle, Number(t.dataset.depth), !t.classList.contains("open")); return renderLists(); }
  if (t.id === "undo") return undo();
  if (t.dataset.op === "first") return editOp("first");
  if (t.dataset.say) return sendChat(t.dataset.say);
  if (t.id === "chat-send") { const v = $("#chat-input").value; $("#chat-input").value = ""; return sendChat(v); }
  if (t.id === "chat-mic") return VOICE.listen();
  if (t.id === "chat-speak") return VOICE.toggle();
  if (t.id === "copy-siri") {
    const block = JSON.stringify({ app_key: CFG.appKey, dropbox_refresh: LS.get("dbx_refresh") || "", github_token: LS.get("gh_token") || "", repo: CFG.repo, root: CFG.root });
    try { await navigator.clipboard.writeText(block); showBanner("Copied. Paste it into the Shortcut's Text action (see the setup steps)."); }
    catch { showBanner("Couldn't copy on this device."); }
    return;
  }
  if (t.id === "chat-new") { LS.set("chat_conv", null); return renderChat(); }
  if (t.id === "gh-save") { const v = $("#gh-token").value.trim(); if (v) { LS.set("gh_token", v); showBanner("GitHub key saved."); } return renderSettings(); }
  if (t.id === "gh-clear") { LS.set("gh_token", null); return renderSettings(); }
  if (t.id === "copy-dbx") {
    try { await navigator.clipboard.writeText(LS.get("dbx_refresh") || ""); showBanner("Copied. Paste it into the GitHub secret DROPBOX_REFRESH_TOKEN."); }
    catch { showBanner("Couldn't copy on this device."); }
    return;
  }
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
  else if (c.dataset.litem) {
    const id = c.dataset.litem, f = listFile(), n = findNode(parseOutline(f.text), id);
    commit({ [f.path]: setLineDone(f.text, id, c.checked, todayIso()) }, `${c.checked ? "tick" : "untick"} “${short(n?.text || "")}”`);
    setTimeout(renderLists, c.checked && !L.showDone ? 350 : 0);
  }
  else if (c.id === "show-done") { L.showDone = c.checked; LS.set("list_done", L.showDone); renderLists(); }
});
// editing in the Lists tab
document.addEventListener("focusin", (e) => {
  const el = e.target.closest?.("[data-edit]"); if (!el) return;
  if (L.editing && L.editing !== el.dataset.edit) saveText(L.editing);
  L.editing = el.dataset.edit; showBar(true);
});
document.addEventListener("focusout", (e) => {
  const el = e.target.closest?.("[data-edit]"); if (!el) return;
  if (!L.redrawing) saveText(el.dataset.edit);   // not while the list is being redrawn (Return, Indent…): the old line's text is stale
  setTimeout(() => { if (!document.activeElement?.closest?.("[data-edit]")) { L.editing = null; showBar(false); } }, 150);
});
document.addEventListener("input", (e) => {
  const el = e.target.closest?.("[data-edit]"); if (!el) return;
  clearTimeout(L.timer); L.timer = setTimeout(() => saveText(el.dataset.edit), 800);
});
document.addEventListener("keydown", (e) => {
  const el = e.target.closest?.("[data-edit]"); if (!el || e.isComposing) return;
  if (e.key === "Enter") { e.preventDefault(); clearTimeout(L.timer); onEnter(el); }
  else if (e.key === "Backspace" && !el.innerText.trim() && caretOffset(el) === 0) { e.preventDefault(); onBackspaceEmpty(el); }
});
document.addEventListener("beforeinput", (e) => {   // some iPhone keyboards send Return only as an input event
  const el = e.target.closest?.("[data-edit]"); if (!el) return;
  if (e.inputType === "insertParagraph" || e.inputType === "insertLineBreak") { e.preventDefault(); clearTimeout(L.timer); onEnter(el); }
});
// The edit bar acts on press, so the keyboard stays up.
document.addEventListener("pointerdown", (e) => {
  const b = e.target.closest?.("#editbar [data-op]"); if (!b) return;
  e.preventDefault(); editOp(b.dataset.op);
});
document.addEventListener("mousedown", (e) => { if (e.target.closest?.("#editbar")) e.preventDefault(); });
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden" && L.editing) saveText(L.editing); if (document.visibilityState === "visible" && DBX.signedIn() && Date.now() - D.loadedAt > 60e3) loadAll(); });

async function start() {
  try { await DBX.finishRedirect(); } catch (e) { return showSignIn(e.message); }
  if (!DBX.signedIn()) return showSignIn();
  $("#signin").hidden = true; $("#main").hidden = false;
  switchView(view); showUndo();
  const c = LS.get("cache");
  if (c) { Object.assign(D, { cal: c.cal, routine: c.routine, plan: c.plan, planText: c.planText || JSON.stringify(c.plan || { blocks: [] }, null, 1) + "\n", week: c.week, weekTree: parseOutline(c.week || ""), loadedAt: c.at, lists: c.lists || [], files: c.files || {} }); render(); }
  await loadAll();
  pollChat();
}
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js", { updateViaCache: "none" }).then((reg) => reg.update()).catch(() => {});
  // When a new version takes over, reload once so the new screens appear without a second restart.
  let reloaded = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => { if (!reloaded && navigator.serviceWorker.controller) { reloaded = true; location.reload(); } });
}
start();
