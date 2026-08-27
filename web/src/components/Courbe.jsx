/**
 * THE signature of this card, and the reason it is not just a big number on a
 * dark rectangle: the actual price line from entry to now, with the peak marked
 * and every sale marked on it. Nothing else on the page can show you that you
 * sold four hours before the top; this shows it without a word.
 *
 * Drawn from `courbe`, downsampled server-side by a sampler that keeps each
 * bucket's maximum, so the peak cannot be lost on the way here.
 */
export default function Courbe({ courbe, hauteur = 96 }) {
  if (!courbe?.points?.length) return null;
  const pts = courbe.points;
  const L = 1000, H = hauteur;

  const ts = pts.map((p) => p.t);
  const hs = pts.map((p) => p.high);
  const t0 = Math.min(...ts), t1 = Math.max(...ts);
  const hMin = Math.min(...hs), hMax = Math.max(...hs);
  const spanT = Math.max(1, t1 - t0);
  // Log scale: a memecoin goes 30x and back, and a linear axis turns the entire
  // entry half of the line into a flat floor. The shape has to stay readable at
  // both ends or it is decoration.
  const lo = Math.log(Math.max(hMin, hMax * 1e-4)), hi = Math.log(hMax);
  const spanH = Math.max(1e-9, hi - lo);
  const x = (t) => ((t - t0) / spanT) * L;
  const y = (h) => H - ((Math.log(Math.max(h, Math.exp(lo))) - lo) / spanH) * (H - 10) - 5;

  const d = pts.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)} ${y(p.high).toFixed(1)}`).join(" ");
  const aire = `${d} L${L} ${H} L0 ${H} Z`;
  const sommet = courbe.sommet;
  const ventes = (courbe.ventes ?? []).filter((v) => v.t >= t0 && v.t <= t1);

  return (
    <figure className="mt-5 mb-1" aria-label="Price from entry to now, with your sells and the peak">
      <svg viewBox={`0 0 ${L} ${H}`} preserveAspectRatio="none" className="w-full block" style={{ height: hauteur }}>
        <defs>
          <linearGradient id="jc-aire" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--color-drift)" stopOpacity="0.34" />
            <stop offset="100%" stopColor="var(--color-drift)" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={aire} fill="url(#jc-aire)" />
        <path d={d} fill="none" stroke="var(--color-drift)" strokeWidth="2.5"
              strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        {ventes.map((v, i) => (
          <line key={i} x1={x(v.t)} x2={x(v.t)} y1={0} y2={H}
                stroke="var(--color-miss)" strokeWidth="1.5" strokeOpacity="0.5"
                vectorEffect="non-scaling-stroke" />
        ))}
        {sommet && (
          <g>
            <line x1={x(sommet.t)} x2={x(sommet.t)} y1={0} y2={H}
                  stroke="var(--color-gain-lit)" strokeWidth="1.5" strokeDasharray="3 4"
                  vectorEffect="non-scaling-stroke" />
            <circle cx={x(sommet.t)} cy={y(sommet.prix)} r="4"
                    fill="var(--color-gain-lit)" vectorEffect="non-scaling-stroke" />
          </g>
        )}
      </svg>
      <figcaption className="mt-2 flex flex-wrap gap-x-5 gap-y-1 font-mono text-[10.5px] text-bone-3">
        <span><i className="inline-block w-3 h-[2px] align-middle mr-1.5 bg-gain-lit not-italic" />peak</span>
        <span><i className="inline-block w-3 h-[2px] align-middle mr-1.5 bg-miss not-italic" />your sells</span>
      </figcaption>
    </figure>
  );
}
