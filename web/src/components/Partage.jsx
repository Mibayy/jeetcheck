import { useState } from "react";
import { compact, sol, usd, duree } from "../format.js";

/**
 * L'image partagee est DESSINEE, pas capturee.
 *
 * Une capture DOM (html2canvas et compagnie) rend une approximation : polices
 * substituees, degrades rates, et surtout un canvas « taint » des qu'une image
 * vient d'un autre domaine, ce qui fait echouer toBlob sans prevenir. Dessiner
 * donne une image de taille fixe, identique partout, et le logo passe par le
 * relais local pour rester same-origin.
 */
const L = 1200, H = 675;
const T = {
  void: "#0E0F12", pit: "#16181E", pit2: "#1C1F27", seam: "#262A33",
  gain: "#4ADE80", miss: "#FB7185", drift: "#5B7CFA",
  bone: "#E9ECF1", bone2: "rgba(233,236,241,0.70)", bone3: "rgba(233,236,241,0.45)",
};
const MONO = '800 {s}px "JetBrains Mono", monospace';
const MONO_R = '400 {s}px "JetBrains Mono", monospace';
const SANS = '500 {s}px "Plus Jakarta Sans", sans-serif';
const f = (tpl, s) => tpl.replace("{s}", s);

function coinsArrondis(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

async function chargerLogo(d) {
  if (!d.token.logo || !d.logo_proxy) return null;   // same-origin ou rien
  try {
    const img = new Image();
    img.src = "/api/logo?u=" + encodeURIComponent(d.token.logo);
    // Une requete d'image peut PENDRE sans jamais echouer : sans borne, le
    // partage attend indefiniment et le bouton reste bloque sur "rendering".
    await Promise.race([
      img.decode(),
      new Promise((_, ko) => setTimeout(() => ko(new Error("logo timeout")), 2500)),
    ]);
    return img.naturalWidth > 0 ? img : null;
  } catch { return null; }
}

function dessinerCourbe(c, courbe, x0, y0, w, h) {
  const pts = courbe?.points;
  if (!pts?.length) return;
  const ts = pts.map((p) => p.t), hs = pts.map((p) => p.high);
  const t0 = Math.min(...ts), t1 = Math.max(...ts);
  const hMax = Math.max(...hs), hMin = Math.min(...hs);
  const lo = Math.log(Math.max(hMin, hMax * 1e-4)), hi = Math.log(hMax);
  const sT = Math.max(1, t1 - t0), sH = Math.max(1e-9, hi - lo);
  const X = (t) => x0 + ((t - t0) / sT) * w;
  const Y = (v) => y0 + h - ((Math.log(Math.max(v, Math.exp(lo))) - lo) / sH) * h;

  const grad = c.createLinearGradient(0, y0, 0, y0 + h);
  grad.addColorStop(0, "rgba(91,124,250,0.32)");
  grad.addColorStop(1, "rgba(91,124,250,0)");
  c.beginPath();
  pts.forEach((p, i) => (i ? c.lineTo(X(p.t), Y(p.high)) : c.moveTo(X(p.t), Y(p.high))));
  c.lineTo(X(t1), y0 + h); c.lineTo(X(t0), y0 + h); c.closePath();
  c.fillStyle = grad; c.fill();

  c.beginPath();
  pts.forEach((p, i) => (i ? c.lineTo(X(p.t), Y(p.high)) : c.moveTo(X(p.t), Y(p.high))));
  c.strokeStyle = T.drift; c.lineWidth = 3; c.lineJoin = "round"; c.stroke();

  c.strokeStyle = "rgba(251,113,133,0.5)"; c.lineWidth = 2;
  for (const v of courbe.ventes ?? []) {
    if (v.t < t0 || v.t > t1) continue;
    c.beginPath(); c.moveTo(X(v.t), y0); c.lineTo(X(v.t), y0 + h); c.stroke();
  }
  if (courbe.sommet) {
    c.strokeStyle = T.gain; c.setLineDash([4, 5]); c.lineWidth = 2;
    c.beginPath(); c.moveTo(X(courbe.sommet.t), y0); c.lineTo(X(courbe.sommet.t), y0 + h); c.stroke();
    c.setLineDash([]);
    c.fillStyle = T.gain;
    c.beginPath(); c.arc(X(courbe.sommet.t), Y(courbe.sommet.prix), 6, 0, Math.PI * 2); c.fill();
  }
}

export async function dessiner(d) {
  const { token: t, position: p, verdict: v, courbe } = d;
  if (document.fonts?.ready) await document.fonts.ready;
  const logo = await chargerLogo(d);

  const cv = document.createElement("canvas");
  cv.width = L; cv.height = H;
  const c = cv.getContext("2d");

  const fond = c.createLinearGradient(0, 0, L * 0.4, H);
  fond.addColorStop(0, "#131722"); fond.addColorStop(1, T.void);
  c.fillStyle = fond; c.fillRect(0, 0, L, H);
  const halo = c.createRadialGradient(L * 0.88, 0, 0, L * 0.88, 0, L * 0.7);
  halo.addColorStop(0, "rgba(239,68,68,0.16)"); halo.addColorStop(1, "transparent");
  c.fillStyle = halo; c.fillRect(0, 0, L, H);

  coinsArrondis(c, 40, 40, L - 80, H - 80, 28);
  c.fillStyle = T.pit; c.fill();
  c.strokeStyle = T.seam; c.lineWidth = 2; c.stroke();

  let x = 76;
  if (logo) {
    c.save(); coinsArrondis(c, x, 76, 64, 64, 18); c.clip();
    c.drawImage(logo, x, 76, 64, 64); c.restore();
    x += 82;
  }
  c.fillStyle = T.bone; c.font = f(MONO, 44); c.textBaseline = "top";
  c.fillText(t.symbol || "TOKEN", x, 84);
  c.fillStyle = T.bone3; c.font = f(MONO_R, 15);
  c.fillText(`${t.address.slice(0, 6)}…${t.address.slice(-6)}`, x, 132);

  const etat = v.categorie === "paperhand" ? ["PAPERHAND", T.miss]
             : v.categorie === "too_late"  ? ["LATE ENTRY", T.drift]
             : v.categorie === "holding"   ? ["STILL IN", T.drift]
             : v.eu_raison                 ? ["JEET GOD", T.gain]
             : ["ROUNDTRIP", T.drift];
  c.font = f(MONO, 17);
  const lb = c.measureText(etat[0]).width + 34;
  coinsArrondis(c, L - 76 - lb, 84, lb, 40, 20);
  c.strokeStyle = etat[1]; c.lineWidth = 2; c.stroke();
  c.fillStyle = etat[1]; c.fillText(etat[0], L - 76 - lb + 17, 95);

  c.fillStyle = T.bone3; c.font = f(SANS, 15);
  c.fillText("PAPERHANDED", 76, 188);
  c.fillStyle = T.miss; c.font = f(MONO, 84);
  const gros = `${compact(p.sold_amount)} ${t.symbol || ""}`.trim();
  c.fillText(gros, 76, 212);
  c.fillStyle = T.bone2; c.font = f(MONO_R, 26);
  c.fillText(v.regret === null ? "not priceable" : `${sol(v.regret_sol)} SOL · ${usd(v.regret)}`, 76, 306);

  dessinerCourbe(c, courbe, 76, 356, L - 152, 108);

  const blocs = [
    ["BOUGHT WITH", `${sol(p.bought_sol)} SOL`, usd(p.bought_cost), T.bone],
    ["SOLD FOR", `${sol(p.sold_sol)} SOL`, usd(p.sold_income), T.gain],
    ["FUMBLED", v.regret_sol === null ? "—" : `${sol(v.regret_sol)} SOL`, usd(v.regret), T.miss],
    ["HELD FOR", duree(p.duree_secondes), `${p.total_buys} buys · ${p.total_sells} sells`, T.bone],
  ];
  const bw = (L - 152 - 3 * 16) / 4;
  blocs.forEach(([k, val, sub, teinte], i) => {
    const bx = 76 + i * (bw + 16);
    coinsArrondis(c, bx, 496, bw, 96, 18);
    c.fillStyle = T.pit2; c.fill(); c.strokeStyle = T.seam; c.lineWidth = 2; c.stroke();
    c.fillStyle = T.bone3; c.font = f(SANS, 12); c.fillText(k, bx + 18, 514);
    c.fillStyle = teinte; c.font = f(MONO, 25); c.fillText(val, bx + 18, 534);
    c.fillStyle = T.bone3; c.font = f(MONO_R, 14); c.fillText(sub, bx + 18, 566);
  });

  // Une image qui circule doit dire d'ou elle vient. Le domaine est lu sur la
  // page qui la genere, jamais ecrit en dur : le depot est public et l'hote
  // peut changer.
  c.fillStyle = T.bone2; c.font = f(MONO, 18);
  c.fillText("JEET", 76, H - 80);
  const wJ = c.measureText("JEET").width;
  c.fillStyle = T.gain; c.fillText("CHECK", 76 + wJ, H - 80);
  c.fillStyle = T.bone3; c.font = f(MONO_R, 15);
  c.fillText(location.host, 76 + wJ + c.measureText("CHECK").width + 16, H - 78);
  return cv;
}

export default function Partage({ d }) {
  const [etat, setEtat] = useState("");

  const image = async () => {
    setEtat("rendering");
    try {
      const cv = await dessiner(d);
      const blob = await new Promise((r) => cv.toBlob(r, "image/png"));
      const fichier = new File([blob], `jeetcheck-${d.token.symbol || "token"}.png`, { type: "image/png" });
      if (navigator.canShare?.({ files: [fichier] })) {
        await navigator.share({ files: [fichier] });
        setEtat("");
        return;
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = fichier.name; a.click();
      URL.revokeObjectURL(url);
      setEtat("saved");
    } catch (e) {
      // Dit ce qui s'est passe, ne s'excuse pas, et n'efface pas la carte.
      setEtat("image failed, the card is still on screen");
    }
    setTimeout(() => setEtat(""), 2600);
  };

  const tweet = () => {
    const v = d.verdict;
    const texte = v.categorie === "paperhand"
      ? `I paperhanded ${compact(d.position.sold_amount)} $${d.token.symbol} and fumbled ${sol(v.regret_sol)} SOL.`
      : v.eu_raison
        ? `Dumped ${compact(d.position.sold_amount)} $${d.token.symbol} and it was the right call.`
        : `Checked my $${d.token.symbol} exit. ${sol(v.regret_sol)} SOL left on the table.`;
    window.open(
      `https://twitter.com/intent/tweet?text=${encodeURIComponent(texte + "\n\njeetcheck")}`,
      "_blank", "noopener,noreferrer"
    );
  };

  return (
    <div className="mt-5 flex gap-2.5">
      <button type="button" onClick={image}
        className="flex-1 rounded-[--radius-block] border-2 border-gain bg-gain px-5 py-3.5
                   font-mono text-[14px] font-extrabold tracking-[0.04em] text-void
                   transition-transform duration-300 ease-[--ease-pop]
                   hover:-translate-y-0.5 active:translate-y-0.5"
        style={{ boxShadow: "0 5px 0 #15803D" }}>
        {etat || "SHARE IMAGE"}
      </button>
      <button type="button" onClick={tweet} aria-label="Post on X"
        className="shrink-0 rounded-[--radius-block] border-2 border-seam-lit bg-pit-2 px-4
                   transition-colors duration-300 ease-[--ease-smooth] hover:border-bone-3">
        <svg viewBox="0 0 24 24" className="size-[18px] fill-bone" aria-hidden="true">
          <path d="M18.9 2H22l-7 8 8.2 12h-6.4l-5-7.3L5.9 22H2.8l7.5-8.6L2.4 2h6.6l4.5 6.6L18.9 2Zm-1.1 18h1.7L7.3 3.8H5.5L17.8 20Z" />
        </svg>
      </button>
    </div>
  );
}
