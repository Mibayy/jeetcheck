# Jeet Check

One coin, your wallets. See what that exit cost you against every peak that
came after it, and whether selling was right anyway.

Paste a token address and the wallets you traded it from. No wallet connection,
no signature, no seed phrase, ever. Everything is read from public on-chain
data through GMGN's API.

---

## What it computes

Every sale is repriced against **the highest price that came after that
particular sale**, not against one peak for the whole position. A trader who
exits in thirty steps made thirty decisions, and a sale made at the top carries
no regret even when the token had been far higher an hour earlier.

Two numbers, because only one of them flatters you:

| Number | Question it answers |
|---|---|
| **What the exit cost you** | What those tokens would have been worth at the peaks that followed your sales |
| **And today** | What they are worth right now, against what you actually took |

The second one is the point. A tool that shows only the regret lies by
omission.

The position gets one verdict:

| Verdict | Meaning |
|---|---|
| **Sold too early** | The peak came after your last sale |
| **Round trip** | You were holding when it topped, and sold under it |
| **Late to the party** | The token had already topped before your first buy. That high was never yours to take |
| **Still holding** | Nothing sold. There is no exit to judge |

### Several wallets

Someone running three wallets on the same coin has one position, not three.
The trades merge into a single verdict, and the per-wallet split stays
available underneath. Up to five wallets.

## Where the numbers come from

Everything is GMGN: trades, balance, token, candles. The only other call is the
SOL/USD series, which GMGN does not publish.

- **Trades** — `wallet_activity`, filtered by token. One call per wallet, with
  the exact timestamp and price of every buy and sell.
- **The peak** — `token_kline`, one or two calls. The first covers the token's
  whole life at a resolution that fits under the API's ceiling; the second
  refines the peak's date down to the minute.
- **The current price** — `token/info`.

### Three things that will bite you if you touch the candle code

Each of these returns a wrong number rather than an error, and each cost a
false conclusion before it was understood:

1. **`from` and `to` are in milliseconds.** In seconds the API answers
   HTTP 200, `"message":"success"`, and an empty list.
2. **`limit` caps at 1000 candles, and truncation eats the START of the
   window.** On one token at 15-minute resolution the series began after the
   peak and reported a price 16× too low. `serieCouvre` exists for this: a
   series that does not reach back to the date you asked for is not a smaller
   answer, it is a wrong one.
3. **GMGN filters on each bucket's start time.** Asking `from = creation` drops
   the bucket that contains the creation, which for a memecoin is usually the
   launch peak. On one token that alone hid a 21×. Always ask from one full
   bucket earlier.

Cross-checked against pump.fun, an independent source: same peak to within
0.87% and 3 minutes.

### And two about positions

- `wallet_holdings` has **no per-token filter**. `token_address`, `token` and
  `address` are all accepted and all ignored, so finding one token there means
  paginating the whole wallet.
- On a position still open, `start_holding_at` is the start of the **current
  holding streak**, not the first buy. On a wallet that had traded the token
  days earlier it returns a date after its own sales. This is why the check
  reads trades instead.
- `token.price` is **0 on every closed position**. GMGN only fills it in while
  you still hold. A tool about closed positions reads zero every time, which
  silently turns "what you sold is worth less today" into a tautology. The
  current price comes from `token/info` for that reason.

## Running it

```bash
npm install
npm start          # listens on 127.0.0.1:8932
npm test           # 54 tests, no network
```

### Credentials

The only credential is a **GMGN OpenAPI key**, read from `~/.config/gmgn/`:

```
~/.config/gmgn/.env          GMGN_API_KEY=<your key>
~/.config/gmgn/keypair.pem   Ed25519 private key, for signed endpoints
```

Get one with [`gmgn-cli`](https://www.npmjs.com/package/gmgn-cli):

```bash
npx gmgn-cli config              # prints a link to create the key
npx gmgn-cli config --apply <key>
```

Hammering the API outside the client's shared pacing gate earns a
`RATE_LIMIT_BANNED` on the whole IP, and a banned reply is an **empty array
inside an HTTP 200**. Read as data it looks exactly like "this wallet never
traded this token". Always go through `server/gmgn.js`.

## The whole-wallet scan

`analyze.js` and `public/scan.html` still hold the older feature: paste one
wallet, get every closed position split four ways. It is not reachable from the
page and `/api/analyze` is not called by it. It carries the `token.price = 0`
problem described above, so its "worth less today" figures should not be
trusted as they stand.

## Layout

```
server/
  check.js       the targeted check: one token, up to five wallets
  positions.js   pure arithmetic, shared: trades, aggregation, regret, verdict
  gmgnkline.js   the peak, from candles, with the coverage guard
  gmgn.js        GMGN client: signing, pacing, the shared ban gate
  solprice.js    SOL/USD by date
  analyze.js     the older whole-wallet scan
  peak.js        GeckoTerminal candles, used only by the scan
  pumpfun.js     pump.fun ATH, used only by the scan
public/
  index.html     the check
  scan.html      the older scan, unlinked
```
