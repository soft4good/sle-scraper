import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeText, normalizedWords } from '../src/text.js';
import {
  stateForCity, fiscalRegionForUnitCode, candidateStates, FISCAL_REGION_STATES,
} from '../src/geo.js';

const executingUnits = JSON.parse(
  readFileSync(new URL('./fixtures/executing-units.json', import.meta.url), 'utf8'),
);

test('normalizeText strips accents, case and extra whitespace', () => {
  assert.equal(normalizeText('EMBARCAÇÃO'), 'EMBARCACAO');
  assert.equal(normalizeText('veleiro'), 'VELEIRO');
  assert.equal(normalizeText('  Barco   a  Vela '), 'BARCO A VELA');
  assert.equal(normalizeText('SÃO PAULO'), 'SAO PAULO');
  assert.equal(normalizeText(null), '');
  assert.equal(normalizeText(undefined), '');
  assert.equal(normalizeText(123), '123');
});

test('normalizedWords splits on punctuation and slashes', () => {
  assert.deepEqual(normalizedWords('CELULAR/ACESSÓRIO'), ['CELULAR', 'ACESSORIO']);
  assert.deepEqual(normalizedWords('barco a vela'), ['BARCO', 'A', 'VELA']);
  assert.deepEqual(normalizedWords(''), []);
});

test('every live executing unit resolves to a state', () => {
  for (const unit of executingUnits) {
    const state = stateForCity(unit);
    assert.ok(state, `no state mapped for executing unit: ${unit}`);
    assert.match(state, /^[A-Z]{2}$/);
  }
});

test('stateForCity handles accent/case variants and unknowns', () => {
  assert.equal(stateForCity('são paulo'), 'SP');
  assert.equal(stateForCity('CURITIBA'), 'PR');
  assert.equal(stateForCity('Porto de Itaguaí'), 'RJ');
  assert.equal(stateForCity('CIDADE INEXISTENTE XYZ'), null);
  assert.equal(stateForCity(''), null);
  assert.equal(stateForCity(null), null);
});

test('regional superintendences resolve to their HQ state via pattern', () => {
  assert.equal(stateForCity('SUPERINTENDÊNCIA REGIONAL DA RECEITA FEDERAL DO BRASIL DA 9ª REGIÃO FISCAL'), 'PR');
  assert.equal(stateForCity('SUPERINTENDÊNCIA REGIONAL DA RECEITA FEDERAL DO BRASIL DA 10ª REGIÃO FISCAL'), 'RS');
  assert.equal(stateForCity('SUPERINTENDÊNCIA REGIONAL DA RECEITA FEDERAL DO BRASIL DA 1ª REGIÃO FISCAL'), 'DF');
});

test('fiscalRegionForUnitCode reads the two-digit region prefix', () => {
  assert.equal(fiscalRegionForUnitCode('0900100'), 9);
  assert.equal(fiscalRegionForUnitCode('0717700'), 7);
  assert.equal(fiscalRegionForUnitCode('0100100'), 1);
  assert.equal(fiscalRegionForUnitCode('1010100'), 10);
  assert.equal(fiscalRegionForUnitCode('9900100'), null, 'region 99 does not exist');
  assert.equal(fiscalRegionForUnitCode('123'), null);
  assert.equal(fiscalRegionForUnitCode(null), null);
});

test('candidateStates prefers city map, falls back to fiscal region', () => {
  assert.deepEqual(candidateStates('CURITIBA', '0900100'), ['PR']);
  assert.deepEqual(candidateStates('CIDADE DESCONHECIDA', '0717700'), ['ES', 'RJ']);
  assert.deepEqual(candidateStates('CIDADE DESCONHECIDA', 'garbage'), []);
});

test('all fiscal regions list valid two-letter states', () => {
  const regions = Object.keys(FISCAL_REGION_STATES).map(Number).sort((a, b) => a - b);
  assert.deepEqual(regions, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  for (const states of Object.values(FISCAL_REGION_STATES)) {
    assert.ok(states.length > 0);
    for (const state of states) assert.match(state, /^[A-Z]{2}$/);
  }
});
