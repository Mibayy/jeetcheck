// REACHABLE peak: the token's highest point since entry, never before.
//
// WHY. We used to rely on GMGN's `ath_price`, which is the highest point of
// the token's entire lifetime. On CATE (in a test wallet) that peak dated from
// 08/21 at 10pm while the buy happened on 08/23 at 5pm: a price the holder
// could never have sold at, which inflated their loss 22x. A peak that
// precedes the buy isn't a regret, it's a train that already left.
//
// WHAT THE MEASUREMENT SHOWED, before a single line of the fix was written.
// Across the wallet's eight biggest positions, SEVEN had a peak after entry
// and an `ath_price` matching the candle maximum. So the fix doesn't redo the
// calculation, it removes what wasn't reachable.
//
// WHY GECKOTERMINAL AND NOT GMGN. Going through GMGN's candles doubled its
// call count and kept triggering its IP ban. GeckoTerminal has an independent
// quota, needs no key, and serves as a second witness: on YOMOGI it gives
// 0.002487549 where GMGN gives 0.0024892626, a 0.1% gap.
//
// THE `token` PARAMETER IS MANDATORY. By default GeckoTerminal quotes the
// pool's BASE token. STONKS's most liquid pool was "NVDAx / STONKS", where
// STONKS is the quote: we were fetching the price of tokenized Nvidia stock,
// $211, for a token worth $0.00036, a fake loss of 1,413,980 SOL.
//
// CIRCUIT BREAKER (2026-08-25). Without it, a GeckoTerminal refusal made the
// page spin in place: 30 tokens x 20 s pause per retry, i.e. more than ten
// minutes before returning control. Insisting is pointless since the quota is
// per IP and every attempt during the window extends it. After two
// consecutive refusals we cut off for everyone for 90 s, and the affected
// positions fall back to the global ATH WHILE BEING FLAGGED as unverified.
// Returning an approximate number while saying so beats returning nothing at
// all.
//
// MEASUREMENT TRAP paid along the way: at 1-minute resolution GMGN only
// returns the last 100 candles. Comparing a peak to that maximum "refutes"
// almost anything. A window that's too short isn't a refutation.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FICHIER_MEMO = join(__dirname, "..", ".cache", "peaks.json");

const GT = "https://api.geckoterminal.com/api/v2/networks/solana";
const LIMITE_BOUGIES = 1000;
const MEMO_TTL_MS = 6 * 60 * 60 * 1000;

// Free quota advertised at 30 calls per minute. We target 2.5 s between two
// starts, i.e. 24/min, and concurrency is capped at 1 on the caller side so
// this pace is actually respected.
const ESPACEMENT_MS = 2500;
const COUPURE_MS = 90 * 1000;
const REFUS_AVANT_COUPURE = 2;

let dernierDepart = 0;
let refusConsecutifs = 0;
let coupeJusqua = 0;

const memo = new Map(); // mint -> { value, expire }
let memoCharge = false;

async function pause(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function chargerMemo() {
  if (memoCharge) return;
  memoCharge = true;
  try {
    const brut = JSON.parse(await readFile(FICHIER_MEMO, "utf-8"));
    const now = Date.now();
    for (const [mint, e] of Object.entries(brut)) {
      if (e && e.expire > now) memo.set(mint, e);
    }
    console.log(`[peak] ${memo.size} peaks restored from disk`);
  } catch {
    /* first startup, nothing to restore */
  }
}

let ecritureEnCours = null;
async function sauverMemo() {
  if (ecritureEnCours) return ecritureEnCours;
  ecritureEnCours = (async () => {
    try {
      await mkdir(dirname(FICHIER_MEMO), { recursive: true });
      await writeFile(FICHIER_MEMO, JSON.stringify(Object.fromEntries(memo)), "utf-8");
    } catch (e) {
      console.error(`[peak] could not save memo: ${e.message}`);
    } finally {
      ecritureEnCours = null;
    }
  })();
  return ecritureEnCours;
}

async function cadencer() {
  const attendre = dernierDepart + ESPACEMENT_MS - Date.now();
  if (attendre > 0) await pause(attendre);
  dernierDepart = Date.now();
}

async function gt(chemin) {
  if (Date.now() < coupeJusqua) {
    throw new Error("geckoterminal: cut off after repeated refusals");
  }
  await cadencer();
  const res = await fetch(GT + chemin, {
    headers: { Accept: "application/json", "User-Agent": "paperhand/1.0" },
    signal: AbortSignal.timeout(15000),
  });
  if (res.status === 429) {
    refusConsecutifs += 1;
    if (refusConsecutifs >= REFUS_AVANT_COUPURE) {
      coupeJusqua = Date.now() + COUPURE_MS;
      console.error(
        `[peak] ${refusConsecutifs} refusals in a row, cutting off for ${COUPURE_MS / 1000} s`
      );
    }
    throw new Error("geckoterminal: quota reached");
  }
  if (!res.ok) throw new Error(`geckoterminal: ${res.status}`);
  refusConsecutifs = 0;
  return res.json();
}

async function trouverPool(mint) {
  const d = await gt(`/tokens/${mint}/pools`);
  const pools = d?.data ?? [];
  if (!pools.length) return null;

  // At comparable liquidity, prefer a pool where OUR token is the base:
  // that's the side GeckoTerminal quotes by default.
  let best = null;
  let bestScore = -1;
  for (const p of pools) {
    const liq = Number(p?.attributes?.reserve_in_usd ?? 0);
    const baseId = p?.relationships?.base_token?.data?.id ?? "";
    const score = liq * (baseId.endsWith(mint) ? 1.5 : 1);
    if (score > bestScore) { bestScore = score; best = p?.attributes?.address ?? null; }
  }
  return best;
}

const PALIERS = [
  [60, "minute?aggregate=1"],
  [300, "minute?aggregate=5"],
  [900, "minute?aggregate=15"],
  [3600, "hour?aggregate=1"],
  [14400, "hour?aggregate=4"],
  [86400, "day?aggregate=1"],
];

export function choisirResolution(span) {
  for (const [sec, chemin] of PALIERS) {
    if (span / sec <= LIMITE_BOUGIES) return { sec, chemin, complet: true };
  }
  const [sec, chemin] = PALIERS[PALIERS.length - 1];
  return { sec, chemin, complet: false };
}

/** Is the circuit breaker open? The caller can stop trying. */
export function sourceCoupee() {
  return Date.now() < coupeJusqua;
}

/**
 * Highest point reached between `depuis` (since) and `maintenant` (now).
 *
 * `athGlobal` acts as an UPPER BOUND: the highest point since entry is by
 * definition less than or equal to the highest point of the token's entire
 * lifetime. A peak that clearly exceeds it signals we're reading the wrong
 * asset.
 *
 * Returns `null` if the data is missing. The caller then falls back to the
 * global ATH WHILE FLAGGING it: a silent fallback would return the very
 * value we distrust while implying it had been verified.
 */
export async function sommetDepuis(mint, depuis, maintenant, poolConnue, athGlobal) {
  if (!depuis || !Number.isFinite(depuis) || depuis <= 0) return null;

  await chargerMemo();
  const enMemo = memo.get(mint);
  if (enMemo && enMemo.expire > Date.now()) return enMemo.valeur;

  // No point waiting in line behind the pacing if the source is cut off.
  if (sourceCoupee()) return null;

  let valeur = null;
  try {
    const pool = poolConnue || (await trouverPool(mint));
    if (pool) {
      const span = Math.max(900, maintenant - depuis);
      const { chemin, complet } = choisirResolution(span);
      const d = await gt(
        `/pools/${pool}/ohlcv/${chemin}&limit=${LIMITE_BOUGIES}&token=${mint}`
      );
      const liste = d?.data?.attributes?.ohlcv_list ?? [];

      // Only candles that START at entry or after. A candle straddling the
      // buy contains prices from before it.
      let haut = 0;
      let quand = null;
      let retenues = 0;
      let plusAncienne = Infinity;
      for (const c of liste) {
        const t = Number(c[0]);
        if (!Number.isFinite(t)) continue;
        if (t < plusAncienne) plusAncienne = t;
        if (t < depuis) continue;
        const h = Number(c[2]);
        if (!Number.isFinite(h) || h <= 0) continue;
        retenues += 1;
        if (h > haut) { haut = h; quand = t; }
      }

      const majorantDepasse = athGlobal && athGlobal > 0 && haut > athGlobal * 1.5;
      if (majorantDepasse) {
        console.error(
          `[peak] ${mint}: peak ${haut} above upper bound ${athGlobal}, rejected`
        );
      }

      if (retenues && haut > 0 && !majorantDepasse) {
        valeur = {
          prix: haut,
          quand,
          source: "geckoterminal",
          couverture_complete: complet && plusAncienne <= depuis,
          bougies: retenues,
        };
      }
    }
  } catch (e) {
    console.error(`[peak] ${mint}: ${e.message}`);
    // A failure is NOT memoized: that would carve a data gap in stone for six
    // hours because of a passing refusal.
    return null;
  }

  if (memo.size > 5000) memo.clear();
  memo.set(mint, { valeur, expire: Date.now() + MEMO_TTL_MS });
  sauverMemo();
  return valeur;
}
