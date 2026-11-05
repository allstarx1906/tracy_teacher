import {
  SESSION_STATUS,
  attendanceDisplayStudentIds,
  getCurrentAttendance,
  defaultAttendanceCatalog,
  localDateKey,
  localDateTimeToUtcIso,
  localWeekday,
  parseIso,
  studentAssignmentClassIds,
} from './ba-domain.js';

export const STANDARD_ATTENDANCE_KIND = Object.freeze({
  PRESENT: 'present',
  ABSENT: 'absent',
  LATE: 'late',
  UNMARKED: 'unmarked',
  UPCOMING: 'upcoming',
  CANCELLED: 'cancelled',
  CUSTOM: 'custom',
});

const MONTH_KEY_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** @param {string} monthKey canonical YYYY-MM (month 01–12) */
export function parseMonthKey(monthKey) {
  const raw = String(monthKey || '').trim();
  const m = raw.match(MONTH_KEY_RE);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (month < 1 || month > 12) return null;
  return { year, month };
}

/** Invalid or missing month → current month in BA (UTC+7). */
export function resolveCalendarMonthKey(monthKey, nowIso) {
  const parsed = parseMonthKey(monthKey);
  if (parsed) return formatMonthKey(parsed.year, parsed.month);
  return currentMonthKeyInBa(nowIso);
}

export function formatMonthKey(year, month) {
  return `${year}-${String(month).padStart(2, '0')}`;
}

/** @param {string} monthKey @param {number} deltaMonths */
export function shiftMonthKey(monthKey, deltaMonths) {
  const parsed = parseMonthKey(monthKey);
  if (!parsed) return monthKey;
  const d = new Date(Date.UTC(parsed.year, parsed.month - 1 + deltaMonths, 1));
  return formatMonthKey(d.getUTCFullYear(), d.getUTCMonth() + 1);
}

/** Current calendar month YYYY-MM in fixed UTC+7. */
export function currentMonthKeyInBa(nowIso = new Date().toISOString()) {
  const dk = localDateKey(nowIso);
  if (!dk) return formatMonthKey(new Date().getFullYear(), new Date().getMonth() + 1);
  return dk.slice(0, 7);
}

/** @param {string} monthKey */
export function monthDateRange(monthKey) {
  const parsed = parseMonthKey(monthKey);
  if (!parsed) return { fromDate: null, toDate: null };
  const fromDate = `${monthKey}-01`;
  const lastDay = new Date(Date.UTC(parsed.year, parsed.month, 0)).getUTCDate();
  const toDate = `${monthKey}-${String(lastDay).padStart(2, '0')}`;
  return { fromDate, toDate };
}

/** @param {string} dateKey YYYY-MM-DD @param {number} days */
export function addDaysToDateKey(dateKey, days) {
  const [y, m, d] = String(dateKey).split('-').map(Number);
  if (!y || !m || !d) return dateKey;
  const t = Date.UTC(y, m - 1, d + days);
  const u = new Date(t);
  return `${u.getUTCFullYear()}-${String(u.getUTCMonth() + 1).padStart(2, '0')}-${String(u.getUTCDate()).padStart(2, '0')}`;
}

/** Monday-first weeks; each cell { dateKey, inMonth }. */
export function buildMondayFirstMonthGrid(monthKey) {
  const parsed = parseMonthKey(monthKey);
  if (!parsed) return [];
  const firstDayKey = `${monthKey}-01`;
  const daysInMonth = new Date(Date.UTC(parsed.year, parsed.month, 0)).getUTCDate();
  const lastDayKey = `${monthKey}-${String(daysInMonth).padStart(2, '0')}`;
  const noonIso = localDateTimeToUtcIso(firstDayKey, '12:00');
  const firstDow = localWeekday(noonIso);
  const startOffset = firstDow == null ? 0 : (firstDow + 6) % 7;
  let cursor = addDaysToDateKey(firstDayKey, -startOffset);
  const weeks = [];
  while (weeks.length < 6) {
    const week = [];
    for (let i = 0; i < 7; i += 1) {
      const ym = cursor.slice(0, 7);
      week.push({ dateKey: cursor, inMonth: ym === monthKey });
      cursor = addDaysToDateKey(cursor, 1);
    }
    weeks.push(week);
    if (week.some((c) => c.dateKey === lastDayKey)) break;
  }
  return weeks;
}

export function statusLabelFromRecord(state, rec) {
  if (!rec?.statusId) return null;
  const cat = state.attendanceStatusCatalog || defaultAttendanceCatalog();
  return rec.statusLabelAtSave || cat.find((s) => s.id === rec.statusId)?.label || rec.statusId;
}

/**
 * @returns {null | object} session row for calendar
 */
export function classifyStudentSessionAttendance(state, session, studentId, nowIso) {
  if (!studentId) return null;
  const displayIds = attendanceDisplayStudentIds(state, session);
  if (!displayIds.includes(studentId)) return null;

  const className = (state.classes || []).find((c) => c.id === session.classId)?.name || session.classId;
  const dateKey = localDateKey(session.startAt);
  const base = {
    sessionId: session.id,
    classId: session.classId,
    className,
    startAt: session.startAt,
    dateKey,
  };

  if (session.status === SESSION_STATUS.CANCELLED) {
    return {
      ...base,
      kind: STANDARD_ATTENDANCE_KIND.CANCELLED,
      statusId: null,
      label: 'Hủy',
      ariaLabel: `Buổi đã hủy · ${className}`,
    };
  }

  const nowMs = parseIso(nowIso)?.getTime();
  const startMs = parseIso(session.startAt)?.getTime();
  const isFuture = startMs != null && nowMs != null && startMs > nowMs;
  const rec = getCurrentAttendance(state, session.id, studentId);

  if (!rec || !rec.statusId) {
    const label = isFuture ? 'Sắp học' : 'Chưa điểm danh';
    return {
      ...base,
      kind: isFuture ? STANDARD_ATTENDANCE_KIND.UPCOMING : STANDARD_ATTENDANCE_KIND.UNMARKED,
      statusId: null,
      label,
      ariaLabel: `${label} · ${className}`,
    };
  }

  const statusId = rec.statusId;
  const label = statusLabelFromRecord(state, rec) || statusId;
  if (statusId === 'present') {
    return { ...base, kind: STANDARD_ATTENDANCE_KIND.PRESENT, statusId, label, ariaLabel: `Có mặt · ${className}` };
  }
  if (statusId === 'absent') {
    return { ...base, kind: STANDARD_ATTENDANCE_KIND.ABSENT, statusId, label, ariaLabel: `Vắng · ${className}` };
  }
  if (statusId === 'late') {
    return { ...base, kind: STANDARD_ATTENDANCE_KIND.LATE, statusId, label, ariaLabel: `Đi muộn · ${className}` };
  }
  return {
    ...base,
    kind: STANDARD_ATTENDANCE_KIND.CUSTOM,
    statusId,
    label,
    ariaLabel: `${label} · ${className}`,
  };
}

export function studentsEligibleForCalendarFilter(state, classId) {
  const students = state.students || [];
  if (!classId) return [...students].sort((a, b) => String(a.name).localeCompare(String(b.name), 'vi'));
  const ids = new Set();
  const nowIso = new Date().toISOString();
  for (const s of students) {
    if (s.classId === classId) ids.add(s.id);
    for (const cid of studentAssignmentClassIds(s, state.memberships, nowIso)) {
      if (cid === classId) ids.add(s.id);
    }
  }
  for (const m of state.memberships || []) {
    if (m.classId === classId) ids.add(m.studentId);
  }
  for (const r of state.attendanceRecords || []) {
    const sess = (state.classSessions || []).find((x) => x.id === r.sessionId);
    if (sess?.classId === classId) ids.add(r.studentId);
  }
  return students.filter((s) => ids.has(s.id)).sort((a, b) => String(a.name).localeCompare(String(b.name), 'vi'));
}

export function resolveCalendarStudentSelection(state, { studentId, classId }) {
  const eligible = studentsEligibleForCalendarFilter(state, classId);
  if (!eligible.length) return null;
  if (studentId && eligible.some((s) => s.id === studentId)) return studentId;
  return eligible[0].id;
}

/**
 * @param {object} state
 * @param {{ studentId: string, classId?: string|null, monthKey: string, nowIso?: string }} opts
 */
export function computeStudentAttendanceCalendarMonth(state, opts) {
  const {
    studentId,
    classId = null,
    monthKey,
    nowIso = new Date().toISOString(),
  } = opts;
  const { fromDate, toDate } = monthDateRange(monthKey);
  const grid = buildMondayFirstMonthGrid(monthKey);
  const byDate = Object.create(null);
  const stats = {
    occurredNonCancelled: 0,
    present: 0,
    absent: 0,
    late: 0,
    unmarked: 0,
    upcoming: 0,
    cancelled: 0,
    customByStatusId: Object.create(null),
  };

  if (!studentId || !fromDate || !toDate) {
    return { monthKey, grid, byDate, stats, attendanceRate: null, sessions: [] };
  }

  const sessions = [];
  for (const session of state.classSessions || []) {
    if (classId && session.classId !== classId) continue;
    const dk = localDateKey(session.startAt);
    if (!dk || dk < fromDate || dk > toDate) continue;
    const entry = classifyStudentSessionAttendance(state, session, studentId, nowIso);
    if (!entry) continue;
    sessions.push(entry);
    if (!byDate[dk]) byDate[dk] = [];
    byDate[dk].push(entry);

    if (entry.kind === STANDARD_ATTENDANCE_KIND.CANCELLED) {
      stats.cancelled += 1;
      continue;
    }
    const startMs = parseIso(session.startAt)?.getTime();
    const nowMs = parseIso(nowIso)?.getTime();
    const isPastOrNow = startMs != null && nowMs != null && startMs <= nowMs;
    if (isPastOrNow) stats.occurredNonCancelled += 1;

    if (entry.kind === STANDARD_ATTENDANCE_KIND.PRESENT) stats.present += 1;
    else if (entry.kind === STANDARD_ATTENDANCE_KIND.ABSENT) stats.absent += 1;
    else if (entry.kind === STANDARD_ATTENDANCE_KIND.LATE) stats.late += 1;
    else if (entry.kind === STANDARD_ATTENDANCE_KIND.UNMARKED) stats.unmarked += 1;
    else if (entry.kind === STANDARD_ATTENDANCE_KIND.UPCOMING) stats.upcoming += 1;
    else if (entry.kind === STANDARD_ATTENDANCE_KIND.CUSTOM) {
      stats.customByStatusId[entry.statusId] = (stats.customByStatusId[entry.statusId] || 0) + 1;
    }
  }

  for (const dk of Object.keys(byDate)) {
    byDate[dk].sort((a, b) => String(a.startAt).localeCompare(String(b.startAt)));
  }
  sessions.sort((a, b) => String(a.startAt).localeCompare(String(b.startAt)));

  const rateDenom = stats.present + stats.late + stats.absent;
  const attendanceRate = rateDenom > 0
    ? (stats.present + stats.late) / rateDenom
    : null;

  return {
    monthKey,
    grid,
    byDate,
    stats,
    attendanceRate,
    sessions,
  };
}

export function attendanceCalendarNavigateHash({ classId, studentId, monthKey } = {}) {
  const params = new URLSearchParams();
  if (classId) params.set('classId', classId);
  if (studentId) params.set('studentId', studentId);
  if (monthKey) params.set('month', monthKey);
  const q = params.toString();
  return q ? `#/tutor/attendance-calendar?${q}` : '#/tutor/attendance-calendar';
}
