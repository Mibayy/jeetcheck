// The verdict, the resolution choice and the coverage guard. Pure, offline:
// every case here has to be reproducible without a provider.
import { test } from "node:test";
import assert from "node:assert/strict";

import { verdict } from "../server/positions.js";
import { choisirResolutions, sommetDeSerie, serieCouvre, sommetsToken, SEUIL_BOUGIES } from "../server/gmgnkline.js";

const H = 3600, J = 86400;

// --- Verdict --------------------------------------------------------------

// Only the four fields the verdict actually reads. Building it by hand rather
// than through the aggregator keeps this testing one thing.
const position = (over = {}) => ({ sold_amount: 1000, entree: 1000, sortie: 9000, ...over });

const SOMMETS = { vie: { prix: 10, quand: 5000 }, depuis: { prix: 10, quand: 5000 }, seau: H };
const CHIFFRAGE = { valeur_au_sommet: 100, regret: 70, multiple: 3.33 };

test("nothing sold: the position is still open, and that is the answer", () => {
  assert.equal(verdict(position({ sold_amount: 0, sortie: null }), SOMMETS).categorie, "holding");
});

test("peak after the last sale: paperhand", () => {
  assert.equal(verdict(position({ sortie: 2000 }), SOMMETS).categorie, "paperhand");
});

test("peak reached while still holding: roundtrip", () => {
  assert.equal(verdict(position({ sortie: 9000 }), SOMMETS).categorie, "roundtrip");
});

// The exit is a block time, exact. The peak is refined down to the minute. So
// the comparison is strict, and a peak landing exactly on the last sale is NOT
// a position sold too early.
test("a peak at the very second of the last sale is not sold too early", () => {
  const s = { vie: { prix: 10, quand: 9000 }, depuis: { prix: 10, quand: 9000 }, seau: 60 };
  assert.equal(verdict(position(), s).categorie, "roundtrip");
});

test("a peak one second past the last sale is paperhand", () => {
  const s = { vie: { prix: 10, quand: 9001 }, depuis: { prix: 10, quand: 9001 }, seau: 60 };
  assert.equal(verdict(position(), s).categorie, "paperhand");
});

// A claim is worth the candle it rests on. A verdict read off a daily candle
// and one read off a minute candle must not look alike on screen.
test("the verdict carries the precision it was decided at", () => {
  assert.equal(verdict(position(), { ...SOMMETS, seau: J }).precision_secondes, J);
});

test("the token topped before the first buy: too_late, and it outranks the rest", () => {
  const v = verdict(position({ entree: 100000, sortie: 200000 }), {
    vie: { prix: 100, quand: 100000 - 2 * J },
    depuis: { prix: 4, quand: 300000 },
    seau: J,
  });
  assert.equal(v.categorie, "too_late");
  assert.equal(v.retard_multiple, 25); // the high it missed was 25x its own best
});

// GMGN filters candles on the bucket's START time, so the peak's date carries
// one bucket of slack. Calling someone late on that margin alone would invert
// what actually happened to them.
test("a lifetime peak inside the entry bucket is not called a late entry", () => {
  const v = verdict(position({ entree: 100000, sortie: 200000 }), {
    vie: { prix: 100, quand: 100000 - 10 },
    depuis: { prix: 100, quand: 100000 - 10 },
    seau: H,
  });
  assert.notEqual(v.categorie, "too_late");
});

// The verdict names the situation; the pricing is done sale by sale elsewhere
// and passed in. Two jobs, two places.
test("the verdict carries the pricing it was handed, without redoing it", () => {
  const v = verdict(position({ sortie: 2000 }), SOMMETS, CHIFFRAGE);
  assert.equal(v.categorie, "paperhand");
  assert.equal(v.regret, 70);
  assert.equal(v.valeur_au_sommet, 100);
});

test("with no pricing at all the verdict still names the situation", () => {
  const v = verdict(position({ sortie: 2000 }), SOMMETS);
  assert.equal(v.categorie, "paperhand");
  assert.equal(v.regret, null);
});

// --- Resolution choice ----------------------------------------------------

test("resolutions are offered finest first, and only those that fit", () => {
  const r = choisirResolutions(10 * J);
  assert.ok(r.length > 0);
  for (const c of r) assert.ok(Math.ceil((10 * J) / c.sec) <= SEUIL_BOUGIES, `${c.res} exceeds the ceiling`);
  for (let i = 1; i < r.length; i++) assert.ok(r[i].sec > r[i - 1].sec, "finest first");
});

test("a three-year span leaves only the daily candle", () => {
  assert.deepEqual(choisirResolutions(3 * 365 * J).map((c) => c.res), ["1d"]);
});

test("a two-hour span allows the minute candle", () => {
  assert.equal(choisirResolutions(2 * H)[0].res, "1m");
});

// Even past every ceiling we must return something rather than nothing: a
// daily candle over ten years is still a usable answer, and the coverage guard
// is what decides whether to trust it.
test("a span beyond every ceiling still returns the coarsest candle", () => {
  assert.deepEqual(choisirResolutions(50 * 365 * J).map((c) => c.res), ["1d"]);
});

// --- Peak in a series, and the coverage guard -----------------------------

const serie = [
  { t: 1000, high: 5 },
  { t: 2000, high: 42 },
  { t: 3000, high: 7 },
];

test("the peak of a series is its highest high, with its date", () => {
  assert.deepEqual(sommetDeSerie(serie), { prix: 42, quand: 2000 });
});

test("the peak since a date ignores what came before it", () => {
  assert.deepEqual(sommetDeSerie(serie, 2500), { prix: 7, quand: 3000 });
});

// A bucket starting before the entry still contains prices reached after it.
// Dropping it understates; the caller refines it afterwards.
test("the bucket straddling the entry is kept", () => {
  assert.deepEqual(sommetDeSerie(serie, 2500, 1000), { prix: 42, quand: 2000 });
});

test("a peak asked for after the last candle has no answer", () => {
  assert.equal(sommetDeSerie(serie, 9999), null);
});

test("an empty series has no peak", () => {
  assert.equal(sommetDeSerie([]), null);
});

// THE guard. GMGN caps at 1000 candles and truncates from the START, silently,
// inside an HTTP 200. Measured on SCAMCOIN: at 15m the series began after the
// peak and returned a value 16x too low, with no error of any kind.
test("a series starting after the requested date does not cover it", () => {
  assert.equal(serieCouvre(serie, 500), false);
});

test("a series starting on the requested date covers it", () => {
  assert.equal(serieCouvre(serie, 1000), true);
});

test("a series reaching back past the date covers it", () => {
  assert.equal(serieCouvre(serie, 1500), true);
});

test("an empty series covers nothing", () => {
  assert.equal(serieCouvre([], 0), false);
});

// --- A peak dated on a coarse candle, judged with a fine margin -------------
//
// Measured on 2026-08-27 while comparing candle providers. When the coverage
// guard falls back to a four-hour candle, `vie` is dated to within four hours,
// but the second pass refines `precision` down to the minute — and that second
// pass only ever refines `depuis`. Comparing a four-hour date against the entry
// with a one-minute margin manufactures a late entry out of a bucket boundary:
// on NANDRY it turned a roundtrip worth $1663 into a too_late worth $428, and
// it is reachable on GMGN alone, since the fallback exists because GMGN
// truncates.

test("a coarsely dated lifetime peak is judged by its own bucket, not the refined one", () => {
  const v = verdict(position({ entree: 100000, sortie: 200000 }), {
    vie: { prix: 100, quand: 100000 - 996 },  // same four-hour bucket as the entry
    depuis: { prix: 100, quand: 150000 },
    seau: 60,                                 // refined: describes `depuis`
    seau_vie: 4 * H,                          // the candle `vie` was read off
  });
  assert.equal(v.categorie, "roundtrip");
});

test("a lifetime peak a full coarse bucket before the entry is still too_late", () => {
  const v = verdict(position({ entree: 100000, sortie: 200000 }), {
    vie: { prix: 100, quand: 100000 - 5 * H },
    depuis: { prix: 4, quand: 150000 },
    seau: 60,
    seau_vie: 4 * H,
  });
  assert.equal(v.categorie, "too_late");
});

// Without a coarse bucket to go on, the refined one is all there is. Keeps the
// guard from changing the answer on series that were never coarse.
test("with no coarse bucket reported, the verdict falls back to the refined one", () => {
  const v = verdict(position({ entree: 100000, sortie: 200000 }), {
    vie: { prix: 100, quand: 100000 - 996 },
    depuis: { prix: 4, quand: 150000 },
    seau: 60,
  });
  assert.equal(v.categorie, "too_late");
});

// --- The hole, which is what the coverage guard cannot see -----------------
//
// `serieCouvre` only reads min(t). A provider can start its series at the right
// date and still omit most of it: measured on Mobula, a one-minute series over
// YOMOGI's whole life started at the creation minute, passed the guard, and put
// the peak 11x too low because the top fell in a 17-hour hole. Global density
// does not separate the two cases — that series was at 53.6%, above any
// sensible threshold. The largest hole does: 1048 buckets against 12 on the
// healthy series measured the same day.

const bougies = (debut, fin, pas) => {
  const l = [];
  for (let t = debut; t <= fin; t += pas) l.push({ time: t, high: 1 + (t % 7) });
  return l;
};

test("a series that starts on time but is full of holes is refused for a coarser one", async () => {
  const creation = 1000000, maintenant = creation + J;
  const appels = [];
  const faux = async (res, fromMs) => {
    appels.push(res);
    const debut = Math.floor(fromMs / 1000);
    // 5m arrives on time but with one candle every 500 minutes: 100 buckets of
    // hole, far past anything a real series shows.
    if (res === "5m") return bougies(debut, maintenant, 500 * 60);
    return bougies(debut, maintenant, 900);
  };
  const s = await sommetsToken("MINT", { creation, entree: creation + 60, maintenant }, faux);
  assert.equal(s.resolution, "15m");
  assert.ok(appels.includes("5m"), "the finest resolution is still tried first");
});

test("a dense series at the finest resolution is kept", async () => {
  const creation = 1000000, maintenant = creation + J;
  const faux = async (res, fromMs) => bougies(Math.floor(fromMs / 1000), maintenant, res === "5m" ? 300 : 900);
  const s = await sommetsToken("MINT", { creation, entree: creation + 60, maintenant }, faux);
  assert.equal(s.resolution, "5m");
});

test("the bucket the lifetime peak was read off is reported", async () => {
  const creation = 1000000, maintenant = creation + J;
  const faux = async (res, fromMs) => bougies(Math.floor(fromMs / 1000), maintenant, res === "5m" ? 300 : 900);
  const s = await sommetsToken("MINT", { creation, entree: creation + 60, maintenant }, faux);
  assert.equal(s.seau_vie, 300);
});

// --- pump.fun, to date the lifetime peak to the second ---------------------
//
// `vie` is what decides too_late, and candles can only date it to the bucket
// they were read off, which is what produced a false too_late on 2026-08-27.
// pump.fun answers `/coins/{mint}` without a key and gives the lifetime ATH
// with a real timestamp. Measured the same day on two tokens: 0.28% and 0.87%
// off GMGN on the price, and landing 63 s and 236 s AFTER GMGN's bucket start,
// which is the bucket start being early rather than pump.fun being late.
//
// So it is used for its DATE and never for its price. Swapping the price would
// change the number the whole tool rests on, on the word of a second source.

const pipeline = (res) => async (r, fromMs) => bougies(Math.floor(fromMs / 1000), res.fin, r === "5m" ? 300 : 900);

test("pump.fun confirming the peak hands over its date, not its price", async () => {
  const creation = 1000000, maintenant = creation + J;
  const faux = pipeline({ fin: maintenant });
  const nu = await sommetsToken("MINT", { creation, entree: creation + 60, maintenant }, faux);
  const ath = { prix: nu.vie.prix * 1.008, quand: nu.vie.quand + 173 };
  const s = await sommetsToken("MINT", { creation, entree: creation + 60, maintenant }, faux, async () => ath);
  assert.equal(s.vie.prix, nu.vie.prix, "the candle price stands");
  assert.equal(s.vie.quand, ath.quand, "the date comes from pump.fun");
  assert.equal(s.seau_vie, 0, "and it is no longer bound by a bucket");
  assert.equal(s.vie_source, "pumpfun");
});

// A large disagreement is a real signal, not noise: it can be a launch spike the
// candles never covered. But adopting it silently would rewrite the tool's
// central number on a second source's word, so it is refused and reported.
test("pump.fun disagreeing on the price changes nothing, and says so", async () => {
  const creation = 1000000, maintenant = creation + J;
  const faux = pipeline({ fin: maintenant });
  const nu = await sommetsToken("MINT", { creation, entree: creation + 60, maintenant }, faux);
  const s = await sommetsToken("MINT", { creation, entree: creation + 60, maintenant }, faux,
    async () => ({ prix: nu.vie.prix * 21, quand: creation + 30 }));
  assert.equal(s.vie.quand, nu.vie.quand, "the candle date stands");
  assert.equal(s.seau_vie, nu.seau_vie);
  assert.equal(s.vie_source, "desaccord");
});

test("no pump.fun answer leaves the candle peak exactly as it was", async () => {
  const creation = 1000000, maintenant = creation + J;
  const faux = pipeline({ fin: maintenant });
  const nu = await sommetsToken("MINT", { creation, entree: creation + 60, maintenant }, faux);
  for (const source of [async () => null, async () => { throw new Error("429"); }]) {
    const s = await sommetsToken("MINT", { creation, entree: creation + 60, maintenant }, faux, source);
    assert.equal(s.vie.quand, nu.vie.quand);
    assert.equal(s.seau_vie, nu.seau_vie);
    assert.equal(s.vie_source, "bougies");
  }
});

test("a token that is not on pump.fun keeps the candle answer untouched", async () => {
  const creation = 1000000, maintenant = creation + J;
  const faux = pipeline({ fin: maintenant });
  const s = await sommetsToken("MINT", { creation, entree: creation + 60, maintenant }, faux);
  assert.equal(s.vie_source, "bougies");
  assert.equal(s.seau_vie, 300);
});
