const T = process.env.T || "/tmp/t";  // the work folder tests/run.sh sets up
const fs = require("fs");
const { JSDOM } = require(T + "/node_modules/jsdom");
const { TextEncoder, TextDecoder } = require("util");
const check = (label, ok) => console.log((ok ? "PASS " : "FAIL ") + label);
const tick = (ms = 30) => new Promise(r => setTimeout(r, ms));
const until = async (f, ms = 8000) => { const t0 = Date.now(); while (!f() && Date.now() - t0 < ms) await tick(); return f(); };
const data = fs.readFileSync(T + "/data.json", "utf8");
const reply = (status, body) => ({ ok: status < 300, status, json: async () => body });
const fakeFetch = async (url, opts = {}) => {
  if (url.endsWith("/user")) return reply(200, { login: "dylanNC889" });
  if ((opts.headers || {}).Authorization !== "Bearer owner-token") return reply(401, {});
  return url.includes("data.json") ? reply(200, { content: Buffer.from(data).toString("base64"), sha: "a" }) : reply(404, {});
};
const html = fs.readFileSync(T + "/index.html", "utf8").replace(/<script src="app.js[^"]*"><\/script>/, "");
const w = new JSDOM(html, { url: "https://dylannc889.github.io/celebs/?c=Valorant", runScripts: "outside-only", pretendToBeVisual: true }).window;
Object.assign(w, { fetch: fakeFetch, TextEncoder, TextDecoder, confirm: () => true, scrollTo: () => {} });
Object.defineProperty(w, "crypto", { value: require("crypto").webcrypto });
w.HTMLElement.prototype.scrollIntoView = function () {};
w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
w.HTMLDialogElement.prototype.close = function () { this.open = false; };
w.eval(fs.readFileSync(T + "/app.js", "utf8"));
const d = w.document, $ = s => d.querySelector(s);
(async () => {
  await until(() => $("#login-form"));
  $("#signin").click(); $("#token").value = "owner-token"; $("#signin-form").dispatchEvent(new w.Event("submit", { cancelable: true }));
  await until(() => d.querySelectorAll(".card").length === 30);
  check("owner sign-in: Owner menu top right with GitHub name", $("#account summary").textContent === "Owner" && $("#account").textContent.includes("GitHub: dylanNC889"));
  check("owner can edit shared names, no working-on bar", !!$('a[href="?new"]') && $("#working").hidden);
  $("#account #signout").click(); await tick();
  check("owner sign out: login screen", !!$("#login-form"));
})();
