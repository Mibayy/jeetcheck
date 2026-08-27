// Historical peak of a pump.fun token, with its DATE.
//
// WHY THIS SOURCE. GeckoTerminal accepts 5 to 7 calls per window regardless
// of spacing (measured 2026-08-25 at 2.5 s, 4 s, and 6 s: same result). This
// isn't a per-minute limit you can work around by slowing down, it's a hard
// budget, and thirty are needed per wallet.
//
// pump.fun exposes `/coins/{mint}` without a key, and the `ath_market_cap`
// field with its `ath_market_cap_timestamp`. A single call therefore gives
// both the peak AND its date, which is what's needed to decide between
// paperhand and roundtrip. Measured 2026-08-25: 60 calls 50 ms apart, no
// refusals, i.e. about twenty per second.
//
// PRECISION, cross-checked on five tokens against GMGN: 0.1% to 0.9% gap.
// GeckoTerminal gave 0.1% on the same YOMOGI. Three independent sources agree
// within a percent, which doesn't establish the true price but rules out a
// single one silently drifting.
//
// KNOWN LIMITATION. This is the highest point of the token's ENTIRE lifetime,
// not the highest since entry. The date lets us tell whether it was
// reachable: if it precedes the buy, this value is unusable and the caller
// must fall back to candles. On the test wallet, only one token out of eight
// was in that case.

const BASE = "https://frontend-api-v3.pump.fun/coins/";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130 Safari/537.36";
// Pacing, and why it isn't what the first measurement suggested.
//
// Over 40 calls, pump.fun absorbs 70 req/s without a single refusal. I
// concluded we could go with that, and I was wrong: on a wallet with 1982
// positions, i.e. ~1500 calls at 125 req/s, it returned 1014 refusals, and
// the wallet analyzed right after got nothing at all. A 40-call probe doesn't
// measure a quota that kicks in at the scale of a thousand. Same trap as
// GMGN's 100 candles: the measurement window didn't cover what I believed it
// did.
//
// 25 ms with a concurrency of 6 gives a ceiling of about 40 req/s, sustained
// over time. A thousand tokens in twenty-five seconds.
// 150 ms, not 25. Measured 2026-08-25: at 25 ms with six in parallel, i.e.
// ~40 req/s, pump.fun refused all 250 calls outright. The background task, at
// 400 ms sequential, banked 92 peaks over the same period. Their quota
// tolerates a low, sustained throughput, not bursts, and a 40-call probe
// didn't show that. Since the store is permanent, being slow costs nothing:
// what's already acquired will never be requested again.
const ESPACEMENT_MS = 150;
const COUPURE_MS = 30 * 1000;
const REFUS_AVANT_COUPURE = 5;
let refusConsecutifs = 0;
let coupeJusqua = 0;
// A dead memecoin has a DEFINITIVE peak: no more liquidity, no more trades,
// the peak will never move. Keeping it for six hours meant requesting it
// again endlessly. So we keep it forever once it's more than a day old, and
// only six hours for still-living tokens, whose peak can still climb.
//
// This is what makes a full analysis reachable: tokens overlap across
// wallets, the store converges, and an already-known peak costs nothing more.
// Thirty bytes per token.
const TTL_VIVANT_MS = 6 * 60 * 60 * 1000;
const TTL_FIGE_MS = 365 * 24 * 60 * 60 * 1000;
const AGE_FIGE_MS = 24 * 60 * 60 * 1000;

let dernierDepart = 0;
const memo = new Map(); // mint -> { value, expire }
let memoCharge = false;
let sauvegardePrevue = null;

async function pause(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function cadencer() {
  const attendre = dernierDepart + ESPACEMENT_MS - Date.now();
  if (attendre > 0) await pause(attendre);
  dernierDepart = Date.now();
}

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const FICHIER = join(dirname(fileURLToPath(import.meta.url)), "..", ".cache", "ath-pumpfun.json");

export async function chargerMagasin() {
  if (memoCharge) return;
  memoCharge = true;
  try {
    const brut = JSON.parse(await readFile(FICHIER, "utf-8"));
    const now = Date.now();
    for (const [mint, e] of Object.entries(brut)) {
      if (e && e.expire > now) memo.set(mint, e);
    }
    console.log(`[pumpfun] ${memo.size} peaks restored from the store`);
  } catch {
    /* first startup */
  }
}

// Batched writes: a wallet with two thousand positions must not produce two
// thousand disk writes.
function planifierSauvegarde() {
  if (sauvegardePrevue) return;
  sauvegardePrevue = setTimeout(async () => {
    sauvegardePrevue = null;
    try {
      await mkdir(dirname(FICHIER), { recursive: true });
      await writeFile(FICHIER, JSON.stringify(Object.fromEntries(memo)), "utf-8");
    } catch (e) {
      console.error(`[pumpfun] could not save the store: ${e.message}`);
    }
  }, 4000);
  if (sauvegardePrevue.unref) sauvegardePrevue.unref();
}

/** A pump.fun mint is recognized by its suffix. Avoids a call doomed to 404. */
export function estPumpFun(mint) {
  return typeof mint === "string" && mint.endsWith("pump");
}

/**
 * Returns { prix, quand } (price, when) or null.
 *
 * `decimals` comes from GMGN when we have it: `total_supply` is in raw
 * units, and assuming 6 decimals for everyone would give a price off by a
 * factor of a thousand for a token that doesn't have six.
 */
export async function athPumpFun(mint, decimals) {
  if (!estPumpFun(mint)) return null;
  await chargerMagasin();

  const enMemo = memo.get(mint);
  if (enMemo && enMemo.expire > Date.now()) return enMemo.valeur;

  let valeur = null;
  try {
    if (Date.now() < coupeJusqua) return null;
    await cadencer();
    let res = await fetch(BASE + mint, {
      headers: { "User-Agent": UA, Accept: "application/json" },
      signal: AbortSignal.timeout(12000),
    });

    // A single retry after a real pause. Insisting immediately only keeps
    // the refusal going, and giving up on the first try loses data that a
    // one-second delay is often enough to get.
    if (res.status === 429) {
      refusConsecutifs += 1;
      if (refusConsecutifs >= REFUS_AVANT_COUPURE) {
        coupeJusqua = Date.now() + COUPURE_MS;
        console.error(`[pumpfun] ${refusConsecutifs} refusals in a row, cutting off for ${COUPURE_MS / 1000} s`);
        return null;
      }
      await pause(1500);
      res = await fetch(BASE + mint, {
        headers: { "User-Agent": UA, Accept: "application/json" },
        signal: AbortSignal.timeout(12000),
      });
    }
    if (res.ok) {
      refusConsecutifs = 0;
      const d = await res.json();
      const dec = Number.isFinite(decimals) && decimals >= 0 ? decimals : 6;
      const offre = Number(d?.total_supply ?? 0) / Math.pow(10, dec);
      const capAth = Number(d?.ath_market_cap ?? 0);
      const quand = Math.floor(Number(d?.ath_market_cap_timestamp ?? 0) / 1000);
      if (offre > 0 && capAth > 0 && Number.isFinite(quand) && quand > 0) {
        // L'image vient du MEME appel, donc elle est gratuite, et elle compte :
        // GMGN sert ses logos depuis `gmgn.ai/external-res`, que ni ce serveur
        // ni un navigateur ne joignent. La requete ne repond ni n'echoue, elle
        // PEND, donc aucun `onerror` ne part jamais et la carte garde un carre
        // vide indefiniment. Une image absente doit couter zero.
        valeur = { prix: capAth / offre, quand, source: "pumpfun",
                   image: passerelleImage(String(d?.image_uri ?? "").trim()) };
      }
    } else if (res.status !== 404) {
      console.error(`[pumpfun] ${mint}: http ${res.status}`);
    }
  } catch (e) {
    console.error(`[pumpfun] ${mint}: ${e.message}`);
    return null; // a passing failure isn't carved in stone for six hours
  }

  if (memo.size > 200000) memo.clear();
  const fige = valeur && (Date.now() - valeur.quand * 1000) > AGE_FIGE_MS;
  memo.set(mint, { valeur, expire: Date.now() + (fige ? TTL_FIGE_MS : TTL_VIVANT_MS) });
  planifierSauvegarde();
  return valeur;
}

/**
 * L'image d'un token, sur une passerelle qu'un navigateur charge vraiment.
 *
 * MESURE le 27/08/2026 : 44 des 70 `image_uri` de pump.fun pointent sur
 * `ipfs.io`, qui sert pourtant le fichier en 0,14 s depuis un serveur mais que
 * le recuperateur d'images d'un client distant n'arrive pas a charger. Sur un
 * CID complet, la passerelle publique `gateway.pinata.cloud` rend 429 la ou
 * celle de pump.fun rend 200.
 *
 * Seuls les liens IPFS sont reecrits : les CDN dedies marchent deja, et les
 * faire transiter par une passerelle IPFS les casserait.
 */
export function passerelleImage(u, passerelle = "https://pump.mypinata.cloud/ipfs/") {
  if (!u) return "";
  const i = u.indexOf("/ipfs/");
  if (i < 0) return u;
  const cid = u.slice(i + 6).split(/[?#]/)[0];
  return cid ? passerelle + cid : u;
}
