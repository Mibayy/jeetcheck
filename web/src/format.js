export const compact = (n) => {
  if (n === null || n === undefined || !isFinite(n)) return "—";
  const a = Math.abs(n);
  if (a >= 1e9) return (n / 1e9).toFixed(2).replace(/\.00$/, "") + "B";
  if (a >= 1e6) return (n / 1e6).toFixed(2).replace(/\.00$/, "") + "M";
  if (a >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "K";
  return Math.round(n).toLocaleString("en-US");
};

export const sol = (n) => (n === null || n === undefined || !isFinite(n))
  ? "—" : (Math.abs(n) >= 100 ? n.toFixed(1) : n.toFixed(2));

export const usd = (n) => (n === null || n === undefined || !isFinite(n))
  ? "—" : "$" + Math.round(Math.abs(n)).toLocaleString("en-US");

/**
 * Held for, in DAYS, always, including zero.
 *
 * "31h" is accurate and says nothing. "0 Days" is the same fact and it lands:
 * the joke is the flatness, not a punchline. Rounded DOWN on purpose, because
 * a position held eleven hours was not held for a day.
 */
export const duree = (s) => {
  if (s === null || s === undefined || !isFinite(s) || s < 0) return "—";
  const j = Math.floor(s / 86400);
  return j + (j === 1 ? " Day" : " Days");
};

export const court = (a) => (a ? a.slice(0, 4) + "…" + a.slice(-4) : "");

export const quand = (t) => (t
  ? new Date(t * 1000).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
  : "—");
