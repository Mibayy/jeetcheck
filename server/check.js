// The targeted check: one token, one to five wallets, one verdict.
//
// The whole-wallet scan answers "what did I fumble?" and pays for it: every
// position needs a peak, peaks are rate-limited, and the answer takes a minute
// and a half. This answers a question the user already has in mind, so it
// needs the price history of ONE token, which is what lets it be both faster
// and more accurate than the scan: the candles get read at a resolution the
// scan cannot afford, and every sale gets priced against the peak that
// followed IT rather than against one peak for the whole position.
//
// Several wallets, because someone running three wallets in parallel on the
// same token has one position, not three. The trades merge; the per-wallet
// split stays available underneath.
//
// Everything comes from GMGN: trades, balance, token, candles. The only other
// call is the SOL/USD series, which GMGN does not publish.

import {
  getWalletActivity, getWalletTokenBalance, getTokenInfo,
  mapWithConcurrency, ouvrirBudget, budgetEpuise,
} from "./gmgn.js";
import { getSolSeries, faireConvertisseur } from "./solprice.js";
import { sommetsToken, maximaApres } from "./gmgnkline.js";
import {
  normaliserTrades, agregerTrades, regretParVente, chiffrerDetenu, verdict,
  isValidSolanaAddress, nettoyerSymbole, num, round2,
} from "./positions.js";

export const MAX_WALLETS = 5;

function invalide(message) {
  const e = new Error(message);
  e.badRequest = true;
  return e;
}

const sol4 = (n) => (Number.isFinite(n) ? Math.round(n * 10000) / 10000 : null);

export async function checkToken(mint, wallets) {
  if (!isValidSolanaAddress(mint)) {
    throw invalide("invalid token address (expected base58, 32-44 characters)");
  }
  const uniques = [...new Set(wallets)];
  if (uniques.length === 0 || uniques.length > MAX_WALLETS) {
    throw invalide(`between 1 and ${MAX_WALLETS} wallets, got ${uniques.length}`);
  }
  for (const w of uniques) {
    if (!isValidSolanaAddress(w)) throw invalide(`invalid wallet address: ${w}`);
  }

  // 90 s, well under nginx's 300 s. Nothing here should come close: the whole
  // check is a handful of calls whatever the size of the wallets.
  ouvrirBudget(90000);

  const [parWallet, solData, infoToken] = await Promise.all([
    // Concurrency 2 because GMGN bans per IP, not per connection, and its
    // pacing gate is shared: more workers make the rhythm less predictable
    // without making it faster.
    mapWithConcurrency(uniques, 2, async (w) => {
      try {
        const brut = await getWalletActivity(w, mint);
        const balance = await getWalletTokenBalance(w, mint).catch(() => null);
        return { wallet: w, trades: normaliserTrades(brut, w), balance };
      } catch (e) {
        // An error must never reach the caller as an empty trade list: a
        // rate-limited reply is an empty array inside an HTTP 200, and read as
        // data it says "this wallet never touched this token".
        console.error(`[check] ${w}: ${e.message}`);
        return { wallet: w, trades: null, balance: null, erreur: e.message };
      }
    }),
    getSolSeries(),
    // The current price comes from token/info and NOT from a position line.
    // Measured 2026-08-25 on 50 closed positions: GMGN reports `price = 0` on
    // EVERY position whose balance is zero. A tool about closed positions
    // therefore reads zero every time, which silently turns "what you sold is
    // worth less today" into a tautology.
    getTokenInfo(mint).catch((e) => {
      console.error(`[check] token/info failed for ${mint}: ${e.message}`);
      return null;
    }),
  ]);
  const sol = faireConvertisseur(solData);

  const tousTrades = [];
  const sans_position = [];
  const en_erreur = [];
  const soldes = new Map();

  for (const r of parWallet) {
    if (r.trades === null) { en_erreur.push({ wallet: r.wallet, erreur: r.erreur }); continue; }
    if (r.balance !== null) soldes.set(r.wallet, r.balance);
    if (!r.trades.length) { sans_position.push(r.wallet); continue; }
    tousTrades.push(...r.trades);
  }

  if (!tousTrades.length) {
    const toutEnErreur = en_erreur.length === uniques.length;
    const e = new Error(toutEnErreur
      ? "could not read those wallets right now, try again in a moment"
      : "none of those wallets ever traded this token");
    e.notFound = !toutEnErreur;
    e.details = { sans_position, en_erreur };
    throw e;
  }

  const agg = agregerTrades(tousTrades);
  const maintenant = Math.floor(Date.now() / 1000);
  const creation = num(infoToken?.creation_timestamp) ?? num(infoToken?.open_timestamp) ?? null;
  const priceNow = num(infoToken?.price?.price);

  let sommets = null;
  try {
    sommets = await sommetsToken(mint, { creation, entree: agg.entree, maintenant });
  } catch (e) {
    console.error(`[check] peak failed for ${mint}: ${e.message}`);
  }

  // Each sale against the peak that followed IT. Free: the series is already
  // in hand, so thirty sales cost thirty binary searches, not thirty calls.
  const chiffrage = regretParVente(
    agg.ventes,
    sommets?.serie?.length ? maximaApres(sommets.serie) : () => null
  );

  const v = verdict(agg, sommets ?? {}, chiffrage);

  // The second number, the one that keeps the first honest: what the tokens
  // they sold would be worth today. A tool that shows only the regret lies by
  // omission. It is only as good as `priceNow`, which is why that no longer
  // comes from a position line.
  const valeur_aujourdhui = priceNow !== null ? agg.sold_amount * priceNow : null;
  const ecart_aujourdhui = valeur_aujourdhui !== null ? valeur_aujourdhui - agg.sold_income : null;

  const balance = [...soldes.values()].reduce((t, b) => t + b, 0);
  // Rate at the EXIT date: converting an old sale at today's rate is wrong.
  const dateRef = agg.sortie ?? agg.entree ?? null;
  // Only the part actually sold counts against the cost: buys never resold are
  // not a loss, they are a position still open.
  const partVendue = agg.bought_amount ? Math.min(1, agg.sold_amount / agg.bought_amount) : 0;

  // And that open position gets its own number, next to the regret and never
  // inside it. On a half-sold bag the unsold half is routinely the larger gap,
  // and a tool that prices only what you sold flatters you by omission.
  const detenu = chiffrerDetenu(balance, sommets?.depuis, priceNow);

  return {
    token: {
      address: mint,
      symbol: nettoyerSymbole(infoToken?.symbol),
      name: nettoyerSymbole(infoToken?.name),
      logo: infoToken?.logo ?? "",
      launchpad: infoToken?.launchpad ?? "",
      creation,
      price_now: priceNow,
      // Stated rather than assumed: with no price, "was it worth selling" has
      // no answer, and an absent answer must not read as a zero.
      prix_connu: priceNow !== null,
    },
    wallets: {
      demandes: uniques,
      avec_position: agg.par_wallet.map((p) => p.wallet),
      sans_position,
      en_erreur,
    },
    position: {
      bought_amount: agg.bought_amount,
      bought_cost: round2(agg.bought_cost),
      // SOL amounts are what GMGN settled the trade in, not a conversion:
      // every swap here is quoted against WSOL.
      bought_sol: sol4(agg.bought_sol),
      sold_amount: agg.sold_amount,
      sold_income: round2(agg.sold_income),
      sold_sol: sol4(agg.sold_sol),
      realized_profit: round2(agg.sold_income - agg.bought_cost * partVendue),
      realized_profit_sol: sol4(agg.sold_sol - agg.bought_sol * partVendue),
      total_buys: agg.total_buys,
      total_sells: agg.total_sells,
      balance,
      encore_detenu: balance > 0,
      valeur_detenue: priceNow !== null ? round2(balance * priceNow) : null,
      entree: agg.entree,
      sortie: agg.sortie,
      duree_secondes: agg.entree && agg.sortie && agg.sortie >= agg.entree ? agg.sortie - agg.entree : null,
      par_wallet: agg.par_wallet.map((p) => ({
        wallet: p.wallet,
        achats: p.achats,
        ventes: p.ventes,
        bought_amount: p.bought_amount,
        sold_amount: p.sold_amount,
        bought_cost: round2(p.bought_cost),
        sold_income: round2(p.sold_income),
        bought_sol: sol4(p.bought_sol),
        sold_sol: sol4(p.sold_sol),
        entree: p.entree,
        sortie: p.sortie,
        balance: soldes.get(p.wallet) ?? null,
      })),
    },
    sommet: sommets ? {
      prix: sommets.depuis?.prix ?? null,
      quand: sommets.depuis?.quand ?? null,
      prix_vie: sommets.vie?.prix ?? null,
      quand_vie: sommets.vie?.quand ?? null,
      resolution: sommets.resolution,
      // Two buckets, because there are two peaks and they are not known to the
      // same precision. `precision_secondes` describes `quand` alone: the
      // refining pass narrows the reachable peak and never touches the lifetime
      // one. Reporting the first next to `quand_vie` claimed a minute where the
      // series only ever gave four hours.
      precision_secondes: sommets.seau,
      precision_vie_secondes: sommets.seau_vie ?? sommets.seau,
      // False means the candle window was truncated from the start, so the
      // peak may be understated. Never presented as if it were certain.
      couverture_complete: sommets.couverture_complete,
      // The largest hole in the series, in buckets. 1 means no hole. A series
      // can start on the right date and still omit the window: see trouMax.
      trou_max: sommets.trou_max ?? null,
      bougies: sommets.bougies,
    } : null,
    verdict: {
      categorie: v.categorie,
      valeur_au_sommet: round2(v.valeur_au_sommet),
      regret: round2(v.regret),
      multiple: v.multiple !== null ? Math.round(v.multiple * 100) / 100 : null,
      retard_multiple: v.retard_multiple !== null ? Math.round(v.retard_multiple * 100) / 100 : null,
      precision_secondes: v.precision_secondes,
      valeur_au_sommet_sol: sol.enSol(v.valeur_au_sommet, dateRef),
      regret_sol: sol.enSol(v.regret, dateRef),
      valeur_aujourdhui: round2(valeur_aujourdhui),
      valeur_aujourdhui_sol: sol.enSol(valeur_aujourdhui, null),
      ecart_aujourdhui: round2(ecart_aujourdhui),
      ecart_aujourdhui_sol: sol.enSol(ecart_aujourdhui, null),
      // The whole point of the product: was selling actually the right call?
      eu_raison: ecart_aujourdhui !== null ? ecart_aujourdhui < 0 : null,
      // What the number does NOT cover, said out loud rather than rounded away.
      ventes_chiffrees: chiffrage.ventes_chiffrees,
      ventes_sans_sommet: chiffrage.ventes_sans_sommet,
      ventes_au_dessus_des_bougies: chiffrage.ventes_au_dessus_des_bougies,
    },
    // Its own block, deliberately outside `verdict`: nothing here was decided,
    // so none of it belongs to a verdict. null when the position is closed.
    detenu: detenu ? {
      jetons: detenu.jetons,
      valeur_au_sommet: round2(detenu.valeur_au_sommet),
      // At the rate of the day the peak happened. Converting a past high at
      // today's rate would price it in a currency it never had.
      valeur_au_sommet_sol: sol.enSol(detenu.valeur_au_sommet, sommets?.depuis?.quand ?? null),
      valeur_aujourdhui: round2(detenu.valeur_aujourdhui),
      valeur_aujourdhui_sol: sol.enSol(detenu.valeur_aujourdhui, null),
      ecart_au_sommet: round2(detenu.ecart_au_sommet),
      ecart_au_sommet_sol: sol.enSol(detenu.ecart_au_sommet, null),
    } : null,
    sol_rate: dateRef ? Math.round(sol.tauxA(dateRef) * 100) / 100 : null,
    sol_rate_now: Math.round(sol.tauxCourant * 100) / 100,
    generated_at: maintenant,
    partiel: budgetEpuise(),
  };
}
