// Trade-level logic: merging the real buy/sell history of several wallets, and
// pricing each sale against the peak that came AFTER that sale. Pure, offline.
import { test } from "node:test";
import assert from "node:assert/strict";

import { normaliserTrades, agregerTrades, regretParVente, chiffrerDetenu } from "../server/positions.js";
import { maximaApres } from "../server/gmgnkline.js";
import { refusDeguise } from "../server/gmgn.js";

// --- Normalising what GMGN sends ------------------------------------------

const brut = (over = {}) => ({
  timestamp: 1000,
  event_type: "buy",
  token_amount: "1000",
  quote_amount: "2",
  cost_usd: "300",
  price_usd: "0.3",
  tx_hash: "sig1",
  ...over,
});

test("a raw event becomes a trade with numbers, not strings", () => {
  const [t] = normaliserTrades([brut()], "W1");
  assert.equal(t.wallet, "W1");
  assert.equal(t.sens, "buy");
  assert.equal(t.amount, 1000);
  assert.equal(t.usd, 300);
  assert.equal(t.sol, 2);
  assert.equal(t.prix, 0.3);
});

test("events come back oldest first, whatever order they arrived in", () => {
  const l = normaliserTrades([brut({ timestamp: 3000 }), brut({ timestamp: 1000 })], "W1");
  assert.deepEqual(l.map((x) => x.t), [1000, 3000]);
});

// Transfers, approvals and anything else are not trades. Counting a transfer
// as a buy would invent a purchase that never cost anything.
test("anything that is not a buy or a sell is dropped", () => {
  const l = normaliserTrades([brut({ event_type: "transfer_out" }), brut()], "W1");
  assert.equal(l.length, 1);
  assert.equal(l[0].sens, "buy");
});

test("an event with no usable price is dropped rather than counted as zero", () => {
  const l = normaliserTrades([brut({ price_usd: null, cost_usd: null }), brut()], "W1");
  assert.equal(l.length, 1);
});

// --- Aggregating across wallets -------------------------------------------

const achat = (t, w = "W1", over = {}) => ({ wallet: w, t, sens: "buy", amount: 1000, usd: 100, sol: 1, prix: 0.1, ...over });
const vente = (t, w = "W1", over = {}) => ({ wallet: w, t, sens: "sell", amount: 1000, usd: 300, sol: 3, prix: 0.3, ...over });

test("buys and sells are summed across every wallet", () => {
  const a = agregerTrades([achat(100, "W1"), vente(200, "W1"), achat(150, "W2"), vente(250, "W2")]);
  assert.equal(a.bought_amount, 2000);
  assert.equal(a.bought_cost, 200);
  assert.equal(a.sold_amount, 2000);
  assert.equal(a.sold_income, 600);
  assert.equal(a.sold_sol, 6);
  assert.equal(a.wallets, 2);
});

// This is the whole reason the check reads trades instead of positions: the
// window has to start at the first buy ANY of the wallets made, and end at the
// last sale ANY of them made.
test("the window spans the first buy and the last sale, across wallets", () => {
  const a = agregerTrades([achat(500, "W1"), vente(900, "W1"), achat(100, "W2"), vente(300, "W2")]);
  assert.equal(a.entree, 100);
  assert.equal(a.sortie, 900);
});

test("a wallet that only bought leaves the exit open", () => {
  const a = agregerTrades([achat(100, "W1")]);
  assert.equal(a.sortie, null);
  assert.equal(a.sold_amount, 0);
});

test("aggregating nothing is not a crash", () => {
  const a = agregerTrades([]);
  assert.equal(a.entree, null);
  assert.equal(a.wallets, 0);
});

test("the per-wallet split survives aggregation", () => {
  const a = agregerTrades([achat(100, "W1"), vente(200, "W2")]);
  const w2 = a.par_wallet.find((p) => p.wallet === "W2");
  assert.equal(w2.sold_income, 300);
  assert.equal(w2.bought_cost, 0);
  assert.equal(a.par_wallet.length, 2);
});

// --- Peak after a given moment --------------------------------------------

const serie = [
  { t: 100, high: 5 },
  { t: 200, high: 50 },
  { t: 300, high: 9 },
  { t: 400, high: 20 },
];

test("the peak after a moment ignores everything up to and including it", () => {
  const apres = maximaApres(serie);
  assert.equal(apres(100), 50);
  assert.equal(apres(200), 20);
  assert.equal(apres(300), 20);
});

// A candle whose bucket contains the sale may have peaked BEFORE it. Counting
// it would credit the seller with a price they could no longer get.
test("the bucket containing the moment does not count", () => {
  assert.equal(maximaApres(serie)(150), 50);
  assert.equal(maximaApres(serie)(250), 20);
});

test("after the last candle there is no peak to compare against", () => {
  assert.equal(maximaApres(serie)(400), null);
  assert.equal(maximaApres(serie)(9999), null);
});

test("an empty series answers nothing rather than zero", () => {
  assert.equal(maximaApres([])(0), null);
});

// --- The regret, sale by sale ---------------------------------------------

test("each sale is priced against the peak that followed IT", () => {
  // sold 1000 at 0.3 then 1000 at 0.5; peaks after are 1.0 and 2.0
  const ventes = [
    { t: 100, amount: 1000, usd: 300, prix: 0.3 },
    { t: 200, amount: 1000, usd: 500, prix: 0.5 },
  ];
  const r = regretParVente(ventes, (t) => (t === 100 ? 1.0 : 2.0));
  assert.equal(r.valeur_au_sommet, 1000 * 1.0 + 1000 * 2.0);
  assert.equal(r.regret, 3000 - 800);
  assert.equal(r.ventes_chiffrees, 2);
});

// The single most important property, and the reason this replaced one global
// peak: a sale made AT the top must show no regret, even when the token went
// far higher before it.
test("a sale at the top of its own future carries no regret", () => {
  const r = regretParVente([{ t: 100, amount: 1000, usd: 500, prix: 0.5 }], () => 0.5);
  assert.equal(r.regret, 0);
});

// The candles are aggregates: a sale can land above the high they report. That
// is a limit of the source, not a negative regret.
test("a sale above the candle high contributes zero and is counted", () => {
  const r = regretParVente([{ t: 100, amount: 1000, usd: 900, prix: 0.9 }], () => 0.5);
  assert.equal(r.regret, 0);
  assert.equal(r.ventes_au_dessus_des_bougies, 1);
});

test("a sale with no peak after it is left out and counted", () => {
  const r = regretParVente([{ t: 100, amount: 1000, usd: 300, prix: 0.3 }], () => null);
  assert.equal(r.regret, null);
  assert.equal(r.ventes_chiffrees, 0);
  assert.equal(r.ventes_sans_sommet, 1);
});

test("no sales at all means no regret to state", () => {
  const r = regretParVente([], () => 1);
  assert.equal(r.regret, null);
  assert.equal(r.ventes_chiffrees, 0);
});

// --- The part still held --------------------------------------------------
//
// `regretParVente` walks sales and only sales, which is right: holding is not a
// decision, so there is nothing to judge. But on an open position that leaves
// the largest number off the screen. Measured on a real position: $1686 of
// regret shown on the sold half, $2081 unshown on the half still held.

test("nothing held: there is no held figure at all, not a zero", () => {
  assert.equal(chiffrerDetenu(0, { prix: 10, quand: 5000 }, 2), null);
  assert.equal(chiffrerDetenu(null, { prix: 10, quand: 5000 }, 2), null);
});

test("held tokens are priced against the peak reachable since entry", () => {
  const d = chiffrerDetenu(1000, { prix: 10, quand: 5000 }, 2);
  assert.equal(d.jetons, 1000);
  assert.equal(d.valeur_au_sommet, 10000);
  assert.equal(d.valeur_aujourdhui, 2000);
  assert.equal(d.ecart_au_sommet, 8000);
});

// The two numbers answer different questions. Adding them would invent a sale
// that was never made, which is the one thing this tool exists not to do.
test("the held figure never lands in the regret", () => {
  const ventes = [{ t: 1000, amount: 100, usd: 100, prix: 1 }];
  const chiffrage = regretParVente(ventes, () => 5);
  const avecSolde = chiffrerDetenu(9_000_000, { prix: 5, quand: 5000 }, 1);
  assert.equal(chiffrage.regret, 400);          // 100 tokens x $5, minus the $100 taken
  assert.ok(avecSolde.ecart_au_sommet > chiffrage.regret * 100, "held gap dwarfs it, and stays separate");
});

test("no peak: the held value is still shown, the gap is not invented", () => {
  const d = chiffrerDetenu(1000, null, 2);
  assert.equal(d.valeur_aujourdhui, 2000);
  assert.equal(d.valeur_au_sommet, null);
  assert.equal(d.ecart_au_sommet, null);
});

test("no current price: the peak value stands alone rather than being zeroed", () => {
  const d = chiffrerDetenu(1000, { prix: 10, quand: 5000 }, null);
  assert.equal(d.valeur_au_sommet, 10000);
  assert.equal(d.valeur_aujourdhui, null);
  assert.equal(d.ecart_au_sommet, null);
});

// --- A refusal read as data ------------------------------------------------
//
// The most expensive mistake this repo has already paid for: a rate-limit ban
// comes back as an EMPTY array inside an HTTP 200, and read as data it says
// "this wallet never traded this token". The docstring in gmgn.js warns about
// it, but nothing detected it, so under load every visitor would have been told
// a confident lie. Only explicit wording is flagged: a guard that fires on a
// legitimate answer is worse than no guard.

test("a rate-limit refusal wearing a 200 is caught", () => {
  for (const corps of [
    { code: 429, msg: "RATE_LIMIT_BANNED", data: { activities: [] } },
    { message: "Too Many Requests", data: [] },
    { error: "rate limit exceeded" },
    { code: 0, msg: "ip banned", data: { activities: [] } },
  ]) {
    assert.ok(refusDeguise(corps), `non detecte: ${JSON.stringify(corps)}`);
  }
});

test("an honest empty answer is not mistaken for a refusal", () => {
  for (const corps of [
    { code: 0, msg: "success", data: { activities: [] } },
    { data: { activities: [] } },
    { data: [] },
    {},
    null,
    { msg: "success", data: { activities: [{ event_type: "buy" }] } },
  ]) {
    assert.equal(refusDeguise(corps), null, `faux positif: ${JSON.stringify(corps)}`);
  }
});
