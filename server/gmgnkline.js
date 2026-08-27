// The peak, read from GMGN candles and nothing else.
//
// This replaces, for the targeted check, the two providers the whole-wallet
// scan needs: pump.fun (only covers `...pump` mints, only knows the lifetime
// high) and GeckoTerminal (a hard free-tier budget of 5 to 7 calls per window,
// which is what capped the scan at 30 verified peaks). On a single token those
// constraints buy us nothing: two GMGN calls give an exact, dated peak for any
// mint.
//
// THREE THINGS MEASURED ON 2026-08-25, each of which returned a wrong number
// before it was understood. None of them raises an error.
//
//   1. `from` and `to` are in MILLISECONDS. In seconds the API answers
//      HTTP 200, `"message":"success"`, and an EMPTY list.
//   2. `limit` caps at 1000 candles, and the truncation eats the START of the
//      window. On SCAMCOIN at 15m the series began after the peak and returned
//      a value 16x too low. Hence the coverage guard below: a series that
//      doesn't reach back to the requested date is not a smaller answer, it is
//      a wrong one.
//   3. GMGN filters on each bucket's START time. Asking `from = creation`
//      drops the bucket that contains the creation, which for a memecoin is
//      usually the launch peak: on YOMOGI that alone hid a 21x. So we always
//      ask from one full bucket earlier.
//
// Cross-checked against pump.fun, an independent source, on YOMOGI: same peak
// to within 0.87% and 3 minutes.

import { getTokenKline } from "./gmgn.js";

// GMGN hands back at most 1000 candles. We aim below that: at exactly 1000 we
// cannot tell a complete window from a truncated one.
export const SEUIL_BOUGIES = 900;

const RESOLUTIONS = [
  { res: "1m", sec: 60 },
  { res: "5m", sec: 300 },
  { res: "15m", sec: 900 },
  { res: "1h", sec: 3600 },
  { res: "4h", sec: 14400 },
  { res: "1d", sec: 86400 },
];

/**
 * The resolutions that can cover `span` seconds without being truncated,
 * finest first. Never empty: past every ceiling the daily candle is still an
 * answer, and the coverage guard is what decides whether to trust it.
 */
export function choisirResolutions(span) {
  const tenables = RESOLUTIONS.filter((c) => Math.ceil(span / c.sec) <= SEUIL_BOUGIES);
  return tenables.length ? tenables : [RESOLUTIONS[RESOLUTIONS.length - 1]];
}

/**
 * Highest high of a series, with its date.
 * @param {number} [depuis] - ignore what happened before this date.
 * @param {number} [seau] - bucket width; a bucket straddling `depuis` is kept,
 *   because it contains prices reached after it. The caller refines it.
 */
export function sommetDeSerie(serie, depuis = null, seau = 0) {
  const retenues = depuis === null
    ? serie
    : serie.filter((c) => c.t + seau > depuis);
  if (!retenues.length) return null;
  const max = retenues.reduce((a, b) => (b.high > a.high ? b : a));
  return { prix: max.high, quand: max.t };
}

/**
 * THE guard. A series that starts after the date we asked for does not cover
 * it, and its peak is not the peak. See note 2 above.
 */
export function serieCouvre(serie, depuis) {
  if (!serie.length) return false;
  return Math.min(...serie.map((c) => c.t)) <= depuis;
}

/**
 * THE OTHER guard. `serieCouvre` only reads min(t), so a series can start at
 * exactly the right date and still be missing most of itself.
 *
 * MEASURED 2026-08-27, comparing four candle providers. A one-minute series
 * over YOMOGI's whole life began at the creation minute, passed the coverage
 * guard, and put the peak 11x too low: the top fell inside a 17-hour hole.
 * Average density does NOT separate that case -- the sick series was at 53.6%,
 * above any threshold one would think to set. The largest hole does: 1048
 * buckets there, against 1 to 12 on every healthy series measured the same day.
 * A peak hides in a hole, not in an average.
 *
 * @returns the largest gap between two consecutive candles, counted in buckets.
 *   1 means no hole at all.
 */
export function trouMax(serie, sec) {
  if (serie.length < 2 || !sec) return 0;
  const tries = [...serie].sort((a, b) => a.t - b.t);
  let max = 0;
  for (let i = 1; i < tries.length; i++) max = Math.max(max, (tries[i].t - tries[i - 1].t) / sec);
  return max;
}

// --- The series, cached per token ------------------------------------------
//
// The costly half of a check is this series, and it depends on the TOKEN alone.
// `depuis` is derived from it per caller, which is pure arithmetic over an array
// already in hand. The check's own cache was keyed on token|wallets and lived
// three minutes, so two visitors checking the same token with different wallets
// shared nothing at all. Fine for one user, hopeless for distribution, where the
// whole point is that many people check the SAME token at the same time.
//
// Freshness is measured against the `maintenant` handed in, never the clock: it
// makes the behaviour testable without waiting, and it cannot drift with the
// machine's time.
//
// Readers never mutate: sommetDeSerie filters and maximaApres copies before
// sorting, so the cached array is safe to hand to several callers at once.
const series = new Map();

// A live token grows new candles, so its series goes stale fast. Once its last
// candle is a day old there is nothing left to add, and it can be kept far
// longer. Same two-speed reasoning as the pump.fun store, and the same accepted
// risk: a dead token that revives will be served a stale series until the
// window passes.
export const FRAICHEUR_SERIE_S = 10 * 60;
export const FRAICHEUR_SERIE_MORTE_S = 24 * 60 * 60;
const AGE_MORTE_S = 24 * 60 * 60;
const MAX_SERIES = 300;

/** Empties the store. For tests, and for anything that needs a cold read. */
export function viderSeries() {
  series.clear();
  affinages.clear();
}

/**
 * The cached series for `mint`, or null. Refuses an entry that starts later
 * than the caller needs: a series that does not reach back to the requested
 * date is not a smaller answer, it is a wrong one. Same rule as serieCouvre.
 */
function serieEnCache(mint, debut, maintenant) {
  const c = series.get(mint);
  if (!c || c.debut > debut || maintenant < c.maintenant) return null;
  const morte = c.maintenant - c.fin > AGE_MORTE_S;
  const limite = morte ? FRAICHEUR_SERIE_MORTE_S : FRAICHEUR_SERIE_S;
  return maintenant - c.maintenant <= limite ? c : null;
}

function garderSerie(mint, entree) {
  if (series.size > MAX_SERIES) series.clear();
  series.set(mint, entree);
}

// The refining pass costs one more call, and it is keyed on the peak it is
// dating, not on the caller. On a token that had one real top, every visitor who
// entered before it lands on the SAME `depuis`, so they all refine the same
// bucket: caching it by that bucket collapses the last candle call to zero for
// the second visitor onward.
const affinages = new Map();
const MAX_AFFINAGES = 1000;

function affinageEnCache(mint, res, quand) {
  return affinages.get(`${mint}|${res}|${quand}`) ?? null;
}

function garderAffinage(mint, res, quand, valeur) {
  if (affinages.size > MAX_AFFINAGES) affinages.clear();
  affinages.set(`${mint}|${res}|${quand}`, valeur);
}

// Calibrated on the same measurement, and deliberately far from both ends: the
// sick series was at 1048 buckets, the healthiest of the real series at 12. A
// threshold of 10 would have cried wolf on three series that gave the right
// verdict.
export const TROU_MAX_SEAUX = 50;

// How far pump.fun's lifetime ATH may sit from the candles' and still count as
// the same peak. Measured 2026-08-27 on two tokens: 0.28% and 0.87%. The repo's
// earlier cross-check on five tokens gave 0.1% to 0.9%. Three percent is clear
// of that spread and nowhere near a genuinely different peak, which on a
// memecoin launch is a multiple and not a fraction of a percent.
export const ECART_ATH_TOLERE = 0.03;

/**
 * Highest price strictly AFTER a given moment, for any moment, without a
 * single extra call.
 *
 * Built as a suffix maximum over the series, so pricing thirty sales costs
 * thirty binary searches rather than thirty requests. "Strictly after" is
 * deliberate: the bucket that contains a sale may well have peaked BEFORE it,
 * and crediting a seller with a price they could no longer get is exactly the
 * kind of flattering error this tool exists to avoid.
 */
export function maximaApres(serie) {
  const tries = [...serie].sort((a, b) => a.t - b.t);
  const n = tries.length;
  const suffixe = new Array(n);
  let courant = -Infinity;
  for (let i = n - 1; i >= 0; i--) {
    courant = Math.max(courant, tries[i].high);
    suffixe[i] = courant;
  }

  return function maxApres(t) {
    if (!n) return null;
    // first index whose bucket starts strictly after t
    let lo = 0;
    let hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (tries[mid].t > t) hi = mid;
      else lo = mid + 1;
    }
    return lo < n ? suffixe[lo] : null;
  };
}

// GMGN dates candles in seconds on some pairs and milliseconds on others.
function normaliser(brut) {
  return (brut ?? [])
    .map((c) => {
      const t = Number(c.time ?? c.timestamp ?? 0);
      return {
        t: t > 1e12 ? Math.floor(t / 1000) : t,
        high: Number(c.high),
      };
    })
    .filter((c) => c.t > 0 && Number.isFinite(c.high) && c.high > 0)
    .sort((a, b) => a.t - b.t);
}

/**
 * Both peaks that the verdict needs, in one or two calls.
 *
 * - `vie`: the token's highest point over its whole life, which tells us
 *   whether the buyer arrived after the party.
 * - `depuis`: the highest point reachable since entry, which is the only one
 *   a regret can be priced against.
 *
 * @param {(res: string, fromMs: number, toMs: number) => Promise<any[]>} [appelKline]
 *   injected for tests; defaults to the real GMGN client.
 * @param {(mint: string) => Promise<{prix: number, quand: number}|null>} [athPump]
 *   optional second opinion on `vie`, for its DATE only. See below.
 */
export async function sommetsToken(mint, { creation, entree, maintenant }, appelKline = null, athPump = null) {
  const appel = appelKline
    ?? ((res, fromMs, toMs) => getTokenKline(mint, res, fromMs, toMs, 1000));

  const debut = creation && creation > 0 ? creation : entree;
  if (!debut || !maintenant || maintenant <= debut) return null;

  let serie = [];
  let choisie = null;
  let couverture = false;

  // The series belongs to the token, so a second visitor on the same token pays
  // nothing for it. See the store above for what "still fresh" means here.
  const enCache = serieEnCache(mint, debut, maintenant);
  if (enCache) {
    ({ serie, choisie, couverture } = enCache);
  } else {
    for (const cand of choisirResolutions(maintenant - debut)) {
      // One full bucket of margin before the start: see note 3 above.
      const brut = await appel(cand.res, (debut - cand.sec) * 1000, maintenant * 1000);
      const s = normaliser(brut);
      if (!s.length) continue;
      serie = s;
      choisie = cand;
      // Truncated from the start, or riddled with holes: two ways of omitting
      // the window, and neither is a smaller answer. Both take the same exit,
      // because a coarser candle covers the same span with fewer buckets and
      // fills what the finer one left out. Retrying finer would only truncate
      // harder.
      if (serieCouvre(s, debut) && trouMax(s, cand.sec) <= TROU_MAX_SEAUX) { couverture = true; break; }
    }
    // `normaliser` sorts ascending, so the last candle is the newest.
    if (choisie && serie.length) {
      garderSerie(mint, {
        serie, choisie, couverture, debut, maintenant, fin: serie[serie.length - 1].t,
      });
    }
  }

  if (!choisie || !serie.length) return null;

  let vie = sommetDeSerie(serie);
  let seauVie = choisie.sec;
  let vieSource = "bougies";

  // A second opinion on WHEN the token topped, and on nothing else.
  //
  // `vie` decides too_late, and candles can only date it to the bucket they
  // were read off: on a four-hour fallback that is four hours of slack on the
  // one comparison that inverts the verdict. pump.fun answers without a key and
  // carries a real timestamp. Measured 2026-08-27 on two tokens: 0.28% and
  // 0.87% off the candle price, landing 63 s and 236 s AFTER the bucket start,
  // which is the bucket being early rather than pump.fun being late. On YOMOGI
  // it agreed to the minute with what the refining pass had to spend a second
  // call to find.
  //
  // Its PRICE is never adopted. A large disagreement is a real signal, and can
  // be a launch spike on the bonding curve that the candles never covered, but
  // rewriting the number the whole tool rests on because a second source says
  // so is not a refinement, it is a source swap. So it confirms or it is
  // refused, and the refusal is reported rather than swallowed.
  if (vie && athPump) {
    try {
      const a = await athPump(mint);
      if (a && a.prix > 0 && a.quand > 0) {
        vieSource = Math.abs(a.prix / vie.prix - 1) <= ECART_ATH_TOLERE ? "pumpfun" : "desaccord";
        if (vieSource === "pumpfun") {
          vie = { prix: vie.prix, quand: a.quand };
          seauVie = 0;               // a real timestamp, no bucket to allow for
        }
      }
    } catch {
      // The candle answer stands. A second opinion that cannot be reached is
      // not a reason to have no answer.
    }
  }

  let depuis = sommetDeSerie(serie, entree ?? debut, choisie.sec);
  let precision = choisie.sec;

  // Second call, only to date the peak precisely. Its VALUE is already exact:
  // a bucket's high is the max of the highs it contains, so every resolution
  // that covers the window agrees on it (verified: 1d, 4h and 1h returned the
  // same figure to the last digit). What a coarse bucket does not give is the
  // minute, and the minute is what separates "sold before the top" from "rode
  // it down".
  if (depuis && choisie.sec > 60) {
    const fin = depuis.quand + choisie.sec;
    const fine = choisirResolutions(choisie.sec * 2)[0];
    if (fine.sec < choisie.sec) {
      try {
        // The fine SERIES is cached, not the peak read off it: that peak is
        // filtered by `entree`, which belongs to the caller, while the window
        // asked for depends only on the bucket being refined. Caching the
        // conclusion instead of the evidence would hand one visitor's entry
        // date to the next one.
        let s = affinageEnCache(mint, fine.res, depuis.quand);
        if (!s) {
          s = normaliser(await appel(fine.res, (depuis.quand - fine.sec) * 1000, fin * 1000));
          garderAffinage(mint, fine.res, depuis.quand, s);
        }
        const affine = sommetDeSerie(s, entree ?? debut, fine.sec);
        // The refined window is narrow, so it can only confirm the peak, never
        // beat it. If it comes back lower, it missed the bucket: we keep the
        // coarse figure rather than quietly shrinking the number.
        if (affine && affine.prix >= depuis.prix * 0.999) {
          depuis = { prix: Math.max(depuis.prix, affine.prix), quand: affine.quand };
          precision = fine.sec;
        }
      } catch {
        // The coarse answer stands; only its precision suffers.
      }
    }
  }

  return {
    vie,
    depuis,
    seau: precision,
    // `precision` above describes `depuis` ALONE: the second pass refines the
    // date of the reachable peak and never touches `vie`. Reporting one number
    // for both let the verdict compare a peak dated to within four hours
    // against the entry with a one-minute margin, which manufactured a
    // too_late out of a bucket boundary (measured 2026-08-27 on NANDRY: a
    // roundtrip worth $1663 read as a too_late worth $428).
    seau_vie: seauVie,
    // Where `vie`'s DATE came from: "bougies" (bucket-bound), "pumpfun" (to the
    // second), or "desaccord" (pump.fun answered a different peak and was
    // refused, which is worth seeing rather than hiding).
    vie_source: vieSource,
    trou_max: trouMax(serie, choisie.sec),
    resolution: choisie.res,
    couverture_complete: couverture,
    bougies: serie.length,
    // Handed back so the caller can price every sale against the peak that
    // followed IT, with no further request. See maximaApres.
    serie,
  };
}
