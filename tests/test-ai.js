const T = process.env.T || "/tmp/t";  // the work folder tests/run.sh sets up
const fs = require("fs");
const { JSDOM } = require(T + "/node_modules/jsdom");
const { TextEncoder, TextDecoder } = require("util");
const check = (label, ok) => console.log((ok ? "PASS " : "FAIL ") + label);
const tick = (ms = 30) => new Promise(r => setTimeout(r, ms));
const until = async (f, ms = 10000) => { const t0 = Date.now(); while (!f() && Date.now() - t0 < ms) await tick(); return f(); };
const files = { "main:data.json": fs.readFileSync(T + "/data.json", "utf8"), "main:users.json": fs.readFileSync(T + "/users.json", "utf8") };
const shas = {}; let n = 0, puts = 0;
const ai = { calls: [], plan: [] };  // plan: list of [status, names] answers to give, in order
const reply = (status, body) => ({ ok: status < 300, status, json: async () => body });
async function fakeFetch(url, opts = {}) {
  if (url.startsWith("https://generativelanguage.googleapis.com/")) {
    const body = JSON.parse(opts.body);
    ai.calls.push({ model: url.split("/models/")[1].split(":")[0], key: opts.headers["x-goog-api-key"], prompt: body.contents[0].parts[0].text, schema: body.generationConfig.responseJsonSchema });
    const [status, names] = ai.plan.shift() || [200, ["Goku", "Vegeta", "Piccolo"]];
    if (status !== 200) return reply(status, { error: { message: "nope" } });
    return reply(200, { candidates: [{ content: { parts: [{ text: "thinking…", thought: true }, { text: JSON.stringify({ names }) }] } }] });
  }
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
  Object.assign(w, { fetch: fakeFetch, TextEncoder, TextDecoder, confirm: () => true, scrollTo: () => {}, AbortController });
  Object.defineProperty(w, "crypto", { value: require("crypto").webcrypto });
  w.HTMLElement.prototype.scrollIntoView = function () {};
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  w.HTMLDialogElement.prototype.close = function () { this.open = false; };
  for (const [k, v] of Object.entries(storage || {})) w.localStorage.setItem(k, v);
  w.eval(fs.readFileSync(T + "/app.js", "utf8"));
  return w;
}
const nav = async (w, url) => { w.history.pushState(null, "", url); w.dispatchEvent(new w.PopStateEvent("popstate")); await tick(); };
const own = () => JSON.parse(files["main:users/cheezie.json"] || '{"topics":[],"extra":{}}');
(async () => {
  let w = open("https://dylannc889.github.io/celebs/?c=Valorant"), d = w.document, $ = s => d.querySelector(s);
  await until(() => $("#login-form"));
  $("#login-name").value = "Cheezie"; $("#login-password").value = "Cheezie-test-pw"; $("#login-form").dispatchEvent(new w.Event("submit", { cancelable: true }));
  await until(() => d.querySelectorAll(".card").length === 30);
  check("Valorant as a player: no Add names, no Remove names (nothing of theirs)", !$("#addbtn") && !$("#removebtn"));
  await nav(w, "?new");
  check("New topic page has the AI option (key unlocked with the players' token)", !!$('[name="ai"]') && !!$('[name="aiCount"]') && !!$('[name="aiHint"]'));
  const f = $('form[data-op="addTopic"]');
  f.querySelector('[name="name"]').value = "Dragon Ball"; f.querySelector('[name="ai"]').checked = true;
  f.querySelector('[name="aiCount"]').value = "20"; f.querySelector('[name="aiHint"]').value = "main characters only";
  ai.plan = [[503], [503], [200, ["Goku", "Vegeta", " Piccolo ", "goku", "Bulma"]]];
  f.querySelector("button.primary").click();
  await until(() => d.querySelectorAll(".card").length === 4);
  check("topic added, then the AI's names (deduplicated) as a second save", own().topics[0].name === "Dragon Ball" && own().topics[0].entries.map(e => e.name).join() === "Bulma,Goku,Piccolo,Vegeta" && puts === 2);
  check("busy first model retried once, then the backup model", ai.calls.map(c => c.model).join() === "gemini-3.5-flash-lite,gemini-3.5-flash-lite,gemini-3.8-flash");
  check("request: the key, topic, count, hint, JSON list schema", ai.calls[0].key === "fake-gemini-key" && /up to 20 well-known names for the topic "Dragon Ball"\. Only include: main characters only\./.test(ai.calls[0].prompt) && ai.calls[0].schema.properties.names.type === "array");
  check("flash tells you how to remove extras", $("#status").textContent.includes("Added 4 names from the AI. Use Remove names"));
  check("Remove names lists the player's names", !!$("#removebtn") && d.querySelectorAll("#remove-box [name=r]").length === 4);
  $("#addbtn").click(); ai.plan = [[200, ["Goku", "Frieza", "Cell"]]];
  $("#add [name=n]").value = "Krillin"; $("#ai-suggest").click();
  await until(() => $("#add [name=n]").value.includes("Cell"));
  check("Suggest with AI fills the box, skipping names already there", $("#add [name=n]").value === "Krillin\nFrieza\nCell" && /Leave out these, which are already in the list: Goku; Vegeta; Piccolo; Bulma; Krillin|Bulma; Goku; Piccolo; Vegeta; Krillin/.test(ai.calls.at(-1).prompt));
  $("#add button.primary").click(); await until(() => d.querySelectorAll(".card").length === 7);
  check("then Add saves them", own().topics[0].entries.length === 7);
  $("#removebtn").click();
  for (const c of d.querySelectorAll("#remove-box [name=r]")) if (["Cell", "Frieza"].includes(c.value)) c.checked = true;
  $("#remove-box button.danger").click(); await until(() => d.querySelectorAll(".card").length === 5);
  check("Remove names removes the ticked ones", own().topics[0].entries.map(e => e.name).join() === "Bulma,Goku,Krillin,Piccolo,Vegeta" && $("#status").textContent === "Removed 2 names");
  $("#removebtn").click(); $("#tick-all").click();
  check("Tick all ticks every name", [...d.querySelectorAll("#remove-box [name=r]")].every(c => c.checked));
  $("#tick-none").click(); $("#removeclose").click();
  await nav(w, "?new"); const g = $('form[data-op="addTopic"]');
  g.querySelector('[name="name"]').value = "Pokemon"; g.querySelector('[name="ai"]').checked = true; ai.plan = [[429], [429]];
  g.querySelector("button.primary").click();
  await until(() => $("#status").textContent.includes("allowance"));
  check("AI allowance used up: topic still added, clear message", own().topics.some(t => t.name === "Pokemon") && $("#status").textContent.includes("free AI allowance is used up"));
  await nav(w, "?c=Book+Characters");
  check("player on a shared topic: Add names yes, Remove names no (nothing of theirs)", !!$("#addbtn") && !$("#removebtn"));
  $("#account #signout").click(); await tick();
  check("logged out: login screen", !!$("#login-form"));
  // admin on the shared topics can remove any name
  $("#login-name").value = "Akimei"; $("#login-password").value = "Akimei-test-pw"; $("#login-form").dispatchEvent(new w.Event("submit", { cancelable: true }));
  await until(() => d.querySelectorAll(".card").length);
  await nav(w, "?admin"); await until(() => $('[data-target="*shared*"]')); $('[data-target="*shared*"]').click(); await until(() => !$("#working").hidden);
  await nav(w, "?c=Book+Characters");
  check("admin on shared topics: Remove names lists every name", d.querySelectorAll("#remove-box [name=r]").length === 58);
  // a login whose token can't unlock the AI key
  w = open("https://dylannc889.github.io/celebs/?new", { "ch-mode": "user", "ch-user": "Cheezie", "ch-token": "wrong-token" }); d = w.document;
  await until(() => d.querySelector("#login-form") || d.querySelector('form[data-op="addTopic"]'));
  check("no working token: no AI options shown", !d.querySelector('[name="ai"]'));
})();
