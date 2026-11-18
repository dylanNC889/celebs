const T = process.env.T || "/tmp/t";  // the work folder tests/run.sh sets up
const fs = require("fs");
const { JSDOM } = require(T + "/node_modules/jsdom");
const { TextEncoder, TextDecoder } = require("util");
const check = (label, ok) => console.log((ok ? "PASS " : "FAIL ") + label);
const tick = (ms = 30) => new Promise(r => setTimeout(r, ms));
const until = async (f, ms = 10000) => { const t0 = Date.now(); while (!f() && Date.now() - t0 < ms) await tick(); return f(); };
const files = { "main:data.json": fs.readFileSync(T + "/data.json", "utf8"), "main:users.json": fs.readFileSync(T + "/users.json", "utf8"),
  "main:users/cheezie.json": JSON.stringify({ topics: [{ name: "Anime", note: "", fields: [], entries: ["Goku", "Naruto", "Luffy"].map(name => ({ name, details: {} })) }], extra: {} }) };
const shas = {}; let n = 0;
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
const w = new JSDOM(html, { url: "https://dylannc889.github.io/celebs/", runScripts: "outside-only", pretendToBeVisual: true }).window;
Object.assign(w, { fetch: fakeFetch, TextEncoder, TextDecoder, confirm: () => true, scrollTo: () => {}, AbortController });
Object.defineProperty(w, "crypto", { value: require("crypto").webcrypto });
w.HTMLElement.prototype.scrollIntoView = function () {};
w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
w.HTMLDialogElement.prototype.close = function () { this.open = false; };
w.eval(fs.readFileSync(T + "/app.js", "utf8"));
const d = w.document, $ = s => d.querySelector(s);
const nav = async url => { w.history.pushState(null, "", url); w.dispatchEvent(new w.PopStateEvent("popstate")); await tick(); };
const own = () => JSON.parse(files["main:users/cheezie.json"]);
const login = async (name, pw) => { await until(() => $("#login-form")); $("#login-name").value = name; $("#login-password").value = pw; $("#login-form").dispatchEvent(new w.Event("submit", { cancelable: true })); await until(() => $("#account").textContent.includes(name)); await tick(); };
(async () => {
  await login("Cheezie", "Cheezie-test-pw");
  const cards = [...d.querySelectorAll(".card.topic")];
  check("logs in to the home page: every topic + New topic", cards.map(c => c.querySelector(".name").textContent).join("|") === "Valorant|Book Characters|Anime|+ New topic" && cards[2].textContent.includes("3 names · yours"));
  check("Valorant's card has a picture, the others don't", !!cards[0].querySelector("img.thumb") && !cards[1].querySelector("img"));
  cards[2].click(); await tick();
  check("tapping a topic opens its list", w.location.search.startsWith("?c=Anime") && d.querySelectorAll(".card").length === 3);
  $("h1 a.home").click(); await tick();
  check("Celebrity Heads at the top goes home", !!$(".grid.topics") && !w.location.search);
  await nav("?c=Anime&fields=1");
  const add = $('form[data-op="addField"]'); add.querySelector('[name="name"]').value = "Has power"; add.querySelector("button.primary").click();
  await until(() => w.location.search.includes("ask="));
  check("adding a field goes straight to filling it in", w.location.search === "?c=Anime&ask=Has+power" && d.querySelectorAll(".qrow.fill").length === 3 && d.querySelectorAll('.qrow [data-v="Yes"]').length === 3 && $("#status").textContent.includes("Fill it in for each name"));
  await nav("?c=Anime");
  check("list before filling: the filter says nothing filled in yet, with a link", $(".filter-empty").textContent.includes("Nothing filled in yet") && $(".filter-empty a").getAttribute("href") === "?c=Anime&ask=Has+power");
  $(".filter-empty a").click(); await tick();
  $('#n0 [data-v="Yes"]').click(); $("#save-fill").click(); await until(() => $("#status").textContent.startsWith("Saved"));
  await nav("?c=Anime");
  check("after one answer: real filter with Yes 1 and Unknown 2", /data-field="Has power".*data-value="Yes"[^>]*>Yes<span class="n">1<.*Unknown<span class="n">2</s.test($(".filters").innerHTML) && !$(".filter-empty"));
  // own field on a shared topic
  await nav("?c=Valorant&fields=1");
  const add2 = $('form[data-op="addField"]'); add2.querySelector('[name="name"]').value = "Main"; add2.querySelector("button.primary").click();
  await until(() => w.location.search.includes("ask=Main"));
  check("own field on a shared topic: every shared name can be filled in", d.querySelectorAll(".qrow.fill").length === 30);
  $('#n12 [data-v="Yes"]').click(); $("#save-fill").click(); await until(() => $("#status").textContent.startsWith("Saved") && (own().extra.Valorant || {}).answers);
  check("stored as the player's own answer", JSON.stringify(own().extra.Valorant.answers) === '{"Jett":{"Main":"Yes"}}');
  await nav("?c=Valorant&ask=Role");
  check("shared field as a player: values shown, not changeable", d.querySelectorAll(".qrow").length === 30 && !$(".qrow.fill") && !$("#savebar") && $("#n12").textContent.includes("Duelist"));
  check("old topic links still work", (await nav("?c=Book+Characters"), d.querySelectorAll(".card").length === 58));
})();
