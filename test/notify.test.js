import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb, upsertNotice, upsertLot, saveLotDetail, listTriggers, createTrigger } from '../src/db.js';
import { lotRowsForMatching } from '../src/matcher.js';
import { planNotifications, sendNotifications, createTransports, formatBRL } from '../src/notify.js';

const NOW = '2026-07-06T12:00:00Z';
const FRONTEND = 'http://localhost:8377';
const NOTICE_ID = '0717600/000004/2026';

function seedDb({ lotCount = 2 } = {}) {
  const db = openDb(':memory:');
  upsertNotice(db, {
    noticeId: NOTICE_ID, shortId: '717600/4/2026', unitCode: '0717600', number: '000004',
    year: '2026', unitName: 'PORTO DO RIO DE JANEIRO', city: 'RIO DE JANEIRO', state: 'RJ',
    statusCode: 3, allowsIndividuals: true, proposalsEndAt: '2026-07-15 21:00', lotCount,
  }, NOW);
  for (let lotNumber = 1; lotNumber <= lotCount; lotNumber += 1) {
    upsertLot(db, {
      noticeId: NOTICE_ID, lotNumber, category: 'EMBARCAÇÃO', minBid: 10000 * lotNumber,
      appraisalValue: 50000 * lotNumber, allowsIndividuals: true, hasImages: true,
    }, NOW);
    saveLotDetail(db, NOTICE_ID, lotNumber, [{ description: `VELEIRO ${lotNumber}` }],
      `EMBARCACAO VELEIRO ${lotNumber}`, NOW);
  }
  return db;
}

function seedTrigger(db, config = { keywords: ['veleiro'] }) {
  const id = createTrigger(db, { name: 'Sailboats', config }, NOW);
  return listTriggers(db).find((trigger) => trigger.id === id);
}

function plan(db, trigger, { noticeEvents = [] } = {}) {
  return planNotifications({
    db,
    triggers: [trigger],
    lots: lotRowsForMatching(db, [2, 3, 8]),
    noticeEvents,
    frontendUrl: FRONTEND,
    now: NOW,
  });
}

test('formatBRL formats and tolerates garbage', () => {
  assert.match(formatBRL(15000), /R\$\s?15\.000/);
  assert.equal(formatBRL(null), '?');
  assert.equal(formatBRL(Number.NaN), '?');
});

test('new_lot matches batch into ONE message per trigger per run', () => {
  const db = seedDb({ lotCount: 6 });
  const trigger = seedTrigger(db);
  const messages = plan(db, trigger);

  assert.equal(messages.length, 1, 'one batched message, not six');
  assert.equal(messages[0].event, 'new_lot');
  assert.match(messages[0].title, /6 new lots/);
  assert.match(messages[0].body, /\+2 more/, 'body lists 4 lots then a remainder');
  assert.equal(messages[0].records.length, 6);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM notifications').get().n, 6, 'per-lot dedup rows');
  db.close();
});

test('second plan run produces nothing (dedup across runs)', () => {
  const db = seedDb();
  const trigger = seedTrigger(db);
  assert.equal(plan(db, trigger).length, 1);
  assert.equal(plan(db, trigger).length, 0, 'already notified');
  db.close();
});

test('a new lot appearing later notifies only that lot', () => {
  const db = seedDb({ lotCount: 2 });
  const trigger = seedTrigger(db);
  plan(db, trigger);

  upsertLot(db, {
    noticeId: NOTICE_ID, lotNumber: 3, category: 'EMBARCAÇÃO', minBid: 99000,
    appraisalValue: 200000, allowsIndividuals: true, hasImages: true,
  }, NOW);
  saveLotDetail(db, NOTICE_ID, 3, [{ description: 'VELEIRO NOVO' }], 'EMBARCACAO VELEIRO NOVO', NOW);

  const messages = plan(db, trigger);
  assert.equal(messages.length, 1);
  assert.match(messages[0].title, /1 new lot$/);
  assert.match(messages[0].body, /#3/);
  db.close();
});

test('notice-level events notify once, only for triggers with matching lots', () => {
  const db = seedDb();
  const matchingTrigger = seedTrigger(db);
  const otherTrigger = seedTrigger(db, { keywords: ['helicoptero'] });
  const noticeEvents = [{ event: 'proposals_open', noticeId: NOTICE_ID }];

  const messages = planNotifications({
    db,
    triggers: [matchingTrigger, otherTrigger],
    lots: lotRowsForMatching(db, [2, 3, 8]),
    noticeEvents,
    frontendUrl: FRONTEND,
    now: NOW,
  });
  const openMessages = messages.filter((message) => message.event === 'proposals_open');
  assert.equal(openMessages.length, 1, 'only the matching trigger notifies');
  assert.equal(openMessages[0].triggerId, matchingTrigger.id);

  const again = plan(db, matchingTrigger, { noticeEvents });
  assert.equal(again.filter((message) => message.event === 'proposals_open').length, 0, 'dedup on rerun');
  db.close();
});

test('deadline_soon message mentions the deadline', () => {
  const db = seedDb();
  const trigger = seedTrigger(db, { keywords: ['veleiro'], events: ['deadline_soon'] });
  const messages = plan(db, trigger, { noticeEvents: [{ event: 'deadline_soon', noticeId: NOTICE_ID }] });
  assert.equal(messages.length, 1);
  assert.match(messages[0].body, /2026-07-15 21:00/);
  db.close();
});

test('trigger without new_lot in events never sends lot batches', () => {
  const db = seedDb();
  const trigger = seedTrigger(db, { keywords: ['veleiro'], events: ['proposals_open'] });
  assert.equal(plan(db, trigger).length, 0);
  db.close();
});

test('sendNotifications fans out to channels and records what was delivered', async () => {
  const db = seedDb();
  const trigger = seedTrigger(db, { keywords: ['veleiro'], channels: ['toast', 'ntfy'] });
  const messages = plan(db, trigger);
  const calls = { toast: 0, ntfy: 0 };
  const result = await sendNotifications({
    db,
    messages,
    transports: { toast: async () => { calls.toast += 1; }, ntfy: async () => { calls.ntfy += 1; } },
  });
  assert.deepEqual(result, { sent: 1, failed: 0 });
  assert.equal(calls.toast, 1);
  assert.equal(calls.ntfy, 1);
  const row = db.prepare('SELECT channelsJson FROM notifications LIMIT 1').get();
  assert.deepEqual(JSON.parse(row.channelsJson), ['toast', 'ntfy']);
  db.close();
});

test('partial channel failure still counts as sent and keeps dedup', async () => {
  const db = seedDb();
  const trigger = seedTrigger(db, { keywords: ['veleiro'], channels: ['toast', 'ntfy'] });
  const messages = plan(db, trigger);
  const logs = [];
  const result = await sendNotifications({
    db,
    messages,
    transports: {
      toast: async () => { throw new Error('powershell exploded'); },
      ntfy: async () => {},
    },
    log: (line) => logs.push(line),
  });
  assert.deepEqual(result, { sent: 1, failed: 0 });
  assert.ok(logs.some((line) => line.includes('powershell exploded')));
  assert.equal(plan(db, trigger).length, 0, 'dedup rows kept');
  const row = db.prepare('SELECT channelsJson FROM notifications LIMIT 1').get();
  assert.deepEqual(JSON.parse(row.channelsJson), ['ntfy'], 'only the delivered channel recorded');
  db.close();
});

test('total channel failure releases dedup rows so next run retries', async () => {
  const db = seedDb();
  const trigger = seedTrigger(db, { keywords: ['veleiro'], channels: ['toast'] });
  const messages = plan(db, trigger);
  const result = await sendNotifications({
    db,
    messages,
    transports: { toast: async () => { throw new Error('boom'); } },
  });
  assert.deepEqual(result, { sent: 0, failed: 1 });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM notifications').get().n, 0, 'records released');
  assert.equal(plan(db, trigger).length, 1, 'retried on next run');
  db.close();
});

test('toast transport shells out to powershell (absolute path) with script and args', async () => {
  const invocations = [];
  const transports = createTransports({
    toastScriptPath: 'C:\\wsl\\toast.ps1',
    ntfyServer: 'https://ntfy.sh',
    getNtfyTopic: () => null,
    execFileImpl: async (command, args) => { invocations.push({ command, args }); },
  });
  await transports.toast({ title: 'T', body: 'B', url: 'http://localhost:8377/#x' });
  assert.equal(invocations.length, 1);
  assert.equal(invocations[0].command, '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',
    'absolute path — systemd services lack /mnt/c interop dirs in PATH');
  const args = invocations[0].args;
  assert.ok(args.includes('-File') && args.includes('C:\\wsl\\toast.ps1'));
  assert.equal(args[args.indexOf('-Title') + 1], 'T');
  assert.equal(args[args.indexOf('-Url') + 1], 'http://localhost:8377/#x');
});

test('ntfy transport publishes JSON, skips silently without topic, throws on HTTP error', async () => {
  const posts = [];
  let topic = 'my-topic';
  let status = 200;
  const transports = createTransports({
    toastScriptPath: 'x',
    ntfyServer: 'https://ntfy.example',
    getNtfyTopic: () => topic,
    fetchImpl: async (url, options) => { posts.push({ url, options }); return { ok: status === 200, status }; },
  });

  await transports.ntfy({ title: 'Título ção', body: 'corpo', url: 'http://x' });
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, 'https://ntfy.example');
  const payload = JSON.parse(posts[0].options.body);
  assert.equal(payload.topic, 'my-topic');
  assert.equal(payload.title, 'Título ção', 'UTF-8 safe via JSON publish');
  assert.equal(payload.click, 'http://x');

  topic = null;
  await transports.ntfy({ title: 't', body: 'b' });
  assert.equal(posts.length, 1, 'no topic → no request');

  topic = 'back';
  status = 500;
  await assert.rejects(() => transports.ntfy({ title: 't', body: 'b' }), /ntfy HTTP 500/);
});
