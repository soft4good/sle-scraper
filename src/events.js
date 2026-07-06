/**
 * Notice-level event detection. Pure: takes plain data and an injected clock,
 * returns event descriptors. Lot-level "new_lot" events are not produced here —
 * they fall out of matching + the notifications dedup table (a lot notifies
 * once per trigger, ever).
 */

export const PROPOSALS_OPEN_STATUS = 3;

/** Parse an SLE API timestamp ("2026-07-27 21:00") as local time. */
export function parseApiDate(value) {
  if (!value) return null;
  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  if (!match) return null;
  const [, year, month, day, hour, minute] = match.map(Number);
  return new Date(year, month - 1, day, hour, minute);
}

/**
 * Compute notice-level events for one scrape pass.
 * - proposals_open: a notice transitioned into status 3 this pass.
 * - deadline_soon: an active notice's proposal window ends within the next
 *   `deadlineSoonHours` hours (and has not already ended).
 * Deduplication across runs is the notifications table's job, not ours.
 *
 * @param {Array} notices rows with { noticeId, statusCode, proposalsEndAt }
 * @param {Array} transitions [{ noticeId, from, to }] from this scrape pass
 * @param {Date} now injected clock
 * @param {number} deadlineSoonHours window size
 */
export function computeNoticeEvents({ notices, transitions, now, deadlineSoonHours }) {
  const events = [];

  for (const transition of transitions) {
    if (transition.to === PROPOSALS_OPEN_STATUS && transition.from !== PROPOSALS_OPEN_STATUS) {
      events.push({ event: 'proposals_open', noticeId: transition.noticeId });
    }
  }

  const windowEnd = new Date(now.getTime() + deadlineSoonHours * 3600 * 1000);
  for (const notice of notices) {
    const endsAt = parseApiDate(notice.proposalsEndAt);
    if (!endsAt) continue;
    if (endsAt > now && endsAt <= windowEnd) {
      events.push({ event: 'deadline_soon', noticeId: notice.noticeId, endsAt });
    }
  }

  return events;
}
