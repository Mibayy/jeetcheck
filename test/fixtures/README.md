# Fixtures

Real captures of `/api/check`, kept as-is so the page tests render what the API
actually returns rather than what we think it returns.

**The wallet addresses are synthetic on purpose.** The captures come from real
trades, and everything else in them is real: the token, the dates, the prices,
the trade counts, the profit. Attaching that to a real address would republish
an identifiable person's trading history next to a verdict on it, permanently
and in public. On-chain data being public is not the same thing as this repo
restating it with a judgment attached.

They are valid base58, 44 characters, so the address validation treats them like
any other. No test asserts a specific address. If you refresh these fixtures from
a live call, replace the addresses again before committing.
