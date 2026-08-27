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

/** Held for. Hours below two days, because "0.4 days" is not how anyone thinks. */
export const duree = (s) => {
  if (!s || !isFinite(s)) return "—";
  const h = s / 3600;
  if (h < 1) return Math.round(s / 60) + "m";
  if (h < 48) return h < 10 ? h.toFixed(1) + "h" : Math.round(h) + "h";
  return Math.round(h / 24) + "d";
};

export const court = (a) => (a ? a.slice(0, 4) + "…" + a.slice(-4) : "");

export const quand = (t) => (t
  ? new Date(t * 1000).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
  : "—");
