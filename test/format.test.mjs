// Les formats de la carte. Purs, donc testables sans navigateur.
import { test } from "node:test";
import assert from "node:assert/strict";
import { duree, compact, sol, usd } from "../web/src/format.js";

// « 31h » est exact et ne dit rien. « 0 Days » est le meme fait et il porte :
// le comique vient de la platitude, pas d'une chute. Arrondi vers le BAS,
// parce qu'une position tenue onze heures n'a pas ete tenue un jour.
test("la duree se lit en jours, toujours, y compris zero", () => {
  assert.equal(duree(0), "0 Days");
  assert.equal(duree(3600), "0 Days");
  assert.equal(duree(11 * 3600), "0 Days");
  assert.equal(duree(86400), "1 Day");
  assert.equal(duree(2 * 86400), "2 Days");
  assert.equal(duree(31 * 3600), "1 Day");
});

test("une duree absente ou absurde ne rend pas un zero trompeur", () => {
  for (const v of [null, undefined, NaN, -5, Infinity]) assert.equal(duree(v), "—", String(v));
});

test("les grands nombres restent lisibles", () => {
  assert.equal(compact(19_720_000), "19.72M");
  assert.equal(compact(1_500), "1.5K");
  assert.equal(compact(42), "42");
  assert.equal(compact(null), "—");
});

test("SOL et dollars gardent leur precision utile", () => {
  assert.equal(sol(17.9711), "17.97");
  assert.equal(sol(1234.5), "1234.5");
  assert.equal(usd(1686.4), "$1,686");
  assert.equal(usd(null), "—");
});
