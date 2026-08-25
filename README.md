# Jeet Check

See what you sold too early on Solana, in SOL, and whether you were right to sell.

Paste a wallet address. No wallet connection, no signature, no seed phrase, ever.
Everything is read from public on-chain data through third-party APIs.

> **Help wanted.** This works, but it is bottlenecked on free-tier rate limits.
> If you know a better way to get historical peak prices for Solana memecoins at
> scale, please open an issue. Details in [The hard problem](#the-hard-problem).

---

## What it computes

For every closed position, it answers a question that only makes sense with a
date attached: **what was the highest price this token reached after you bought
in**, and how does that compare to what you actually walked away with.

Positions are split four ways, and the split is the point:

| Tab | Meaning |
|---|---|
| **Paperhand** | The peak came *after* you exited. You sold too early. |
| **Roundtrip** | The peak happened *while you were still holding*. You rode it up and sold on the way back down. |
| **Gained** | Positions where you actually made money. |
| **Too late** | The token had already topped *before* you bought. You were late, not early. |

That last one matters. Using a token's all-time high without checking its date
inflates the number wildly: on one test wallet a single position claimed a
22× larger "miss" than reality, because its record predated the purchase by two
days. A high you missed by arriving late was never yours to take.

## What it looks like

One frame, no scrolling. A ranked strip of tokens drives the detail below.

## Running it

```bash
npm install
node server/index.js          # listens on 127.0.0.1:8932
```

### Credentials

The only credential is a **GMGN OpenAPI key**, read from `~/.config/gmgn/.env`:

```
GMGN_API_KEY=<your key>
GMGN_PRIVATE_KEY=<PEM Ed25519 private key, for signed endpoints>
```

Get one with [`gmgn-cli`](https://www.npmjs.com/package/gmgn-cli):

```bash
npx gmgn-cli config              # prints a link to create the key
npx gmgn-cli config --apply <key>
```

Nothing else needs a key. Everything in this repository is safe to publish:
no credential is committed, and the server only ever reads them from outside
the repo.

> If your host cannot reach `openapi.gmgn.ai` over IPv4, it is not your code.
> Cloudflare blocks some datacenter ranges for that zone while IPv6 works fine.
> `gmgn-cli` also hardcodes `family: 4`, which produces a misleading
> `ConnectTimeoutError`.

### Deployment

See [`deploy/`](deploy/) for a systemd unit and an nginx site with rate limits.
Two settings there are not cosmetic: a 300 s read timeout, because a cold
analysis of a large wallet takes over a minute, and a hard cap of 6 analyses per
minute per IP, because every cold analysis spends a shared third-party quota.

## Data sources, and why each one

| Source | Used for | Key needed |
|---|---|---|
| **GMGN** `wallet_holdings` | Positions: amounts bought and sold, proceeds, realized PnL, entry and exit timestamps, token metadata, current price | yes |
| **pump.fun** `/coins/{mint}` | All-time high **with its timestamp**, which is what makes the four-way split possible | no |
| **GeckoTerminal** OHLCV | Peak since entry, for tokens whose all-time high predates the purchase, and for non-pump.fun memecoins | no |
| **Binance** (Coinbase fallback) | Daily SOL/USD close, three years of history | no |

### Everything upstream is in USD

GMGN returns dollars everywhere, including its candles. Amounts are converted to
SOL at **the SOL/USD close of the day each position was exited**, never today's
rate, which would misprice an old sale. Cross-checked before being trusted:
Binance against Coinbase differed by at most 0.16 % over six common days, and
against the rate implied by GMGN's own trades by 1.12 %.

### Only memecoins

LSTs, wrapped assets and stablecoins are excluded. Not out of purism: that is
exactly where the upstream `ath_price` is broken. One wallet reported JitoSOL at
$108,107,571 against a real $125, and four such rows accounted for **99.95 %** of
that wallet's total. Three filters, in order: known non-memecoin families first,
then the launchpad field, then a plausibility guard on the high itself.

## The hard problem

Resolving a peak costs one API call per token. A single active trader can hold
**2000 positions**, and free tiers do not survive that.

Measured, not assumed:

- **GeckoTerminal** accepts 5 to 7 calls per window *regardless of spacing*.
  2.5 s, 4 s and 6 s between calls all give the same result. It is a hard budget,
  not a rate, so slowing down does not help.
- **pump.fun** tolerates a low sustained rate but not volume. A 40-call probe
  showed 70 req/s with zero refusals; 1500 calls at that pace returned **1014
  refusals** and then nothing at all for several minutes. A short probe does not
  measure a quota that triggers at the thousand.

What the code does about it: a permanent on-disk store of resolved peaks (a dead
memecoin's high is final, so it is never re-fetched), a global time budget so a
request degrades instead of hanging, deferred background completion for the
remainder, and a short cache TTL for degraded results so one bad minute does not
poison a wallet for hours.

**What would actually solve it**, and where help is welcome:

1. A bulk source for Solana memecoin price history. A store of *suffix maxima*
   (the running high from each instant, monotonically decreasing, so only its
   breakpoints need storing) is about **30 bytes per token**: roughly 36 MB for
   tokens that graduated, under 500 MB for everything ever traded. The size is
   not the problem; the initial ingest is. Dune, BigQuery and Bitquery all
   require an account.
2. A cheaper way to get an all-time high **with its timestamp**. The timestamp is
   the whole point; a high without a date cannot be classified.
3. Anything that makes the peak lookup unnecessary for the long tail.

## Known limitations

- On very large wallets, totals cover every sold position, but peaks are resolved
  in waves. The interface says how many, and how many are still pending.
- A peak is an instantaneous spike. On an illiquid token nobody unloads a full
  bag at that price, so treat it as a ceiling, not as money you would really have
  touched. That is why there is more than one tab.
- Token logos are hosted on `gmgn.ai`, which some networks cannot reach. The
  server probes this at startup and the page either proxies them or loads them
  directly. Initials always sit underneath, because an image that hangs never
  fires `onerror`.
- Non-pump.fun memecoins depend on candles, where the budget is tightest.

## A note on safety

Sites offering the same analysis but asking you to **connect your wallet** should
be treated as hostile. Reading public on-chain history requires an address and
nothing else. One such site, examined for comparison, loaded transaction-signing
libraries, wrapped Phantom, Solflare and Jupiter, exfiltrated encrypted payloads
to a domain named to look like a wallet-adapter CDN, and pinged its server the
moment the page loaded. Its hardcoded destination address had zero purchases and
six sales.

This tool never requests a signature, and never will.

## License

MIT
