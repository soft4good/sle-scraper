import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb, upsertNotice, upsertLot, saveLotDetail } from '../src/db.js';
import { createApp } from '../src/server.js';

const NOW = '2026-07-06T12:00:00Z';
const NOTICE_ID = '0717600/000004/2026';

const TEST_CONFIG = {
  port: 0,
  baseUrl: 'https://www25.receita.fazenda.gov.br/sle-sociedade/',
  activeStatusCodes: [2, 3, 8],
  frontendUrl: 'http://localhost:8377',
  ntfyServer: 'https://ntfy.test',
  ntfyTopicDefault: 'env-default-topic',
};

function seedDb() {
  const db = openDb(':memory:');
  upsertNotice(db, {
    noticeId: NOTICE_ID, shortId: '717600/4/2026', unitCode: '0717600', number: '000004',
    year: '2026', unitName: 'PORTO DO RIO DE JANEIRO', city: 'RIO DE JANEIRO', state: 'RJ',
    statusCode: 3, allowsIndividuals: true, proposalsEndAt: '2026-07-15 21:00', lotCount: 3,
  }, NOW);
  const lots = [
    { lotNumber: 1, category: 'EMBARCAÇÃO', minBid: 30000, appraisalValue: 150000, text: 'VELEIRO OCEANICO' },
    { lotNumber: 2, category: 'VEÍCULO', minBid: 8000, appraisalValue: 20000, text: 'FIAT UNO 2015' },
    { lotNumber: 3, category: 'NOTEBOOK', minBid: 1500, appraisalValue: 6000, text: 'MACBOOK PRO M3' },
  ];
  for (const lot of lots) {
    upsertLot(db, {
      noticeId: NOTICE_ID, lotNumber: lot.lotNumber, category: lot.category, minBid: lot.minBid,
      appraisalValue: lot.appraisalValue, allowsIndividuals: true, hasImages: true,
    }, NOW);
    saveLotDetail(db, NOTICE_ID, lot.lotNumber, [{ description: lot.text }],
      `${lot.category} ${lot.text}`.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase(), NOW);
  }
  return db;
}

async function startServer(options = {}) {
  const db = seedDb();
  const app = createApp({ db, config: TEST_CONFIG, ...options });
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, () => resolve(listening));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = async (path, init) => {
    const response = await fetch(`${base}${path}`, init);
    const body = response.status === 204 ? null : await response.json();
    return { status: response.status, body };
  };
  const close = () => new Promise((resolve) => { server.close(resolve); db.close(); });
  return { api, close, db };
}

const json = (method, payload) => ({
  method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
});

test('trigger CRUD round-trip over HTTP', async () => {
  const { api, close } = await startServer();
  try {
    const created = await api('/api/triggers', json('POST', {
      name: 'Sailboats RJ',
      config: { keywords: ['veleiro'], states: ['RJ'], maxPrice: 50000 },
    }));
    assert.equal(created.status, 201);
    assert.ok(created.body.id >= 1);
    assert.equal(created.body.enabled, true);

    const list = await api('/api/triggers');
    assert.equal(list.body.length, 1);

    const updated = await api(`/api/triggers/${created.body.id}`, json('PUT', {
      name: 'Sailboats anywhere', enabled: false, config: { keywords: ['veleiro'] },
    }));
    assert.equal(updated.status, 200);
    assert.equal(updated.body.enabled, false);
    assert.deepEqual(updated.body.config, { keywords: ['veleiro'] });

    const missing = await api('/api/triggers/9999', json('PUT', { name: 'x', config: { keywords: ['x'] } }));
    assert.equal(missing.status, 404);

    const deleted = await api(`/api/triggers/${created.body.id}`, { method: 'DELETE' });
    assert.equal(deleted.status, 204);
    assert.equal((await api('/api/triggers')).body.length, 0);
    assert.equal((await api(`/api/triggers/${created.body.id}`, { method: 'DELETE' })).status, 404);
  } finally {
    await close();
  }
});

test('trigger validation rejects malformed configs with problem details', async () => {
  const { api, close } = await startServer();
  try {
    const noName = await api('/api/triggers', json('POST', { config: { keywords: ['x'] } }));
    assert.equal(noName.status, 400);
    assert.ok(noName.body.problems.includes('name is required'));

    const empty = await api('/api/triggers', json('POST', { name: 'Empty', config: {} }));
    assert.equal(empty.status, 400);
    assert.ok(empty.body.problems.some((problem) => problem.includes('at least one')));

    const badRange = await api('/api/triggers', json('POST', {
      name: 'Bad', config: { minPrice: 100, maxPrice: 5 },
    }));
    assert.equal(badRange.status, 400);
  } finally {
    await close();
  }
});

test('POST /api/triggers/test previews matches without persisting', async () => {
  const { api, close } = await startServer();
  try {
    const preview = await api('/api/triggers/test', json('POST', {
      config: { keywords: ['veleiro'] },
    }));
    assert.equal(preview.status, 200);
    assert.equal(preview.body.total, 1);
    assert.equal(preview.body.lots[0].category, 'EMBARCAÇÃO');
    assert.equal(preview.body.lots[0].pctOfAppraisal, 20);
    assert.match(preview.body.lots[0].officialUrl, /portal\/edital\/717600\/4\/2026\/lote\/1$/);
    assert.equal((await api('/api/triggers')).body.length, 0, 'nothing persisted');

    const invalid = await api('/api/triggers/test', json('POST', { config: {} }));
    assert.equal(invalid.status, 400);
  } finally {
    await close();
  }
});

test('GET /api/lots filters via query params', async () => {
  const { api, close } = await startServer();
  try {
    assert.equal((await api('/api/lots')).body.total, 3);
    assert.equal((await api('/api/lots?category=EMBARCA%C3%87%C3%83O')).body.total, 1);
    assert.equal((await api('/api/lots?keyword=macbook')).body.total, 1);
    assert.equal((await api('/api/lots?maxPrice=10000')).body.total, 2);
    assert.equal((await api('/api/lots?state=SP')).body.total, 0);
    assert.equal((await api('/api/lots?maxPctOfAppraisal=25')).body.total, 2, 'boat 20%, macbook 25%');
    const paged = await api('/api/lots?limit=2');
    assert.equal(paged.body.lots.length, 2);
    assert.equal(paged.body.total, 3);
  } finally {
    await close();
  }
});

test('GET /api/notices includes counts, labels and official links', async () => {
  const { api, close } = await startServer();
  try {
    const notices = (await api('/api/notices')).body;
    assert.equal(notices.length, 1);
    assert.equal(notices[0].storedLots, 3);
    assert.equal(notices[0].pendingDetails, 0);
    assert.equal(notices[0].statusLabel, 'Receiving proposals');
    assert.match(notices[0].officialUrl, /portal\/edital\/717600\/4\/2026$/);
  } finally {
    await close();
  }
});

test('settings round-trip and status endpoint', async () => {
  const { api, close } = await startServer();
  try {
    const status = await api('/api/status');
    assert.equal(status.body.running, false);
    assert.equal(status.body.ntfyTopic, 'env-default-topic', 'env-provided default used before any override');
    assert.equal(status.body.counts.lots, 3);

    const set = await api('/api/settings', json('PUT', { ntfyTopic: 'other-topic' }));
    assert.equal(set.body.ntfyTopic, 'other-topic');
    assert.equal((await api('/api/status')).body.ntfyTopic, 'other-topic');

    const bad = await api('/api/settings', json('PUT', { ntfyTopic: 42 }));
    assert.equal(bad.status, 400);
  } finally {
    await close();
  }
});

test('POST /api/run kicks the runner once and reports conflicts while running', async () => {
  let resolveRun;
  let runs = 0;
  const runner = () => { runs += 1; return new Promise((resolve) => { resolveRun = resolve; }); };
  const { api, close } = await startServer({ runner });
  try {
    assert.equal((await api('/api/run', { method: 'POST' })).status, 202);
    assert.equal((await api('/api/status')).body.running, true);
    assert.equal((await api('/api/run', { method: 'POST' })).status, 409);
    resolveRun();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal((await api('/api/status')).body.running, false);
    assert.equal(runs, 1);
  } finally {
    await close();
  }
});

test('POST /api/test-notification uses the transport and surfaces failures', async () => {
  const sent = [];
  const transports = {
    toast: async (message) => sent.push(message),
    ntfy: async () => { throw new Error('topic rejected'); },
  };
  const { api, close } = await startServer({ transports });
  try {
    const ok = await api('/api/test-notification', json('POST', { channel: 'toast' }));
    assert.equal(ok.status, 200);
    assert.equal(sent.length, 1);
    assert.match(sent[0].title, /test notification/);

    const failed = await api('/api/test-notification', json('POST', { channel: 'ntfy' }));
    assert.equal(failed.status, 502);
    assert.deepEqual(failed.body.problems, ['topic rejected']);

    const bad = await api('/api/test-notification', json('POST', { channel: 'carrier-pigeon' }));
    assert.equal(bad.status, 400);
  } finally {
    await close();
  }
});

test('GET /api/notifications returns history newest first', async () => {
  const { api, close, db } = await startServer();
  try {
    db.prepare(`INSERT INTO notifications (triggerId, noticeId, lotNumber, event, title, channelsJson, sentAt)
                VALUES (1, ?, 1, 'new_lot', 'older', '["toast"]', '2026-07-05T10:00:00Z'),
                       (1, ?, 2, 'new_lot', 'newer', '["ntfy"]', '2026-07-06T10:00:00Z')`)
      .run(NOTICE_ID, NOTICE_ID);
    const history = (await api('/api/notifications')).body;
    assert.equal(history.length, 2);
    assert.equal(history[0].title, 'newer');
    assert.deepEqual(history[0].channels, ['ntfy']);
  } finally {
    await close();
  }
});
