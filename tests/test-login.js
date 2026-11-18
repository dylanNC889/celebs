const T = process.env.T || "/tmp/t";  // the work folder tests/run.sh sets up
const fs = require("fs");
const { JSDOM } = require(T + "/node_modules/jsdom");
const { TextEncoder, TextDecoder } = require("util");
const check = (label, ok) => console.log((ok ? "PASS " : "FAIL ") + label);
const tick = (ms = 30) => new Promise(r => setTimeout(r, ms));
const until = async (f, ms = 8000) => { const t0 = Date.now(); while (!f() && Date.now() - t0 < ms) await tick(); return f(); };
const files = { "main:data.json": fs.readFileSync(T + "/data.json", "utf8"), "main:users.json": fs.readFileSync(T + "/users.json", "utf8") };
let fetched = [];
const reply = (status, body) => ({ ok: status < 300, status, json: async () => body });
async function fakeFetch(url, opts = {}) {
  fetched.push(url);
  const auth = (opts.headers || {}).Authorization;
  if (url === "data.json" || url === "users.json") return reply(200, JSON.parse(files["main:" + url]));
  if (url.endsWith("/user")) return reply(200, { login: "dylanNC889" });
  const m = url.match(/\/contents\/([^?]+)\?ref=(\w+)$/);
  if (!m) return reply(404, {});
  if (m[1] !== "users.json" && auth !== "Bearer dummy-token-for-tests") return reply(401, {});
  const k = `${m[2]}:${m[1]}`;
  return k in files ? reply(200, { content: Buffer.from(files[k]).toString("base64"), sha: "x" }) : reply(404, {});
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
const submit = (w, id) => w.document.getElementById(id).dispatchEvent(new w.Event("submit", { cancelable: true }));
(async () => {
  let w = open("https://dylannc889.github.io/celebs/?c=Valorant&n=Jett"), d = w.document, $ = s => d.querySelector(s);
  await until(() => $("#login-form"));
  check("logged out: only the login screen", !!$("#login-form") && !d.querySelector(".card") && !d.querySelector("nav.tabs") && !d.body.textContent.includes("Jett") && d.title === "Log in · Celebrity Heads");
  check("logged out: no data loaded", !fetched.some(u => u.includes("data.json")));
  check("logged out: Owner sign-in link still there", !!$("#signin"));
  $("#login-name").value = "AKIMEI"; $("#login-password").value = "nope"; submit(w, "login-form");
  await until(() => $("#status").textContent.includes("Wrong"));
  check("wrong password: stays on login screen", !!$("#login-form") && $("#status").textContent === "Wrong username or password.");
  $("#login-password").value = "Akimei-test-pw"; submit(w, "login-form");
  await until(() => d.body.textContent.includes("Logged in as Akimei"));
  check("logged in: opens the page that was asked for (Jett)", $("h1").textContent === "Jett" && !!$("#questions .addq"));
  $(".back").click(); await tick();
  check("topics show once logged in", d.querySelectorAll(".card").length === 30 && !!d.querySelector("nav.tabs"));
  const kept = Object.fromEntries(Object.entries(w.localStorage));
  w = open("https://dylannc889.github.io/celebs/?c=Book+Characters", kept); d = w.document; $ = s => d.querySelector(s);
  await until(() => d.querySelectorAll(".card").length);
  check("reload: stays logged in", d.querySelectorAll(".card").length === 58 && $("#account summary").textContent.startsWith("Akimei"));
  $("#signout").click(); await tick();
  check("log out: back to the login screen, nothing shown", !!$("#login-form") && !d.querySelector(".card") && !w.localStorage.getItem("ch-token"));
  $("#signin").click(); $("#token").value = "dummy-token-for-tests"; submit(w, "signin-form");
  await until(() => $("#account summary") && $("#account summary").textContent === "Owner");
  check("owner sign-in from the login screen", d.querySelectorAll(".card").length === 58 && !!d.querySelector('a[href="?new"]'));
})();
