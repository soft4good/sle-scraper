import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS notices (
  noticeId TEXT PRIMARY KEY,
  shortId TEXT NOT NULL,
  unitCode TEXT NOT NULL,
  number TEXT NOT NULL,
  year TEXT NOT NULL,
  unitName TEXT,
  city TEXT,
  state TEXT,
  statusCode INTEGER NOT NULL,
  allowsIndividuals INTEGER NOT NULL DEFAULT 0,
  proposalsStartAt TEXT,
  proposalsEndAt TEXT,
  biddingStartsAt TEXT,
  lotCount INTEGER,
  firstSeenAt TEXT NOT NULL,
  lastSeenAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS lots (
  noticeId TEXT NOT NULL REFERENCES notices(noticeId),
  lotNumber INTEGER NOT NULL,
  category TEXT,
  minBid REAL,
  appraisalValue REAL,
  lotStatusCode INTEGER,
  featured INTEGER NOT NULL DEFAULT 0,
  allowsIndividuals INTEGER NOT NULL DEFAULT 0,
  hasImages INTEGER NOT NULL DEFAULT 0,
  thumbnailUrl TEXT,
  detailFetchedAt TEXT,
  searchText TEXT NOT NULL DEFAULT '',
  firstSeenAt TEXT NOT NULL,
  PRIMARY KEY (noticeId, lotNumber)
);

CREATE TABLE IF NOT EXISTS items (
  noticeId TEXT NOT NULL,
  lotNumber INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  description TEXT,
  quantity REAL,
  unit TEXT,
  warehouse TEXT,
  PRIMARY KEY (noticeId, lotNumber, seq)
);

CREATE TABLE IF NOT EXISTS triggers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  configJson TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  triggerId INTEGER NOT NULL,
  noticeId TEXT NOT NULL,
  lotNumber INTEGER NOT NULL,
  event TEXT NOT NULL,
  title TEXT,
  body TEXT,
  url TEXT,
  channelsJson TEXT,
  sentAt TEXT NOT NULL,
  UNIQUE (triggerId, noticeId, lotNumber, event)
);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE INDEX IF NOT EXISTS idx_lots_detail_pending ON lots(detailFetchedAt) WHERE detailFetchedAt IS NULL;
CREATE INDEX IF NOT EXISTS idx_notifications_sentAt ON notifications(sentAt);
`;

export function openDb(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('schemaVersion');
  if (!row) {
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('schemaVersion', String(SCHEMA_VERSION));
  }
  return db;
}

/** Insert or update a notice; preserves firstSeenAt. Returns previous statusCode or null. */
export function upsertNotice(db, notice, now) {
  const existing = db.prepare('SELECT statusCode FROM notices WHERE noticeId = ?').get(notice.noticeId);
  db.prepare(`
    INSERT INTO notices (noticeId, shortId, unitCode, number, year, unitName, city, state,
                         statusCode, allowsIndividuals, proposalsStartAt, proposalsEndAt,
                         biddingStartsAt, lotCount, firstSeenAt, lastSeenAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(noticeId) DO UPDATE SET
      shortId = excluded.shortId,
      unitName = excluded.unitName,
      city = excluded.city,
      state = excluded.state,
      statusCode = excluded.statusCode,
      allowsIndividuals = excluded.allowsIndividuals,
      proposalsStartAt = excluded.proposalsStartAt,
      proposalsEndAt = excluded.proposalsEndAt,
      biddingStartsAt = excluded.biddingStartsAt,
      lotCount = excluded.lotCount,
      lastSeenAt = excluded.lastSeenAt
  `).run(
    notice.noticeId, notice.shortId, notice.unitCode, notice.number, notice.year,
    notice.unitName ?? null, notice.city ?? null, notice.state ?? null,
    notice.statusCode, notice.allowsIndividuals ? 1 : 0,
    notice.proposalsStartAt ?? null, notice.proposalsEndAt ?? null,
    notice.biddingStartsAt ?? null, notice.lotCount ?? null, now, now,
  );
  return existing ? existing.statusCode : null;
}

/** Insert or update a lot; preserves firstSeenAt and detail columns. Returns true if new. */
export function upsertLot(db, lot, now) {
  const existing = db.prepare('SELECT 1 AS present FROM lots WHERE noticeId = ? AND lotNumber = ?')
    .get(lot.noticeId, lot.lotNumber);
  db.prepare(`
    INSERT INTO lots (noticeId, lotNumber, category, minBid, appraisalValue, lotStatusCode,
                      featured, allowsIndividuals, hasImages, thumbnailUrl, firstSeenAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(noticeId, lotNumber) DO UPDATE SET
      category = excluded.category,
      minBid = excluded.minBid,
      appraisalValue = excluded.appraisalValue,
      lotStatusCode = excluded.lotStatusCode,
      featured = excluded.featured,
      allowsIndividuals = excluded.allowsIndividuals,
      hasImages = excluded.hasImages,
      thumbnailUrl = excluded.thumbnailUrl
  `).run(
    lot.noticeId, lot.lotNumber, lot.category ?? null, lot.minBid ?? null,
    lot.appraisalValue ?? null, lot.lotStatusCode ?? null, lot.featured ? 1 : 0,
    lot.allowsIndividuals ? 1 : 0, lot.hasImages ? 1 : 0, lot.thumbnailUrl ?? null, now,
  );
  return !existing;
}

/** Replace a lot's items and mark its detail as fetched. */
export function saveLotDetail(db, noticeId, lotNumber, items, searchText, now) {
  db.prepare('DELETE FROM items WHERE noticeId = ? AND lotNumber = ?').run(noticeId, lotNumber);
  const insert = db.prepare(`
    INSERT INTO items (noticeId, lotNumber, seq, description, quantity, unit, warehouse)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  items.forEach((item, index) => {
    insert.run(noticeId, lotNumber, index + 1, item.description ?? null,
      item.quantity ?? null, item.unit ?? null, item.warehouse ?? null);
  });
  db.prepare('UPDATE lots SET searchText = ?, detailFetchedAt = ? WHERE noticeId = ? AND lotNumber = ?')
    .run(searchText, now, noticeId, lotNumber);
}

export function createTrigger(db, { name, enabled = true, config }, now) {
  const result = db.prepare(
    'INSERT INTO triggers (name, enabled, configJson, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)',
  ).run(name, enabled ? 1 : 0, JSON.stringify(config), now, now);
  return Number(result.lastInsertRowid);
}

export function updateTrigger(db, id, { name, enabled, config }, now) {
  const result = db.prepare(
    'UPDATE triggers SET name = ?, enabled = ?, configJson = ?, updatedAt = ? WHERE id = ?',
  ).run(name, enabled ? 1 : 0, JSON.stringify(config), now, id);
  return result.changes > 0;
}

export function deleteTrigger(db, id) {
  return db.prepare('DELETE FROM triggers WHERE id = ?').run(id).changes > 0;
}

export function listTriggers(db, { enabledOnly = false } = {}) {
  const rows = enabledOnly
    ? db.prepare('SELECT * FROM triggers WHERE enabled = 1 ORDER BY id').all()
    : db.prepare('SELECT * FROM triggers ORDER BY id').all();
  return rows.map((row) => ({
    id: Number(row.id),
    name: row.name,
    enabled: Boolean(row.enabled),
    config: JSON.parse(row.configJson),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }));
}

/**
 * Record a notification; returns false when this (trigger, notice, lot, event)
 * was already notified (dedup via unique constraint).
 */
export function recordNotification(db, notification, now) {
  const result = db.prepare(`
    INSERT OR IGNORE INTO notifications (triggerId, noticeId, lotNumber, event, title, body, url, channelsJson, sentAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    notification.triggerId, notification.noticeId, notification.lotNumber, notification.event,
    notification.title ?? null, notification.body ?? null, notification.url ?? null,
    JSON.stringify(notification.channels ?? []), now,
  );
  return result.changes > 0;
}

export function getMeta(db, key) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? row.value : null;
}

export function setMeta(db, key, value) {
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value);
}
