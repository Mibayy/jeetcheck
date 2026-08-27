import { useState } from "react";
import Carte from "./components/Carte.jsx";
import { MAX } from "./constantes.js";

export default function App() {
  const [token, setToken] = useState("");
  const [wallets, setWallets] = useState([""]);
  const [etat, setEtat] = useState("repos");     // repos | charge | fait | erreur
  const [erreur, setErreur] = useState("");
  const [data, setData] = useState(null);
  const [actif, setActif] = useState("tous");

  const majWallet = (i, val) => setWallets((w) => w.map((x, j) => (j === i ? val : x)));

  const lancer = async (e) => {
    e.preventDefault();
    const t = token.trim();
    const w = wallets.map((x) => x.trim()).filter(Boolean);
    if (!t) { setErreur("Paste a token address first."); setEtat("erreur"); return; }
    if (!w.length) { setErreur("Add at least one wallet."); setEtat("erreur"); return; }

    setEtat("charge"); setErreur("");
    try {
      const r = await fetch(`/api/check?token=${encodeURIComponent(t)}&wallets=${encodeURIComponent(w.join(","))}`);
      const j = await r.json();
      if (!r.ok) {
        // 429 vient de nginx et n'a pas de corps JSON utile : on le nomme.
        setErreur(r.status === 429 ? "Too many checks from here. Wait a minute." : (j.error || "Could not read that right now."));
        setEtat("erreur"); return;
      }
      setData(j); setActif("tous"); setEtat("fait");
    } catch {
      setErreur("Network dropped. Try again.");
      setEtat("erreur");
    }
  };

  return (
    <main className="relative z-[1] mx-auto flex min-h-dvh w-full max-w-[720px] flex-col justify-center px-4 py-8">
      <div className="mb-6 flex items-center gap-2.5">
        <span className="grid size-9 place-items-center rounded-[12px] border-2 border-gain bg-gain-wash">
          <svg viewBox="0 0 32 32" className="size-5" aria-hidden="true">
            <path d="M5 24 L12 17 L18 20 L27 7" fill="none" stroke="#4ADE80" strokeWidth="3.4"
                  strokeLinecap="round" strokeLinejoin="round" />
            <circle cx="18" cy="20" r="3.4" fill="#FB7185" />
          </svg>
        </span>
        <span className="font-mono text-[17px] font-extrabold tracking-tight">
          JEET<span className="text-gain-lit">CHECK</span>
        </span>
      </div>

      {etat !== "fait" && (
        <section className="monte">
          <h1 className="font-mono text-[clamp(26px,6.4vw,42px)] font-extrabold uppercase leading-[1.04] tracking-[-0.028em]">
            Did you <span className="text-miss-lit">fumble</span> it?
          </h1>
          <p className="mt-3 max-w-[460px] font-sans text-[13.5px] leading-relaxed text-bone-2">
            One token, your wallets. Every sale priced against the peak that came after it.
          </p>

          <form onSubmit={lancer} className="mt-6 flex flex-col gap-2.5">
            <input value={token} onChange={(e) => setToken(e.target.value)} inputMode="text"
              placeholder="Token contract address"
              className="rounded-[--radius-block] border-2 border-seam bg-pit px-4 py-3.5
                         font-mono text-[13px] text-bone placeholder:text-bone-4 outline-none
                         transition-colors duration-300 ease-[--ease-smooth] focus:border-gain" />
            {wallets.map((w, i) => (
              <div key={i} className="flex gap-2.5">
                <input value={w} onChange={(e) => majWallet(i, e.target.value)}
                  placeholder={i ? `Wallet ${i + 1}` : "Your wallet address"}
                  className="min-w-0 flex-1 rounded-[--radius-block] border-2 border-seam bg-pit px-4 py-3.5
                             font-mono text-[13px] text-bone placeholder:text-bone-4 outline-none
                             transition-colors duration-300 ease-[--ease-smooth] focus:border-gain" />
                {i > 0 && (
                  <button type="button" onClick={() => setWallets((ws) => ws.filter((_, j) => j !== i))}
                    aria-label={`Remove wallet ${i + 1}`}
                    className="shrink-0 rounded-[--radius-block] border-2 border-seam bg-pit px-4
                               text-bone-3 transition-colors duration-300 ease-[--ease-smooth]
                               hover:border-miss hover:text-miss-lit">
                    <svg viewBox="0 0 14 14" className="size-3.5" aria-hidden="true">
                      <path d="M1 1 L13 13 M13 1 L1 13" stroke="currentColor" strokeWidth="2"
                            strokeLinecap="round" fill="none" />
                    </svg>
                  </button>
                )}
              </div>
            ))}
            <div className="flex gap-2.5">
              {wallets.length < MAX && (
                <button type="button" onClick={() => setWallets((w) => [...w, ""])}
                  className="rounded-[--radius-block] border-2 border-seam bg-pit px-4 py-3.5 font-mono
                             text-[12px] text-bone-3 transition-colors duration-300 ease-[--ease-smooth]
                             hover:border-seam-lit hover:text-bone">+ wallet</button>
              )}
              <button type="submit" disabled={etat === "charge"}
                className="flex-1 rounded-[--radius-block] border-2 border-gain bg-gain px-5 py-3.5
                           font-mono text-[14px] font-extrabold tracking-[0.04em] text-void
                           transition-transform duration-300 ease-[--ease-pop]
                           hover:-translate-y-0.5 active:translate-y-0.5 disabled:opacity-55"
                style={{ boxShadow: "0 5px 0 #15803D" }}>
                {etat === "charge" ? "CHECKING…" : "CHECK IT"}
              </button>
            </div>
          </form>

          {etat === "erreur" && (
            <p className="mt-4 border-l-[3px] border-miss pl-3 font-sans text-[13px] text-miss-lit">{erreur}</p>
          )}
        </section>
      )}

      {etat === "fait" && data && (
        <>
          <Carte d={data} actif={actif} setActif={setActif} />
          <button type="button" onClick={() => { setEtat("repos"); setData(null); }}
            className="mx-auto mt-4 rounded-full border border-seam px-4 py-2 font-mono text-[11.5px]
                       text-bone-3 transition-colors duration-300 ease-[--ease-smooth]
                       hover:border-seam-lit hover:text-bone">new check</button>
        </>
      )}
    </main>
  );
}
