import test from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultAttendanceCatalog,
  localDateKey,
  localDateTimeToUtcIso,
  SESSION_STATUS,
} from '../dist/ba-domain.js';
import {
  addDaysToDateKey,
  buildMondayFirstMonthGrid,
  computeStudentAttendanceCalendarMonth,
  currentMonthKeyInBa,
  parseMonthKey,
  resolveCalendarMonthKey,
  shiftMonthKey,
  studentsEligibleForCalendarFilter,
} from '../dist/ba-attendance-calendar.js';

function baseState(overrides = {}) {
  return {
    classes: [{ id: 'c1', name: 'Lớp A' }],
    students: [{ id: 's1', name: 'HS 1' }, { id: 's2', name: 'HS 2' }],
    memberships: [{
      classId: 'c1',
      studentId: 's1',
      effectiveFrom: '2020-01-01T00:00:00.000Z',
    }],
    classSessions: [],
    attendanceRecords: [],
    attendanceStatusCatalog: defaultAttendanceCatalog(),
    ...overrides,
  };
}

test('localDateKey groups session at VN midnight boundary', () => {
  const iso = localDateTimeToUtcIso('2026-06-01', '00:30');
  assert.equal(localDateKey(iso), '2026-06-01');
  const prevLocal = localDateTimeToUtcIso('2026-05-31', '23:30');
  assert.equal(localDateKey(prevLocal), '2026-05-31');
  assert.equal(localDateKey('2026-05-31T17:30:00.000Z'), '2026-06-01');
  assert.equal(localDateKey('2026-05-31T16:30:00.000Z'), '2026-05-31');
});

test('buildMondayFirstMonthGrid handles leap February and year rollover', () => {
  const feb2024 = buildMondayFirstMonthGrid('2024-02');
  const inMonth = feb2024.flat().filter((c) => c.inMonth);
  assert.equal(inMonth.length, 29);
  assert.equal(inMonth[0].dateKey, '2024-02-01');
  assert.equal(inMonth.at(-1).dateKey, '2024-02-29');
  const dec2025 = buildMondayFirstMonthGrid('2025-12');
  const decPad = dec2025.flat().filter((c) => !c.inMonth);
  assert.equal(decPad.some((c) => c.dateKey.startsWith('2025-11')), false);
  assert.ok(decPad.some((c) => c.dateKey.startsWith('2026-01')));
  const jan2026 = buildMondayFirstMonthGrid('2026-01');
  const janLeading = jan2026.flat().filter((c) => !c.inMonth && c.dateKey.startsWith('2025-12'));
  assert.equal(janLeading[0]?.dateKey, '2025-12-29');
});

test('shiftMonthKey rolls year', () => {
  assert.equal(shiftMonthKey('2025-12', 1), '2026-01');
  assert.equal(shiftMonthKey('2026-01', -1), '2025-12');
});

test('membership span excludes sessions before join unless saved attendance', () => {
  const joinAt = localDateTimeToUtcIso('2026-06-15', '00:00');
  const state = baseState({
    memberships: [{
      classId: 'c1',
      studentId: 's1',
      effectiveFrom: joinAt,
    }],
    classSessions: [
      {
        id: 'early',
        classId: 'c1',
        startAt: localDateTimeToUtcIso('2026-06-10', '19:00'),
        endAt: localDateTimeToUtcIso('2026-06-10', '20:00'),
        status: SESSION_STATUS.SCHEDULED,
      },
      {
        id: 'late',
        classId: 'c1',
        startAt: localDateTimeToUtcIso('2026-06-20', '19:00'),
        endAt: localDateTimeToUtcIso('2026-06-20', '20:00'),
        status: SESSION_STATUS.SCHEDULED,
      },
    ],
    attendanceRecords: [{
      sessionId: 'early',
      studentId: 's1',
      statusId: 'present',
    }],
  });
  const model = computeStudentAttendanceCalendarMonth(state, {
    studentId: 's1',
    monthKey: '2026-06',
    nowIso: localDateTimeToUtcIso('2026-06-25', '12:00'),
  });
  assert.equal(model.sessions.length, 2);
  assert.ok(model.sessions.some((s) => s.sessionId === 'early'));
  assert.ok(model.sessions.some((s) => s.sessionId === 'late'));
});

test('multiple sessions same day listed separately', () => {
  const state = baseState({
    classSessions: [
      {
        id: 'a',
        classId: 'c1',
        startAt: localDateTimeToUtcIso('2026-06-05', '09:00'),
        endAt: localDateTimeToUtcIso('2026-06-05', '10:00'),
        status: SESSION_STATUS.COMPLETED,
      },
      {
        id: 'b',
        classId: 'c1',
        startAt: localDateTimeToUtcIso('2026-06-05', '19:00'),
        endAt: localDateTimeToUtcIso('2026-06-05', '20:00'),
        status: SESSION_STATUS.COMPLETED,
      },
    ],
    attendanceRecords: [
      { sessionId: 'a', studentId: 's1', statusId: 'present' },
      { sessionId: 'b', studentId: 's1', statusId: 'absent' },
    ],
  });
  const model = computeStudentAttendanceCalendarMonth(state, {
    studentId: 's1',
    monthKey: '2026-06',
    nowIso: localDateTimeToUtcIso('2026-06-06', '12:00'),
  });
  assert.equal(model.byDate['2026-06-05'].length, 2);
  assert.equal(model.stats.present, 1);
  assert.equal(model.stats.absent, 1);
});

test('cancelled future unmarked and custom status counts', () => {
  const state = baseState({
    attendanceStatusCatalog: [
      ...defaultAttendanceCatalog(),
      { id: 'custom', label: 'Nghỉ phép', sortOrder: 3, active: true },
    ],
    classSessions: [
      {
        id: 'canc',
        classId: 'c1',
        startAt: localDateTimeToUtcIso('2026-06-08', '19:00'),
        endAt: localDateTimeToUtcIso('2026-06-08', '20:00'),
        status: SESSION_STATUS.CANCELLED,
      },
      {
        id: 'fut',
        classId: 'c1',
        startAt: localDateTimeToUtcIso('2026-06-20', '19:00'),
        endAt: localDateTimeToUtcIso('2026-06-20', '20:00'),
        status: SESSION_STATUS.SCHEDULED,
      },
      {
        id: 'past',
        classId: 'c1',
        startAt: localDateTimeToUtcIso('2026-06-09', '19:00'),
        endAt: localDateTimeToUtcIso('2026-06-09', '20:00'),
        status: SESSION_STATUS.COMPLETED,
      },
      {
        id: 'cust',
        classId: 'c1',
        startAt: localDateTimeToUtcIso('2026-06-10', '19:00'),
        endAt: localDateTimeToUtcIso('2026-06-10', '20:00'),
        status: SESSION_STATUS.COMPLETED,
      },
    ],
    attendanceRecords: [
      { sessionId: 'cust', studentId: 's1', statusId: 'custom' },
    ],
  });
  const nowIso = localDateTimeToUtcIso('2026-06-15', '12:00');
  const model = computeStudentAttendanceCalendarMonth(state, {
    studentId: 's1',
    monthKey: '2026-06',
    nowIso,
  });
  assert.equal(model.stats.cancelled, 1);
  assert.equal(model.stats.upcoming, 1);
  assert.equal(model.stats.unmarked, 1);
  assert.equal(model.stats.customByStatusId.custom, 1);
  assert.equal(model.attendanceRate, null);
});

test('attendance rate uses present+late over present+late+absent only', () => {
  const state = baseState({
    classSessions: [{
      id: 's',
      classId: 'c1',
      startAt: localDateTimeToUtcIso('2026-06-03', '19:00'),
      endAt: localDateTimeToUtcIso('2026-06-03', '20:00'),
      status: SESSION_STATUS.COMPLETED,
    }],
    attendanceRecords: [
      { sessionId: 's', studentId: 's1', statusId: 'present' },
    ],
  });
  const model = computeStudentAttendanceCalendarMonth(state, {
    studentId: 's1',
    monthKey: '2026-06',
    nowIso: localDateTimeToUtcIso('2026-06-04', '12:00'),
  });
  assert.equal(model.attendanceRate, 1);
});

test('attendance rate zero denominator returns null', () => {
  const state = baseState({
    classSessions: [{
      id: 's',
      classId: 'c1',
      startAt: localDateTimeToUtcIso('2026-06-03', '19:00'),
      endAt: localDateTimeToUtcIso('2026-06-03', '20:00'),
      status: SESSION_STATUS.COMPLETED,
    }],
  });
  const model = computeStudentAttendanceCalendarMonth(state, {
    studentId: 's1',
    monthKey: '2026-06',
    nowIso: localDateTimeToUtcIso('2026-06-04', '12:00'),
  });
  assert.equal(model.stats.unmarked, 1);
  assert.equal(model.attendanceRate, null);
});

test('studentsEligibleForCalendarFilter keeps historical attendance without membership', () => {
  const state = baseState({
    memberships: [],
    attendanceRecords: [{ sessionId: 'x', studentId: 's2', statusId: 'present' }],
    classSessions: [{
      id: 'x',
      classId: 'c1',
      startAt: localDateTimeToUtcIso('2026-06-01', '19:00'),
      endAt: localDateTimeToUtcIso('2026-06-01', '20:00'),
      status: SESSION_STATUS.COMPLETED,
    }],
  });
  const list = studentsEligibleForCalendarFilter(state, 'c1');
  assert.ok(list.some((s) => s.id === 's2'));
});

test('addDaysToDateKey crosses month boundary', () => {
  assert.equal(addDaysToDateKey('2026-01-31', 1), '2026-02-01');
});

test('currentMonthKeyInBa uses VN calendar month', () => {
  const iso = localDateTimeToUtcIso('2026-03-01', '00:30');
  assert.equal(currentMonthKeyInBa(iso), '2026-03');
});

test('parseMonthKey accepts canonical YYYY-MM only', () => {
  assert.deepEqual(parseMonthKey('2026-06'), { year: 2026, month: 6 });
  assert.equal(parseMonthKey('2026-6'), null);
  assert.equal(parseMonthKey('2026-13'), null);
  assert.equal(parseMonthKey('26-06'), null);
});

test('resolveCalendarMonthKey falls back to current BA month', () => {
  const nowIso = localDateTimeToUtcIso('2026-04-15', '12:00');
  assert.equal(resolveCalendarMonthKey('2026-06'), '2026-06');
  assert.equal(resolveCalendarMonthKey('2026-13', nowIso), '2026-04');
  assert.equal(resolveCalendarMonthKey('', nowIso), '2026-04');
});
