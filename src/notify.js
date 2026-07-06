import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { recordNotification } from './db.js';
import { evaluateTriggers } from './matcher.js';

const execFileAsync = promisify(execFile);

const DEFAULT_EVENTS = ['new_lot', 'proposals_open', 'deadline_soon'];
const DEFAULT_CHANNELS = ['toast'];
const NOTICE_LEVEL_LOT = 0; // sentinel lotNumber for notice-level events
const MAX_LOTS_IN_BODY = 4;

export function formatBRL(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '?';
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency', currency: 'BRL', maximumFractionDigits: 0,
  }).format(value);
}

function alreadyNotified(db, triggerId, noticeId, lotNumber, event) {
  return Boolean(db.prepare(
    'SELECT 1 AS present FROM notifications WHERE triggerId = ? AND noticeId = ? AND lotNumber = ? AND event = ?',
  ).get(triggerId, noticeId, lotNumber, event));
}

function describeLot(lot) {
  const place = lot.city || lot.unitName || '?';
  return `#${lot.lotNumber} ${lot.category ?? '?'} ${formatBRL(lot.minBid)} (${place})`;
}

function lotListBody(lots) {
  const shown = lots.slice(0, MAX_LOTS_IN_BODY).map(describeLot);
  const rest = lots.length - shown.length;
  return shown.join(' • ') + (rest > 0 ? ` • +${rest} more` : '');
}

/**
 * Decide what to send this run. Consults the notifications table for dedup and
 * records every covered (trigger, notice, lot, event) row. Returns messages:
 * { triggerId, triggerName, event, title, body, url, channels, records }.
 */
export function planNotifications({ db, triggers, lots, noticeEvents, frontendUrl, now }) {
  const messages = [];
  const matchesByTrigger = evaluateTriggers(triggers, lots);

  for (const trigger of triggers) {
    const events = trigger.config.events ?? DEFAULT_EVENTS;
    const channels = trigger.config.channels ?? DEFAULT_CHANNELS;
    const matching = matchesByTrigger.get(trigger.id) ?? [];
    if (matching.length === 0) continue;
    const url = `${frontendUrl}/#/triggers/${trigger.id}/matches`;

    if (events.includes('new_lot')) {
      const fresh = matching.filter(
        (lot) => !alreadyNotified(db, trigger.id, lot.noticeId, lot.lotNumber, 'new_lot'),
      );
      if (fresh.length > 0) {
        const message = {
          triggerId: trigger.id,
          triggerName: trigger.name,
          event: 'new_lot',
          title: `SLE · ${trigger.name}: ${fresh.length} new lot${fresh.length > 1 ? 's' : ''}`,
          body: lotListBody(fresh),
          url,
          channels,
          records: fresh.map((lot) => ({ noticeId: lot.noticeId, lotNumber: lot.lotNumber })),
        };
        for (const record of message.records) {
          recordNotification(db, {
            triggerId: trigger.id, noticeId: record.noticeId, lotNumber: record.lotNumber,
            event: 'new_lot', title: message.title, body: message.body, url, channels,
          }, now);
        }
        messages.push(message);
      }
    }

    for (const noticeEvent of noticeEvents) {
      if (!events.includes(noticeEvent.event)) continue;
      const lotsInNotice = matching.filter((lot) => lot.noticeId === noticeEvent.noticeId);
      if (lotsInNotice.length === 0) continue;
      if (alreadyNotified(db, trigger.id, noticeEvent.noticeId, NOTICE_LEVEL_LOT, noticeEvent.event)) continue;

      const title = noticeEvent.event === 'proposals_open'
        ? `SLE · ${trigger.name}: proposals now open`
        : `SLE · ${trigger.name}: proposal deadline soon`;
      const suffix = noticeEvent.event === 'deadline_soon' && lotsInNotice[0].proposalsEndAt
        ? ` — ends ${lotsInNotice[0].proposalsEndAt}`
        : '';
      const message = {
        triggerId: trigger.id,
        triggerName: trigger.name,
        event: noticeEvent.event,
        title,
        body: `${lotsInNotice.length} matching lot${lotsInNotice.length > 1 ? 's' : ''} in ${noticeEvent.noticeId}${suffix}: ${lotListBody(lotsInNotice)}`,
        url,
        channels,
        records: [{ noticeId: noticeEvent.noticeId, lotNumber: NOTICE_LEVEL_LOT }],
      };
      recordNotification(db, {
        triggerId: trigger.id, noticeId: noticeEvent.noticeId, lotNumber: NOTICE_LEVEL_LOT,
        event: noticeEvent.event, title, body: message.body, url, channels,
      }, now);
      messages.push(message);
    }
  }

  return messages;
}

/**
 * Send planned messages over their channels. A message whose every channel
 * fails has its dedup records deleted so it retries next run. Returns
 * { sent, failed }.
 */
export async function sendNotifications({ db, messages, transports, log = () => {} }) {
  let sent = 0;
  let failed = 0;

  for (const message of messages) {
    const delivered = [];
    for (const channel of message.channels) {
      const transport = transports[channel];
      if (!transport) continue;
      try {
        await transport(message);
        delivered.push(channel);
      } catch (error) {
        log(`notify: ${channel} failed for trigger ${message.triggerId}: ${error.message}`);
      }
    }

    if (delivered.length > 0) {
      sent += 1;
      const update = db.prepare(
        'UPDATE notifications SET channelsJson = ? WHERE triggerId = ? AND noticeId = ? AND lotNumber = ? AND event = ?',
      );
      for (const record of message.records) {
        update.run(JSON.stringify(delivered), message.triggerId, record.noticeId, record.lotNumber, message.event);
      }
    } else {
      failed += 1;
      const remove = db.prepare(
        'DELETE FROM notifications WHERE triggerId = ? AND noticeId = ? AND lotNumber = ? AND event = ?',
      );
      for (const record of message.records) {
        remove.run(message.triggerId, record.noticeId, record.lotNumber, message.event);
      }
    }
  }

  return { sent, failed };
}

/** Real delivery channels: Windows toast via powershell.exe, push via ntfy. */
// Absolute path: systemd services run with a minimal PATH that lacks /mnt/c interop dirs.
const DEFAULT_POWERSHELL = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';

export function createTransports({
  toastScriptPath,
  ntfyServer,
  getNtfyTopic,
  powershellPath = DEFAULT_POWERSHELL,
  execFileImpl = execFileAsync,
  fetchImpl = fetch,
}) {
  return {
    async toast(message) {
      const args = [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', toastScriptPath,
        '-Title', message.title,
        '-Body', message.body,
      ];
      if (message.url) args.push('-Url', message.url);
      await execFileImpl(powershellPath, args, { timeout: 30000 });
    },

    async ntfy(message) {
      const topic = getNtfyTopic();
      if (!topic) return; // channel not configured → silently skip
      const response = await fetchImpl(ntfyServer, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          topic,
          title: message.title,
          message: message.body,
          click: message.url || undefined,
          tags: ['moneybag'],
        }),
      });
      if (!response.ok) throw new Error(`ntfy HTTP ${response.status}`);
    },
  };
}
