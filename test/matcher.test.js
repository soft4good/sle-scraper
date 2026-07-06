import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateTriggerConfig, triggerMatchesLot, evaluateTriggers, lotRowsForMatching,
} from '../src/matcher.js';
import { openDb, upsertNotice, upsertLot, saveLotDetail } from '../src/db.js';

function sampleLot(overrides = {}) {
  return {
    noticeId: '0717600/000004/2026',
    lotNumber: 7,
    category: 'EMBARCAÇÃO',
    minBid: 30000,
    appraisalValue: 150000,
    featured: 0,
    allowsIndividuals: 1,
    noticeAllowsIndividuals: 0,
    hasImages: 1,
    searchText: 'EMBARCACAO \n VELEIRO OCEANICO BENETEAU 40 PES CASCO EM FIBRA',
    city: 'RIO DE JANEIRO',
    unitName: 'PORTO DO RIO DE JANEIRO',
    state: 'RJ',
    unitCode: '0717600',
    ...overrides,
  };
}

// --- validation ---

test('validateTriggerConfig accepts a sound config', () => {
  assert.deepEqual(validateTriggerConfig({
    keywords: ['veleiro', 'barco a vela'],
    excludeKeywords: ['sucata'],
    categories: ['EMBARCAÇÃO'],
    states: ['RJ', 'SP'],
    minPrice: 1000,
    maxPrice: 50000,
    maxPctOfAppraisal: 30,
    individualsOnly: true,
    requireImages: false,
    events: ['new_lot', 'deadline_soon'],
    channels: ['toast', 'ntfy'],
  }), []);
});

test('validateTriggerConfig rejects bad shapes', () => {
  assert.ok(validateTriggerConfig(null).length > 0);
  assert.ok(validateTriggerConfig([]).length > 0);
  assert.ok(validateTriggerConfig({}).some((problem) => problem.includes('at least one')));
  assert.ok(validateTriggerConfig({ keywords: [] }).length > 0, 'empty keyword list');
  assert.ok(validateTriggerConfig({ keywords: [42] }).length > 0, 'non-string keyword');
  assert.ok(validateTriggerConfig({ minPrice: -5 }).length > 0, 'negative price');
  assert.ok(validateTriggerConfig({ minPrice: 100, maxPrice: 50 }).length > 0, 'inverted range');
  assert.ok(validateTriggerConfig({ keywords: ['x'], events: ['bogus'] }).length > 0, 'unknown event');
  assert.ok(validateTriggerConfig({ keywords: ['x'], channels: ['sms'] }).length > 0, 'unknown channel');
  assert.ok(validateTriggerConfig({ maxPctOfAppraisal: Number.NaN }).length > 0, 'NaN pct');
  assert.ok(validateTriggerConfig({ requireImages: false }).some((problem) => problem.includes('at least one')),
    'false booleans do not count as a condition');
});

// --- keyword matching ---

test('keywords match accent- and case-insensitively', () => {
  assert.ok(triggerMatchesLot({ keywords: ['VELEIRO'] }, sampleLot()));
  assert.ok(triggerMatchesLot({ keywords: ['veleiro'] }, sampleLot()));
  assert.ok(triggerMatchesLot({ keywords: ['embarcação'] }, sampleLot()), 'accented query vs stripped text');
  assert.ok(!triggerMatchesLot({ keywords: ['lancha'] }, sampleLot()));
});

test('keywords also match the category name', () => {
  const lot = sampleLot({ searchText: 'CASCO DE FIBRA SEM NOME' });
  assert.ok(triggerMatchesLot({ keywords: ['embarcacao'] }, lot));
});

test('multi-word keyword requires all words; list is OR', () => {
  assert.ok(triggerMatchesLot({ keywords: ['veleiro beneteau'] }, sampleLot()), 'both words present');
  assert.ok(!triggerMatchesLot({ keywords: ['veleiro ferrari'] }, sampleLot()), 'one word missing');
  assert.ok(triggerMatchesLot({ keywords: ['ferrari', 'beneteau'] }, sampleLot()), 'OR across keywords');
});

test('exclude keywords veto a match', () => {
  assert.ok(!triggerMatchesLot({ keywords: ['veleiro'], excludeKeywords: ['beneteau'] }, sampleLot()));
  assert.ok(triggerMatchesLot({ keywords: ['veleiro'], excludeKeywords: ['sucata'] }, sampleLot()));
});

// --- category / location ---

test('category condition is exact (normalized) match', () => {
  assert.ok(triggerMatchesLot({ categories: ['EMBARCAÇÃO'] }, sampleLot()));
  assert.ok(triggerMatchesLot({ categories: ['embarcacao'] }, sampleLot()));
  assert.ok(!triggerMatchesLot({ categories: ['VEÍCULO'] }, sampleLot()));
});

test('state condition uses resolved state, or fiscal region when city unknown', () => {
  assert.ok(triggerMatchesLot({ states: ['RJ'] }, sampleLot()));
  assert.ok(!triggerMatchesLot({ states: ['SP'] }, sampleLot()));
  const unknownCity = sampleLot({ state: null, city: 'LUGAR NENHUM', unitCode: '0717600' });
  assert.ok(triggerMatchesLot({ states: ['RJ'] }, unknownCity), 'region 7 includes RJ');
  assert.ok(triggerMatchesLot({ states: ['ES'] }, unknownCity), 'region 7 includes ES');
  assert.ok(!triggerMatchesLot({ states: ['RS'] }, unknownCity));
});

test('city condition matches city or executing-unit name', () => {
  assert.ok(triggerMatchesLot({ cities: ['rio de janeiro'] }, sampleLot()));
  assert.ok(triggerMatchesLot({ cities: ['PORTO DO RIO DE JANEIRO'] }, sampleLot()));
  assert.ok(!triggerMatchesLot({ cities: ['SANTOS'] }, sampleLot()));
});

// --- price ---

test('price bounds apply to minBid', () => {
  assert.ok(triggerMatchesLot({ maxPrice: 30000 }, sampleLot()));
  assert.ok(!triggerMatchesLot({ maxPrice: 29999 }, sampleLot()));
  assert.ok(triggerMatchesLot({ minPrice: 30000 }, sampleLot()));
  assert.ok(!triggerMatchesLot({ minPrice: 30001 }, sampleLot()));
  assert.ok(!triggerMatchesLot({ maxPrice: 1000 }, sampleLot({ minBid: null })), 'missing price never satisfies a bound');
});

test('maxPctOfAppraisal computes discount ratio and requires an appraisal', () => {
  assert.ok(triggerMatchesLot({ maxPctOfAppraisal: 20 }, sampleLot()), '30k/150k = 20%');
  assert.ok(!triggerMatchesLot({ maxPctOfAppraisal: 19 }, sampleLot()));
  assert.ok(!triggerMatchesLot({ maxPctOfAppraisal: 50 }, sampleLot({ appraisalValue: null })));
  assert.ok(!triggerMatchesLot({ maxPctOfAppraisal: 50 }, sampleLot({ appraisalValue: 0 })));
});

// --- flags ---

test('individualsOnly honors lot- or notice-level permission', () => {
  assert.ok(triggerMatchesLot({ individualsOnly: true }, sampleLot()));
  assert.ok(!triggerMatchesLot({ individualsOnly: true },
    sampleLot({ allowsIndividuals: 0, noticeAllowsIndividuals: 0 })));
  assert.ok(triggerMatchesLot({ individualsOnly: true },
    sampleLot({ allowsIndividuals: 0, noticeAllowsIndividuals: 1 })));
});

test('requireImages and featuredOnly flags', () => {
  assert.ok(!triggerMatchesLot({ requireImages: true }, sampleLot({ hasImages: 0 })));
  assert.ok(!triggerMatchesLot({ featuredOnly: true }, sampleLot({ featured: 0 })));
  assert.ok(triggerMatchesLot({ featuredOnly: true }, sampleLot({ featured: 1 })));
});

test('conditions AND together', () => {
  const config = { keywords: ['veleiro'], states: ['RJ'], maxPrice: 50000, individualsOnly: true };
  assert.ok(triggerMatchesLot(config, sampleLot()));
  assert.ok(!triggerMatchesLot(config, sampleLot({ minBid: 60000 })));
  assert.ok(!triggerMatchesLot(config, sampleLot({ state: 'SP', city: 'SANTOS', unitCode: '0800100' })));
});

// --- evaluateTriggers + DB integration ---

test('evaluateTriggers maps trigger ids to matching lots; lotRowsForMatching joins notice data', () => {
  const db = openDb(':memory:');
  const now = '2026-07-06T12:00:00Z';
  upsertNotice(db, {
    noticeId: '0717600/000004/2026', shortId: '717600/4/2026', unitCode: '0717600',
    number: '000004', year: '2026', unitName: 'PORTO DO RIO DE JANEIRO',
    city: 'RIO DE JANEIRO', state: 'RJ', statusCode: 3, allowsIndividuals: false,
    proposalsEndAt: '2026-07-15 21:00', lotCount: 2,
  }, now);
  upsertLot(db, {
    noticeId: '0717600/000004/2026', lotNumber: 1, category: 'EMBARCAÇÃO',
    minBid: 30000, appraisalValue: 150000, allowsIndividuals: true, hasImages: true,
  }, now);
  upsertLot(db, {
    noticeId: '0717600/000004/2026', lotNumber: 2, category: 'VEÍCULO',
    minBid: 8000, appraisalValue: 20000, allowsIndividuals: true, hasImages: true,
  }, now);
  saveLotDetail(db, '0717600/000004/2026', 1, [{ description: 'VELEIRO OCEANICO' }],
    'EMBARCACAO VELEIRO OCEANICO', now);
  // lot 2 has no detail yet → must be excluded from matching

  const rows = lotRowsForMatching(db, [2, 3, 8]);
  assert.equal(rows.length, 1, 'only detail-fetched lots are matchable');
  assert.equal(rows[0].state, 'RJ', 'notice fields joined in');

  const triggers = [
    { id: 1, config: { keywords: ['veleiro'] } },
    { id: 2, config: { categories: ['VEÍCULO'] } },
    { id: 3, config: { keywords: ['helicoptero'] } },
  ];
  const matches = evaluateTriggers(triggers, rows);
  assert.deepEqual([...matches.keys()], [1], 'trigger 2 sees no detail-fetched vehicle, trigger 3 no match');
  assert.equal(matches.get(1).length, 1);
  db.close();
});
