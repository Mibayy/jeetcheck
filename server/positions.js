// Position arithmetic, shared by the whole-wallet scan and the targeted check.
// Everything here is pure: no network, no clock, no state. That is what makes
// it testable, and the numbers below are the ones the product actually shows.

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function isValidSolanaAddress(addr) {
  return typeof addr === "string" && BASE58_RE.test(addr);
}

export function num(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

export function round2(n) {
  if (n === null || n === undefined || !Number.isFinite(n)) return n;
  return Math.round(n * 100) / 100;
}

// The on-chain symbol is a fixed-size byte array: GMGN returns it raw, so
// "proSOL" followed by four NULs, or "INF" followed by a NUL. `.trim()`
// removes neither NULs nor zero-width characters, so these LSTs were slipping
// through the non-memecoin filter.
export function nettoyerSymbole(v) {
  return String(v ?? "")
    .replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200D\uFEFF]/g, "")
    .trim();
}

// GMGN returns 0 when it doesn't have the date, not null: an unfiltered 0
// collapsed the median holding time to 0 s and made first_trade = 1970.
export function horodatage(v) {
  const n = num(v);
  return n !== null && n > 0 ? n : null;
}

// --- What counts as a memecoin -------------------------------------------
//
// GMGN returns a flatly wrong `ath_price` for established tokens: JitoSOL at
// $108,107,571 when it's worth $125, WETH at $4,671,114, PENGU at $280 for a
// real $0.0095. Three filters, because none is sufficient alone. See the long
// note this was extracted from in analyze.js.

const NON_MEME_EXACTS = new Set([
  "SOL","WSOL","USDC","USDT","USDS","PYUSD","FDUSD","EURC","UXD","USDE",
  "RAY","JUP","JTO","ORCA","PYTH","TNSR","DRIFT","KMNO","MNDE","SRM","INF",
  "WETH","WBTC","ZBTC","CBBTC","WBNB","LST","JLP",
]);

const LST_RE = /SOL$/i;
const STABLE_RE = /USD|EUR/i;
const RATIO_ATH_INCROYABLE = 1000;

export function classer(token, athPrice, priceNow) {
  const sym = nettoyerSymbole(token?.symbol);
  const launchpad = String(token?.launchpad ?? "").trim();
  const up = sym.toUpperCase();

  // Families first, launchpad second: the other way around, INF and proSOL
  // (both LSTs) were getting through because they carry a non-empty launchpad.
  if (NON_MEME_EXACTS.has(up)) return { memecoin: false, motif: "non_memecoin" };
  if (up !== "SOL" && LST_RE.test(up) && up.length > 3) return { memecoin: false, motif: "non_memecoin" };
  if (STABLE_RE.test(up)) return { memecoin: false, motif: "non_memecoin" };

  if (launchpad !== "") return { memecoin: true, motif: null };

  if (athPrice !== null && priceNow !== null && priceNow > 0
      && athPrice / priceNow > RATIO_ATH_INCROYABLE) {
    return { memecoin: false, motif: "ath_invraisemblable" };
  }
  return { memecoin: true, motif: null };
}

// --- Reading the real trade history ---------------------------------------
//
// The targeted check reads trades, not positions. A position line carries
// lifetime totals but dates only the CURRENT holding streak, so on a wallet
// that sold and bought back, its "entry" lands after its own sales and the
// window used to find a reachable peak is simply wrong. A trade knows when it
// happened.

export function normaliserTrades(bruts, wallet) {
  return (bruts ?? [])
    .map((e) => {
      const sens = String(e?.event_type ?? "").toLowerCase();
      const t = num(e?.timestamp);
      const amount = num(e?.token_amount);
      const usd = num(e?.cost_usd);
      const sol = num(e?.quote_amount);
      let prix = num(e?.price_usd);
      if (prix === null && usd !== null && amount) prix = usd / amount;
      return { wallet, t, sens, amount, usd, sol: sol ?? 0, prix, tx: e?.tx_hash ?? "" };
    })
    // Transfers, approvals and the rest are not trades: counting a transfer in
    // as a buy would invent a purchase that never cost anything.
    .filter((e) => (e.sens === "buy" || e.sens === "sell")
      && e.t !== null && e.t > 0
      && e.amount !== null && e.amount > 0
      && e.usd !== null && e.prix !== null && e.prix > 0)
    .sort((a, b) => a.t - b.t);
}

export function agregerTrades(evenements) {
  // Sorted here and not only at the source: each wallet arrives sorted, but
  // merging several wallets interleaves them, and the first buy of the merged
  // list is not the first buy in time. That mistake shifts the whole window.
  const trades = [...evenements].sort((a, b) => a.t - b.t);
  const achats = trades.filter((e) => e.sens === "buy");
  const ventes = trades.filter((e) => e.sens === "sell");
  const somme = (l, cle) => l.reduce((t, e) => t + (e[cle] ?? 0), 0);

  const parWallet = new Map();
  for (const e of trades) {
    if (!parWallet.has(e.wallet)) {
      parWallet.set(e.wallet, {
        wallet: e.wallet,
        bought_amount: 0, bought_cost: 0, bought_sol: 0, achats: 0,
        sold_amount: 0, sold_income: 0, sold_sol: 0, ventes: 0,
        entree: null, sortie: null,
      });
    }
    const p = parWallet.get(e.wallet);
    if (e.sens === "buy") {
      p.bought_amount += e.amount; p.bought_cost += e.usd; p.bought_sol += e.sol; p.achats += 1;
      if (p.entree === null || e.t < p.entree) p.entree = e.t;
    } else {
      p.sold_amount += e.amount; p.sold_income += e.usd; p.sold_sol += e.sol; p.ventes += 1;
      if (p.sortie === null || e.t > p.sortie) p.sortie = e.t;
    }
  }

  return {
    wallets: parWallet.size,
    par_wallet: [...parWallet.values()],
    trades,
    ventes,
    bought_amount: somme(achats, "amount"),
    bought_cost: somme(achats, "usd"),
    bought_sol: somme(achats, "sol"),
    sold_amount: somme(ventes, "amount"),
    sold_income: somme(ventes, "usd"),
    sold_sol: somme(ventes, "sol"),
    total_buys: achats.length,
    total_sells: ventes.length,
    entree: achats.length ? achats[0].t : null,
    sortie: ventes.length ? ventes[ventes.length - 1].t : null,
  };
}

// --- The regret, sale by sale ---------------------------------------------
//
// Not one global peak against the whole position: each sale is priced against
// the highest point that came AFTER that particular sale. A trader who exits
// in thirty steps is not one decision, it is thirty, and a sale made at the
// top carries no regret even when the token had been far higher earlier.
//
// @param {(t: number) => number|null} maxApres - highest price strictly after t

export function regretParVente(ventes, maxApres) {
  let valeur = 0;
  let recu = 0;
  let chiffrees = 0;
  let sansSommet = 0;
  let auDessus = 0;

  for (const v of ventes) {
    const sommet = maxApres(v.t);
    if (sommet === null || !Number.isFinite(sommet) || sommet <= 0) { sansSommet += 1; continue; }
    // The candles are aggregates, so a sale can land above the high they
    // report. That is a limit of the source, not a negative regret: the sale
    // counts at its own price and the case is reported.
    if (sommet < v.prix) auDessus += 1;
    valeur += v.amount * Math.max(sommet, v.prix);
    recu += v.usd;
    chiffrees += 1;
  }

  if (!chiffrees) {
    return {
      valeur_au_sommet: null, regret: null, multiple: null, recu_chiffre: 0,
      ventes_chiffrees: 0, ventes_sans_sommet: sansSommet, ventes_au_dessus_des_bougies: auDessus,
    };
  }

  return {
    valeur_au_sommet: valeur,
    regret: valeur - recu,
    multiple: recu > 0 ? valeur / recu : null,
    recu_chiffre: recu,
    ventes_chiffrees: chiffrees,
    ventes_sans_sommet: sansSommet,
    ventes_au_dessus_des_bougies: auDessus,
  };
}

// --- The part still held ---------------------------------------------------
//
// `regretParVente` walks sales, and only sales. That is the right call: holding
// is not a decision, so there is nothing to judge and nothing to regret.
//
// But on a position still open it leaves the largest number off the screen
// entirely. Measured on a real NANDRY position on 2026-08-27: $1686 of regret
// shown on the half that was sold, and $2081 unshown on the half still held,
// which is worth more than the figure the tool was displaying.
//
// So it is computed and shown BESIDE the regret, never folded into it. The two
// answer different questions, and adding them would invent a sale that was
// never made.
//
// @param sommetDepuis - the highest price reachable since the entry: held
//   tokens could have been sold at any point after it, so that is their bar.
// @returns null when nothing is held, so the caller shows nothing rather than
//   a zero pretending to be an answer.

export function chiffrerDetenu(balance, sommetDepuis, prixMaintenant) {
  const jetons = num(balance);
  if (jetons === null || jetons <= 0) return null;

  const sommet = num(sommetDepuis?.prix);
  const courant = num(prixMaintenant);
  const auSommet = sommet !== null && sommet > 0 ? jetons * sommet : null;
  const aujourdhui = courant !== null && courant > 0 ? jetons * courant : null;

  return {
    jetons,
    valeur_au_sommet: auSommet,
    valeur_aujourdhui: aujourdhui,
    // Deliberately not called a regret: no decision was taken, so nothing was
    // got wrong. It is the distance between what the position is worth and the
    // most it was ever worth after the entry.
    ecart_au_sommet: auSommet !== null && aujourdhui !== null ? auSommet - aujourdhui : null,
  };
}

// --- The line the card draws -----------------------------------------------
//
// The card shows the price from entry to now with the peak and every sale
// marked on it, which is the one thing this tool knows that a screenshot of a
// number does not. That series is hundreds of candles and has to cross the wire
// small.
//
// It is NOT a slice. Taking every Nth point drops the peak silently, and the
// peak is the whole subject: bucketing and keeping each bucket's MAXIMUM
// preserves it by construction. Same reasoning as maximaApres crediting the
// high rather than the close.

export function echantillonner(serie, cible = 140) {
  if (!Array.isArray(serie) || !serie.length) return [];
  if (serie.length <= cible) return serie;

  const tries = [...serie].sort((a, b) => a.t - b.t);
  // Two slots are reserved for the ends, so `cible` is a real ceiling and not
  // a suggestion: a caller sizing a canvas can rely on it.
  const seaux = Math.max(1, cible - 2);
  const taille = tries.length / seaux;
  const sortie = [];
  for (let i = 0; i < seaux; i++) {
    const debut = Math.floor(i * taille);
    const fin = Math.min(tries.length, Math.floor((i + 1) * taille));
    if (fin <= debut) continue;
    let haut = tries[debut];
    for (let j = debut + 1; j < fin; j++) if (tries[j].high > haut.high) haut = tries[j];
    sortie.push(haut);
  }
  // The ends anchor the line: without them it starts and stops wherever the
  // bucket maxima happen to fall, and the shape no longer matches the window.
  if (sortie[0].t !== tries[0].t) sortie.unshift(tries[0]);
  const dernier = tries[tries.length - 1];
  if (sortie[sortie.length - 1].t !== dernier.t) sortie.push(dernier);
  return sortie;
}

/**
 * The peak, checked against a second source.
 *
 * `token/info` carries `ath_price`, which comes from GMGN's indexer and not
 * from the candle endpoint. Both are GMGN, so their AGREEMENT proves nothing
 * about correctness. Their DISAGREEMENT proves something is wrong, and it aims
 * at the most expensive failure this repo has: a truncated candle window
 * returns a peak that is far too low (16x on one token, 11x on another) while
 * an indexer's all-time high stays right.
 *
 * `verifie` and `suspect` are separate on purpose. Not suspect is not the same
 * as checked: with no second source there is nothing to conclude, and saying so
 * is the whole point.
 */
export function accordAth(pic, ath, tolerance = 0.02) {
  const a = num(ath);
  const p = num(pic);
  if (a === null || a <= 0 || p === null || p <= 0) {
    return { verifie: false, suspect: false };
  }
  const ecart = Math.abs(a / p - 1);
  if (ecart <= tolerance) return { verifie: true, suspect: false, ecart };
  return {
    verifie: true,
    suspect: true,
    ecart,
    facteur: a > p ? a / p : p / a,
    // Le sens compte : une serie tronquee rend un pic TROP BAS. L'autre sens
    // est plus rare et signale autre chose, donc il se nomme autrement.
    sens: a > p ? "le pic lu sur les bougies est trop bas" : "le pic est au-dessus de l'ATH connu",
  };
}

// --- The verdict ----------------------------------------------------------
//
// One line, one answer. The order matters: a token that had already topped
// before the buy is a late entry, and calling that "sold too early" would be
// the exact inversion of what happened.

export function verdict(agg, sommets, chiffrage = null) {
  const seau = sommets?.seau ?? 0;
  // The bucket the LIFETIME peak was read off, which is not the one `seau`
  // reports: the refining pass only ever narrows `depuis`. Falls back to
  // `seau` so a caller that reports a single bucket keeps its old answer.
  const seauVie = sommets?.seau_vie ?? seau;
  const depuis = sommets?.depuis ?? null;
  const vie = sommets?.vie ?? null;

  const base = {
    categorie: null,
    valeur_au_sommet: chiffrage?.valeur_au_sommet ?? null,
    regret: chiffrage?.regret ?? null,
    multiple: chiffrage?.multiple ?? null,
    retard_multiple: null,
    precision_secondes: seau,
  };

  if ((agg.sold_amount ?? 0) <= 0) return { ...base, categorie: "holding" };

  // A late entry: the token's own record predates the first buy. GMGN filters
  // candles on the bucket's START time, so one bucket of slack is the honest
  // margin here, unlike the exit which is an exact block time. The bucket that
  // matters is the one `vie` was dated on: judging a four-hour date with a
  // one-minute margin turns a bucket boundary into a late entry, and that
  // inversion is exactly what this branch exists to avoid.
  if (vie && agg.entree !== null && vie.quand + seauVie <= agg.entree) {
    return {
      ...base,
      categorie: "too_late",
      retard_multiple: depuis && depuis.prix > 0 ? vie.prix / depuis.prix : null,
    };
  }

  if (agg.sortie !== null && depuis && depuis.quand > agg.sortie) {
    return { ...base, categorie: "paperhand" };
  }

  return { ...base, categorie: "roundtrip" };
}
