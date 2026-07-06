import test from 'node:test';
import assert from 'node:assert/strict';
import {
  openDb, upsertNotice, upsertLot, saveLotDetail,
  createTrigger, updateTrigger, deleteTrigger, listTriggers,
  recordNotification, getMeta, setMeta,
} from '../src/db.js';

const NOW = '2026-07-06T12:00:00Z';
const LATER = '2026-07-06T13:00:00Z';

function sampleNotice(overrides = {}) {
  return {
    noticeId: '0900100/000008/2026',
    shortId: '900100/8/2026',
    unitCode: '0900100',
    number: '000008',
    year: '2026',
    unitName: 'SUPERINTENDÊNCIA 9ª RF',
    city: 'CURITIBA',
    state: 'PR',
    statusCode: 2,
    allowsIndividuals: false,
    proposalsStartAt: '2026-07-20 08:00',
    proposalsEndAt: '2026-07-27 21:00',
    biddingStartsAt: '2026-07-28 10:00',
    lotCount: 272,
    ...overrides,
  };
}

function sampleLot(overrides = {}) {
  return {
    noticeId: '0900100/000008/2026',
    lotNumber: 1,
    category: 'VEÍCULO',
    minBid: 12000,
    appraisalValue: 40000,
    lotStatusCode: 11,
    featured: false,
    allowsIndividuals: true,
    hasImages: true,
    thumbnailUrl: 'https://example.test/img.jpg',
    ...overrides,
  };
}

test('schema opens idempotently (migrations re-run safely)', () => {
  const db = openDb(':memory:');
  assert.equal(getMeta(db, 'schemaVersion'), '1');
  db.close();
});

test('upsertNotice inserts then updates, preserving firstSeenAt', () => {
  const db = openDb(':memory:');
  const notice = sampleNotice();
  assert.equal(upsertNotice(db, notice, NOW), null, 'first insert returns no previous status');

  const previous = upsertNotice(db, sampleNotice({ statusCode: 3, lotCount: 300 }), LATER);
  assert.equal(previous, 2, 'returns previous statusCode on update');

  const row = db.prepare('SELECT * FROM notices WHERE noticeId = ?').get(notice.noticeId);
  assert.equal(row.statusCode, 3);
  assert.equal(row.lotCount, 300);
  assert.equal(row.firstSeenAt, NOW, 'firstSeenAt preserved');
  assert.equal(row.lastSeenAt, LATER);
  db.close();
});

test('upsertLot reports newness and preserves detail columns on update', () => {
  const db = openDb(':memory:');
  upsertNotice(db, sampleNotice(), NOW);
  assert.equal(upsertLot(db, sampleLot(), NOW), true, 'new lot');
  saveLotDetail(db, '0900100/000008/2026', 1,
    [{ description: 'GOL 1.6', quantity: 1, unit: 'un', warehouse: 'PATIO' }], 'GOL 1 6', NOW);

  assert.equal(upsertLot(db, sampleLot({ minBid: 11000 }), LATER), false, 'existing lot');
  const row = db.prepare('SELECT * FROM lots WHERE noticeId = ? AND lotNumber = 1')
    .get('0900100/000008/2026');
  assert.equal(row.minBid, 11000, 'price updated');
  assert.equal(row.firstSeenAt, NOW, 'firstSeenAt preserved');
  assert.equal(row.searchText, 'GOL 1 6', 'searchText survives lot re-upsert');
  assert.equal(row.detailFetchedAt, NOW, 'detailFetchedAt survives lot re-upsert');
  db.close();
});

test('saveLotDetail replaces items and stamps detailFetchedAt', () => {
  const db = openDb(':memory:');
  upsertNotice(db, sampleNotice(), NOW);
  upsertLot(db, sampleLot(), NOW);

  saveLotDetail(db, '0900100/000008/2026', 1,
    [{ description: 'A' }, { description: 'B' }], 'A B', NOW);
  saveLotDetail(db, '0900100/000008/2026', 1,
    [{ description: 'C', quantity: 2, unit: 'un', warehouse: 'W' }], 'C', LATER);

  const items = db.prepare('SELECT * FROM items WHERE noticeId = ? AND lotNumber = 1 ORDER BY seq')
    .all('0900100/000008/2026');
  assert.equal(items.length, 1, 'items replaced, not appended');
  assert.equal(items[0].description, 'C');
  assert.equal(items[0].quantity, 2);
  db.close();
});

test('trigger CRUD round-trip', () => {
  const db = openDb(':memory:');
  const config = { keywords: ['veleiro'], maxMinBid: 50000, events: ['new_lot'] };
  const id = createTrigger(db, { name: 'Sailboats', config }, NOW);
  assert.ok(id >= 1);

  let triggers = listTriggers(db);
  assert.equal(triggers.length, 1);
  assert.equal(triggers[0].name, 'Sailboats');
  assert.deepEqual(triggers[0].config, config);
  assert.equal(triggers[0].enabled, true);

  assert.ok(updateTrigger(db, id, { name: 'Boats', enabled: false, config: { keywords: ['barco'] } }, LATER));
  triggers = listTriggers(db);
  assert.equal(triggers[0].name, 'Boats');
  assert.equal(triggers[0].enabled, false);
  assert.deepEqual(triggers[0].config, { keywords: ['barco'] });

  assert.equal(listTriggers(db, { enabledOnly: true }).length, 0);
  assert.ok(deleteTrigger(db, id));
  assert.equal(listTriggers(db).length, 0);
  assert.equal(updateTrigger(db, 999, { name: 'x', enabled: true, config: {} }, NOW), false);
  assert.equal(deleteTrigger(db, 999), false);
  db.close();
});

test('recordNotification dedups on (trigger, notice, lot, event)', () => {
  const db = openDb(':memory:');
  const notification = {
    triggerId: 1, noticeId: '0900100/000008/2026', lotNumber: 5,
    event: 'new_lot', title: 't', body: 'b', url: 'u', channels: ['toast'],
  };
  assert.equal(recordNotification(db, notification, NOW), true, 'first send recorded');
  assert.equal(recordNotification(db, notification, LATER), false, 'duplicate suppressed');
  assert.equal(recordNotification(db, { ...notification, event: 'deadline_soon' }, LATER), true,
    'different event for same lot is allowed');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM notifications').get().n, 2);
  db.close();
});

test('meta get/set round-trip', () => {
  const db = openDb(':memory:');
  assert.equal(getMeta(db, 'ntfyTopic'), null);
  setMeta(db, 'ntfyTopic', 'my-topic');
  setMeta(db, 'ntfyTopic', 'my-topic-2');
  assert.equal(getMeta(db, 'ntfyTopic'), 'my-topic-2');
  db.close();
});
