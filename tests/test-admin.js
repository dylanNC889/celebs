const T = process.env.T || "/tmp/t";  // the work folder tests/run.sh sets up
const fs = require("fs");
const { JSDOM } = require(T + "/node_modules/jsdom");
const { TextEncoder, TextDecoder } = require("util");
const check = (label, ok) => console.log((ok ? "PASS " : "FAIL ") + label);
const tick = (ms = 30) => new Promise(r => setTimeout(r, ms));
const until = async (f, ms = 10000) => { const t0 = Date.now(); while (!f() && Date.now() - t0 < ms) await tick(); return f(); };

{ const app = require(T + "/app.js");
  const base = JSON.parse(fs.readFileSync(T + "/data.json", "utf8")), over = { topics: [{ name: "Anime", note: "", fields: [], entries: [{ name: "Goku", details: {} }] }], extra: { Valorant: { fields: [{ name: "Fly?", type: "text", filter: true, card: false, group: "Questions" }], entries: [{ name: "TenZ", details: { "Fly?": "No" } }], answers: { Jett: { "Fly?": "Yes" } } } } };
  const r = (m, q) => { const p = new URLSearchParams(q); const x = p.has("n") ? m.entryPage(p) : m.listPage(p); return x.header + x.content; };
  app.set(app.merge(base, over), "t", "user", "Akimei", true, app.SHARED);
  check("working on shared topics: rename/remove on shared names", r(app, "?c=Valorant&n=Jett").includes('data-op="removeName"'));
  check("summary of a player's additions", app.summary(over) === "1 topic, 2 names, 1 question, 1 answer on shared names"); }

const files = { "main:data.json": fs.readFileSync(T + "/data.json", "utf8"), "main:users.json": fs.readFileSync(T + "/users.json", "utf8"),
  "main:users/cheezie.json": JSON.stringify({ topics: [], extra: { Valorant: { fields: [], entries: [{ name: "Cheese", details: {} }], answers: {} } } }) };
const shas = {}; let n = 0; const log = [];
for (const k of Object.keys(files)) shas[k] = "s" + (++n);
const reply = (status, body) => ({ ok: status < 300, status, json: async () => body });
async function fakeFetch(url, opts = {}) {
  const method = opts.method || "GET", auth = (opts.headers || {}).Authorization;
  if (url === "data.json" || url === "users.json") return reply(200, JSON.parse(files["main:" + url]));
  const m = url.match(/\/contents\/([^?]+)(?:\?ref=(\w+))?$/);
  if (!m) return reply(404, {});
  const path = m[1];
  if (method === "GET") {
    if (path !== "users.json" && auth !== "Bearer dummy-token-for-tests") return reply(401, {});
    const k = `${m[2]}:${path}`;
    return k in files ? reply(200, { content: Buffer.from(files[k]).toString("base64"), sha: shas[k] }) : reply(404, {});
  }
  if (auth !== "Bearer dummy-token-for-tests") return reply(401, {});
  const body = JSON.parse(opts.body), k = `${body.branch}:${path}`;
  log.push({ method, k, message: body.message });
  if (method === "DELETE") { if (body.sha !== shas[k]) return reply(409, {}); delete files[k]; return reply(200, {}); }
  if (k in files ? body.sha !== shas[k] : !!body.sha) return reply(409, {});
  files[k] = Buffer.from(body.content, "base64").toString("utf8"); shas[k] = "s" + (++n);
  return reply(200, { content: { sha: shas[k] } });
}
const html = fs.readFileSync(T + "/index.html", "utf8").replace(/<script src="app.js[^"]*"><\/script>/, "");
function open(url, storage) {
  const w = new JSDOM(html, { url, runScripts: "outside-only", pretendToBeVisual: true }).window;
  Object.assign(w, { fetch: fakeFetch, TextEncoder, TextDecoder, confirm: () => true, scrollTo: () => {} });
  Object.defineProperty(w, "crypto", { value: require("crypto").webcrypto });
  w.HTMLElement.prototype.scrollIntoView = function () {};
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  w.HTMLDialogElement.prototype.close = function () { this.open = false; };
  if (storage) for (const [k, v] of Object.entries(storage)) w.localStorage.setItem(k, v);
  w.eval(fs.readFileSync(T + "/app.js", "utf8"));
  return w;
}
const submit = (w, el) => el.dispatchEvent(new w.Event("submit", { cancelable: true, bubbles: true }));
async function login(w, name, pw) {
  const d = w.document; await until(() => d.getElementById("login-form"));
  d.getElementById("login-name").value = name; d.getElementById("login-password").value = pw; submit(w, d.getElementById("login-form"));
  await until(() => d.getElementById("account").textContent.includes(name) || d.getElementById("status").textContent.includes("Wrong"));
  return d.getElementById("account").textContent.includes(name);
}
const users = () => JSON.parse(files["main:users.json"]).users;

(async () => {
  let w = open("https://dylannc889.github.io/celebs/?c=Valorant"), d = w.document, $ = s => d.querySelector(s);
  await login(w, "Cheezie", "Cheezie-test-pw");
  check("player: account menu top right, no admin console", $("#account summary").textContent === "Cheezie" && !$('#account a[href="?admin"]') && !!$("#account #password") && !!$("#account #signout"));
  check("footer no longer has account links", !$("#foot #signout") && !$("#foot #password"));
  w.history.pushState(null, "", "?admin"); w.dispatchEvent(new w.PopStateEvent("popstate")); await tick();
  check("non-admin can't open the console", d.body.textContent.includes("Only admins can open this"));
  $("#account #signout").click(); await tick();

  check("Akimei logs in", await login(w, "Akimei", "Akimei-test-pw"));
  check("admin: menu shows admin + Admin console", $("#account summary").textContent === "Akimei · admin" && !!$('#account a[href="?admin"]'));
  $("#account details").open = true; $('#account a[href="?admin"]').click();
  await until(() => d.querySelectorAll(".player").length === 3);
  check("console lists 3 players with what they've added", d.querySelectorAll(".player").length === 3 && d.body.textContent.includes("1 name") && d.body.textContent.includes("nothing added yet"));
  check("no admin/remove buttons for yourself", !d.querySelectorAll(".player")[0].querySelector('[data-admin="remove"]') && !!d.querySelectorAll(".player")[1].querySelector('[data-admin="remove"]'));

  $('[data-target="Cheezie"]').click();
  await until(() => !$("#working").hidden);
  w.history.pushState(null, "", "?c=Valorant"); w.dispatchEvent(new w.PopStateEvent("popstate")); await until(() => d.querySelectorAll(".card").length);
  check("working on Cheezie's: bar shows, her name is there", $("#working").textContent.includes("Cheezie's additions") && d.querySelectorAll(".card").length === 31);
  $('a.card[href*="n=Jett"]').click(); await tick();
  const f = $("#questions .addq form"); f.querySelector('[name="q"]').value = "Lactose?"; f.querySelector('button[name="pick"][value="No"]').click();
  await until(() => log.length === 1);
  check("saved into Cheezie's file, signed by Akimei", log[0].k === "main:users/cheezie.json" && log[0].message === 'Akimei for Cheezie: Answer "Lactose?" for Jett: No');
  $("#mine").click(); await until(() => $("#working").hidden);
  check("back to mine: bar gone, Cheezie's question not in Akimei's view", $("#working").hidden && !d.body.textContent.includes("Lactose"));

  w.history.pushState(null, "", "?admin"); w.dispatchEvent(new w.PopStateEvent("popstate")); await until(() => d.querySelectorAll(".player").length);
  $('[data-target="*shared*"]').click(); await until(() => !$("#working").hidden);
  check("working on shared topics: bar says so", $("#working").textContent.includes("shared topics"));
  w.history.pushState(null, "", "?c=Valorant&n=Jett"); w.dispatchEvent(new w.PopStateEvent("popstate")); await tick();
  check("shared: can rename/remove shared names", !!$('form[data-op="removeName"]'));
  const g = $("#questions .addq form"); g.querySelector('[name="q"]').value = "Shared Q?"; g.querySelector('button[name="pick"][value="Yes"]').click();
  await until(() => log.length === 2);
  check("shared question saved to data.json for everyone", log[1].k === "main:data.json" && log[1].message === 'Akimei: Answer "Shared Q?" for Jett: Yes');
  $("#mine").click(); await until(() => $("#working").hidden);

  const go = async () => { w.history.pushState(null, "", "?admin"); w.dispatchEvent(new w.PopStateEvent("popstate")); await until(() => d.querySelectorAll(".player").length); };
  const player = name => [...d.querySelectorAll(".player")].find(p => p.querySelector(".qtext").textContent.startsWith(name));
  await go();
  let pf = player("Cheezie").querySelector('[data-admin="password"]'); pf.querySelector('[name="password"]').value = "newcheese1"; submit(w, pf);
  await until(() => $("#status").textContent.includes("password is changed"));
  check("reset Cheezie's password", log.at(-1).message === "Akimei: reset Cheezie's password");
  await until(() => d.querySelectorAll(".player").length === 3);
  submit(w, player("Kyndemoo").querySelector('[data-admin="admin"]'));
  await until(() => $("#status").textContent.includes("now an admin"));
  check("make Kyndemoo an admin", users().find(u => u.name === "Kyndemoo").admin === true);
  await until(() => player("Kyndemoo") && player("Kyndemoo").querySelector(".badge"));
  submit(w, player("Kyndemoo").querySelector('[data-admin="admin"]'));
  await until(() => $("#status").textContent.includes("no longer an admin"));
  check("remove Kyndemoo's admin", !("admin" in users().find(u => u.name === "Kyndemoo")));
  await until(() => d.querySelector('[data-admin="add"]'));
  const add = $('[data-admin="add"]'); add.querySelector('[name="name"]').value = "Newbie"; add.querySelector('[name="password"]').value = "Newbie-test-pw"; submit(w, add);
  await until(() => $("#status").textContent.includes("Added Newbie"));
  check("add a player", users().some(u => u.name === "Newbie"));
  files["main:users/newbie.json"] = JSON.stringify({ topics: [], extra: {} }); shas["main:users/newbie.json"] = "nb";
  await until(() => player("Newbie"));
  submit(w, player("Newbie").querySelector('[data-admin="remove"]'));
  await until(() => $("#status").textContent.includes("Removed Newbie"));
  check("remove a player and their additions", !users().some(u => u.name === "Newbie") && !("main:users/newbie.json" in files) && log.some(l => l.method === "DELETE"));
  check("Akimei still admin after all that", users().find(u => u.name === "Akimei").admin === true);

  $("#account #password").click(); $("#new-password").value = $("#new-password-again").value = "akimei-new"; submit(w, $("#password-form"));
  await until(() => $("#status").textContent.includes("Password changed"));
  check("own password change keeps admin", users().find(u => u.name === "Akimei").admin === true);
  $("#account #signout").click(); await tick();
  check("log out from the menu: login screen, menu gone", !!$("#login-form") && $("#account").innerHTML === "");
  check("Cheezie logs in with the reset password", await login(w, "Cheezie", "newcheese1"));
  check("Cheezie sees the question Akimei added for her", (w.history.pushState(null, "", "?c=Valorant&n=Jett"), w.dispatchEvent(new w.PopStateEvent("popstate")), d.body.textContent.includes("Lactose?")));
})();
