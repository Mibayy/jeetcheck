// The page, driven end to end against real API payloads captured from a live
// run. Not a screenshot: what this catches is the thing a screenshot would
// show you last, namely a script that threw halfway and left half a screen.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const ici = dirname(fileURLToPath(import.meta.url));
const PAGE = readFileSync(join(ici, "..", "public", "index.html"), "utf-8");
const charge = (nom) => JSON.parse(readFileSync(join(ici, "fixtures", nom), "utf-8"));

/**
 * Loads the real page, answers its one fetch with `reponse`, submits the form
 * and hands back the document plus anything the script threw.
 */
async function lancer(reponse, { statut = 200, token = "HDXeZq5Komdc4gcPbLgmrZFcsbupoteZkf1cPitRpump", wallets = ["W"] } = {}) {
  const incidents = [];
  const dom = new JSDOM(PAGE, {
    runScripts: "dangerously",
    url: "http://localhost:8932/",
    beforeParse(win) {
      win.fetch = async () => ({ ok: statut < 400, status: statut, json: async () => reponse });
      win.addEventListener("error", (e) => incidents.push(String(e.error ?? e.message)));
      win.navigator.clipboard = { writeText: async () => {} };
    },
  });
  const { window } = dom;
  const { document } = window;

  document.getElementById("token").value = token;
  for (let i = 1; i < wallets.length; i++) document.getElementById("add").click();
  [...document.querySelectorAll("#wallets input.w")].forEach((el, i) => { el.value = wallets[i] ?? ""; });

  document.getElementById("go").click();
  // one tick for the awaited fetch, one for the render
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));

  return { window, document, incidents, texte: (id) => document.getElementById(id).textContent };
}

test("the form starts with exactly one wallet row and room for more", async () => {
  const dom = new JSDOM(PAGE, { runScripts: "dangerously", url: "http://localhost:8932/" });
  const d = dom.window.document;
  assert.equal(d.querySelectorAll("#wallets input.w").length, 1);
  // The first row carries no remove button: removing your only wallet is not
  // an action that makes sense.
  assert.equal(d.querySelectorAll("#wallets .drop").length, 0);
  assert.equal(d.getElementById("add").disabled, false);
});

test("wallet rows can be added up to five, then the button says so", async () => {
  const dom = new JSDOM(PAGE, { runScripts: "dangerously", url: "http://localhost:8932/" });
  const d = dom.window.document;
  for (let i = 0; i < 9; i++) d.getElementById("add").click();
  assert.equal(d.querySelectorAll("#wallets input.w").length, 5);
  assert.equal(d.getElementById("add").disabled, true);
  assert.match(d.getElementById("add").textContent, /limit/i);
});

test("a wallet row can be removed again", async () => {
  const dom = new JSDOM(PAGE, { runScripts: "dangerously", url: "http://localhost:8932/" });
  const d = dom.window.document;
  d.getElementById("add").click();
  d.getElementById("add").click();
  assert.equal(d.querySelectorAll("#wallets input.w").length, 3);
  d.querySelector("#wallets .drop").click();
  assert.equal(d.querySelectorAll("#wallets input.w").length, 2);
  assert.equal(d.getElementById("add").disabled, false);
});

test("a real two-wallet payload renders the result screen with no exception", async () => {
  const r = await lancer(charge("check-roundtrip.json"), { wallets: ["W1", "W2"] });
  assert.deepEqual(r.incidents, []);
  assert.ok(r.document.getElementById("s2").classList.contains("on"), "result screen shown");
  assert.ok(!r.document.getElementById("s1").classList.contains("on"), "form screen hidden");
  assert.match(r.texte("r-badge"), /Round trip/i);
  assert.match(r.texte("r-sym"), /NANDRY/);
});

test("both numbers are filled, and neither is the placeholder", async () => {
  const r = await lancer(charge("check-roundtrip.json"), { wallets: ["W1", "W2"] });
  for (const id of ["r-left-v", "r-right-v", "r-in", "r-out", "r-net", "r-peak"]) {
    assert.notEqual(r.texte(id).trim(), "", `${id} is empty`);
    assert.notEqual(r.texte(id).trim(), "—", `${id} fell back to the placeholder`);
  }
  assert.match(r.texte("r-left-v"), /SOL/);
});

// The per-wallet split is the reason several wallets can be entered at all: it
// has to appear when there are several, and stay out of the way when there is
// only one.
test("the split shows every wallet when there are several", async () => {
  const r = await lancer(charge("check-roundtrip.json"), { wallets: ["W1", "W2"] });
  assert.notEqual(r.document.getElementById("r-split").style.display, "none");
  assert.equal(r.document.querySelectorAll("#r-rows .wrow").length, 2);
  assert.match(r.texte("r-split-k"), /2 wallets/);
});

test("the split stays hidden for a single wallet", async () => {
  const r = await lancer(charge("check-un-wallet.json"), { wallets: ["W1"] });
  assert.deepEqual(r.incidents, []);
  assert.equal(r.document.getElementById("r-split").style.display, "none");
});

// Everything the figure does not cover has to reach the screen. A caveat that
// only exists in the JSON is a caveat nobody reads.
test("the caveats from the payload reach the screen", async () => {
  const base = charge("check-un-wallet.json");
  const paye = {
    ...base,
    wallets: { ...base.wallets, sans_position: ["Wx"], en_erreur: [{ wallet: "Wy", erreur: "boom" }] },
    verdict: { ...base.verdict, ventes_sans_sommet: 3, ventes_au_dessus_des_bougies: 2 },
    sommet: { ...base.sommet, couverture_complete: false },
  };
  const r = await lancer(paye, { wallets: ["W1"] });
  const note = r.texte("r-note");
  assert.match(note, /never traded this token/);
  assert.match(note, /could not be read/);
  assert.match(note, /3 of .* sales have no price history/);
  assert.match(note, /landed above the candle high/);
  assert.match(note, /may be understated/);
});

// An unpriceable line must say so rather than show a zero. A zero regret and
// an unknown regret are opposite claims.
test("a regret that could not be priced shows no number at all", async () => {
  const base = charge("check-un-wallet.json");
  const paye = { ...base, verdict: { ...base.verdict, regret: null, regret_sol: null, multiple: null } };
  const r = await lancer(paye, { wallets: ["W1"] });
  assert.deepEqual(r.incidents, []);
  assert.match(r.texte("r-left-k"), /Not priceable/i);
  assert.equal(r.texte("r-left-v").trim(), "—");
});

test("with no current price, whether selling was right stays unanswered", async () => {
  const base = charge("check-un-wallet.json");
  const paye = { ...base, token: { ...base.token, prix_connu: false, price_now: null } };
  const r = await lancer(paye, { wallets: ["W1"] });
  assert.equal(r.texte("r-right-v").trim(), "—");
  assert.match(r.texte("r-right-why"), /cannot be answered/i);
});

test("a position with nothing sold is named, not scored", async () => {
  const base = charge("check-un-wallet.json");
  const paye = {
    ...base,
    position: { ...base.position, sold_sol: 0, sold_amount: 0, total_sells: 0, balance: 1000, sortie: null },
    verdict: { ...base.verdict, categorie: "holding" },
  };
  const r = await lancer(paye, { wallets: ["W1"] });
  assert.match(r.texte("r-badge"), /Still holding/i);
  assert.match(r.texte("r-left-k"), /Nothing sold/i);
});

test("an error from the API is shown and the form stays put", async () => {
  const r = await lancer({ error: "none of those wallets ever traded this token" }, { statut: 404, wallets: ["W1"] });
  assert.equal(r.document.getElementById("err").style.display, "block");
  assert.match(r.texte("err"), /ever traded this token/);
  assert.ok(r.document.getElementById("s1").classList.contains("on"), "still on the form");
});

test("submitting with no token asks for one instead of calling the API", async () => {
  const r = await lancer(charge("check-un-wallet.json"), { token: "", wallets: ["W1"] });
  assert.match(r.texte("err"), /token address/i);
  assert.ok(!r.document.getElementById("s2").classList.contains("on"));
});

// --- The band for what is still held --------------------------------------

test("a position still open shows what the unsold half is worth, beside the regret", async () => {
  const r = await lancer(charge("check-roundtrip.json"), { wallets: ["W1", "W2"] });
  const bande = r.document.getElementById("r-held");
  assert.notEqual(bande.style.display, "none", "the band is shown when tokens are still held");
  // The regret on screen must stay the regret on the SALES, untouched.
  assert.match(r.texte("r-left-v"), /17\.73|1663/, "the sold-side figure is unchanged");
  assert.match(r.texte("r-held-why"), /not counted/i, "and the band says it is not counted in it");
});

test("a position fully closed shows no held band", async () => {
  const r = await lancer(charge("check-un-wallet.json"), { wallets: ["W1"] });
  assert.equal(r.document.getElementById("r-held").style.display, "none");
});
