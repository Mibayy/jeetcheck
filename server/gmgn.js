// GMGN openapi client: auth "exist" (query params + X-APIKEY) and "signed" (+ X-Signature Ed25519).
import { readFileSync } from "node:fs";
import { randomUUID, sign as cryptoSign } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

const HOST = "https://openapi.gmgn.ai";
const USER_AGENT = "paperhand/1.0";

const envPath = join(homedir(), ".config/gmgn/.env");
const pemPath = join(homedir(), ".config/gmgn/keypair.pem");

function loadApiKey() {
  const raw = readFileSync(envPath, "utf-8");
  const m = raw.match(/^GMGN_API_KEY=(.*)$/m);
  if (!m) throw new Error("GMGN_API_KEY not found in " + envPath);
  return m[1].trim();
}

function loadPrivateKeyPem() {
  // keypair.pem is the canonical file (actual multi-line format).
  return readFileSync(pemPath, "utf-8");
}

const API_KEY = loadApiKey();
const PRIVATE_KEY_PEM = loadPrivateKeyPem();

function buildSortedQs(params) {
  const pairs = [];
  const keys = Object.keys(params).sort();
  for (const k of keys) {
    const v = params[k];
    if (Array.isArray(v)) {
      const sortedVals = [...v].sort();
      for (const sv of sortedVals) {
        pairs.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(sv))}`);
      }
    } else {
      pairs.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
    }
  }
  return pairs.join("&");
}

function signMessage(message) {
  const sig = cryptoSign(null, Buffer.from(message, "utf-8"), PRIVATE_KEY_PEM);
  return sig.toString("base64");
}

/**
 * Calls a GMGN endpoint.
 * @param {string} subPath - e.g. "/v1/token/info"
 * @param {object} params - business query params (without timestamp/client_id)
 * @param {"exist"|"signed"} mode
 */
async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Minimum spacing between two actually-sent requests, even under
// concurrency=5: a burst of 5 simultaneous requests is enough to trigger
// GMGN's IP ban. `claimSlot` is synchronous (no `await` between reading and
// writing `nextSlotMs`), so it stays atomic despite concurrent calls.
let nextSlotMs = 0;
const MIN_GAP_MS = 260;

function claimSlot() {
  const now = Date.now();
  nextSlotMs = Math.max(nextSlotMs, now) + MIN_GAP_MS;
  return nextSlotMs;
}

async function paceRequest() {
  const wait = claimSlot() - Date.now();
  if (wait > 0) await sleep(wait);
}

async function gmgnRequest(subPath, params, mode = "exist") {
  const timestamp = Math.floor(Date.now() / 1000);
  const clientId = randomUUID();
  const allParams = { ...params, timestamp, client_id: clientId };

  const sortedQs = buildSortedQs(allParams);
  const url = `${HOST}${subPath}?${sortedQs}`;

  const headers = {
    "Content-Type": "application/json",
    "User-Agent": USER_AGENT,
    "X-APIKEY": API_KEY,
  };

  if (mode === "signed") {
    const message = `${subPath}:${sortedQs}::${timestamp}`;
    headers["X-Signature"] = signMessage(message);
  }

  await paceRequest();
  const res = await fetch(url, { method: "GET", headers });

  if (!res.ok) {
    const bodyText = await res.text().catch(() => "");
    const err = new Error(`GMGN ${subPath} -> HTTP ${res.status}: ${bodyText.slice(0, 300)}`);
    err.status = res.status;
    err.bodyText = bodyText;
    throw err;
  }

  return res.json();
}

// GMGN temporarily bans the whole IP ("RATE_LIMIT_BANNED") if you keep
// insisting during the rate-limit window: every request sent during the ban
// extends it. This gate is SHARED across all concurrent workers so that one
// worker "aware" of the ban is enough to silence the others, instead of each
// one rediscovering it and re-extending it independently.
let gateUntilMs = 0;

async function waitForGate() {
  const wait = gateUntilMs - Date.now();
  if (wait > 0) await sleep(wait);
}

function parseResetAt(bodyText) {
  try {
    const parsed = JSON.parse(bodyText);
    const resetAt = Number(parsed?.reset_at);
    return Number.isFinite(resetAt) ? resetAt : null;
  } catch {
    return null;
  }
}

/**
 * GMGN request with retry on 429: honors a global IP ban (reset_at) if
 * reported by the API, otherwise falls back to a short exponential backoff.
 */

// --- Global time budget -----------------------------------------------------
//
// Without it, a large wallet makes the page spin forever. Real case from
// 2026-08-25: a wallet with over 250 positions, where GMGN starts refusing
// mid-pagination. Each refusal triggers a wait until `reset_at`, i.e. 30 to
// 50 s, up to five times. A handful of failures is enough to exceed nginx's
// 300 s, and the user only sees a spinner before an error.
//
// The rule: we NEVER wait past the deadline. We throw, the caller returns
// what it has and says so. An announced partial result beats a page that
// spins for five minutes only to end in a 504.
let echeanceMs = 0;

export function ouvrirBudget(dureeMs) {
  echeanceMs = Date.now() + dureeMs;
}

export function budgetEpuise() {
  return echeanceMs > 0 && Date.now() >= echeanceMs;
}

export function budgetRestantMs() {
  return echeanceMs > 0 ? Math.max(0, echeanceMs - Date.now()) : Infinity;
}

class BudgetDepasse extends Error {
  constructor() {
    super("time budget exceeded");
    this.budget = true;
  }
}

async function gmgnRequestWithRetry(subPath, params, mode = "exist", maxRetries = 5) {
  let attempt = 0;
  for (;;) {
    await waitForGate();
    try {
      return await gmgnRequest(subPath, params, mode);
    } catch (e) {
      const is429 = e.status === 429;
      if (!is429 || attempt >= maxRetries) throw e;
      if (budgetEpuise()) throw new BudgetDepasse();
      attempt += 1;

      const resetAt = parseResetAt(e.bodyText);
      if (resetAt) {
        // reset_at is in unix seconds; we add a short margin.
        gateUntilMs = Math.max(gateUntilMs, resetAt * 1000 + 300);
        const wait = gateUntilMs - Date.now();
        // Waiting longer than the remaining budget is pointless: better to
        // throw now and return a partial result.
        if (wait > budgetRestantMs()) throw new BudgetDepasse();
        console.error(`[gmgn] 429 (IP ban) on ${subPath}, retry ${attempt}/${maxRetries} in ${wait}ms (reset_at=${resetAt})`);
      } else {
        const backoff = 500 * 2 ** (attempt - 1);
        gateUntilMs = Math.max(gateUntilMs, Date.now() + backoff);
        console.error(`[gmgn] 429 on ${subPath}, retry ${attempt}/${maxRetries} in ${backoff}ms`);
      }
      await waitForGate();
    }
  }
}

/**
 * Fetches the full set of a wallet's holdings (pagination).
 */
export async function getAllWalletHoldings(walletAddress) {
  const all = [];
  let cursor = "";
  const MAX_PAGES = 40;

  for (let page = 0; page < MAX_PAGES; page++) {
    const params = {
      chain: "sol",
      wallet_address: walletAddress,
      limit: 50,
      hide_closed: false,
      // hide_airdrop STAYS FALSE. Measured 2026-08-25 on a large wallet, two
      // passes per setting: at `true` GMGN returns 52 positions, at `false`
      // it returns 1014. Their "airdrop" classification sweeps away 95% of
      // a wallet that buys small amounts across many tokens. The sorting
      // happens on our side, on a verifiable criterion: a position with a
      // non-zero purchase cost is a buy, not a gift.
      hide_airdrop: false,
    };
    if (cursor) params.cursor = cursor;

    if (budgetEpuise()) {
      console.error(`[gmgn] budget exhausted during pagination, ${all.length} positions retrieved`);
      break;
    }

    let data;
    try {
      data = await gmgnRequestWithRetry("/v1/user/wallet_holdings", params, "signed");
    } catch (e) {
      if (e.budget || all.length > 0) {
        // We keep what we have rather than lose everything over one page.
        console.error(`[gmgn] pagination interrupted at ${all.length} positions: ${e.message}`);
        break;
      }
      throw e;
    }

    const payload = data?.data ?? data;
    const list = payload?.list ?? [];
    all.push(...list);

    const next = payload?.next;
    if (!next) break;
    cursor = next;
  }

  return all;
}

/**
 * Fetches info for a token (ath_price, current price, symbol, ...).
 */
/**
 * Candles for a token.
 *
 * `from` and `to` are in MILLISECONDS. Measured 2026-08-25: in seconds this
 * endpoint answers HTTP 200 with `"message":"success"` and an EMPTY list, so
 * the mistake costs a wrong number rather than an error. `limit` goes past the
 * default 100 and caps at 1000, truncating the START of the window when the
 * span needs more than that. gmgnkline.js is what guards against it.
 */
export async function getTokenKline(mintAddress, resolution, fromMs, toMs, limit = 1000) {
  const params = { chain: "sol", address: mintAddress, resolution, limit };
  if (fromMs) params.from = Math.floor(fromMs);
  if (toMs) params.to = Math.floor(toMs);
  const data = await gmgnRequestWithRetry("/v1/market/token_kline", params, "exist");
  return (data?.data ?? data)?.list ?? [];
}

export async function getTokenInfo(mintAddress) {
  const data = await gmgnRequestWithRetry(
    "/v1/token/info",
    { chain: "sol", address: mintAddress },
    "exist"
  );
  return data?.data ?? data;
}

/**
 * Every trade a wallet made on ONE token, newest first.
 *
 * This is the endpoint the targeted check is built on, and it replaces
 * `wallet_holdings` there entirely. Two reasons, both measured 2026-08-25:
 *
 *   - `wallet_holdings` has no per-token filter (`token_address`, `token` and
 *     `address` are all accepted and all ignored), so finding one token means
 *     paginating the whole wallet: up to forty calls. This is one call.
 *   - On a position still open, `wallet_holdings.start_holding_at` is the
 *     start of the CURRENT holding streak, not the first buy. On a wallet that
 *     had traded the token days earlier it returned a date AFTER its own
 *     sales, which put the "reachable peak" window in the wrong place. Trades
 *     carry their own timestamps and cannot drift like that.
 *
 * A word of caution paid for on the spot: hammering this endpoint outside the
 * shared gate earns a `RATE_LIMIT_BANNED` on the whole IP, and a banned reply
 * is an EMPTY `activities` array inside an HTTP 200. Read as data, that looks
 * exactly like "this wallet never traded this token" — it cost a false
 * conclusion about a retention window that does not exist. Hence the retry
 * path here, and hence callers must never take an empty list as proof of
 * absence when an error was raised.
 */
export async function getWalletActivity(walletAddress, tokenAddress) {
  const all = [];
  let cursor = "";
  const MAX_PAGES = 20;

  for (let page = 0; page < MAX_PAGES; page++) {
    const params = {
      chain: "sol",
      wallet_address: walletAddress,
      token_address: tokenAddress,
      limit: 100,
    };
    if (cursor) params.cursor = cursor;

    if (budgetEpuise()) {
      console.error(`[gmgn] budget exhausted during activity pagination, ${all.length} events`);
      break;
    }

    const data = await gmgnRequestWithRetry("/v1/user/wallet_activity", params, "signed");
    const payload = data?.data ?? data;
    all.push(...(payload?.activities ?? []));

    const next = payload?.next;
    if (!next) break;
    cursor = next;
  }

  return all;
}

/**
 * What a wallet still holds of one token. One call, exact, and the only way to
 * tell "sold everything" from "sold most of it": transfers in and out never
 * appear as trades, so a balance derived from buys minus sells would drift.
 */
export async function getWalletTokenBalance(walletAddress, tokenAddress) {
  const data = await gmgnRequestWithRetry(
    "/v1/user/wallet_token_balance",
    { chain: "sol", wallet_address: walletAddress, token_address: tokenAddress },
    "signed"
  );
  const liste = (data?.data ?? data)?.balances ?? [];
  const ligne = liste.find((b) => b?.token_address === tokenAddress) ?? liste[0];
  const brut = Number(ligne?.balance);
  return Number.isFinite(brut) ? brut : 0;
}

/**
 * Runs a list of async tasks with limited concurrency.
 */
export async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let idx = 0;

  async function worker() {
    for (;;) {
      const i = idx++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}
