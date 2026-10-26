// Drives the phone app in a phone-sized browser against a mocked Dropbox + GitHub.
// Usage: node tests/phone.test.js <planner-folder-copy>
const { chromium, devices } = require("playwright");
const fs = require("fs"), path = require("path"), http = require("http");
const ROOT = process.argv[2], APP = path.join(__dirname, "..", "app");
const files = new Map(); let revN = 1;
function load(rel) { const p = path.join(ROOT, rel); if (fs.existsSync(p)) files.set("/planner/" + rel.toLowerCase(), { text: fs.readFileSync(p, "utf8"), rev: "r" + revN++, name: rel }); }
["cache/calendar.json", "data/routine.json", "data/plan.json", "data/lists.json", "data/this-week.md"].forEach(load);
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
      return rt.fulfill({ status: 409, body: JSON.stringify({ error_summary: "path/conflict/file/" }) });
    const rev = "r" + revN++;
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
  await p.waitForSelector("#view-today .timeline li");
  const today = await p.textContent("#view-today");
  ok(today.includes("call with tanner"), "Today shows Google event");
  ok(today.includes("School pickup"), "Today shows routine pickup");
  ok(today.includes("Gym"), "Today shows planned block");
  ok(today.includes("From This Week") && today.includes("BJPS review"), "Today shows This Week lines for the day");
  await p.screenshot({ path: "/tmp/claude-0/phone-today.png", fullPage: false });

  // tick the gym block -> plan.json done + this-week line ticked
  await p.check('input[data-block="0nkj6h"]');
  await p.waitForTimeout(500);
  const plan = JSON.parse(files.get("/planner/data/plan.json").text);
  ok(plan.blocks.find((x) => x.id === "0nkj6h").done === true, "block marked done in plan.json");
  const wk = files.get("/planner/data/this-week.md").text;
  ok(/- \[x\] gym after drop-off.* @done\(2026-10-26\) \^vfaqoc/.test(wk), "linked This Week line ticked with date");
  const orig = fs.readFileSync(path.join(ROOT, "data/this-week.md"), "utf8").split("\n"), now = wk.split("\n");
  ok(orig.length === now.length && orig.filter((l, i) => l !== now[i]).length === 1, "only that one line changed");
  ok(await p.isChecked('input[data-item="vfaqoc"]'), "This Week checkbox on Today follows");

  // untick through the This Week line -> block undone
  await p.uncheck('input[data-item="vfaqoc"]'); await p.waitForTimeout(500);
  ok(JSON.parse(files.get("/planner/data/plan.json").text).blocks.find((x) => x.id === "0nkj6h").done === false, "unticking the line un-dones the block");
  ok(files.get("/planner/data/this-week.md").text === fs.readFileSync(path.join(ROOT, "data/this-week.md"), "utf8"), "this-week.md back to byte-identical");

  // conflict: file changed on the Mac meanwhile -> reload and redo
  const f = files.get("/planner/data/this-week.md"); f.text = f.text.replace("bag for Sasha", "bag for Sasha (edited on Mac)"); f.rev = "r" + revN++;
  await p.check('input[data-item="sfocsw"]'); await p.waitForTimeout(800);
  const w2 = files.get("/planner/data/this-week.md").text;
  ok(w2.includes("(edited on Mac)") && /- \[x\] ★ BJPS review.*\^sfocsw/.test(w2), "conflict: Mac edit kept and tick applied after reload");

  // This Week view
  await p.click('.tabs button[data-view="week"]');
  ok((await p.textContent("#view-week")).includes("TOP 3 THIS WEEK"), "This Week view lists sections");
  ok(await p.locator("#view-week li.done").count() >= 2, "done items shown crossed out, not hidden");
  await p.screenshot({ path: "/tmp/claude-0/phone-week.png" });

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
  await p.click('.tabs button[data-view="settings"]');
  await p.screenshot({ path: "/tmp/claude-0/phone-settings.png" });
  ok(errs.length === 0, "no page errors " + errs.join("; "));
  await b.close(); srv.close();
})().catch((e) => { fail(e.stack); srv.close(); process.exit(1); });
