const T = process.env.T || "/tmp/t";  // the work folder tests/run.sh sets up
const fs = require("fs");
const { JSDOM } = require(T + "/node_modules/jsdom");
const { TextEncoder, TextDecoder } = require("util");
const check = (label, ok) => console.log((ok ? "PASS " : "FAIL ") + label);
const tick = (ms = 30) => new Promise(r => setTimeout(r, ms));
const until = async (f, ms = 10000) => { const t0 = Date.now(); while (!f() && Date.now() - t0 < ms) await tick(); return f(); };
const files = { "main:data.json": fs.readFileSync(T + "/data.json", "utf8"), "main:users.json": fs.readFileSync(T + "/users.json", "utf8"),
  "main:users/cheezie.json": JSON.stringify({ topics: [{ name: "Anime", note: "", fields: [{ name: "Has power", type: "text", filter: true, card: false }, { name: "Powers", type: "tags", filter: true, card: false }, { name: "Mood", type: "text", filter: true, card: false }],
    entries: [{ name: "Goku", details: { Mood: "Unknown" } }, { name: "Naruto", details: {} }, { name: "Luffy", details: {} }, { name: "Saitama", details: {} }] }], extra: {} }) };
const shas = {}; let n = 0, puts = 0, confirms = [], answer = true;
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
const w = new JSDOM(html, { url: "https://dylannc889.github.io/celebs/?c=Anime&ask=Has+power", runScripts: "outside-only", pretendToBeVisual: true }).window;
Object.assign(w, { fetch: fakeFetch, TextEncoder, TextDecoder, confirm: m => { confirms.push(m); return answer; }, scrollTo: () => {}, AbortController });
Object.defineProperty(w, "crypto", { value: require("crypto").webcrypto });
w.HTMLElement.prototype.scrollIntoView = function () {};
w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
w.HTMLDialogElement.prototype.close = function () { this.open = false; };
w.eval(fs.readFileSync(T + "/app.js", "utf8"));
const d = w.document, $ = s => d.querySelector(s);
const nav = async url => { w.history.pushState(null, "", url); w.dispatchEvent(new w.PopStateEvent("popstate")); await tick(); };
const own = () => JSON.parse(files["main:users/cheezie.json"]).topics[0];
const row = name => [...d.querySelectorAll(".qrow.fill")].find(r => r.dataset.name === name);
(async () => {
  await until(() => $("#login-form")); $("#login-name").value = "Cheezie"; $("#login-password").value = "Cheezie-test-pw"; $("#login-form").dispatchEvent(new w.Event("submit", { cancelable: true }));
  await until(() => $("#savebar"));
  check("every-name page has a Save bar, disabled with no changes", $("#save-fill").disabled && $("#changes").textContent === "No changes yet" && $("#n0 .missing").textContent === "Unknown");
  row("Goku").querySelector('[data-v="Yes"]').click(); row("Naruto").querySelector('[data-v="Yes"]').click();
  row("Luffy").querySelector(".other input").value = "sometimes"; row("Luffy").querySelector("[data-add]").click();
  check("taps only mark answers: 3 unsaved, highlighted, nothing sent", $("#changes").textContent === "3 unsaved changes" && !$("#save-fill").disabled && d.querySelectorAll(".qrow.changed").length === 3 && puts === 0);
  check("a typed answer becomes a button on every row", d.querySelectorAll('.chip[data-v="Sometimes"]').length === 4 && row("Luffy").querySelector('[data-v="Sometimes"]').getAttribute("aria-pressed") === "true");
  row("Naruto").querySelector('[data-v="Yes"]').click();
  check("tapping the same answer again un-marks it (back to unchanged)", $("#changes").textContent === "2 unsaved changes" && !row("Naruto").classList.contains("changed"));
  row("Naruto").querySelector('[data-v="No"]').click();
  answer = false; d.querySelector(".back").click(); await tick();
  check("leaving with unsaved changes asks; saying no stays", confirms.at(-1) === "Leave without saving 3 changes?" && w.location.search.includes("ask=Has+power"));
  $("#save-fill").click(); await until(() => $("#status").textContent.startsWith("Saved"));
  check("Save sends everything as one change", puts === 1 && $("#status").textContent === "Saved 3 names" && JSON.stringify(own().entries.map(e => e.details["Has power"] || null)) === '["Yes","No","Sometimes",null]');
  check("after saving: page reloads with nothing unsaved", $("#changes").textContent === "No changes yet" && !d.querySelector(".qrow.changed"));
  await nav("?c=Anime&ask=Powers");
  row("Goku").querySelector(".other input").value = "ki, Flight"; row("Goku").querySelector("[data-add]").click();
  row("Saitama").querySelector('[data-v="Flight"]').click(); row("Saitama").querySelector('[data-v="Ki"]').click(); row("Saitama").querySelector('[data-v="Ki"]').click();
  $("#save-fill").click(); await until(() => puts === 2 && $("#status").textContent.startsWith("Saved"));
  check("several-answers field: toggles saved as lists", JSON.stringify(own().entries.find(e => e.name === "Goku").details.Powers) === '["Ki","Flight"]' && JSON.stringify(own().entries.find(e => e.name === "Saitama").details.Powers) === '["Flight"]');
  await nav("?c=Anime");
  const chip = (field, v) => [...d.querySelectorAll(`.filter[data-field="${field}"] .chip`)].find(c => c.dataset.value === v);
  check("one-value field blank shows as Unknown", chip("Has power", "(none)").textContent.startsWith("Unknown"));
  check("several-values field blank shows as None", chip("Powers", "(none)").textContent.startsWith("None"));
  check("a real Unknown answer: blanks say Not set", chip("Mood", "Unknown").textContent.startsWith("Unknown") && chip("Mood", "(none)").textContent.startsWith("Not set"));
  await nav("?c=Valorant");
  const vchip = (field) => [...d.querySelectorAll(`.filter[data-field="${field}"] option, .filter[data-field="${field}"] .chip`)].find(c => (c.dataset.value || c.value) === "(none)");
  check("Valorant Omega fields keep None (field setting), Worked for keeps None", vchip("Omega double").textContent.startsWith("None") && vchip("Omega status").textContent.startsWith("None") && vchip("Worked for").textContent.startsWith("None"));
  await nav("?c=Valorant&ask=Role");
  check("shared field as a player: no Save bar", !$("#savebar"));
})();
