import express from "express";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeWallet, isValidSolanaAddress } from "./analyze.js";
import { readCache, readStale, writeCache } from "./cache.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, "..", "public");

const app = express();

app.get("/api/analyze", async (req, res) => {
  const wallet = req.query.wallet;

  if (!isValidSolanaAddress(wallet)) {
    res.status(400).json({ error: "invalid wallet address (expected base58, 32-44 characters)" });
    return;
  }

  try {
    const cached = await readCache(wallet);
    if (cached) {
      res.json({ ...cached, cached: true, logo_proxy: relaisDisponible });
      return;
    }

    const payload = await analyzeWallet(wallet);

    // Result quality: the share of peaks actually resolved among those
    // attempted. Below half, the analysis ran into a provider and a fresh
    // attempt will do better: we don't lock it in.
    const t = payload?.totals ?? {};
    const tentes = t.sommets_cherches ?? 0;
    const resolus = payload?.positions?.filter((p) => p.peak_measured || p.late_peak_at).length ?? 0;
    const degrade = tentes > 0 && resolus < tentes * 0.5;
    if (degrade) {
      console.error(`[api/analyze] degraded result (${resolus}/${tentes} peaks), short cache`);
    }
    await writeCache(wallet, payload, degrade ? 5 * 60 * 1000 : undefined);
    res.json({ ...payload, logo_proxy: relaisDisponible });
  } catch (e) {
    if (e.notFound) {
      res.status(404).json({ error: e.message });
      return;
    }
    console.error(`[api/analyze] failed for ${wallet}:`, e);

    // Rather than a dry error, serve the last known version even if expired:
    // a figure from two hours ago beats an empty page when a provider is
    // temporarily refusing us.
    const vieux = await readStale(wallet);
    if (vieux) {
      res.json({
        ...vieux.payload,
        cached: true,
        stale: true,
        cached_age_minutes: Math.round(vieux.age / 60000),
        logo_proxy: relaisDisponible,
      });
      return;
    }
    res.status(502).json({ error: "could not fetch data right now, try again in a moment" });
  }
});


// Image relay.
//
// Token logos are hosted on gmgn.ai, whose IPv4 is blocked from this server
// (see the header comment in gmgn.js). A browser sitting behind the same
// network wouldn't load them, and the token card would show only initials.
// The server itself can reach GMGN.
//
// Strict host whitelist: without it, this route would be an open relay and
// would let the server be made to send arbitrary requests.

// The image relay only works if THIS server can reach gmgn.ai. From the dev
// VPS it cannot: gmgn.ai only exposes an IPv4 (its AAAA is an IPv4-mapped
// address) and Cloudflare blocks datacenter IPs. A residential browser, on
// the other hand, reaches it just fine.
//
// Rather than betting on either path, we probe at startup and let the page
// choose. Without this probe, every logo would wait for the relay to time
// out before switching, i.e. twenty waits per page.
let relaisDisponible = false;

async function sonderRelais() {
  try {
    const r = await fetch("https://gmgn.ai/favicon.ico", {
      headers: { "User-Agent": "paperhand/1.0" },
      signal: AbortSignal.timeout(8000),
    });
    relaisDisponible = r.ok || r.status === 404;
  } catch {
    relaisDisponible = false;
  }
  console.log(
    relaisDisponible
      ? "[logo] gmgn.ai reachable: images go through the relay"
      : "[logo] gmgn.ai unreachable from this server: images will be loaded directly by the browser"
  );
}

app.get("/api/capabilities", (req, res) => {
  res.json({ logo_proxy: relaisDisponible });
});

const HOTES_IMAGE = new Set(["gmgn.ai", "www.gmgn.ai", "static.gmgn.ai"]);
const TAILLE_MAX = 3 * 1024 * 1024;
const memoImages = new Map(); // url -> { type, buf, expire }

app.get("/api/logo", async (req, res) => {
  const brut = req.query.u;
  if (typeof brut !== "string" || brut.length > 600) {
    res.status(400).end();
    return;
  }

  let cible;
  try {
    cible = new URL(brut);
  } catch {
    res.status(400).end();
    return;
  }
  if (cible.protocol !== "https:" || !HOTES_IMAGE.has(cible.hostname)) {
    res.status(403).end();
    return;
  }

  const cle = cible.toString();
  const memo = memoImages.get(cle);
  if (memo && memo.expire > Date.now()) {
    res.setHeader("Content-Type", memo.type);
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.end(memo.buf);
    return;
  }

  try {
    const amont = await fetch(cle, {
      headers: { "User-Agent": "paperhand/1.0" },
      signal: AbortSignal.timeout(8000),
    });
    if (!amont.ok) {
      res.status(404).end();
      return;
    }
    const type = amont.headers.get("content-type") || "";
    if (!type.startsWith("image/")) {
      res.status(415).end();
      return;
    }
    const buf = Buffer.from(await amont.arrayBuffer());
    if (buf.length > TAILLE_MAX) {
      res.status(413).end();
      return;
    }

    if (memoImages.size > 600) memoImages.clear();
    memoImages.set(cle, { type, buf, expire: Date.now() + 24 * 3600 * 1000 });

    res.setHeader("Content-Type", type);
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.end(buf);
  } catch (e) {
    console.error(`[api/logo] ${cle}: ${e.message}`);
    res.status(502).end();
  }
});

app.use(express.static(PUBLIC_DIR));

const PORT = process.env.PAPERHAND_PORT ? Number(process.env.PAPERHAND_PORT) : 8932;
const HOST = "127.0.0.1";

app.listen(PORT, HOST, () => {
  console.log(`paperhand server listening on http://${HOST}:${PORT}`);
  sonderRelais();
});
