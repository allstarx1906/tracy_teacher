import { parseIso, localDateKey } from './ba-domain.js';
import {
  currentMonthKeyInBa,
  monthDateRange,
  shiftMonthKey,
} from './ba-attendance-calendar.js';

const STANDARD = Object.freeze({
  PRESENT: 'present',
  ABSENT: 'absent',
  LATE: 'late',
});

/** @typedef {'this-month'|'last-month'|'custom'} ReportPeriodPreset */

/**
 * @param {string} [nowIso]
 * @returns {{ preset: ReportPeriodPreset, fromDate: string, toDate: string, monthKey: string }}
 */
export function defaultReportPeriod(nowIso = new Date().toISOString()) {
  const monthKey = currentMonthKeyInBa(nowIso);
  const fromDate = `${monthKey}-01`;
  const toDate = localDateKey(nowIso) || fromDate;
  return { preset: 'this-month', fromDate, toDate, monthKey };
}

/**
 * @param {ReportPeriodPreset} preset
 * @param {string} [nowIso]
 */
export function resolveReportPeriodRange(preset, nowIso = new Date().toISOString()) {
  const monthKey = currentMonthKeyInBa(nowIso);
  if (preset === 'this-month') {
    return {
      preset,
      fromDate: `${monthKey}-01`,
      toDate: localDateKey(nowIso) || `${monthKey}-01`,
      monthKey,
    };
  }
  if (preset === 'last-month') {
    const prev = shiftMonthKey(monthKey, -1);
    const { fromDate, toDate } = monthDateRange(prev);
    return { preset, fromDate, toDate, monthKey: prev };
  }
  return { preset: 'custom', fromDate: null, toDate: null, monthKey };
}

/**
 * @param {number|null} rate
 */
export function formatAttendanceRatePercent(rate) {
  if (rate == null || Number.isNaN(rate)) return '—';
  return `${Math.round(rate * 1000) / 10}%`;
}

function isSessionFuture(session, nowIso) {
  const nowMs = parseIso(nowIso)?.getTime();
  const startMs = parseIso(session?.startAt)?.getTime();
  return startMs != null && nowMs != null && startMs > nowMs;
}

function classifyRow(row, nowIso) {
  if (row.kind === 'cancelled') return { bucket: 'cancelled' };
  if (row.kind === 'unmarked') {
    if (isSessionFuture(row.session, nowIso)) return { bucket: 'upcoming' };
    return { bucket: 'unmarked' };
  }
  const statusId = row.statusId;
  if (statusId === STANDARD.PRESENT) return { bucket: 'present' };
  if (statusId === STANDARD.ABSENT) return { bucket: 'absent' };
  if (statusId === STANDARD.LATE) return { bucket: 'late' };
  return { bucket: 'other', statusId };
}

/**
 * @param {object} report server computeAttendanceReport result
 * @param {{ nowIso?: string, includeFuture?: boolean }} opts
 */
export function aggregateAttendanceReport(report, opts = {}) {
  const nowIso = opts.nowIso || new Date().toISOString();
  const drilldown = report?.drilldown || [];
  const sessionIdsNonCancelled = new Set();
  const studentIds = new Set();
  let pendingUnmarked = 0;
  let upcomingUnmarked = 0;
  let absentTotal = 0;

  /** @type {Map<string, object>} */
  const byStudent = new Map();

  for (const row of drilldown) {
    if (row.kind === 'cancelled') continue;
    const sid = row.studentId;
    if (!sid) continue;
    studentIds.add(sid);
    const sessId = row.session?.id;
    if (sessId) sessionIdsNonCancelled.add(sessId);

    const { bucket, statusId } = classifyRow(row, nowIso);
    if (bucket === 'upcoming') upcomingUnmarked += 1;
    else if (bucket === 'unmarked') pendingUnmarked += 1;
    else if (bucket === 'absent') absentTotal += 1;

    let agg = byStudent.get(sid);
    if (!agg) {
      agg = {
        studentId: sid,
        sessions: 0,
        present: 0,
        absent: 0,
        late: 0,
        unmarked: 0,
        upcoming: 0,
        other: 0,
        otherByStatus: Object.create(null),
        classIds: new Set(),
      };
      byStudent.set(sid, agg);
    }
    agg.sessions += 1;
    if (row.session?.classId) agg.classIds.add(row.session.classId);
    if (bucket === 'present') agg.present += 1;
    else if (bucket === 'absent') agg.absent += 1;
    else if (bucket === 'late') agg.late += 1;
    else if (bucket === 'unmarked') agg.unmarked += 1;
    else if (bucket === 'upcoming') agg.upcoming += 1;
    else if (bucket === 'other') {
      agg.other += 1;
      const key = statusId || 'unknown';
      agg.otherByStatus[key] = (agg.otherByStatus[key] || 0) + 1;
    }
  }

  const studentRows = [...byStudent.values()].map((agg) => {
    const rateDenom = agg.present + agg.late + agg.absent;
    const rate = rateDenom > 0 ? (agg.present + agg.late) / rateDenom : null;
    return {
      studentId: agg.studentId,
      sessions: agg.sessions,
      present: agg.present,
      absent: agg.absent,
      late: agg.late,
      unmarked: agg.unmarked,
      upcoming: agg.upcoming,
      other: agg.other,
      otherByStatus: { ...agg.otherByStatus },
      classIds: [...agg.classIds],
      attendanceRate: rate,
    };
  });

  studentRows.sort((a, b) => String(a.studentId).localeCompare(String(b.studentId)));

  const cancelledSessions = report?.cancelledSessions ?? 0;
  const sessionCountAll = report?.sessionCount ?? 0;
  const nonCancelledSessions = Math.max(0, sessionCountAll - cancelledSessions);

  return {
    kpis: {
      sessionsNonCancelled: nonCancelledSessions,
      uniqueStudents: studentIds.size,
      absentTotal,
      pendingUnmarked,
      upcomingUnmarked,
      cancelledSessions,
    },
    studentRows,
    hasOtherStatuses: studentRows.some((r) => r.other > 0),
  };
}

/**
 * @param {object[]} drilldown
 * @param {string} studentId
 * @param {string} nowIso
 */
export function drilldownRowsForStudent(drilldown, studentId, nowIso = new Date().toISOString()) {
  return (drilldown || [])
    .filter((r) => r.studentId === studentId && r.kind !== 'cancelled')
    .map((row) => {
      const { bucket, statusId } = classifyRow(row, nowIso);
      return { row, bucket, statusId };
    })
    .sort((a, b) => String(b.row.session?.startAt || '').localeCompare(String(a.row.session?.startAt || '')));
}

export function cancelledDrilldownRows(drilldown) {
  return (drilldown || []).filter((r) => r.kind === 'cancelled');
}

function formatReportFilterDateDisplay(dateOnly) {
  const s = String(dateOnly || '').trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return `${m[3]}/${m[2]}/${m[1]}`;
  return s || '—';
}

/** @param {object} applied */
export function describeAppliedReportFilters(applied, { className, studentLabel }) {
  const parts = [];
  parts.push(className || 'Tất cả lớp');
  if (applied.fromDate && applied.toDate) {
    parts.push(`${formatReportFilterDateDisplay(applied.fromDate)} → ${formatReportFilterDateDisplay(applied.toDate)}`);
  } else if (applied.fromDate) {
    parts.push(`từ ${formatReportFilterDateDisplay(applied.fromDate)}`);
  } else if (applied.toDate) {
    parts.push(`đến ${formatReportFilterDateDisplay(applied.toDate)}`);
  }
  if (applied.includeFuture) parts.push('gồm buổi tương lai');
  else parts.push('không gồm buổi tương lai');
  if (studentLabel) parts.push(`HS: ${studentLabel}`);
  return parts.join(' · ');
}

export function filtersPayloadEqual(a, b) {
  if (!a || !b) return false;
  return a.classId === b.classId
    && a.fromDate === b.fromDate
    && a.toDate === b.toDate
    && a.includeFuture === b.includeFuture
    && a.studentId === b.studentId
    && (a.searchText || '') === (b.searchText || '');
}
