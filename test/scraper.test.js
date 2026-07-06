import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openDb } from '../src/db.js';
import {
  createSleClient, parseNoticeId, mapNoticeSummary, mapLotSummary, mapLotItems,
} from '../src/api-client.js';
import { runScrape } from '../src/scraper.js';

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

const noticesList = fixture('notices-list.json');
const galeaoDetail = fixture('notice-detail-galeao.json');
const curitibaDetail = fixture('notice-detail-curitiba.json');
const lotDetail = fixture('lot-detail.json');

const GALEAO_ID = '0717700/000002/2026';
const CURITIBA_ID = '0900100/000008/2026';

/**
 * Notices list trimmed so active groups only reference the two notices we have
 * detail fixtures for; one closed group (statusCode 15) is kept to verify
 * inactive notices are stored but not crawled.
 */
function buildNoticesList() {
  const activeIds = new Set([GALEAO_ID, CURITIBA_ID]);
  const groups = [];
  for (const group of noticesList.situacoes) {
    if (group.situacao === 2) {
      groups.push({ ...group, lista: group.lista.filter((entry) => activeIds.has(entry.edital)) });
    } else if (group.situacao === 15) {
      groups.push({ ...group, lista: group.lista.slice(0, 2) });
    }
  }
  return { agora: noticesList.agora, situacoes: groups };
}

function createFakeFetch({ list = buildNoticesList(), failNoticeLots = null, failLotDetails = false } = {}) {
  const calls = { list: 0, noticeLots: 0, lotDetails: 0 };
  async function fakeFetch(url) {
    const respond = (data) => ({ ok: true, json: async () => data });
    const fail = () => ({ ok: false, status: 500 });
    if (url.includes('api/editais-disponiveis')) {
      calls.list += 1;
      return respond(list);
    }
    let match = url.match(/api\/edital\/(\d+)\/(\d+)\/(\d+)$/);
    if (match) {
      calls.noticeLots += 1;
      const noticeId = `${match[1]}/${match[2]}/${match[3]}`;
      if (noticeId === failNoticeLots) return fail();
      if (noticeId === GALEAO_ID) return respond(galeaoDetail);
      if (noticeId === CURITIBA_ID) return respond(curitibaDetail);
      return fail();
    }
    match = url.match(/api\/lote\/(\d+)\/(\d+)\/(\d+)\/(\d+)$/);
    if (match) {
      calls.lotDetails += 1;
      if (failLotDetails) return fail();
      return respond(lotDetail);
    }
    throw new Error(`unexpected url: ${url}`);
  }
  return { fakeFetch, calls };
}

function createClient(fakeFetch) {
  return createSleClient({
    fetchImpl: fakeFetch,
    baseUrl: 'https://sle.test/',
    userAgent: 'test-agent',
    requestSpacingMs: 0,
    maxRetries: 0,
    sleep: async () => {},
  });
}

const CONFIG = { activeStatusCodes: [2, 3, 8], maxLotDetailsPerRun: 400 };

function makeClock() {
  let tick = 0;
  return () => `2026-07-06T12:00:${String(tick++ % 60).padStart(2, '0')}Z`;
}

// --- api-client mapping ---

test('parseNoticeId splits and validates', () => {
  assert.deepEqual(parseNoticeId(GALEAO_ID), { unitCode: '0717700', number: '000002', year: '2026' });
  assert.throws(() => parseNoticeId('garbage'));
});

test('mapNoticeSummary maps Portuguese fields to the domain model', () => {
  const raw = noticesList.situacoes[0].lista[0];
  const notice = mapNoticeSummary(raw, 2);
  assert.equal(notice.noticeId, raw.edital);
  assert.equal(notice.shortId, raw.edle);
  assert.equal(notice.statusCode, raw.codigoSituacao);
  assert.equal(notice.city, raw.cidade);
  assert.equal(notice.state, 'RJ', 'RIO DE JANEIRO resolves to RJ');
  assert.equal(notice.proposalsEndAt, raw.dataFimPropostas);
  assert.equal(notice.lotCount, raw.lotes);
  assert.equal(typeof notice.allowsIndividuals, 'boolean');
});

test('mapLotSummary picks thumbnail and maps values', () => {
  const raw = galeaoDetail.listaLotes[0];
  const lot = mapLotSummary(raw, GALEAO_ID);
  assert.equal(lot.lotNumber, 1);
  assert.equal(lot.category, 'DIVERSOS');
  assert.equal(lot.minBid, 7000);
  assert.equal(lot.appraisalValue, 35000);
  assert.equal(lot.thumbnailUrl, raw.imagens[0].min);
  assert.equal(lot.hasImages, true);
});

test('mapLotItems maps item fields', () => {
  const items = mapLotItems(lotDetail);
  assert.ok(items.length > 0);
  assert.ok(items[0].description.length > 0);
  assert.equal(typeof items[0].quantity, 'number');
  assert.ok(items[0].warehouse);
  assert.deepEqual(mapLotItems({}), []);
});

test('client retries failed requests with backoff then succeeds', async () => {
  let attempts = 0;
  const sleeps = [];
  const client = createSleClient({
    fetchImpl: async () => {
      attempts += 1;
      if (attempts < 3) return { ok: false, status: 503 };
      return { ok: true, json: async () => ({ situacoes: [] }) };
    },
    baseUrl: 'https://sle.test',
    userAgent: 'test',
    requestSpacingMs: 100,
    maxRetries: 2,
    sleep: async (ms) => { sleeps.push(ms); },
  });
  const result = await client.fetchNoticesList();
  assert.deepEqual(result.notices, []);
  assert.equal(attempts, 3);
  assert.deepEqual(sleeps, [200, 400], 'exponential backoff between retries');
});

test('client gives up after maxRetries and throws', async () => {
  const client = createSleClient({
    fetchImpl: async () => ({ ok: false, status: 500 }),
    baseUrl: 'https://sle.test',
    userAgent: 'test',
    requestSpacingMs: 0,
    maxRetries: 1,
    sleep: async () => {},
  });
  await assert.rejects(() => client.fetchNoticesList(), /HTTP 500/);
});

// --- scraper orchestration ---

test('full run: stores all notices, crawls only active ones, fetches all details', async () => {
  const db = openDb(':memory:');
  const { fakeFetch, calls } = createFakeFetch();
  const summary = await runScrape({ db, client: createClient(fakeFetch), config: CONFIG, now: makeClock() });

  assert.equal(summary.noticesSeen, 4, '2 active + 2 closed');
  assert.equal(summary.newLots, galeaoDetail.listaLotes.length + curitibaDetail.listaLotes.length);
  assert.equal(summary.detailsFetched, summary.newLots);
  assert.deepEqual(summary.errors, []);
  assert.equal(calls.noticeLots, 2, 'closed notices are not crawled');

  const noticeCount = db.prepare('SELECT COUNT(*) AS n FROM notices').get().n;
  assert.equal(noticeCount, 4);
  const lot = db.prepare('SELECT * FROM lots WHERE noticeId = ? AND lotNumber = 1').get(GALEAO_ID);
  assert.ok(lot.searchText.includes('DRONE RADIOCONTROLADO DJI MAVIC AIR 2'), 'searchText is normalized item text');
  assert.ok(lot.searchText.includes('DIVERSOS'), 'searchText includes category');
  const items = db.prepare('SELECT COUNT(*) AS n FROM items').get().n;
  assert.ok(items > 0);
  db.close();
});

test('second run is incremental: no new lots, no detail fetches', async () => {
  const db = openDb(':memory:');
  const first = createFakeFetch();
  await runScrape({ db, client: createClient(first.fakeFetch), config: CONFIG, now: makeClock() });

  const second = createFakeFetch();
  const summary = await runScrape({ db, client: createClient(second.fakeFetch), config: CONFIG, now: makeClock() });
  assert.equal(summary.newLots, 0);
  assert.equal(summary.detailsFetched, 0);
  assert.equal(second.calls.lotDetails, 0, 'no lot detail requests on unchanged data');
  db.close();
});

test('detail fetches are capped per run and resume on the next run', async () => {
  const db = openDb(':memory:');
  const config = { ...CONFIG, maxLotDetailsPerRun: 5 };
  const totalLots = galeaoDetail.listaLotes.length + curitibaDetail.listaLotes.length;

  const first = createFakeFetch();
  const run1 = await runScrape({ db, client: createClient(first.fakeFetch), config, now: makeClock() });
  assert.equal(run1.detailsFetched, 5);

  const second = createFakeFetch();
  const run2 = await runScrape({ db, client: createClient(second.fakeFetch), config, now: makeClock() });
  assert.equal(run2.detailsFetched, 5);

  const fetched = db.prepare('SELECT COUNT(*) AS n FROM lots WHERE detailFetchedAt IS NOT NULL').get().n;
  assert.equal(fetched, 10);
  const pending = db.prepare('SELECT COUNT(*) AS n FROM lots WHERE detailFetchedAt IS NULL').get().n;
  assert.equal(pending, totalLots - 10);
  db.close();
});

test('failure crawling one notice does not abort the run', async () => {
  const db = openDb(':memory:');
  const { fakeFetch } = createFakeFetch({ failNoticeLots: GALEAO_ID });
  const summary = await runScrape({ db, client: createClient(fakeFetch), config: CONFIG, now: makeClock() });

  assert.equal(summary.errors.length, 1);
  assert.equal(summary.errors[0].noticeId, GALEAO_ID);
  assert.equal(summary.errors[0].step, 'lots');
  assert.equal(summary.newLots, curitibaDetail.listaLotes.length, 'other notice still crawled');
  db.close();
});

test('failure fetching lot details records errors per lot and continues', async () => {
  const db = openDb(':memory:');
  const ok = createFakeFetch();
  const config = { ...CONFIG, maxLotDetailsPerRun: 0 };
  await runScrape({ db, client: createClient(ok.fakeFetch), config, now: makeClock() });

  const failing = createFakeFetch({ failLotDetails: true });
  const summary = await runScrape({
    db, client: createClient(failing.fakeFetch), config: { ...CONFIG, maxLotDetailsPerRun: 3 }, now: makeClock(),
  });
  assert.equal(summary.detailsFetched, 0);
  assert.equal(summary.errors.length, 3);
  assert.ok(summary.errors.every((error) => error.step === 'detail'));
  db.close();
});

test('status transitions are detected between runs', async () => {
  const db = openDb(':memory:');
  const list1 = buildNoticesList();
  const first = createFakeFetch({ list: list1 });
  await runScrape({ db, client: createClient(first.fakeFetch), config: CONFIG, now: makeClock() });

  const list2 = JSON.parse(JSON.stringify(list1));
  const group = list2.situacoes.find((entry) => entry.situacao === 2);
  const moved = group.lista.find((entry) => entry.edital === GALEAO_ID);
  moved.codigoSituacao = 3;
  group.lista = group.lista.filter((entry) => entry.edital !== GALEAO_ID);
  list2.situacoes.unshift({ situacao: 3, lista: [moved] });

  const second = createFakeFetch({ list: list2 });
  const summary = await runScrape({ db, client: createClient(second.fakeFetch), config: CONFIG, now: makeClock() });
  assert.deepEqual(summary.statusTransitions, [{ noticeId: GALEAO_ID, from: 2, to: 3 }]);
  db.close();
});
