import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { chromium } from 'playwright';
import { openDb, upsertNotice, upsertLot, saveLotDetail } from '../../src/db.js';
import { createApp } from '../../src/server.js';

const NOW = '2026-07-06T12:00:00Z';
const RJ_NOTICE = '0717600/000004/2026';
const PR_NOTICE = '0900100/000008/2026';
const SCREENSHOTS = join(dirname(fileURLToPath(import.meta.url)), 'screenshots');

// 1x1 blue PNG so lot cards render an image without touching the network.
const PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const CONFIG = {
  port: 0,
  baseUrl: 'https://www25.receita.fazenda.gov.br/sle-sociedade/',
  activeStatusCodes: [2, 3, 8],
  frontendUrl: 'http://localhost:8377',
  ntfyServer: 'https://ntfy.test',
  ntfyTopicDefault: 'env-default-topic',
};

let db;
let server;
let browser;
let page;
let base;
const sentTestNotifications = [];

function seed() {
  db = openDb(':memory:');
  upsertNotice(db, {
    noticeId: RJ_NOTICE, shortId: '717600/4/2026', unitCode: '0717600', number: '000004',
    year: '2026', unitName: 'PORTO DO RIO DE JANEIRO', city: 'RIO DE JANEIRO', state: 'RJ',
    statusCode: 3, allowsIndividuals: true, proposalsEndAt: '2026-07-15 21:00', lotCount: 2,
  }, NOW);
  upsertNotice(db, {
    noticeId: PR_NOTICE, shortId: '900100/8/2026', unitCode: '0900100', number: '000008',
    year: '2026', unitName: 'SRRF 9ª RF', city: 'CURITIBA', state: 'PR',
    statusCode: 2, allowsIndividuals: false, proposalsEndAt: '2026-07-27 21:00', lotCount: 1,
  }, NOW);

  const lots = [
    { noticeId: RJ_NOTICE, lotNumber: 1, category: 'EMBARCAÇÃO', minBid: 30000, appraisalValue: 150000, allowsIndividuals: true, text: 'VELEIRO OCEANICO BENETEAU 40 PES', thumbnailUrl: PIXEL },
    { noticeId: RJ_NOTICE, lotNumber: 2, category: 'VEÍCULO', minBid: 8000, appraisalValue: 20000, allowsIndividuals: true, text: 'FIAT UNO 2015 BRANCO' },
    { noticeId: PR_NOTICE, lotNumber: 1, category: 'NOTEBOOK', minBid: 1500, appraisalValue: 6000, allowsIndividuals: false, text: 'MACBOOK PRO M3 16GB' },
  ];
  for (const lot of lots) {
    upsertLot(db, { ...lot, hasImages: Boolean(lot.thumbnailUrl) }, NOW);
    saveLotDetail(db, lot.noticeId, lot.lotNumber, [{ description: lot.text }],
      `${lot.category} ${lot.text}`.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase(), NOW);
  }

  db.prepare(`INSERT INTO notifications (triggerId, noticeId, lotNumber, event, title, body, url, channelsJson, sentAt)
              VALUES (1, ?, 1, 'new_lot', 'SLE · Boats: 1 new lot', 'body', 'http://localhost:8377/#/triggers?matches=1', '["toast","ntfy"]', ?)`)
    .run(RJ_NOTICE, NOW);
}

before(async () => {
  mkdirSync(SCREENSHOTS, { recursive: true });
  seed();
  const transports = {
    toast: async (message) => sentTestNotifications.push({ channel: 'toast', message }),
    ntfy: async (message) => sentTestNotifications.push({ channel: 'ntfy', message }),
  };
  const app = createApp({ db, config: CONFIG, transports });
  server = await new Promise((resolve) => {
    const listening = app.listen(0, () => resolve(listening));
  });
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('dialog', (dialog) => dialog.accept());
});

after(async () => {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  db.close();
});

const shot = (name) => page.screenshot({ path: join(SCREENSHOTS, name), fullPage: true });

test('triggers page shows empty state', async () => {
  await page.goto(`${base}/#/triggers`);
  await page.waitForSelector('[data-testid="trigger-list"]');
  assert.match(await page.textContent('[data-testid="trigger-list"]'), /No triggers yet/);
  await shot('01-triggers-empty.png');
});

test('create a trigger through the form', async () => {
  await page.fill('[data-testid="trigger-form"] input[name="name"]', 'Sailboats RJ');
  await page.fill('input[name="keywords"]', 'veleiro, barco a vela');
  await page.check('[data-chips="states"] input[value="RJ"]');
  await page.fill('input[name="maxPrice"]', '50000');
  await page.check('input[name="individualsOnly"]');
  await shot('02-trigger-form-filled.png');
  await page.click('[data-testid="trigger-form"] button[type="submit"]');
  await page.waitForSelector('.trigger-row');

  const row = await page.textContent('.trigger-row');
  assert.match(row, /Sailboats RJ/);
  assert.match(row, /veleiro/);
  assert.match(row, /RJ/);
  await shot('03-trigger-created.png');
});

test('live preview shows matching lots', async () => {
  await page.click('.trigger-row button:has-text("Edit")');
  await page.waitForSelector('[data-testid="preview-button"]');
  await page.click('[data-testid="preview-button"]');
  await page.waitForSelector('[data-testid="preview-count"]');
  assert.match(await page.textContent('[data-testid="preview-count"]'), /Currently matches 1 lot/);
  const card = await page.textContent('[data-testid="preview-area"] .lot-card');
  assert.match(card, /EMBARCAÇÃO/);
  assert.match(card, /30\.000/);
  await shot('04-trigger-preview.png');
});

test('validation errors surface in the form', async () => {
  await page.goto(`${base}/#/triggers`);
  await page.waitForSelector('[data-testid="trigger-form"]');
  await page.fill('[data-testid="trigger-form"] input[name="name"]', 'Broken');
  await page.click('[data-testid="trigger-form"] button[type="submit"]');
  await page.waitForSelector('[data-testid="form-message"] .msg.error');
  assert.match(await page.textContent('[data-testid="form-message"]'), /at least one filter condition/);
  await shot('05-validation-error.png');
});

test('browse page lists and filters lots', async () => {
  await page.goto(`${base}/#/browse`);
  await page.waitForSelector('[data-testid="browse-count"]');
  assert.equal(await page.textContent('[data-testid="browse-count"]'), '3');
  const cards = await page.locator('.lot-card').count();
  assert.equal(cards, 3);
  await shot('06-browse-all.png');

  await page.fill('[data-testid="browse-form"] input[name="keyword"]', 'macbook');
  await page.click('[data-testid="browse-form"] button[type="submit"]');
  await page.waitForFunction(() => document.querySelector('[data-testid="browse-count"]')?.textContent === '1');
  const card = await page.textContent('.lot-card');
  assert.match(card, /NOTEBOOK/);
  assert.match(card, /Companies only/);
  await shot('07-browse-filtered.png');

  const link = await page.getAttribute('.lot-card a', 'href');
  assert.equal(link, 'https://www25.receita.fazenda.gov.br/sle-sociedade/portal/edital/900100/8/2026/lote/1');
});

test('notifications history renders', async () => {
  await page.goto(`${base}/#/notifications`);
  await page.waitForSelector('table');
  const table = await page.textContent('table');
  assert.match(table, /SLE · Boats: 1 new lot/);
  assert.match(table, /toast, ntfy/);
  assert.match(table, /New matching lot/);
  await shot('08-notifications.png');
});

test('settings saves ntfy topic and fires test notifications', async () => {
  await page.goto(`${base}/#/settings`);
  await page.waitForSelector('#ntfy-topic');
  assert.equal(await page.inputValue('#ntfy-topic'), 'env-default-topic', 'default topic prefilled');

  await page.fill('#ntfy-topic', 'my-custom-topic');
  await page.click('button:has-text("Save")');
  await page.waitForSelector('.msg.ok');

  await page.click('[data-testid="test-toast"]');
  await page.waitForFunction(() => document.querySelector('.msg.ok')?.textContent.includes('Toast sent'));
  await page.click('[data-testid="test-ntfy"]');
  await page.waitForFunction(() => document.querySelector('.msg.ok')?.textContent.includes('Push sent'));

  assert.deepEqual(sentTestNotifications.map((entry) => entry.channel), ['toast', 'ntfy']);
  assert.match(sentTestNotifications[0].message.title, /test notification/);
  await shot('09-settings.png');
});

test('trigger matches deep link (used by toast/ntfy click-through)', async () => {
  await page.goto(`${base}/#/triggers?matches=1`);
  await page.waitForSelector('.lot-card');
  const heading = await page.textContent('h2');
  assert.match(heading, /Current matches for .Sailboats RJ./);
  await shot('10-matches-deeplink.png');
});

test('delete trigger from the list', async () => {
  await page.goto(`${base}/#/triggers`);
  await page.waitForSelector('.trigger-row');
  await page.click('.trigger-row button:has-text("Delete")');
  await page.waitForSelector('[data-testid="trigger-list"] p.muted');
  assert.match(await page.textContent('[data-testid="trigger-list"]'), /No triggers yet/);
  await shot('11-trigger-deleted.png');
});
