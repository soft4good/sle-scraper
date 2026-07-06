import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFileSync, readFileSync, unlinkSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createSleClient } from './api-client.js';
import { runScrape } from './scraper.js';
import { lotRowsForMatching } from './matcher.js';
import { computeNoticeEvents } from './events.js';
import { planNotifications, sendNotifications, createTransports } from './notify.js';
import { listTriggers, getMeta, setMeta } from './db.js';

const execFileAsync = promisify(execFile);
const LOCK_STALE_MS = 30 * 60 * 1000;

function acquireLock(lockPath) {
  if (existsSync(lockPath)) {
    try {
      const { pid, at } = JSON.parse(readFileSync(lockPath, 'utf8'));
      const alive = (() => { try { process.kill(pid, 0); return true; } catch { return false; } })();
      if (alive && Date.now() - at < LOCK_STALE_MS) return null;
    } catch { /* corrupt lock file → treat as stale */ }
  }
  writeFileSync(lockPath, JSON.stringify({ pid: process.pid, at: Date.now() }));
  return () => { try { unlinkSync(lockPath); } catch { /* already gone */ } };
}

/** Windows path of the toast script, needed by powershell.exe. */
async function windowsToastPath(config) {
  const { stdout } = await execFileAsync('wslpath', ['-w', config.toastScriptPath]);
  return stdout.trim();
}

/**
 * One full pass: scrape → detect events → match triggers → notify.
 * Returns the run summary, or null when another run holds the lock.
 */
export async function performRun({ db, config, log = console.log, transports = null, now = () => new Date() }) {
  const lockPath = join(dirname(config.dbPath), 'scrape.lock');
  const releaseLock = acquireLock(lockPath);
  if (!releaseLock) {
    log('run: another scrape is in progress, skipping');
    return null;
  }

  try {
    const client = createSleClient({
      baseUrl: config.baseUrl,
      userAgent: config.userAgent,
      requestSpacingMs: config.requestSpacingMs,
    });

    const isoNow = () => now().toISOString();
    const summary = await runScrape({ db, client, config, now: isoNow, log });

    const placeholders = config.activeStatusCodes.map(() => '?').join(',');
    const activeNotices = db.prepare(
      `SELECT noticeId, statusCode, proposalsEndAt FROM notices WHERE statusCode IN (${placeholders})`,
    ).all(...config.activeStatusCodes);

    const noticeEvents = computeNoticeEvents({
      notices: activeNotices,
      transitions: summary.statusTransitions,
      now: now(),
      deadlineSoonHours: config.deadlineSoonHours,
    });

    const triggers = listTriggers(db, { enabledOnly: true });
    const lots = lotRowsForMatching(db, config.activeStatusCodes);
    const messages = planNotifications({
      db, triggers, lots, noticeEvents, frontendUrl: config.frontendUrl, now: isoNow(),
    });

    const activeTransports = transports ?? createTransports({
      toastScriptPath: await windowsToastPath(config),
      ntfyServer: config.ntfyServer,
      getNtfyTopic: () => getMeta(db, 'ntfyTopic') ?? config.ntfyTopicDefault ?? null,
    });
    const delivery = await sendNotifications({ db, messages, transports: activeTransports, log });

    const result = { ...summary, noticeEvents: noticeEvents.length, messages: messages.length, ...delivery };
    setMeta(db, 'lastRunAt', isoNow());
    setMeta(db, 'lastRunSummary', JSON.stringify(result));
    log(`run: ${JSON.stringify(result)}`);
    return result;
  } finally {
    releaseLock();
  }
}
