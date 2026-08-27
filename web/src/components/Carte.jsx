import { useState } from "react";
import Courbe from "./Courbe.jsx";
import Partage from "./Partage.jsx";
import { compact, sol, usd, duree, court, quand } from "../format.js";

/* Les trois etats demandes. Un badge s'allume, les autres restent eteints :
   la categorie se lit en une seconde sans lire une phrase. */
const BADGES = [
  { cle: "paperhand", texte: "PAPERHAND", ton: "miss" },
  { cle: "roundtrip", texte: "ROUNDTRIP", ton: "drift" },
  { cle: "jeetgod",   texte: "JEET GOD",  ton: "gain" },
];

const TONS = {
  miss:  { on: "border-miss text-miss-lit bg-miss-wash",   off: "border-seam text-bone-3" },
  gain:  { on: "border-gain text-gain-lit bg-gain-wash",   off: "border-seam text-bone-3" },
  drift: { on: "border-drift text-drift bg-drift-wash",    off: "border-seam text-bone-3" },
};

function Bloc({ k, v, sub, ton = "" }) {
  return (
    <div className="rounded-[--radius-block] border border-seam bg-pit-2 px-4 py-3.5">
      <div className="font-sans text-[10px] uppercase tracking-[0.14em] text-bone-3">{k}</div>
      <div className={`mt-1.5 font-mono text-[19px] font-extrabold tabular-nums leading-none ${ton}`}>{v}</div>
      {sub && <div className="mt-1.5 font-mono text-[11px] text-bone-3 tabular-nums">{sub}</div>}
    </div>
  );
}

export default function Carte({ d, actif, setActif }) {
  const { token: t, position: p, verdict: v, sommet: s, detenu, courbe } = d;
  const [copie, setCopie] = useState(false);
  const [logoOk, setLogoOk] = useState(false);

  const wallets = p.par_wallet ?? [];
  const multi = wallets.length > 1;
  // Un onglet = un wallet interroge sur CE token, plus « tous ». Les chiffres
  // du wallet sont ceux que l'agregation a deja calcules par wallet.
  const vue = actif === "tous" ? null : wallets.find((w) => w.wallet === actif);
  const achatSol = vue ? vue.bought_sol : p.bought_sol;
  const achatUsd = vue ? vue.bought_cost : p.bought_cost;
  const venteSol = vue ? vue.sold_sol : p.sold_sol;
  const venteUsd = vue ? vue.sold_income : p.sold_income;
  const vendus  = vue ? vue.sold_amount : p.sold_amount;

  const allume = {
    paperhand: v.categorie === "paperhand",
    roundtrip: v.categorie === "roundtrip",
    jeetgod: v.eu_raison === true,
  };
  const aPart = v.categorie === "too_late" ? "LATE ENTRY" : v.categorie === "holding" ? "STILL IN" : null;

  const copier = async () => {
    try { await navigator.clipboard.writeText(t.address); setCopie(true); setTimeout(() => setCopie(false), 1400); }
    catch { /* pas de presse-papiers : le CA reste lisible et selectionnable */ }
  };

  return (
    <article id="jc-carte"
      className="monte rounded-[--radius-card] border border-seam bg-pit overflow-hidden"
      style={{ boxShadow: "0 46px 100px -50px #000000F2" }}>

      {/* Identite du token : logo, ticker en grand, CA copiable */}
      <header className="flex items-center gap-3.5 px-5 pt-5 pb-4 border-b border-seam">
        {/* Les initiales sont la couche de BASE, le logo se pose dessus une fois
            charge. Mesure le 27/08 : la requete vers l'hote d'origine ne repond
            ni ne echoue, elle pend, donc `onError` ne part jamais et un repli
            sur erreur laisse un carre vide pour toujours. Une image absente ne
            doit rien coûter. */}
        <div className="relative size-12 shrink-0 overflow-hidden rounded-[14px] border border-seam-lit bg-pit-2">
          {/* Retirees des que l'image est la, et non laissees en fond : beaucoup
              de logos pump.fun sont des PNG a fond transparent, et les
              initiales transparaissaient au travers. */}
          {!logoOk && (
            <span className="absolute inset-0 grid place-items-center font-mono text-[13px] font-extrabold text-bone-3">
              {(t.symbol || "?").slice(0, 3).toUpperCase()}
            </span>
          )}
          {t.logo && (
            <img src={d.logo_proxy ? "/api/logo?u=" + encodeURIComponent(t.logo) : t.logo}
                 alt="" referrerPolicy="no-referrer" loading="eager"
                 className={`absolute inset-0 size-full object-cover transition-opacity duration-500
                             ease-[--ease-smooth] ${logoOk ? "opacity-100" : "opacity-0"}`}
                 onLoad={(e) => { if (e.currentTarget.naturalWidth > 0) setLogoOk(true); }} />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="font-mono text-[26px] font-extrabold leading-none tracking-tight truncate">
            {t.symbol || court(t.address)}
          </h2>
          <button onClick={copier} type="button"
            className="mt-2 inline-flex items-center gap-1.5 rounded-full border border-seam bg-pit-2 px-2.5 py-1
                       font-mono text-[10.5px] text-bone-3 transition-colors duration-200 ease-[--ease-smooth]
                       hover:text-bone hover:border-seam-lit"
            title="Copy contract address">
            <span className="tabular-nums">{court(t.address)}</span>
            <span className={copie ? "text-gain-lit" : "text-bone-4"}>{copie ? "copied" : "copy CA"}</span>
          </button>
        </div>
        {aPart && (
          <span className="shrink-0 rounded-full border border-drift bg-drift-wash px-3 py-1.5
                           font-mono text-[10px] font-bold tracking-[0.12em] text-drift">{aPart}</span>
        )}
      </header>

      <div className="px-5 pt-4 pb-5">
        {/* Les trois etats */}
        <div className="flex gap-2">
          {BADGES.map((b) => (
            <span key={b.cle}
              className={`flex-1 rounded-full border px-2 py-2 text-center font-mono text-[10.5px] font-bold
                          tracking-[0.12em] transition-colors duration-300 ease-[--ease-smooth]
                          ${allume[b.cle] ? TONS[b.ton].on : TONS[b.ton].off}`}>
              {b.texte}
            </span>
          ))}
        </div>

        {/* Le chiffre, seul, sans paragraphe sous lui */}
        <div className="mt-5">
          <div className="font-sans text-[11px] uppercase tracking-[0.16em] text-bone-3">Paperhanded</div>
          {/* En VERT, et c'est tout le trait d'esprit : la couleur du gain posee
              sur un desastre. En rouge, la carte prend l'air grave et cesse
              d'etre partageable. */}
          <div className="mt-1.5 font-mono text-[clamp(34px,9vw,58px)] font-extrabold leading-[0.94]
                          tracking-[-0.03em] tabular-nums text-gain-lit">
            {compact(vendus)} <span className="text-[0.44em] text-bone-2">{t.symbol}</span>
          </div>
          <div className="mt-2 font-mono text-[15px] tabular-nums text-bone-2">
            {v.regret === null ? "not priceable" : <>
              {sol(v.regret_sol)} SOL <span className="text-bone-3">· {usd(v.regret)}</span>
              {/* Le multiple, pose la sans un mot. Quand il est absurde, il l'est
                  tout seul ; l'annoncer gacherait l'effet. */}
              {v.multiple ? <span className="text-bone-3"> · ×{v.multiple}</span> : null}
            </>}
          </div>
        </div>

        <Courbe courbe={courbe} />

        {/* Quatre indicateurs, rien d'autre */}
        <div className="mt-4 grid grid-cols-2 gap-2.5">
          <Bloc k="Bought with" v={`${sol(achatSol)} SOL`} sub={usd(achatUsd)} />
          <Bloc k="Sold for"    v={`${sol(venteSol)} SOL`} sub={usd(venteUsd)} />
          <Bloc k="Fumbled"     v={v.regret_sol === null ? "—" : `${sol(v.regret_sol)} SOL`}
                sub={usd(v.regret)} />
          <Bloc k="Held for"    v={duree(p.duree_secondes)} sub={quand(p.entree)} />
        </div>

        {/* Le solde encore detenu : jamais fondu dans le chiffre du dessus */}
        {detenu && (
          <div className="mt-2.5 rounded-[--radius-block] border border-seam border-l-[3px] border-l-drift
                          bg-drift-wash px-4 py-3">
            <div className="flex items-baseline justify-between gap-3">
              <span className="font-sans text-[10px] uppercase tracking-[0.14em] text-bone-3">Still holding</span>
              <span className="font-mono text-[11px] text-bone-3 tabular-nums">{compact(detenu.jetons)} {t.symbol}</span>
            </div>
            <div className="mt-1 font-mono text-[17px] font-extrabold tabular-nums text-drift">
              {sol(detenu.ecart_au_sommet_sol)} SOL <span className="text-[0.62em] font-normal text-bone-3">under its peak · not in the number above</span>
            </div>
          </div>
        )}

        {/* Onglets par wallet, seulement quand il y en a plusieurs */}
        {multi && (
          <div className="mt-4 flex gap-1.5 overflow-x-auto pb-1">
            {["tous", ...wallets.map((w) => w.wallet)].map((cle) => (
              <button key={cle} type="button" onClick={() => setActif(cle)}
                className={`shrink-0 rounded-full border px-3 py-1.5 font-mono text-[11px]
                            transition-colors duration-200 ease-[--ease-smooth]
                            ${actif === cle ? "border-gain text-gain-lit bg-gain-wash"
                                            : "border-seam text-bone-3 hover:text-bone"}`}>
                {cle === "tous" ? `all ${wallets.length}` : court(cle)}
              </button>
            ))}
          </div>
        )}

        <Partage d={d} />

        {/* Elle ne sort QUE s'il y a quelque chose a dire. Le decompte de
            bougies etait le dernier reste de ton comptable : vrai, inutile, et
            il donnait a la carte l'air d'une note de bas de page. Ce qui reste
            est ce qui rendrait un chiffre trompeur si on le taisait. */}
        {(s?.ath_suspect || v.ventes_au_dessus_des_bougies > 0 || !t.prix_connu) && (
          <p className="mt-4 font-mono text-[10px] leading-relaxed text-bone-4">
            {s?.ath_suspect && "the candles disagree with the known all-time high, so this is a floor"}
            {v.ventes_au_dessus_des_bougies > 0
              && `${s?.ath_suspect ? " · " : ""}${v.ventes_au_dessus_des_bougies} sale(s) above the candle high, counted at their own price`}
            {!t.prix_connu && " · no current price, so \"was it right\" has no answer"}
          </p>
        )}
      </div>
    </article>
  );
}
