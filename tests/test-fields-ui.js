const T = process.env.T || "/tmp/t";  // the work folder tests/run.sh sets up
const fs = require("fs");
const { JSDOM } = require(T + "/node_modules/jsdom");
const { TextEncoder, TextDecoder } = require("util");
const check = (label, ok) => console.log((ok ? "PASS " : "FAIL ") + label);
const tick = (ms = 30) => new Promise(r => setTimeout(r, ms));
const until = async (f, ms = 10000) => { const t0 = Date.now(); while (!f() && Date.now() - t0 < ms) await tick(); return f(); };
const unlocked = JSON.parse(fs.readFileSync(T + "/data.json", "utf8")); delete unlocked.topics[0].noNewNames;  // these checks add names to Valorant
const files = { "main:data.json": JSON.stringify(unlocked, null, 1) + "\n", "main:users.json": fs.readFileSync(T + "/users.json", "utf8") };
const shas = {}; let n = 0, puts = 0;
const reply = (status, body) => ({ ok: status < 300, status, json: async () => body });
async function fakeFetch(url, opts = {}) {
  const method = opts.method || "GET";
  const m = url.match(/\/contents\/([^?]+)(?:\?ref=(\w+))?$/);
  if (!m) return reply(404, {});
  if (method === "GET") { const k = `${m[2]}:${m[1]}`; return k in files ? reply(200, { content: Buffer.from(files[k]).toString("base64"), sha: shas[k] || "s0" }) : reply(404, {}); }
  const body = JSON.parse(opts.body), k = `${body.branch}:${m[1]}`;
  if ((k in files) && body.sha !== (shas[k] || "s0")) return reply(409, {});
  files[k] = Buffer.from(body.content, "base64").toString("utf8"); shas[k] = "s" + (++n); puts++;
  return reply(200, { content: { sha: shas[k] } });
}
const html = fs.readFileSync(T + "/index.html", "utf8").replace(/<script src="app.js[^"]*"><\/script>/, "");
const w = new JSDOM(html, { url: "https://dylannc889.github.io/celebs/?c=Valorant", runScripts: "outside-only", pretendToBeVisual: true }).window;
Object.assign(w, { fetch: fakeFetch, TextEncoder, TextDecoder, confirm: () => true, scrollTo: () => {} });
Object.defineProperty(w, "crypto", { value: require("crypto").webcrypto });
w.HTMLElement.prototype.scrollIntoView = function () {};
w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
w.HTMLDialogElement.prototype.close = function () { this.open = false; };
w.eval(fs.readFileSync(T + "/app.js", "utf8"));
const d = w.document, $ = s => d.querySelector(s);
const mineFile = () => JSON.parse(files["main:users/cheezie.json"] || '{"topics":[],"extra":{}}');
const waitPut = async k => { const p = puts; await until(() => puts > p); await tick(60); };
(async () => {
  await until(() => $("#login-form"));
  $("#login-name").value = "Cheezie"; $("#login-password").value = "Cheezie-test-pw"; $("#login-form").dispatchEvent(new w.Event("submit", { cancelable: true }));
  await until(() => d.querySelectorAll(".card").length === 30);
  check("list has Add names + Fields & filters", $("#addbtn").textContent === "Add names" && !!$('a.btn[href="?c=Valorant&fields=1"]'));
  $("#addbtn").click(); $('#add [name="n"]').value = "TenZ\nShroud\nJett"; $("#add button.primary").click();
  await waitPut(); await until(() => d.querySelectorAll(".card").length === 32);
  check("bulk add from the dialog: 2 added, flash says so", d.querySelectorAll(".card").length === 32 && $("#status").textContent === "Added 2 names (1 already there)");
  $('a.btn[href="?c=Valorant&fields=1"]').click(); await tick();
  check("Fields & filters page opens", $("h1").textContent === "Fields & filters" && d.querySelectorAll(".frow").length === 18);
  const add = $('form[data-op="addField"]');
  add.querySelector('[name="name"]').value = "Team"; add.querySelector('[name="type"]').value = "text"; add.querySelector('[name="card"]').checked = true;
  add.querySelector("button.primary").click(); await waitPut();
  await until(() => w.location.search.includes("ask=Team"));
  check("field added (filter on by default), opens its fill-in page", mineFile().extra.Valorant.fields[0].name === "Team" && mineFile().extra.Valorant.fields[0].filter === true && d.querySelectorAll(".qrow.fill").length === 32);
  w.history.pushState(null, "", "?c=Valorant&n=TenZ"); w.dispatchEvent(new w.PopStateEvent("popstate")); await tick();
  const ed = $('form[data-op="editDetails"]');
  ed.querySelector('[name="f:Team"]').value = "Sentinels"; ed.querySelector('[name="f:Role"]').value = "Duelist"; ed.querySelector('[name="f:Abilities"]').value = "Aim\n\nMovement";
  ed.querySelector("button.primary").click(); await waitPut();
  const tenz = mineFile().extra.Valorant.entries.find(e => e.name === "TenZ").details;
  check("Edit details saves own name's fields", tenz.Team === "Sentinels" && tenz.Role === "Duelist" && JSON.stringify(tenz.Abilities) === '["Aim","Movement"]');
  check("profile shows the new details", d.body.textContent.includes("Sentinels") && d.body.textContent.includes("Movement"));
  const q = $("#questions .addq form");
  q.querySelector('[name="q"]').value = "Maps"; q.querySelector('[name="a"]').value = "Ascent, bind"; q.querySelector('[name="multi"]').checked = true;
  q.querySelector("button.primary").click(); await waitPut();
  check("several-answer question from the form", JSON.stringify(mineFile().extra.Valorant.entries.find(e => e.name === "TenZ").details.Maps) === '["Ascent","Bind"]');
  $('#questions .qrow button[name="pick"][value="Bind"]').click(); await waitPut();
  check("tapping an answer toggles it off", JSON.stringify(mineFile().extra.Valorant.entries.find(e => e.name === "TenZ").details.Maps) === '["Ascent"]' && !$('#questions button[value="Bind"][aria-pressed="true"]'));
  $(".back").click(); await tick();
  check("list filters: Team and Maps (has all)", !!$('.filter[data-field="Team"]') && !!$('.filter[data-field="Maps"][data-mode="all"]'));
  check("Team shows on TenZ's card", /Sentinels/.test($('a.card[href*="n=TenZ"] .meta').textContent));
  check("nothing written to the shared data", files["main:data.json"] === JSON.stringify(unlocked, null, 1) + "\n");
})();
