import test from 'node:test';
import assert from 'node:assert/strict';
import { computeNoticeEvents, parseApiDate } from '../src/events.js';

const NOW = new Date(2026, 6, 6, 12, 0); // 2026-07-06 12:00 local

test('parseApiDate parses SLE timestamps as local time', () => {
  const parsed = parseApiDate('2026-07-27 21:00');
  assert.equal(parsed.getFullYear(), 2026);
  assert.equal(parsed.getMonth(), 6);
  assert.equal(parsed.getDate(), 27);
  assert.equal(parsed.getHours(), 21);
  assert.equal(parseApiDate(null), null);
  assert.equal(parseApiDate('not a date'), null);
});

test('proposals_open fires only on transitions INTO status 3', () => {
  const events = computeNoticeEvents({
    notices: [],
    transitions: [
      { noticeId: 'A', from: 2, to: 3 },
      { noticeId: 'B', from: 3, to: 8 },
      { noticeId: 'C', from: 2, to: 8 },
    ],
    now: NOW,
    deadlineSoonHours: 24,
  });
  assert.deepEqual(events, [{ event: 'proposals_open', noticeId: 'A' }]);
});

test('deadline_soon fires inside the window only', () => {
  const notices = [
    { noticeId: 'IN', statusCode: 3, proposalsEndAt: '2026-07-07 10:00' },   // 22h away
    { noticeId: 'EDGE', statusCode: 3, proposalsEndAt: '2026-07-07 12:00' }, // exactly 24h
    { noticeId: 'FAR', statusCode: 3, proposalsEndAt: '2026-07-08 13:00' },  // 49h away
    { noticeId: 'PAST', statusCode: 3, proposalsEndAt: '2026-07-06 11:00' }, // already ended
    { noticeId: 'NODATE', statusCode: 3, proposalsEndAt: null },
  ];
  const events = computeNoticeEvents({ notices, transitions: [], now: NOW, deadlineSoonHours: 24 });
  assert.deepEqual(events.map((event) => event.noticeId), ['IN', 'EDGE']);
  assert.ok(events.every((event) => event.event === 'deadline_soon'));
});

test('deadline_soon never fires after the deadline (no late notifications)', () => {
  const justEnded = computeNoticeEvents({
    notices: [{ noticeId: 'X', proposalsEndAt: '2026-07-06 12:00' }],
    transitions: [],
    now: NOW,
    deadlineSoonHours: 24,
  });
  assert.deepEqual(justEnded, [], 'endsAt == now is not "soon", it is over');
});

test('window size is configurable', () => {
  const notices = [{ noticeId: 'A', proposalsEndAt: '2026-07-06 14:00' }]; // 2h away
  assert.equal(computeNoticeEvents({ notices, transitions: [], now: NOW, deadlineSoonHours: 1 }).length, 0);
  assert.equal(computeNoticeEvents({ notices, transitions: [], now: NOW, deadlineSoonHours: 3 }).length, 1);
});
