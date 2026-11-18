const T = process.env.T || "/tmp/t";  // the work folder tests/run.sh sets up
const fs = require("fs");
const { JSDOM } = require(T + "/node_modules/jsdom");
const { TextEncoder, TextDecoder } = require("util");
const check = (label, ok) => console.log((ok ? "PASS " : "FAIL ") + label);
const tick = (ms = 30) => new Promise(r => setTimeout(r, ms));
const until = async (f, ms = 10000) => { const t0 = Date.now(); while (!f() && Date.now() - t0 < ms) await tick(); return f(); };
const files = { "main:data.json": fs.readFileSync(T + "/data.json", "utf8"), "main:users.json": fs.readFileSync(T + "/users.json", "utf8"),
  "main:users/cheezie.json": JSON.stringify({ topics: [{ name: "Anime", note: "", fields: [], entries: [{ name: "Goku", details: {} }, { name: "Naruto", details: {} }] }], extra: {} }) };
const shas = {}; let n = 0, confirms = [];
const reply = (status, body) => ({ ok: status < 300, status, json: async () => body });
async function fakeFetch(url, opts = {}) {
  const method = opts.method || "GET", m = url.match(/\/contents\/([^?]+)(?:\?ref=(\w+))?$/);
  if (!m) return reply(404, {});
  if (method === "GET") { const k = `${m[2]}:${m[1]}`; return k in files ? reply(200, { content: Buffer.from(files[k]).toString("base64"), sha: shas[k] || "s0" }) : reply(404, {}); }
  const body = JSON.parse(opts.body), k = `${body.branch}:${m[1]}`;
  if ((k in files) && body.sha !== (shas[k] || "s0")) return reply(409, {});
  files[k] = Buffer.from(body.content, "base64").toString("utf8"); shas[k] = "s" + (++n);
  return reply(200, { content: { sha: shas[k] } });
}
const html = fs.readFileSync(T + "/index.html", "utf8").replace(/<script src="app.js[^"]*"><\/script>/, "");
const w = new JSDOM(html, { url: "https://dylannc889.github.io/celebs/?c=Anime&fields=1", runScripts: "outside-only", pretendToBeVisual: true }).window;
Object.assign(w, { fetch: fakeFetch, TextEncoder, TextDecoder, confirm: m => { confirms.push(m); return true; }, scrollTo: () => {}, AbortController });
Object.defineProperty(w, "crypto", { value: require("crypto").webcrypto });
w.HTMLElement.prototype.scrollIntoView = function () {};
w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
w.HTMLDialogElement.prototype.close = function () { this.open = false; };
w.eval(fs.readFileSync(T + "/app.js", "utf8"));
const d = w.document, $ = s => d.querySelector(s);
const nav = async url => { w.history.pushState(null, "", url); w.dispatchEvent(new w.PopStateEvent("popstate")); await tick(); };
const login = async (name, pw) => { await until(() => $("#login-form")); $("#login-name").value = name; $("#login-password").value = pw; $("#login-form").dispatchEvent(new w.Event("submit", { cancelable: true })); await until(() => $("#account").textContent.includes(name)); };
(async () => {
  await login("Cheezie", "Cheezie-test-pw");
  await until(() => $("h1") && $("h1").textContent === "Fields & filters");
  check("own topic: Delete topic in the left column, with the name count", $(".col-add").textContent.includes("Deletes Anime and its 2 names.") && !!$('.col-add form[data-op="removeTopic"]'));
  $('.col-add form[data-op="removeTopic"] button').click();
  await until(() => !JSON.parse(files["main:users/cheezie.json"]).topics.length);
  check("asks first, then deletes the topic and its names", confirms.at(-1) === "Delete Anime and its 2 names? This can't be undone here." && !JSON.parse(files["main:users/cheezie.json"]).topics.length);
  await until(() => d.querySelectorAll(".card").length);
  check("goes back home, Anime gone", ["", "?"].includes(w.location.search) && !d.querySelector('nav.tabs a[href="?c=Anime"]') && $("#status").textContent === "Deleted Anime and its 2 names");
  await nav("?c=Book+Characters&fields=1");
  check("shared topic as a player: no Delete topic", !$('form[data-op="removeTopic"]'));
  $("#account #signout").click(); await tick();
  await login("Akimei", "Akimei-test-pw");
  await nav("?admin"); await until(() => $('[data-target="*shared*"]')); $('[data-target="*shared*"]').click(); await until(() => !$("#working").hidden);
  await nav("?c=Book+Characters&fields=1");
  check("admin on shared topics: Delete topic, says for everyone", $(".col-add").textContent.includes("Deletes Book Characters and its 58 names, for everyone."));
  $('.col-add form[data-op="removeTopic"] button').click();
  await until(() => !JSON.parse(files["main:data.json"]).topics.some(t => t.name === "Book Characters"));
  check("shared topic deleted from the shared data", JSON.parse(files["main:data.json"]).topics.map(t => t.name).join() === "Valorant" && confirms.at(-1).includes("58 names for everyone"));
})();
