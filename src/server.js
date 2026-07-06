import express from 'express';
import { join } from 'node:path';
import { openDb, listTriggers, createTrigger, updateTrigger, deleteTrigger, getMeta, setMeta } from './db.js';
import { validateTriggerConfig, triggerMatchesLot, lotRowsForMatching, EVENT_TYPES, CHANNEL_TYPES } from './matcher.js';
import { OFFICIAL_CATEGORIES, BRAZIL_STATES, STATUS_LABELS } from './catalog.js';
import { loadConfig, projectRoot, officialNoticeUrl, officialLotUrl } from './config.js';
import { performRun } from './run.js';
import { createTransports } from './notify.js';

/** Build a matcher config from /api/lots query parameters (all optional). */
function filterConfigFromQuery(query) {
  const config = {};
  if (query.keyword) config.keywords = [String(query.keyword)];
  if (query.category) config.categories = String(query.category).split('|');
  if (query.state) config.states = String(query.state).split('|');
  if (query.city) config.cities = String(query.city).split('|');
  if (query.minPrice) config.minPrice = Number(query.minPrice);
  if (query.maxPrice) config.maxPrice = Number(query.maxPrice);
  if (query.maxPctOfAppraisal) config.maxPctOfAppraisal = Number(query.maxPctOfAppraisal);
  if (query.individuals === '1') config.individualsOnly = true;
  if (query.images === '1') config.requireImages = true;
  if (query.featured === '1') config.featuredOnly = true;
  return config;
}

function decorateLot(lot, config) {
  return {
    ...lot,
    featured: Boolean(lot.featured),
    hasImages: Boolean(lot.hasImages),
    allowsIndividuals: Boolean(lot.allowsIndividuals || lot.noticeAllowsIndividuals),
    pctOfAppraisal: lot.appraisalValue > 0 && lot.minBid != null
      ? Math.round((lot.minBid / lot.appraisalValue) * 100)
      : null,
    statusLabel: STATUS_LABELS[lot.statusCode] ?? `status ${lot.statusCode}`,
    officialUrl: officialLotUrl(config.baseUrl, lot.shortId, lot.lotNumber),
  };
}

export function createApp({ db, config, transports = null, runner = performRun }) {
  const app = express();
  app.use(express.json());

  const runState = { running: false };

  app.get('/api/options', (req, res) => {
    const cities = db.prepare(
      'SELECT DISTINCT city FROM notices WHERE city IS NOT NULL ORDER BY city',
    ).all().map((row) => row.city);
    res.json({
      categories: OFFICIAL_CATEGORIES,
      states: BRAZIL_STATES,
      cities,
      events: EVENT_TYPES,
      channels: CHANNEL_TYPES,
    });
  });

  app.get('/api/triggers', (req, res) => {
    res.json(listTriggers(db));
  });

  app.post('/api/triggers', (req, res) => {
    const { name, enabled = true, config: triggerConfig } = req.body ?? {};
    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ problems: ['name is required'] });
    }
    const problems = validateTriggerConfig(triggerConfig);
    if (problems.length > 0) return res.status(400).json({ problems });
    const id = createTrigger(db, { name: name.trim(), enabled, config: triggerConfig }, new Date().toISOString());
    res.status(201).json(listTriggers(db).find((trigger) => trigger.id === id));
  });

  app.put('/api/triggers/:id', (req, res) => {
    const id = Number(req.params.id);
    const existing = listTriggers(db).find((trigger) => trigger.id === id);
    if (!existing) return res.status(404).json({ problems: ['trigger not found'] });
    const { name = existing.name, enabled = existing.enabled, config: triggerConfig = existing.config } = req.body ?? {};
    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ problems: ['name is required'] });
    }
    const problems = validateTriggerConfig(triggerConfig);
    if (problems.length > 0) return res.status(400).json({ problems });
    updateTrigger(db, id, { name: name.trim(), enabled, config: triggerConfig }, new Date().toISOString());
    res.json(listTriggers(db).find((trigger) => trigger.id === id));
  });

  app.delete('/api/triggers/:id', (req, res) => {
    if (!deleteTrigger(db, Number(req.params.id))) {
      return res.status(404).json({ problems: ['trigger not found'] });
    }
    res.status(204).end();
  });

  app.post('/api/triggers/test', (req, res) => {
    const triggerConfig = req.body?.config;
    const problems = validateTriggerConfig(triggerConfig);
    if (problems.length > 0) return res.status(400).json({ problems });
    const lots = lotRowsForMatching(db, config.activeStatusCodes)
      .filter((lot) => triggerMatchesLot(triggerConfig, lot));
    res.json({
      total: lots.length,
      lots: lots.slice(0, 50).map((lot) => decorateLot(lot, config)),
    });
  });

  app.get('/api/lots', (req, res) => {
    const filter = filterConfigFromQuery(req.query);
    let lots = lotRowsForMatching(db, config.activeStatusCodes);
    if (Object.keys(filter).length > 0) {
      lots = lots.filter((lot) => triggerMatchesLot(filter, lot));
    }
    lots.sort((a, b) => String(a.proposalsEndAt).localeCompare(String(b.proposalsEndAt))
      || (a.minBid ?? Infinity) - (b.minBid ?? Infinity));
    const limit = Math.min(Number(req.query.limit) || 60, 200);
    const offset = Number(req.query.offset) || 0;
    res.json({
      total: lots.length,
      lots: lots.slice(offset, offset + limit).map((lot) => decorateLot(lot, config)),
    });
  });

  app.get('/api/notices', (req, res) => {
    const notices = db.prepare(`
      SELECT n.*, COUNT(l.lotNumber) AS storedLots,
             SUM(CASE WHEN l.detailFetchedAt IS NULL THEN 1 ELSE 0 END) AS pendingDetails
      FROM notices n LEFT JOIN lots l ON l.noticeId = n.noticeId
      GROUP BY n.noticeId ORDER BY n.statusCode, n.proposalsEndAt
    `).all().map((notice) => ({
      ...notice,
      allowsIndividuals: Boolean(notice.allowsIndividuals),
      statusLabel: STATUS_LABELS[notice.statusCode] ?? `status ${notice.statusCode}`,
      officialUrl: officialNoticeUrl(config.baseUrl, notice.shortId),
    }));
    res.json(notices);
  });

  app.get('/api/notifications', (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const rows = db.prepare(
      'SELECT * FROM notifications ORDER BY sentAt DESC, id DESC LIMIT ?',
    ).all(limit).map((row) => ({ ...row, channels: JSON.parse(row.channelsJson ?? '[]') }));
    res.json(rows);
  });

  app.get('/api/status', (req, res) => {
    const counts = {
      notices: db.prepare('SELECT COUNT(*) AS n FROM notices').get().n,
      lots: db.prepare('SELECT COUNT(*) AS n FROM lots').get().n,
      pendingDetails: db.prepare('SELECT COUNT(*) AS n FROM lots WHERE detailFetchedAt IS NULL').get().n,
      notifications: db.prepare('SELECT COUNT(*) AS n FROM notifications').get().n,
    };
    res.json({
      running: runState.running,
      lastRunAt: getMeta(db, 'lastRunAt'),
      lastRunSummary: JSON.parse(getMeta(db, 'lastRunSummary') ?? 'null'),
      ntfyTopic: getMeta(db, 'ntfyTopic') ?? config.ntfyTopicDefault ?? null,
      counts,
    });
  });

  app.put('/api/settings', (req, res) => {
    const { ntfyTopic } = req.body ?? {};
    if (ntfyTopic !== null && ntfyTopic !== undefined && typeof ntfyTopic !== 'string') {
      return res.status(400).json({ problems: ['ntfyTopic must be a string or null'] });
    }
    setMeta(db, 'ntfyTopic', ntfyTopic ? ntfyTopic.trim() : null);
    res.json({ ntfyTopic: getMeta(db, 'ntfyTopic') });
  });

  app.post('/api/run', (req, res) => {
    if (runState.running) return res.status(409).json({ problems: ['a run is already in progress'] });
    runState.running = true;
    runner({ db, config, transports, log: (line) => console.log(`[run] ${line}`) })
      .catch((error) => console.error(`[run] failed: ${error.stack}`))
      .finally(() => { runState.running = false; });
    res.status(202).json({ started: true });
  });

  app.post('/api/test-notification', async (req, res) => {
    const channel = req.body?.channel;
    if (!CHANNEL_TYPES.includes(channel)) {
      return res.status(400).json({ problems: [`channel must be one of: ${CHANNEL_TYPES.join(', ')}`] });
    }
    try {
      const active = transports ?? await defaultTransports(db, config);
      await active[channel]({
        title: 'SLE Watcher — test notification',
        body: `The ${channel} channel works. Fired at ${new Date().toLocaleString()}.`,
        url: config.frontendUrl,
      });
      res.json({ ok: true });
    } catch (error) {
      res.status(502).json({ problems: [error.message] });
    }
  });

  app.use(express.static(join(projectRoot, 'public')));
  return app;
}

async function defaultTransports(db, config) {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { stdout } = await promisify(execFile)('wslpath', ['-w', config.toastScriptPath]);
  return createTransports({
    toastScriptPath: stdout.trim(),
    ntfyServer: config.ntfyServer,
    getNtfyTopic: () => getMeta(db, 'ntfyTopic') ?? config.ntfyTopicDefault ?? null,
  });
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (isMain) {
  const config = loadConfig();
  const db = openDb(config.dbPath);
  const app = createApp({ db, config });
  // Bind to loopback only: the UI has no auth and must not be reachable from the network.
  app.listen(config.port, '127.0.0.1', () => console.log(`SLE watcher UI on ${config.frontendUrl}`));
}
