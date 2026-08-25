// Disk cache: one JSON file per wallet.
//
// TTL raised from 10 minutes to 6 hours on 2026-08-25. Ten minutes didn't
// hold up: a cold analysis costs 90 s and consumes two shared quotas, so a
// cache that expires that fast guarantees the next visitor starts from
// scratch. Positions are CLOSED, their history no longer moves; only the
// current price and the peak can change, which doesn't justify recomputing
// everything every ten minutes.
//
// `readStale` serves the last known version even if expired. A page showing
// a figure from two hours ago is vastly better than a page spinning in place
// because a provider is refusing us.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = join(__dirname, "..", ".cache");
const TTL_MS = 6 * 60 * 60 * 1000;

async function ensureCacheDir() {
  await mkdir(CACHE_DIR, { recursive: true });
}

function cachePath(wallet) {
  return join(CACHE_DIR, `${wallet}.json`);
}

async function lire(wallet) {
  try {
    const raw = await readFile(cachePath(wallet), "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed || !parsed.payload) return null;
    return {
      payload: parsed.payload,
      age: Date.now() - (parsed.cached_at ?? 0),
      ttl: parsed.ttl_ms ?? TTL_MS,
    };
  } catch {
    return null;
  }
}

export async function readCache(wallet) {
  const c = await lire(wallet);
  if (!c || c.age > c.ttl) return null;
  return c.payload;
}

/** Last known version, regardless of age. Also returns its age. */
export async function readStale(wallet) {
  return lire(wallet);
}

/**
 * `ttlMs` lets us avoid keeping a degraded result for six hours.
 *
 * Real case from 2026-08-25: an analysis that landed during a pump.fun
 * penalty returned zero peaks, and that gap was served for hours on every
 * visit to the same wallet. One bad moment poisoned the whole day. So a poor
 * result is kept for a few minutes, just enough to avoid a burst, not beyond.
 */
export async function writeCache(wallet, payload, ttlMs) {
  await ensureCacheDir();
  const record = { cached_at: Date.now(), payload, ttl_ms: ttlMs ?? TTL_MS };
  await writeFile(cachePath(wallet), JSON.stringify(record), "utf-8");
}
