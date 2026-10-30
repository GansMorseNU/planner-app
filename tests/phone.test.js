// Drives the phone app in a phone-sized browser against a mocked Dropbox + GitHub.
// Usage: node tests/phone.test.js [planner-folder]   (default: tests/fixture, made-up data)
const { chromium, devices } = require("playwright");
const fs = require("fs"), path = require("path"), http = require("http");
const ROOT = process.argv[2] || path.join(__dirname, "fixture"), APP = path.join(__dirname, "..", "app");
const files = new Map(); let revN = 1;
function load(rel) { const p = path.join(ROOT, rel); if (fs.existsSync(p)) files.set("/planner/" + rel.toLowerCase(), { text: fs.readFileSync(p, "utf8"), rev: "r" + revN++, name: rel }); }
["cache/calendar.json", "data/routine.json", "data/plan.json", "data/lists.json", "data/this-week.md", "data/tasks.md", "data/research-pipeline.md", "data/research-ideas.md"].forEach(load);
const dispatched = [];
const fail = (m) => { console.error("FAIL:", m); process.exitCode = 1; };
const ok = (c, m) => c ? console.log("ok  ", m) : fail(m);

const srv = http.createServer((q, r) => {
  const f = path.join(APP, q.url.split("?")[0] === "/" ? "index.html" : q.url.split("?")[0]);
  if (!fs.existsSync(f)) { r.writeHead(404); return r.end(); }
  const t = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".png": "image/png", ".webmanifest": "application/manifest+json" }[path.extname(f)];
  r.writeHead(200, { "Content-Type": t }); r.end(fs.readFileSync(f));
}).listen(8811);

(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ ...devices["iPhone 13"], timezoneId: "America/Chicago" });
  await ctx.addInitScript(() => { localStorage.setItem("planner.dbx_refresh", JSON.stringify("RT")); localStorage.setItem("planner.gh_token", JSON.stringify("GH")); });
  await ctx.clock?.install?.({ time: new Date("2026-10-26T09:40:00-05:00") });
  await ctx.route("https://api.dropboxapi.com/**", async (rt) => {
    const u = rt.request().url();
    if (u.endsWith("/oauth2/token")) return rt.fulfill({ json: { access_token: "AT", expires_in: 14400 } });
    if (u.endsWith("files/list_folder")) return rt.fulfill({ json: { entries: [], has_more: false } });
    rt.fulfill({ status: 400, body: "unexpected " + u });
  });
  await ctx.route("https://content.dropboxapi.com/**", async (rt) => {
    const req = rt.request(), arg = JSON.parse(req.headers()["dropbox-api-arg"]), key = arg.path.toLowerCase();
    if (req.url().endsWith("/download")) {
      const f = files.get(key);
      if (!f) return rt.fulfill({ status: 409, json: { error_summary: "path/not_found/" } });
      return rt.fulfill({ status: 200, headers: { "Dropbox-API-Result": JSON.stringify({ rev: f.rev }), "Access-Control-Allow-Origin": "*", "Access-Control-Expose-Headers": "Dropbox-API-Result" }, body: f.text });
    }
    const cur = files.get(key), m = arg.mode;
    if ((m === "add" && cur) || (m[".tag"] === "update" && (!cur || cur.rev !== m.update)))
      { if (process.env.DBG) console.log("CONFLICT", key, JSON.stringify(m), cur && cur.rev); return rt.fulfill({ status: 409, body: JSON.stringify({ error_summary: "path/conflict/file/" }) }); }
    const rev = "r" + revN++;
    if (process.env.DBG) console.log("WRITE", key, JSON.stringify(m), "->", rev);
    files.set(key, { text: req.postDataBuffer().toString("utf8"), rev });
    rt.fulfill({ json: { rev } });
  });
  await ctx.route("https://api.github.com/**", async (rt) => {
    dispatched.push(JSON.parse(rt.request().postData()));
    rt.fulfill({ status: 204, body: "" });
  });
  const p = await ctx.newPage();
  const errs = []; p.on("pageerror", (e) => errs.push(e.message));
  await p.goto("http://localhost:8811/");
  await p.waitForSelector("#view-today .timeline li.plan");
  const today = await p.textContent("#view-today");
  ok(today.includes("call with tanner"), "Today shows Google event");
  ok(today.includes("School pickup"), "Today shows routine pickup");
  ok(today.includes("Gym"), "Today shows planned block");
  ok(today.includes("BJPS review") && today.includes("Also today"), "Today shows This Week lines for the day");
  ok(!today.includes("2:00 call with Tanner"), "calendar-event line not repeated under Also today");
  await p.screenshot({ path: "/tmp/claude-0/phone-today.png", fullPage: false });

  // tick the gym block -> plan.json done + this-week line ticked
  ok(await p.locator("input[data-block]").count() === 0, "calendar blocks have no tick box of their own");
  ok(await p.locator('#view-today li.plan input[data-item="vfaqoc"]').count() === 1 && await p.locator('#view-today input[data-item="vfaqoc"]').count() === 1, "block lists its This Week line (once on the screen)");
  await p.check('#view-today li.plan input[data-item="vfaqoc"]');
  await p.waitForTimeout(500);
  const plan = JSON.parse(files.get("/planner/data/plan.json").text);
  ok(plan.blocks.find((x) => x.id === "0nkj6h").done === true, "block marked done in plan.json");
  const wk = files.get("/planner/data/this-week.md").text;
  ok(/- \[x\] gym after drop-off.* @done\(2026-10-26\) \^vfaqoc/.test(wk), "linked This Week line ticked with date");
  const orig = fs.readFileSync(path.join(ROOT, "data/this-week.md"), "utf8").split("\n"), now = wk.split("\n");
  ok(orig.length === now.length && orig.filter((l, i) => l !== now[i]).length === 1, "only that one line changed");
  ok(await p.isChecked('input[data-item="vfaqoc"]') && (await p.getAttribute('#view-today li.plan:has(input[data-item="vfaqoc"])', "class")).includes("done"), "block shows as done on Today");

  // untick through the This Week line -> block undone
  await p.uncheck('input[data-item="vfaqoc"]'); await p.waitForTimeout(500);
  ok(JSON.parse(files.get("/planner/data/plan.json").text).blocks.find((x) => x.id === "0nkj6h").done === false, "unticking the line un-dones the block");
  ok(files.get("/planner/data/this-week.md").text === fs.readFileSync(path.join(ROOT, "data/this-week.md"), "utf8"), "this-week.md back to byte-identical");

  // conflict: file changed on the Mac meanwhile -> reload and redo
  const f = files.get("/planner/data/this-week.md"); f.text = f.text.replace("bag for Sasha", "bag for Sasha (edited on Mac)"); f.rev = "r" + revN++;
  await p.click('input[data-item="sfocsw"]'); await p.waitForTimeout(800);   // one tap (check() would re-tap after the reload)
  const w2 = files.get("/planner/data/this-week.md").text;
  ok(w2.includes("(edited on Mac)") && !/- \[x\] ★ BJPS review/.test(w2) && (await p.textContent("#banner")).includes("not"), "conflict: Mac edit kept, tick not forced over it, user told");

  // This Week view
  await p.click('.tabs button[data-view="week"]');
  ok((await p.textContent("#view-week")).includes("TOP 3 THIS WEEK"), "This Week view lists sections");
  ok(await p.locator("#view-week li.done").count() >= 2, "done items shown crossed out, not hidden");
  await p.evaluate(() => document.querySelectorAll("#view-week details").forEach((d) => { d.open = true; }));
  const car = p.locator('#view-week li.carried:has(input[data-item="yx51cf"])');
  ok(await car.count() === 1 && (await car.textContent()).includes("→ Mon"), "carried-forward line greyed with the day it went to");
  ok(await p.locator('#view-week li.carried:has(input[data-item="e7xq45"])').count() === 0, "its open copy is not greyed");
  const ev = p.locator('#view-week li.cal-event');
  ok(await ev.count() === 1 && (await ev.textContent()).trim() === "2:00 call with Tanner" && await p.locator('input[data-item="nszhpf"]').count() === 0,
     "calendar-event line shown with a clock, no tick box, no @event tag");
  await p.screenshot({ path: "/tmp/claude-0/phone-week.png" });

  // Lists
  const T = () => files.get("/planner/data/tasks.md").text;
  const diffN = (x, y) => { const X = x.split("\n"), Y = y.split("\n"); let n = Math.abs(X.length - Y.length); X.forEach((l, i) => { if (l !== Y[i]) n++; }); return n; };
  const settle = () => p.waitForTimeout(1200);
  await p.click('.tabs button[data-view="lists"]');
  ok((await p.textContent("#view-lists")).includes("PRIORITY - WORK"), "Lists shows the To-Do List");
  await p.click('button[data-toggle="1miudb"]');
  ok((await p.textContent("#view-lists")).includes("write austin wright"), "expanding a section shows its items");
  const t0 = T();
  await p.click('[data-edit="1miudb"]'); await settle();
  ok(T() === t0, "tapping a section's text does not tick it (no file change)");
  ok(await p.isVisible("#editbar"), "edit bar appears while editing");

  // type into an item
  await p.click('[data-edit="fr5b31"]'); await p.keyboard.press("End"); await p.keyboard.type(" soon"); await settle();
  const t1 = T();
  ok(/^    - \[ \] write austin wright about meeting up soon @added\(2026-10-23\) \^fr5b31$/m.test(t1) && diffN(t0, t1) === 1, "typing edits only that line, tags kept");
  // Return at end -> new sibling below, then type
  await p.keyboard.press("Enter"); await p.keyboard.type("new from phone"); await settle();
  const t2 = T().split("\n"), k = t2.findIndex((l) => l.includes("new from phone"));
  ok(/\^fr5b31$/.test(t2[k - 1]) && /^    - \[ \] new from phone @added\(2026-10-26\) \^[a-z0-9]{6}$/.test(t2[k]), "Return makes a new item right below, same level");
  const nid = t2[k].slice(-6);
  // indent -> child of austin item; outdent -> back
  await p.click('#editbar [data-op="indent"]'); await settle();
  ok(/^      - \[ \] new from phone/m.test(T()), "Indent makes it a child of the item above");
  ok(await p.evaluate(() => document.activeElement?.dataset?.edit) === nid, "keeps typing focus after Indent");
  await p.click('#editbar [data-op="outdent"]'); await settle();
  ok(/^    - \[ \] new from phone/m.test(T()) && T().split("\n").findIndex((l) => l.includes("new from phone")) === k, "Outdent puts it back after its old parent");
  // split in the middle
  await p.keyboard.press("Home"); for (let i = 0; i < 4; i++) await p.keyboard.press("ArrowRight");
  await p.keyboard.press("Enter"); await settle();
  ok(/- \[ \] new @added\(2026-10-26\) \^/.test(T()) && /- \[ \] from phone @added\(2026-10-26\) \^/.test(T()), "Return in the middle splits the item");
  // empty + backspace deletes
  await p.keyboard.press("End"); await p.keyboard.press("Enter"); await p.keyboard.press("Backspace"); await settle();
  ok(T().split("\n").length === t1.split("\n").length + 2, "Backspace on an empty new item removes it");
  // a section with children is never deleted by Backspace
  // undo all the way back to t0
  await p.click('#editbar [data-op="done"]'); await settle();
  for (let i = 0; i < 12 && T() !== t0; i++) { await p.click("#undo"); await settle(); }
  ok(T() === t0, "Undo steps back to the original file, byte for byte");
  // Undo from the bar while still typing (the iPhone case)
  await p.click('[data-edit="fr5b31"]'); await p.keyboard.press("End"); await p.keyboard.type(" XYZ"); await settle();
  ok(T().includes("meeting up XYZ"), "typed text saved");
  await p.click('#editbar [data-op="undo"]'); await settle();
  ok(T() === t0 && !(await p.textContent('[data-edit="fr5b31"]')).includes("XYZ"), "bar Undo while typing removes the typed text (file and screen)");
  ok(await p.evaluate(() => document.activeElement?.dataset?.edit) === "fr5b31", "keyboard stays on that item after Undo");
  await p.click('#editbar [data-op="done"]'); await settle();
  ok(T() === t0, "closing the keyboard afterwards doesn't bring the text back");
  await p.click('[data-edit="fr5b31"]');
  const bb = await p.locator("#editbar").boundingBox(), vh = p.viewportSize().height;
  ok(bb && bb.y + bb.height <= vh + 1 && bb.y > vh / 2, "edit bar sits at the bottom of the visible area (above the keyboard)");
  await p.click("#view-lists .listnav", { position: { x: 5, y: 5 } }); await p.waitForTimeout(300);
  ok(!(await p.evaluate(() => document.activeElement?.dataset?.edit)) && await p.isHidden("#editbar"), "tapping outside the item closes the keyboard and the bar");
  // tick + undo
  await p.check('input[data-litem="fr5b31"]'); await settle();
  ok(/- \[x\] write austin wright.* @done\(2026-10-26\) \^fr5b31/.test(T()) && diffN(t0, T()) === 1, "ticking a To-Do item changes only its line");
  await p.click("#undo"); await settle();
  ok(T() === t0, "Undo un-ticks it");
  await p.screenshot({ path: "/tmp/claude-0/phone-lists.png" });
  // a conflict while typing: Mac changed the file -> nothing overwritten
  const fx = files.get("/planner/data/tasks.md"); fx.text = fx.text.replace("finish survey on AI use", "finish survey on AI use (Mac)"); fx.rev = "r" + revN++;
  await p.click('[data-edit="m3sbe5"]'); await p.keyboard.press("End"); await p.keyboard.type(" X"); await p.click('#editbar [data-op="done"]'); await p.waitForTimeout(2000);
  ok(T().includes("(Mac)") && !T().includes("WCIAS X"), "conflict: Mac's change kept, phone edit not forced over it");
  ok((await p.textContent("#banner")).includes("not"), "conflict: says the change wasn't saved");
  await p.click('button[data-list="ideas"]');
  ok((await p.textContent("#top-title")) === "Research Ideas", "switch to Research Ideas");

  // chat
  await p.click('.tabs button[data-view="chat"]');
  await p.click('button[data-say="morning check-in"]');
  await p.waitForTimeout(500);
  const reqKey = [...files.keys()].find((k) => k.includes("/.chat/phone/requests/"));
  ok(!!reqKey && JSON.parse(files.get(reqKey).text).text === "morning check-in", "request written to Dropbox mailbox");
  ok(dispatched.length === 1 && dispatched[0].inputs.request && dispatched[0].ref === "main", "GitHub job started");
  const id = JSON.parse(files.get(reqKey).text).id;
  files.set(`/planner/.chat/phone/working/${id}.json`, { text: JSON.stringify({ progress: ["Reading calendar…"] }), rev: "w1" });
  await p.waitForTimeout(4500);
  ok((await p.textContent("#chat-log")).includes("Reading calendar"), "shows worker progress");
  files.set(`/planner/.chat/phone/replies/${id}.json`, { text: JSON.stringify({ id, text: "**Today at a glance**\n- 9:15 office\n- 2:45 pickup", changed: ["data/plan.json"] }), rev: "x1" });
  await p.waitForTimeout(4500);
  const log = await p.textContent("#chat-log");
  ok(log.includes("Today at a glance") && log.includes("Saved: data/plan.json"), "reply shown with changed files");
  await p.screenshot({ path: "/tmp/claude-0/phone-chat.png" });
  await p.click("#chat-speak");
  ok((await p.getAttribute("#chat-speak", "class")).includes("on") && (await p.textContent("#chat-speak")).includes("🔊"), "Read aloud toggles on");
  await p.click("#chat-speak");
  ok(!(await p.getAttribute("#chat-speak", "class") || "").includes("on"), "Read aloud toggles off");
  await p.click("#chat-mic"); await p.waitForTimeout(300);
  ok(await p.isVisible("#chat-mic"), "mic button present (speech itself is tested on the phone)");
  await p.click('.tabs button[data-view="settings"]');
  ok(await p.isVisible("#copy-siri"), "Settings offers Copy Siri setup");
  await p.screenshot({ path: "/tmp/claude-0/phone-settings.png" });
  ok(errs.length === 0, "no page errors " + errs.join("; "));
  await b.close(); srv.close();
})().catch((e) => { fail(e.stack); srv.close(); process.exit(1); });
