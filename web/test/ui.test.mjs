// L'interface, dans un vrai navigateur, avec l'API stubee.
//
// jsdom n'execute pas les scripts type=module, donc il ne peut plus rien dire
// de cette page. Et un navigateur reel est de toute facon le seul endroit ou
// une CSP, une police manquante ou un canvas qui refuse de rendre se voient :
// tout ca laisse le HTTP a 200 et les sondes au vert.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer";

const ici = dirname(fileURLToPath(import.meta.url));
const RACINE = join(ici, "..", "..", "public");
const FIXTURES = join(ici, "..", "..", "test", "fixtures");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };

let serveur, navigateur, base;

before(async () => {
  serveur = createServer(async (req, res) => {
    // Le type se deduit du FICHIER resolu, pas de l'URL : `extname("/")` est
    // vide, Chrome recoit un octet-stream et telecharge la page au lieu de la
    // charger, ce qui sort en ERR_ABORTED sans rien dire du vrai probleme.
    const demande = req.url.split("?")[0];
    const fichier = demande === "/" ? "index.html" : demande;
    try {
      const f = await readFile(join(RACINE, fichier));
      res.writeHead(200, { "Content-Type": TYPES[extname(fichier)] ?? "application/octet-stream" });
      res.end(f);
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise((r) => serveur.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${serveur.address().port}`;
  navigateur = await puppeteer.launch({ args: ["--no-sandbox", "--disable-dev-shm-usage"] });
});

after(async () => { await navigateur?.close(); serveur?.close(); });

/** Attend qu'un texte apparaisse dans la page. Plus robuste qu'un selecteur
 *  texte : on assertit sur ce que l'utilisateur lit, pas sur une structure. */
async function attendreTexte(p, motif, ms = 10000) {
  await p.waitForFunction(
    (m) => (document.querySelector("main")?.innerText ?? "").includes(m),
    { timeout: ms }, motif
  );
}

const charge = async (nom) => JSON.parse(await readFile(join(FIXTURES, nom), "utf8"));

/** Ouvre la page, stub /api/check, remplit et soumet. */
async function lancer(payload, { statut = 200, token = "HDXeZq5Komdc4gcPbLgmrZFcsbupoteZkf1cPitRpump",
                                 wallets = ["W1111111111111111111111111111111111111111111"] } = {}) {
  const p = await navigateur.newPage();
  const erreurs = [];
  p.on("pageerror", (e) => erreurs.push(e.message));
  await p.setRequestInterception(true);
  p.on("request", (r) => {
    if (r.url().includes("/api/check")) {
      r.respond({ status: statut, contentType: "application/json", body: JSON.stringify(payload) });
    } else if (/fonts\.(googleapis|gstatic)/.test(r.url())) {
      r.abort();                       // hors ligne : les polices ne doivent pas bloquer un test
    } else r.continue();
  });
  await p.goto(base, { waitUntil: "domcontentloaded" });
  await p.waitForSelector("input");
  const champs = await p.$$("input");
  if (token) await champs[0].type(token);
  for (let i = 0; i < wallets.length; i++) {
    if (i > 0) await p.click("button ::-p-text(+ wallet)");
    const tous = await p.$$("input");
    await tous[i + 1].type(wallets[i]);
  }
  await p.click('button[type="submit"]');
  return { p, erreurs };
}

test("the form starts with one wallet row and can grow to five", async () => {
  const p = await navigateur.newPage();
  await p.goto(base, { waitUntil: "domcontentloaded" });
  await p.waitForSelector("input");
  assert.equal((await p.$$("input")).length, 2, "token + one wallet");
  for (let i = 0; i < 6; i++) {
    const bouton = await p.$("button ::-p-text(+ wallet)");
    if (!bouton) break;
    await bouton.click();
  }
  assert.equal((await p.$$("input")).length, 6, "token + five wallets, and no further");
  await p.close();
});

test("a real payload renders the card, with no exception and the right figures", async () => {
  const d = await charge("check-roundtrip.json");
  const { p, erreurs } = await lancer(d);
  await p.waitForSelector("#jc-carte", { timeout: 15000 });
  const txt = await p.$eval("#jc-carte", (e) => e.innerText);
  assert.deepEqual(erreurs, [], "no exception during render");
  assert.match(txt, /NANDRY/);
  assert.match(txt, /PAPERHANDED/i);
  assert.match(txt, /BOUGHT WITH/i);
  assert.match(txt, /SOLD FOR/i);
  assert.match(txt, /FUMBLED/i);
  assert.match(txt, /HELD FOR/i);
  assert.ok(!/There is no exit to judge|Priced sale by sale/i.test(txt), "no narrative paragraphs survived");
  await p.close();
});

// La bande du solde detenu doit rester visible ET dire qu'elle n'entre pas dans
// le chiffre du dessus : c'est la seule mention narrative qu'on garde, parce que
// sans elle le gros chiffre est trompeur sur une position ouverte.
test("a position still open shows the held band, and says it is not counted", async () => {
  const d = await charge("check-roundtrip.json");
  const { p } = await lancer(d);
  await p.waitForSelector("#jc-carte");
  const txt = await p.$eval("#jc-carte", (e) => e.innerText);
  assert.match(txt, /still holding/i);
  assert.match(txt, /not in the number above/i);
  await p.close();
});

test("a closed position shows no held band", async () => {
  const d = await charge("check-un-wallet.json");
  const { p } = await lancer(d);
  await p.waitForSelector("#jc-carte");
  const txt = await p.$eval("#jc-carte", (e) => e.innerText);
  assert.ok(!/still holding/i.test(txt));
  await p.close();
});

test("the price line is drawn, with the peak and every sale marked on it", async () => {
  const d = await charge("check-roundtrip.json");
  d.courbe = {
    points: Array.from({ length: 60 }, (_, i) => ({ t: 1787328000 + i * 900, high: 1 + (i % 7) })),
    ventes: [{ t: 1787340000, prix: 5 }, { t: 1787350000, prix: 4 }],
    entree: 1787328995,
    sommet: { t: 1787336160, prix: 8 },
  };
  const { p } = await lancer(d);
  await p.waitForSelector("#jc-carte svg path");
  assert.equal(await p.$$eval("#jc-carte figure line", (l) => l.length), 3, "two sells and one peak");
  await p.close();
});

test("several wallets get one tab each, plus an all tab", async () => {
  const d = await charge("check-roundtrip.json");
  const { p } = await lancer(d, { wallets: ["W1111111111111111111111111111111111111111111",
                                            "W2222222222222222222222222222222222222222222"] });
  await p.waitForSelector("#jc-carte");
  const onglets = await p.$$eval("#jc-carte button", (b) => b.map((x) => x.innerText.trim()));
  assert.ok(onglets.some((o) => /^all 2$/.test(o)), `pas d'onglet « all 2 » dans ${JSON.stringify(onglets)}`);
  await p.close();
});

test("an API error is shown and the form stays put", async () => {
  const { p } = await lancer({ error: "none of those wallets ever traded this token" }, { statut: 404 });
  await attendreTexte(p, "ever traded this token");
  assert.equal(await p.$("#jc-carte"), null, "no card on an error");
  await p.close();
});

test("a 429 from nginx is named rather than shown as a blank failure", async () => {
  const { p } = await lancer({}, { statut: 429 });
  await attendreTexte(p, "Too many checks");
  await p.close();
});
