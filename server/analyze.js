// "Paperhand" calculation: compares what a wallet received by selling vs.
// what the position would have been worth at its ATH (and vs. now).
import { getAllWalletHoldings, getTokenInfo, mapWithConcurrency,
         ouvrirBudget, budgetEpuise } from "./gmgn.js";
import { getSolSeries, faireConvertisseur } from "./solprice.js";
import { sommetDepuis, sourceCoupee } from "./peak.js";
import { athPumpFun, estPumpFun } from "./pumpfun.js";

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function isValidSolanaAddress(addr) {
  return typeof addr === "string" && BASE58_RE.test(addr);
}

function num(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

function round2(n) {
  if (n === null || n === undefined || !Number.isFinite(n)) return n;
  return Math.round(n * 100) / 100;
}


// --- What counts as a memecoin -------------------------------------------
//
// GMGN returns a flatly wrong `ath_price` for established tokens: JitoSOL at
// $108,107,571 when it's worth $125, WETH at $4,671,114, PENGU at $280 for a
// real $0.0095. On a wallet with 149 positions, FOUR lines of this kind made
// up 99.95% of the total "paperhand" ($213M instead of $110k).
//
// Three filters, because none is sufficient alone:
//   1. Non-empty `launchpad` (pump, ray_launchpad...) => certain memecoin.
//   2. Otherwise, known families of non-memecoins (LST, wrapped, stables,
//      infra tokens). This is where JitoSOL, WETH, sUSD, RAY fall.
//   3. Otherwise we include it (WEN and BONK have an empty launchpad and are
//      nonetheless memecoins), but a plausibility guard on the ATH still
//      excludes the line if the ATH exceeds 1000x the current price. This is
//      the filter that catches PENGU.

const NON_MEME_EXACTS = new Set([
  "SOL","WSOL","USDC","USDT","USDS","PYUSD","FDUSD","EURC","UXD","USDE",
  "RAY","JUP","JTO","ORCA","PYTH","TNSR","DRIFT","KMNO","MNDE","SRM","INF",
  "WETH","WBTC","ZBTC","CBBTC","WBNB","LST","JLP",
]);

// mSOL, bSOL, JupSOL, stSOL, vSOL, sSOL, heliusSOL, strongSOL, NEW-sSOL...
const LST_RE   = /SOL$/i;
const STABLE_RE = /USD|EUR/i;
const RATIO_ATH_INCROYABLE = 1000;

// The on-chain symbol is a fixed-size byte array: GMGN returns it raw, so
// "proSOL" followed by four NULs, or "INF" followed by a NUL. `.trim()`
// removes neither NULs nor zero-width characters, so these LSTs were slipping
// through the non-memecoin filter.
export function nettoyerSymbole(v) {
  return String(v ?? "")
    .replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200D\uFEFF]/g, "")
    .trim();
}

function classer(token, athPrice, priceNow) {
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

// GMGN returns 0 when it doesn't have the date, not null: an unfiltered 0
// collapsed the median holding time to 0 s and made first_trade = 1970.
function horodatage(v) {
  const n = num(v);
  return n !== null && n > 0 ? n : null;
}

// --- Deferred completion -----------------------------------------------------
//
// Only one background pass at a time, and slowly: the goal isn't speed but
// never getting in the way of an ongoing analysis or rushing pump.fun, whose
// quota is a volume over a long window. Whatever is found enters the
// permanent store and will never be requested again.
let fondEnCours = false;

async function completerEnFond(adresses, entrees, infos) {
  if (fondEnCours) return;
  fondEnCours = true;
  const debut = Date.now();
  let trouves = 0;
  try {
    for (const adr of adresses) {
      if (!estPumpFun(adr)) continue;
      // 400 ms between two calls: ten times slower than the main pass,
      // invisible to the user since no one is waiting.
      await new Promise((r) => setTimeout(r, 400));
      const p = await athPumpFun(adr, num(infos.get(adr)?.decimals));
      if (p) trouves += 1;
      // Don't run forever on a very large wallet.
      if (Date.now() - debut > 15 * 60 * 1000) break;
    }
  } catch (e) {
    console.error(`[background] interrupted: ${e.message}`);
  } finally {
    fondEnCours = false;
    console.log(`[background] ${trouves} peaks added to the store in ${Math.round((Date.now() - debut) / 1000)} s`);
  }
}

/**
 * Builds the full analysis payload for a wallet.
 */
export async function analyzeWallet(walletAddress) {
  // 150 s of budget, where nginx cuts off at 300 s: margin to return a
  // partial result instead of getting cut off midway.
  ouvrirBudget(150000);

  const [holdings, solData] = await Promise.all([
    getAllWalletHoldings(walletAddress),
    getSolSeries(),
  ]);
  const sol = faireConvertisseur(solData);

  // A single token per address, to fetch its info only once.
  const uniqueAddresses = [...new Set(holdings.map((h) => h?.token?.token_address).filter(Boolean))];

  // We no longer call token/info per token. Measured 2026-08-25 on a wallet
  // with 250 positions: symbol, name, logo, decimals, total_supply, launchpad
  // and, most importantly, `price` are already in the pagination, at 100%
  // completeness. Those 250 calls at 260 ms cost 65 s for data already in
  // hand, and it was the dominant cost. An active trader opens more than a
  // hundred positions a day: this cost had to disappear, not be parallelized,
  // since GMGN's ban is per IP, not per connection.
  const tokenInfoByAddress = new Map();
  for (const h of holdings) {
    const t = h?.token;
    const adr = t?.token_address;
    if (!adr || tokenInfoByAddress.has(adr)) continue;
    tokenInfoByAddress.set(adr, {
      symbol: t.symbol,
      name: t.name,
      logo: t.logo,
      decimals: t.decimals,
      total_supply: t.total_supply,
      launchpad: t.launchpad,
      // Same shape as token/info so nothing breaks downstream.
      price: { price: t.price },
      // The peak no longer comes from here: pump.fun or the candles provide
      // it, along with its DATE, the only way to know if it was reachable.
      ath_price: null,
      biggest_pool_address: null,
    });
  }

  // REACHABLE peak, i.e. since entry. `ath_price` is the highest point of the
  // token's ENTIRE lifetime: on CATE it dated from before the buy and
  // inflated the loss 22x. See peak.js.
  //
  // We don't verify every position: GeckoTerminal caps out at 30 calls per
  // minute, verifying everything would mean a three-minute wait.
  // 30 is enough to fill the top 10 of each tab, since both draw from the
  // biggest losses. We classify by best guess first using the global ATH,
  // then verify the biggest ones. The fix can only REDUCE a loss, so
  // verifying the lines that carry weight is enough to correct the total;
  // the small ones stay marked as unverified and the screen says so. A silent
  // truncation isn't acceptable here.
  const maintenant = Math.floor(Date.now() / 1000);
  // HOW MANY PEAKS WE LOOK FOR, and why it isn't "all of them".
  //
  // The totals (stake, sales, net gain) cover ALL of the wallet's positions,
  // with no exception. Only the peak search is bounded, and that's a physical
  // constraint, not a comfort choice: on a wallet with 1982 positions,
  // looking for 1500 peaks made pump.fun return 1014 refusals, then nothing
  // at all for several minutes, including for other visitors. Their quota is
  // a volume over a long window, not a throughput.
  //
  // Ranking is done on the cash received, which is free and already in hand.
  // Verified on the test wallet: the twenty tokens that make up the top 10 of
  // paperhand and roundtrip are all within the first 58 by this criterion.
  // 120 leaves a comfortable margin for the first pass, and the rest goes to
  // the background task: nothing is dropped, it's just spread out.
  // No more arbitrary cap: it's the TIME BUDGET that decides. At 150 ms with
  // a concurrency of 2, we resolve ~13 peaks per second, so about a thousand
  // in seventy seconds, which fits within the 150 s. Whatever doesn't fit
  // goes to the background task and enriches the permanent store, so the next
  // visit gets it for free. The cap at 120 left $EYE, ranked 644 out of 1014,
  // invisible even though it comfortably fits the budget.
  const A_SOMMETS = 1200;
  const A_VERIFIER = 12;

  const candidats = [];
  const entreeParToken = new Map();
  const poolParToken = new Map();
  for (const h of holdings) {
    const adr = h?.token?.token_address;
    const debut = num(h.start_holding_at);
    const vendu = num(h.history_sold_amount) ?? 0;
    if (!adr || !debut || debut <= 0 || vendu <= 0) continue;

    const info = tokenInfoByAddress.get(adr);

    const vu = entreeParToken.get(adr);
    if (vu === undefined || debut < vu) entreeParToken.set(adr, debut);
    if (info?.biggest_pool_address) poolParToken.set(adr, info.biggest_pool_address);

    // The cash actually received: the best ordering available with no extra
    // call, and enough to find the front-runners.
    const brut = num(h.history_sold_income) ?? 0;
    candidats.push({ adr, brut });
  }

  const parPoids = new Map();
  for (const c of candidats) {
    parPoids.set(c.adr, Math.max(parPoids.get(c.adr) ?? 0, c.brut));
  }
  // All candidate tokens, ranked by gross loss. pump.fun takes all of them;
  // only the leftover goes through the candles, where the budget is tight.
  const toutesLesEntrees = [...parPoids.entries()]
    .sort((x, y) => y[1] - x[1])
    .map(([adr]) => adr);

  // Concurrency 1: peak.js's pacing is a shared lock, two workers don't go
  // any faster and only make the rhythm less predictable. And as soon as the
  // circuit breaker opens, we stop the loop instead of queuing up for thirty
  // refusals: that's what made the page spin in place.
  const sommetParToken = new Map();

  // Step 1: pump.fun, for ALL positions and no longer just the thirty
  // biggest. One call per token, no key, about twenty per second measured. It
  // returns the highest point of the token's entire lifetime WITH its date,
  // which is enough to know whether it was reachable and to classify
  // paperhand vs. roundtrip.
  const restants = [];
  const tardifParToken = new Map(); // peak prior to entry
  // Concurrency 2, and 150 ms spacing: see the pacing comment in pumpfun.js.
  // Every more aggressive value ended up getting refused outright, including
  // ones a short probe had validated.
  const retenus = toutesLesEntrees.slice(0, A_SOMMETS);
  const horsPlafond = toutesLesEntrees.slice(A_SOMMETS);

  const nonPump = retenus.filter((adr) => !estPumpFun(adr));
  const pumps = retenus.filter((adr) => estPumpFun(adr));
  restants.push(...nonPump);

  const reportes = [];
  await mapWithConcurrency(pumps, 2, async (address) => {
    if (budgetEpuise()) { reportes.push(address); return; }
    const entree = entreeParToken.get(address);
    const info = tokenInfoByAddress.get(address);
    const p = await athPumpFun(address, num(info?.decimals));
    if (p && p.quand >= entree) {
      // Peak after entry: it was within reach, we take it.
      sommetParToken.set(address, {
        prix: p.prix, quand: p.quand, source: "pumpfun",
        couverture_complete: true, bougies: null,
      });
    } else {
      // Peak BEFORE the buy: never reachable as an opportunity loss. This is
      // NOT missing data, it's a late entry, and it's stated as such. We keep
      // the peak and its date to measure how late.
      if (p && p.quand > 0) tardifParToken.set(address, p);
      restants.push(address);
    }
  });
  console.log(`[analyze] pump.fun: ${sommetParToken.size} peaks, ${restants.length} to verify another way`);

  // Everything that wasn't resolved, for lack of time or because of the cap,
  // goes to the background task. The response doesn't wait for it, but the
  // work happens: the store is permanent, so the next visit gets it for free.
  const aReporter = [...horsPlafond, ...reportes];
  if (aReporter.length) {
    console.log(`[analyze] ${aReporter.length} peaks deferred to the background task`);
    completerEnFond(aReporter, entreeParToken, tokenInfoByAddress);
  }

  // Step 2: candles for the rest, within GeckoTerminal's tight budget, and
  // stopping as soon as the circuit breaker opens.
  const aVerifier = restants
    .map((adr) => [adr, parPoids.get(adr) ?? 0])
    .sort((x, y) => y[1] - x[1])
    .slice(0, A_VERIFIER)
    .map(([adr]) => adr);

  for (const address of aVerifier) {
    if (budgetEpuise()) break;
    if (sourceCoupee()) {
      console.error(`[analyze] peak source cut off, ${aVerifier.length - sommetParToken.size} position(s) unverified`);
      break;
    }
    try {
      // Upper bound: pump.fun's peak when it exists. Otherwise we don't
      // impose one: the bug it was catching (wrong side of the pool) is
      // fixed at the source by the `token` parameter.
      const majorant = tardifParToken.get(address)?.prix ?? null;
      const s = await sommetDepuis(
        address, entreeParToken.get(address), maintenant,
        poolParToken.get(address), majorant
      );
      sommetParToken.set(address, s);
    } catch (e) {
      console.error(`[analyze] peak failed for ${address}: ${e.message}`);
      sommetParToken.set(address, null);
    }
  }

  const positions = holdings.map((h) => {
    const token = h?.token ?? {};
    const address = token.token_address ?? "";
    const info = tokenInfoByAddress.get(address);

    const soldAmount = num(h.history_sold_amount) ?? 0;
    const soldIncome = num(h.history_sold_income) ?? 0;
    const boughtCost = num(h.history_bought_cost) ?? 0;
    const realizedProfit = num(h.realized_profit) ?? 0;
    const startHoldingAt = horodatage(h.start_holding_at);
    const endHoldingAt = horodatage(h.end_holding_at);

    // No more global ATH: a position with no DATED peak can't be priced, and
    // that's intentional. Falling back to the token's all-time high was
    // exactly the CATE bug, where a peak before the buy inflated the loss
    // 22x.
    const athGlobal = tardifParToken.get(address)?.prix ?? null;
    const priceNow = num(info?.price?.price);

    // The reference price is the peak since entry. Without candles we don't
    // exclude the position, we fall back to the global ATH while flagging it:
    // staying silent about it would imply a precision we don't have.
    const sommet = sommetParToken.get(address) ?? null;
    const tardif = tardifParToken.get(address) ?? null;
    const athPrice = sommet ? sommet.prix : athGlobal;
    const sommetMesure = Boolean(sommet);

    // True airdrop: tokens that appeared without a purchase. We exclude them
    // ourselves rather than let GMGN do it, since its definition sweeps away
    // 95% of an active wallet's positions.
    const vraiAirdrop = boughtCost <= 0 && (num(h.history_bought_amount) ?? 0) <= 0;
    const hasSold = soldAmount > 0 && !vraiAirdrop;
    const { memecoin, motif } = classer(token, athPrice, priceNow);
    const athEligible = hasSold && memecoin && athPrice !== null && athPrice > 0;


    const athValueBrut = athEligible ? soldAmount * athPrice : null;
    // Selling above the peak is impossible. When it happens, the ATH
    // returned is underestimated or stale: the line can't be priced.
    const athCoherent = athValueBrut !== null && athValueBrut >= soldIncome;
    const athValue = athCoherent ? athValueBrut : null;
    const paperhand = athCoherent ? athValue - soldIncome : null;
    const mult = athCoherent && soldIncome > 0 ? athValue / soldIncome : null;

    const valueNow = priceNow !== null ? soldAmount * priceNow : null;

    let heldSeconds = null;
    if (startHoldingAt !== null && endHoldingAt !== null && endHoldingAt >= startHoldingAt) {
      heldSeconds = endHoldingAt - startHoldingAt;
    }

    // The rate used is the one at the position's EXIT DATE. Converting at
    // today's rate would give a wrong amount for an old sale.
    const dateRef = endHoldingAt ?? startHoldingAt ?? null;

    return {
      symbol: nettoyerSymbole(token.symbol),
      name: nettoyerSymbole(token.name),
      address,
      logo: token.logo ?? "",
      sold_amount: soldAmount,
      sold_income: round2(soldIncome),
      bought_cost: round2(boughtCost),
      ath_price: athPrice,
      ath_value: athValue !== null ? round2(athValue) : null,
      paperhand: paperhand !== null ? round2(paperhand) : null,
      mult: mult !== null ? round2(mult) : null,
      price_now: priceNow,
      value_now: valueNow !== null ? round2(valueNow) : null,
      realized_profit: round2(realizedProfit),
      held_seconds: heldSeconds,
      start_holding_at: startHoldingAt,
      end_holding_at: endHoldingAt,
      ath_global: athGlobal,
      peak_measured: sommetMesure,
      peak_at: sommet ? sommet.quand : null,
      peak_resolution: sommet ? (sommet.resolution ?? null) : null,
      peak_source: sommet ? (sommet.source ?? null) : null,
      // Late entry: the token had already made its peak before the buy.
      late_peak_price: tardif ? tardif.prix : null,
      late_peak_at: tardif ? tardif.quand : null,
      // The number of sells is shown on screen: a position exited in 30
      // steps doesn't read the same as a single exit.
      total_sells: num(h.history_total_sells) ?? 0,
      total_buys: num(h.history_total_buys) ?? 0,
      entry_price: (num(h.history_bought_amount) > 0 && boughtCost > 0)
        ? boughtCost / num(h.history_bought_amount) : null,
      sol_rate: Math.round(sol.tauxA(dateRef) * 100) / 100,
      realized_profit_sol: sol.enSol(realizedProfit, dateRef),
      bought_cost_sol: sol.enSol(boughtCost, dateRef),
      sold_income_sol: sol.enSol(soldIncome, dateRef),
      ath_value_sol: sol.enSol(athValue, dateRef),
      paperhand_sol: sol.enSol(paperhand, dateRef),
      value_now_sol: sol.enSol(valueNow, null),
      bought_amount: num(h.history_bought_amount) ?? 0,
      _hasSold: hasSold,
      _athEligible: athEligible && athCoherent,
      _memecoin: memecoin,
      _motif: motif,
      _sommetMesure: sommetMesure,
      _vraiAirdrop: vraiAirdrop,
    };
  });

  // We keep ONLY memecoins: an LST or a wrapped token has no place in a
  // paperhand calculation, and that's exactly where the data is wrong.
  const memecoins = positions.filter((p) => p._memecoin);
  const positionsSoldCount = memecoins.filter((p) => p._hasSold).length;

  const ecartes = {
    airdrops: positions.filter((p) => p._vraiAirdrop).length,
    non_memecoin: positions.filter((p) => p._motif === "non_memecoin").length,
    ath_invraisemblable: positions.filter((p) => p._motif === "ath_invraisemblable").length,
    sans_ath: memecoins.filter((p) => p._hasSold && !p._athEligible).length,
    sommet_non_verifie: memecoins.filter((p) => p._hasSold && p._athEligible && !p._sommetMesure).length,
    sommet_par_pumpfun: memecoins.filter((p) => p.peak_source === "pumpfun").length,
    entrees_tardives: memecoins.filter((p) => p.late_peak_at).length,
    ath_incoherent: positions.filter((p) => p._memecoin && p._hasSold
      && p.ath_price !== null && p.ath_price > 0 && p.ath_value === null).length,
  };

  if (positionsSoldCount === 0) {
    const err = new Error("no sold position found for this wallet");
    err.notFound = true;
    throw err;
  }

  let boughtCostTotal = 0;
  let soldIncomeTotal = 0;
  let realizedPnlTotal = 0;
  let athValueTotal = 0;
  let soldIncomeEligibleTotal = 0;
  let valueNowTotal = 0;
  let positionsWorseNow = 0;
  let boughtCostSolTotal = 0;
  let soldIncomeSolTotal = 0;
  let realizedPnlSolTotal = 0;
  let athValueSolTotal = 0;
  let soldIncomeEligibleSolTotal = 0;
  let valueNowSolTotal = 0;
  const firstTradeCandidates = [];
  const lastTradeCandidates = [];
  const heldSecondsCandidates = [];

  for (const p of memecoins) {
    boughtCostTotal += p.bought_cost ?? 0;
    soldIncomeTotal += p.sold_income ?? 0;
    realizedPnlTotal += p.realized_profit ?? 0;

    boughtCostSolTotal += p.bought_cost_sol ?? 0;
    soldIncomeSolTotal += p.sold_income_sol ?? 0;
    realizedPnlSolTotal += p.realized_profit_sol ?? 0;

    if (p._athEligible) {
      athValueTotal += p.ath_value ?? 0;
      soldIncomeEligibleTotal += p.sold_income ?? 0;
      athValueSolTotal += p.ath_value_sol ?? 0;
      soldIncomeEligibleSolTotal += p.sold_income_sol ?? 0;
    }

    if (p.value_now_sol !== null) valueNowSolTotal += p.value_now_sol;

    if (p.value_now !== null) {
      valueNowTotal += p.value_now;
    }

    if (p._hasSold && p.value_now !== null && p.value_now < (p.sold_income ?? 0)) {
      positionsWorseNow += 1;
    }

    if (p.start_holding_at !== null) firstTradeCandidates.push(p.start_holding_at);
    if (p.end_holding_at !== null) lastTradeCandidates.push(p.end_holding_at);
    if (p._hasSold && p.held_seconds !== null) heldSecondsCandidates.push(p.held_seconds);
  }

  const paperhandTotal = athValueTotal - soldIncomeEligibleTotal;
  const paperhandMultTotal = soldIncomeEligibleTotal > 0 ? athValueTotal / soldIncomeEligibleTotal : null;
  const diamondDelta = valueNowTotal - soldIncomeTotal;

  // The response carries only DISPLAYABLE positions. Returning all 250 lines
  // of a large wallet bloated the payload and loaded logos nobody would ever
  // see: the screen shows ten tokens per category.
  const PAR_CATEGORIE = 15;
  const cleanPositions = memecoins
    .filter((p) => (p._athEligible && p.paperhand !== null && p.mult !== null) || p.late_peak_at)
    .map(({ _hasSold, _athEligible, _memecoin, _motif, _sommetMesure, _vraiAirdrop, ...rest }) => ({
      ...rest,
      value_now: rest.value_now ?? 0,
    }))
    .sort((a, b) => (b.paperhand ?? 0) - (a.paperhand ?? 0));

  // Keep just enough to fill each category, no more.
  const garder = new Set();
  const prendre = (liste, cle) => liste
    .slice()
    .sort((x, y) => (y[cle] ?? 0) - (x[cle] ?? 0))
    .slice(0, PAR_CATEGORIE)
    .forEach((p) => garder.add(p.address));
  const classees = cleanPositions.filter((p) => p.peak_measured && p.peak_at && p.end_holding_at);
  prendre(classees.filter((p) => p.peak_at > p.end_holding_at), "paperhand_sol");
  prendre(classees.filter((p) => p.peak_at <= p.end_holding_at), "paperhand_sol");
  prendre(cleanPositions.filter((p) => p.realized_profit_sol > 0), "realized_profit_sol");
  prendre(cleanPositions.filter((p) => p.late_peak_at), "paperhand_sol");
  const positionsAffichables = cleanPositions.filter((p) => garder.has(p.address));

  return {
    wallet: walletAddress,
    generated_at: Math.floor(Date.now() / 1000),
    cached: false,
    totals: {
      positions: memecoins.length,
      positions_sold: positionsSoldCount,
      positions_chiffrees: cleanPositions.length,
      positions_affichees: positionsAffichables.length,
      sommets_cherches: Math.min(toutesLesEntrees.length, A_SOMMETS),
      sommets_possibles: toutesLesEntrees.length,
      ecartes,
      bought_cost: round2(boughtCostTotal),
      sold_income: round2(soldIncomeTotal),
      // Cash received from only the positions where the ATH is usable.
      // Comparing the TOTAL cash received to a partial ATH value produced an
      // absurd sentence on screen: "received 76,032, at peak 64,868".
      sold_income_chiffre: round2(soldIncomeEligibleTotal),
      bought_cost_sol: round2(boughtCostSolTotal),
      sold_income_sol: round2(soldIncomeSolTotal),
      // NET gain. Definitely NOT `sold_income - bought_cost`: `bought_cost`
      // includes purchases never resold. On this wallet, Slopius carried $143
      // of buys with no matching sale, which understated the gain by that
      // much. `realized_profit` only pairs up closed trades.
      realized_pnl_sol: round2(realizedPnlSolTotal),
      sold_income_chiffre_sol: round2(soldIncomeEligibleSolTotal),
      ath_value_sol: round2(athValueSolTotal),
      paperhand_sol: round2(athValueSolTotal - soldIncomeEligibleSolTotal),
      value_now_sol: round2(valueNowSolTotal),
      diamond_delta_sol: round2(valueNowSolTotal - soldIncomeSolTotal),
      sol_source: sol.source,
      sol_rate_now: Math.round(sol.tauxCourant * 100) / 100,
      sol_hors_couverture: sol.hors.avant + sol.hors.apres,
      partiel: budgetEpuise(),
      realized_pnl: round2(realizedPnlTotal),
      ath_value: round2(athValueTotal),
      paperhand: round2(paperhandTotal),
      paperhand_mult: paperhandMultTotal !== null ? round2(paperhandMultTotal) : null,
      value_now: round2(valueNowTotal),
      diamond_delta: round2(diamondDelta),
      positions_worse_now: positionsWorseNow,
      first_trade: firstTradeCandidates.length ? Math.min(...firstTradeCandidates) : null,
      last_trade: lastTradeCandidates.length ? Math.max(...lastTradeCandidates) : null,
      median_hold_seconds: heldSecondsCandidates.length ? Math.round(median(heldSecondsCandidates)) : null,
    },
    positions: positionsAffichables,
  };
}
