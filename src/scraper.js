import { upsertNotice, upsertLot, saveLotDetail } from './db.js';
import { normalizeText } from './text.js';

/**
 * One scrape pass:
 *  1. refresh the notices list (all statuses),
 *  2. refresh lots of active notices,
 *  3. fetch item details for lots that never had them (capped per run),
 * returning a summary of what changed. Failures on individual notices/lots are
 * collected, not fatal.
 */
export async function runScrape({ db, client, config, now = () => new Date().toISOString(), log = () => {} }) {
  const summary = {
    noticesSeen: 0,
    statusTransitions: [],
    newLots: 0,
    detailsFetched: 0,
    errors: [],
  };

  const { notices } = await client.fetchNoticesList();
  const activeStatusCodes = new Set(config.activeStatusCodes);
  const activeNotices = [];

  for (const notice of notices) {
    const previousStatus = upsertNotice(db, notice, now());
    summary.noticesSeen += 1;
    if (previousStatus !== null && previousStatus !== notice.statusCode) {
      summary.statusTransitions.push({
        noticeId: notice.noticeId,
        from: previousStatus,
        to: notice.statusCode,
      });
    }
    if (activeStatusCodes.has(notice.statusCode)) activeNotices.push(notice);
  }
  log(`notices: ${summary.noticesSeen} seen, ${activeNotices.length} active`);

  for (const notice of activeNotices) {
    try {
      const lots = await client.fetchNoticeLots(notice.noticeId);
      for (const lot of lots) {
        if (upsertLot(db, lot, now())) summary.newLots += 1;
      }
    } catch (error) {
      summary.errors.push({ noticeId: notice.noticeId, step: 'lots', message: error.message });
    }
  }
  log(`lots: ${summary.newLots} new`);

  const pending = db.prepare(`
    SELECT l.noticeId, l.lotNumber, l.category
    FROM lots l JOIN notices n ON n.noticeId = l.noticeId
    WHERE l.detailFetchedAt IS NULL AND n.statusCode IN (${[...activeStatusCodes].map(() => '?').join(',')})
    ORDER BY l.firstSeenAt, l.noticeId, l.lotNumber
    LIMIT ?
  `).all(...activeStatusCodes, config.maxLotDetailsPerRun);

  for (const row of pending) {
    try {
      const items = await client.fetchLotItems(row.noticeId, row.lotNumber);
      const searchText = normalizeText(
        [row.category, ...items.map((item) => item.description)].filter(Boolean).join(' \n '),
      );
      saveLotDetail(db, row.noticeId, row.lotNumber, items, searchText, now());
      summary.detailsFetched += 1;
    } catch (error) {
      summary.errors.push({
        noticeId: row.noticeId, lotNumber: row.lotNumber, step: 'detail', message: error.message,
      });
    }
  }
  log(`details: ${summary.detailsFetched} fetched, ${summary.errors.length} errors`);

  return summary;
}
