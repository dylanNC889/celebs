const T = process.env.T || "/tmp/t";  // the work folder tests/run.sh sets up
const fs = require("fs");
const { JSDOM } = require(T + "/node_modules/jsdom");
const { TextEncoder, TextDecoder } = require("util");
const check = (label, ok) => console.log((ok ? "PASS " : "FAIL ") + label);
const tick = (ms = 30) => new Promise(r => setTimeout(r, ms));
const until = async (f, ms = 10000) => { const t0 = Date.now(); while (!f() && Date.now() - t0 < ms) await tick(); return f(); };
const files = { "main:data.json": fs.readFileSync(T + "/data.json", "utf8"), "main:users.json": fs.readFileSync(T + "/users.json", "utf8") };
const shas = {}; let n = 0, puts = 0;
const reply = (status, body) => ({ ok: status < 300, status, json: async () => body });
async function fakeFetch(url, opts = {}) {
  const method = opts.method || "GET", m = url.match(/\/contents\/([^?]+)(?:\?ref=(\w+))?$/);
  if (!m) return reply(404, {});
  if (method === "GET") { const k = `${m[2]}:${m[1]}`; return k in files ? reply(200, { content: Buffer.from(files[k]).toString("base64"), sha: shas[k] || "s0" }) : reply(404, {}); }
  const body = JSON.parse(opts.body), k = `${body.branch}:${m[1]}`;
  if ((k in files) && body.sha !== (shas[k] || "s0")) return reply(409, {});
  files[k] = Buffer.from(body.content, "base64").toString("utf8"); shas[k] = "s" + (++n); puts++;
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
  for (const [k, v] of Object.entries(storage || {})) w.localStorage.setItem(k, v);
  w.eval(fs.readFileSync(T + "/app.js", "utf8"));
  return w;
}
const nav = async (w, url) => { w.history.pushState(null, "", url); w.dispatchEvent(new w.PopStateEvent("popstate")); await tick(); };
const waitPut = async () => { const p = puts; await until(() => puts > p); await tick(60); };
(async () => {
  // a login saved before Akimei became an admin
  let w = open("https://dylannc889.github.io/celebs/?c=Valorant", { "ch-mode": "user", "ch-user": "Akimei", "ch-token": "dummy-token-for-tests" });
  let d = w.document, $ = s => d.querySelector(s);
  await until(() => d.querySelectorAll(".card").length);
  check("old saved login: admin menu + Admin console appear without logging in again", $("#account summary").textContent === "Akimei · admin" && !!$('#account a[href="?admin"]'));
  check("Valorant: no Add names, Fields & filters still there", !$("#addbtn") && !$("#add") && !!$('a.btn[href="?c=Valorant&fields=1"]'));
  await nav(w, "?c=Book+Characters");
  check("Book Characters: Add names still there", !!$("#addbtn"));
  await nav(w, "?c=Valorant&fields=1");
  const layout = $(".fields-layout");
  check("fields page: Add a field in the left column, fields in the right", !!layout && layout.children[0].className === "col-add" && layout.children[0].textContent.includes("Add a field") && layout.children[1].className === "col-list" && layout.children[1].textContent.includes("Fields of Valorant"));
  check("Valorant as a player: Names says fixed list (no switch)", layout.children[0].textContent.includes("fixed list of names") && !$('form[data-op="topicSettings"]'));
  // admin on the shared topics can switch it
  await nav(w, "?admin"); await until(() => d.querySelector('[data-target="*shared*"]'));
  $('[data-target="*shared*"]').click(); await until(() => !$("#working").hidden);
  await nav(w, "?c=Valorant&fields=1");
  const box = $('form[data-op="topicSettings"]');
  check("shared topics: the switch is there, off for Valorant", !!box && !box.querySelector('[name="allowNames"]').checked);
  box.querySelector('[name="allowNames"]').checked = true; box.querySelector("button.primary").click(); await waitPut();
  check("switching it on saves to the shared data", !("noNewNames" in JSON.parse(files["main:data.json"]).topics.find(t => t.name === "Valorant")));
  await nav(w, "?c=Valorant&fields=1");
  const box2 = $('form[data-op="topicSettings"]'); box2.querySelector('[name="allowNames"]').checked = false; box2.querySelector("button.primary").click(); await waitPut();
  check("and off again", JSON.parse(files["main:data.json"]).topics.find(t => t.name === "Valorant").noNewNames === true);
  $("#mine").click(); await until(() => $("#working").hidden);

  // a player's own topic
  w = open("https://dylannc889.github.io/celebs/?c=Valorant"); d = w.document; $ = s => d.querySelector(s);
  await until(() => $("#login-form"));
  $("#login-name").value = "Cheezie"; $("#login-password").value = "Cheezie-test-pw"; $("#login-form").dispatchEvent(new w.Event("submit", { cancelable: true }));
  await until(() => d.querySelectorAll(".card").length === 30);
  check("player: no Admin console, no Add names on Valorant", !$('#account a[href="?admin"]') && !$("#addbtn"));
  await nav(w, "?new"); const nt = $('form[data-op="addTopic"]'); nt.querySelector('[name="name"]').value = "Anime"; nt.querySelector("button.primary").click(); await waitPut();
  await nav(w, "?c=Anime&fields=1"); const own = $('form[data-op="topicSettings"]');
  check("own topic: the switch is there and on", !!own && own.querySelector('[name="allowNames"]').checked);
  own.querySelector('[name="allowNames"]').checked = false; own.querySelector("button.primary").click(); await waitPut();
  check("turning it off on an own topic is saved in the player's file", JSON.parse(files["main:users/cheezie.json"]).topics[0].noNewNames === true);

  // a login whose player was removed
  w = open("https://dylannc889.github.io/celebs/?c=Valorant", { "ch-mode": "user", "ch-user": "Ghost", "ch-token": "dummy-token-for-tests" }); d = w.document; $ = s => d.querySelector(s);
  await until(() => $("#login-form"));
  check("removed player: logged out with a message", !!$("#login-form") && $("#status").textContent.includes("isn't in the list"));
})();
