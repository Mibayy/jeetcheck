// Historical SOL price in dollars.
//
// GMGN returns ALL its amounts in USD: `history_sold_income`, `ath_price`,
// and even its candles (verified 2026-08-24 by cross-checking YOMOGI's peak,
// 0.0024892626, between `token/info` and `market kline`). So displaying in
// SOL requires converting, and an honest conversion needs the SOL price at
// the DATE of the operation, not today's.
//
// GMGN can't serve as a source: it caps out at 100 candles, i.e. roughly 100
// days at daily resolution. Binance returns 1000, i.e. nearly three years,
// with no API key.
//
// Sources cross-checked on 2026-08-24 before being chosen:
//   Binance vs Coinbase: 0.16% max gap over six shared days
//   Binance vs price derived from GMGN trades: 1.12%
// Three sources agreeing doesn't prove the true price, but it rules out any
// one of them silently drifting.

const BINANCE = "https://api.binance.com/api/v3/klines?symbol=SOLUSDT&interval=1d&limit=1000";
const COINBASE = "https://api.exchange.coinbase.com/products/SOL-USD/candles?granularity=86400";
const TTL_MS = 60 * 60 * 1000;

let cache = null; // { series: [{t, usd}], expire: number, source: string }

const JOUR = 86400;

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "paperhand/1.0" },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`${url.split("/")[2]} responded ${res.status}`);
  return res.json();
}

async function depuisBinance() {
  const raw = await fetchJson(BINANCE);
  return raw
    .map((c) => ({ t: Math.floor(Number(c[0]) / 1000), usd: Number(c[4]) }))
    .filter((c) => Number.isFinite(c.t) && Number.isFinite(c.usd) && c.usd > 0);
}

async function depuisCoinbase() {
  const raw = await fetchJson(COINBASE);
  return raw
    .map((c) => ({ t: Number(c[0]), usd: Number(c[4]) }))
    .filter((c) => Number.isFinite(c.t) && Number.isFinite(c.usd) && c.usd > 0);
}

/**
 * Daily SOL price series, sorted by ascending date.
 * Binance first, Coinbase as fallback. The fallback covers less history,
 * the caller will see it through `hors_couverture` (out-of-coverage count).
 */
export async function getSolSeries() {
  if (cache && cache.expire > Date.now()) return cache;

  let serie = null;
  let source = null;
  try {
    serie = await depuisBinance();
    source = "binance";
  } catch (e) {
    console.error(`[solprice] Binance unavailable: ${e.message}, falling back to Coinbase`);
    serie = await depuisCoinbase();
    source = "coinbase";
  }

  serie.sort((a, b) => a.t - b.t);
  if (!serie.length) throw new Error("no SOL price available");

  cache = { serie, source, expire: Date.now() + TTL_MS };
  return cache;
}

/**
 * USD -> SOL converter, date by date.
 *
 * Outside the series' coverage, we clamp to the known edge and COUNT the
 * case: clamping a figure without saying so would imply a precision we don't
 * have. The screen displays this counter.
 */
export function faireConvertisseur({ serie, source }) {
  const hors = { avant: 0, apres: 0 };
  const premier = serie[0];
  const dernierPoint = serie[serie.length - 1];

  function tauxA(unix) {
    if (!unix || !Number.isFinite(unix)) return dernierPoint.usd;
    if (unix < premier.t) { hors.avant += 1; return premier.usd; }
    if (unix >= dernierPoint.t + JOUR) { hors.apres += 1; return dernierPoint.usd; }
    let lo = 0;
    let hi = serie.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (serie[mid].t <= unix) lo = mid;
      else hi = mid - 1;
    }
    return serie[lo].usd;
  }

  function enSol(usd, unix) {
    if (usd === null || usd === undefined || !Number.isFinite(usd)) return null;
    const taux = tauxA(unix);
    if (!Number.isFinite(taux) || taux <= 0) return null;
    return Math.round((usd / taux) * 10000) / 10000;
  }

  return {
    enSol,
    tauxA,
    hors,
    source,
    tauxCourant: dernierPoint.usd,
    couvertureDebut: premier.t,
  };
}
