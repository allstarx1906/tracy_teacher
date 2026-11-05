import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SESSION_STATUS,
  computeAttendanceReport,
  defaultAttendanceCatalog,
} from '../dist/ba-domain.js';
import {
  aggregateAttendanceReport,
  defaultReportPeriod,
  formatAttendanceRatePercent,
  resolveReportPeriodRange,
} from '../dist/ba-reports-aggregate.js';

const baseState = {
  classes: [
    { id: 'c1', name: 'Lớp 1' },
    { id: 'c2', name: 'Lớp 2' },
  ],
  students: [
    { id: 's1', name: 'An', classId: 'c1' },
    { id: 's2', name: 'Bình', classId: 'c2' },
  ],
  memberships: [
    { id: 'm1', classId: 'c1', studentId: 's1', effectiveFrom: '2020-01-01T00:00:00.000Z' },
    { id: 'm2', classId: 'c2', studentId: 's2', effectiveFrom: '2020-01-01T00:00:00.000Z' },
  ],
  attendanceStatusCatalog: defaultAttendanceCatalog(),
};

test('aggregateAttendanceReport: mixed classes, legacy status, cancelled, rate', () => {
  const state = {
    ...baseState,
    classSessions: [
      {
        id: 'sc',
        classId: 'c1',
        startAt: '2026-05-10T02:00:00.000Z',
        endAt: '2026-05-10T03:00:00.000Z',
        status: SESSION_STATUS.CANCELLED,
      },
      {
        id: 's1a',
        classId: 'c1',
        startAt: '2026-05-12T02:00:00.000Z',
        endAt: '2026-05-12T03:00:00.000Z',
        status: SESSION_STATUS.COMPLETED,
      },
      {
        id: 's2a',
        classId: 'c2',
        startAt: '2026-05-12T04:00:00.000Z',
        endAt: '2026-05-12T05:00:00.000Z',
        status: SESSION_STATUS.COMPLETED,
      },
    ],
    attendanceRecords: [
      { sessionId: 's1a', studentId: 's1', statusId: 'old-custom' },
      { sessionId: 's2a', studentId: 's2', statusId: 'absent' },
    ],
  };
  const report = computeAttendanceReport(state, {
    fromDate: '2026-05-01',
    toDate: '2026-05-31',
    includeFuture: false,
    nowIso: '2026-06-01T00:00:00.000Z',
  });
  const agg = aggregateAttendanceReport(report, { nowIso: '2026-06-01T00:00:00.000Z' });
  assert.equal(agg.kpis.cancelledSessions, 1);
  assert.equal(agg.kpis.sessionsNonCancelled, 2);
  assert.equal(agg.kpis.uniqueStudents, 2);
  assert.equal(agg.kpis.absentTotal, 1);
  assert.ok(agg.hasOtherStatuses);
  const s1 = agg.studentRows.find((r) => r.studentId === 's1');
  assert.equal(s1.other, 1);
  assert.equal(formatAttendanceRatePercent(s1.attendanceRate), '—');
  const s2 = agg.studentRows.find((r) => r.studentId === 's2');
  assert.equal(s2.absent, 1);
  assert.equal(formatAttendanceRatePercent(s2.attendanceRate), '0%');
});

test('aggregateAttendanceReport: future unmarked vs pending unmarked', () => {
  const state = {
    ...baseState,
    classSessions: [
      {
        id: 'past',
        classId: 'c1',
        startAt: '2026-05-01T02:00:00.000Z',
        endAt: '2026-05-01T03:00:00.000Z',
        status: SESSION_STATUS.COMPLETED,
      },
      {
        id: 'future',
        classId: 'c1',
        startAt: '2026-06-15T02:00:00.000Z',
        endAt: '2026-06-15T03:00:00.000Z',
        status: SESSION_STATUS.SCHEDULED,
      },
    ],
    attendanceRecords: [],
  };
  const report = computeAttendanceReport(state, {
    fromDate: '2026-05-01',
    toDate: '2026-06-30',
    includeFuture: true,
    nowIso: '2026-06-01T00:00:00.000Z',
  });
  const agg = aggregateAttendanceReport(report, { nowIso: '2026-06-01T00:00:00.000Z' });
  assert.equal(agg.kpis.pendingUnmarked, 1);
  assert.equal(agg.kpis.upcomingUnmarked, 1);
  const row = agg.studentRows[0];
  assert.equal(row.unmarked, 1);
  assert.equal(row.upcoming, 1);
});

test('defaultReportPeriod uses month start through today in BA', () => {
  const p = defaultReportPeriod('2026-05-18T04:00:00.000Z');
  assert.equal(p.fromDate, '2026-05-01');
  assert.equal(p.toDate, '2026-05-18');
  const last = resolveReportPeriodRange('last-month', '2026-05-18T04:00:00.000Z');
  assert.equal(last.fromDate, '2026-04-01');
  assert.equal(last.toDate, '2026-04-30');
});
