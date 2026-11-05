/**
 * BA MVP v1.2 — pure domain (tutor classes, sessions, attendance, mock notifications).
 * Timezone: Asia/Ho_Chi_Minh fixed UTC+7 (no DST).
 */

export const BA_TIMEZONE = 'Asia/Ho_Chi_Minh';
export const BA_UTC_OFFSET_MIN = 7 * 60;
export const MOCK_PROVIDER_LABEL = 'MÔ PHỎNG — KHÔNG GỬI ZALO THẬT';

export const CLASS_KIND = Object.freeze({ GROUP: 'group', ONE_TO_ONE: 'one-to-one' });
export const CLASS_STATUS = Object.freeze({ ACTIVE: 'active', ARCHIVED: 'archived' });
export const SESSION_STATUS = Object.freeze({
  SCHEDULED: 'scheduled',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
});
export const REMINDER_JOB_STATUS = Object.freeze({
  PENDING: 'pending',
  PROCESSING: 'processing',
  DONE: 'done',
  CANCELLED: 'cancelled',
  OVERDUE: 'overdue',
});
export const BATCH_RECIPIENT_STATUS = Object.freeze({
  PENDING: 'pending',
  PROCESSING: 'processing',
  MOCK_SUCCESS: 'mock-success',
  MOCK_FAIL: 'mock-fail',
  SKIPPED: 'skipped',
  CANCELLED: 'cancelled',
});
export const REMINDER_TYPE = Object.freeze({
  SESSION_REMINDER: 'session-reminder',
  SESSION_CHANGE: 'session-change',
  SESSION_CANCEL: 'session-cancel',
});

export const MANUAL_SEND_OUTCOME = Object.freeze({
  UNPROCESSED: 'unprocessed',
  TEACHER_CONFIRMED_SUCCESS: 'teacher-confirmed-success',
  FAILED: 'failed',
});

const MANUAL_NOTES_MAX = 2000;

const MS_MIN = 60_000;
const MS_DAY = 86_400_000;

export const RECURRENCE_MAX_RANGE_DAYS = 366;

export const BA_WEEKDAY_LABELS = Object.freeze([
  'CN', 'Thứ 2', 'Thứ 3', 'Thứ 4', 'Thứ 5', 'Thứ 6', 'Thứ 7',
]);

const SESSION_STATUS_VI = Object.freeze({
  [SESSION_STATUS.SCHEDULED]: 'Đã lên lịch',
  [SESSION_STATUS.COMPLETED]: 'Hoàn thành',
  [SESSION_STATUS.CANCELLED]: 'Đã hủy',
});

export function formatBaSessionStatus(status) {
  return SESSION_STATUS_VI[status] || status;
}

export function normalizeOptionalCode(code) {
  const s = String(code ?? '').trim();
  return s || '';
}

export function validateHttpMeetingUrl(url) {
  const s = String(url ?? '').trim();
  if (!s) return { ok: true, value: '' };
  let parsed;
  try {
    parsed = new URL(s);
  } catch {
    return { ok: false, error: 'URL buổi học phải là http(s) hợp lệ.' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: 'URL buổi học phải bắt đầu bằng http:// hoặc https://.' };
  }
  return { ok: true, value: s };
}

export function assertUniqueStudentCode(students, code, excludeId = null) {
  const norm = normalizeOptionalCode(code).toLowerCase();
  if (!norm) return { ok: true };
  const dup = (students || []).find(
    (s) => s.id !== excludeId && normalizeOptionalCode(s.code).toLowerCase() === norm,
  );
  if (dup) return { ok: false, error: 'Mã học sinh đã được dùng.' };
  return { ok: true };
}

export function assertUniqueClassCode(classes, code, excludeClassId) {
  const norm = normalizeOptionalCode(code).toLowerCase();
  if (!norm) return { ok: true };
  const dup = (classes || []).find(
    (c) => c.id !== excludeClassId && normalizeOptionalCode(c.code).toLowerCase() === norm,
  );
  if (dup) return { ok: false, error: 'Mã lớp đã được dùng.' };
  return { ok: true };
}

/** Strict YYYY-MM-DD (rejects Feb 30, etc.). */
export function parseStrictDateYmd(dateStr) {
  const parsed = parseReportDateYmd(dateStr);
  if (!parsed.ok) return null;
  return parsed.value;
}

/** Strict HH:MM in 00:00–23:59 (rejects 25:00). */
export function parseStrictTimeHm(timeStr) {
  const m = String(timeStr || '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (!Number.isFinite(hh) || !Number.isFinite(mm) || hh > 23 || mm > 59 || hh < 0 || mm < 0) {
    return null;
  }
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

export function validateRecurringScheduleInput(params, { classRow = null } = {}) {
  if (!params?.classId) return { ok: false, error: 'Chọn lớp.' };
  if (classRow?.status === CLASS_STATUS.ARCHIVED) {
    return { ok: false, error: 'Lớp đã lưu trữ — không áp dụng lịch lặp.' };
  }
  const weekdays = (params.weekdays || []).map(Number).filter((n) => n >= 0 && n <= 6);
  if (!weekdays.length) return { ok: false, error: 'Chọn ít nhất một ngày trong tuần.' };
  const rangeFromDate = parseStrictDateYmd(params.rangeFromDate);
  const rangeToDate = parseStrictDateYmd(params.rangeToDate);
  if (!rangeFromDate || !rangeToDate) {
    return { ok: false, error: 'Ngày không hợp lệ (YYYY-MM-DD).' };
  }
  if (rangeToDate < rangeFromDate) {
    return { ok: false, error: 'Ngày kết thúc phải sau ngày bắt đầu.' };
  }
  const fromMs = parseIso(localDateTimeToUtcIso(rangeFromDate, '00:00'))?.getTime();
  const toMs = parseIso(localDateTimeToUtcIso(rangeToDate, '23:59'))?.getTime();
  if (fromMs == null || toMs == null) {
    return { ok: false, error: 'Khoảng ngày hiệu lực không hợp lệ.' };
  }
  const spanDays = Math.floor((toMs - fromMs) / MS_DAY) + 1;
  if (spanDays > RECURRENCE_MAX_RANGE_DAYS) {
    return { ok: false, error: `Khoảng ngày tối đa ${RECURRENCE_MAX_RANGE_DAYS} ngày.` };
  }
  const startTime = parseStrictTimeHm(params.startTime);
  const endTime = parseStrictTimeHm(params.endTime);
  if (!startTime || !endTime) {
    return { ok: false, error: 'Giờ không hợp lệ (HH:MM, 00:00–23:59).' };
  }
  const sampleStart = localDateTimeToUtcIso(rangeFromDate, startTime);
  const sampleEnd = localDateTimeToUtcIso(rangeFromDate, endTime);
  const tv = validateSessionTimes(sampleStart, sampleEnd);
  if (!tv.ok) return { ok: false, error: tv.error };
  return {
    ok: true,
    weekdays,
    startTime,
    endTime,
    rangeFromDate,
    rangeToDate,
  };
}

export function buildScheduleApplyFingerprint(previewSessions, input) {
  const keys = (previewSessions || [])
    .filter((s) => !s.duplicateOfExisting)
    .map((s) => s.startAt)
    .sort();
  return JSON.stringify({
    classId: input.classId,
    weekdays: [...(input.weekdays || [])].map(Number).sort((a, b) => a - b),
    startTime: input.startTime,
    endTime: input.endTime,
    rangeFromDate: input.rangeFromDate,
    rangeToDate: input.rangeToDate,
    sessionKeys: keys,
  });
}

/** Student rows for attendance UI (cancelled: union roster-at-start + saved records). */
export function attendanceDisplayStudentIds(state, session) {
  const ids = new Set();
  for (const m of membershipsForClassAt(state.memberships || [], session.classId, session.startAt)) {
    ids.add(m.studentId);
  }
  for (const r of state.attendanceRecords || []) {
    if (r.sessionId === session.id) ids.add(r.studentId);
  }
  return [...ids];
}

export function computeClassArchiveImpact(state, classId, nowIso) {
  let futureScheduledSessions = 0;
  let pendingReminderJobs = 0;
  for (const s of state.classSessions || []) {
    if (s.classId !== classId) continue;
    if (s.status === SESSION_STATUS.SCHEDULED && String(s.startAt) >= String(nowIso)) {
      futureScheduledSessions += 1;
    }
  }
  for (const job of state.reminderJobs || []) {
    if (job.status !== REMINDER_JOB_STATUS.PENDING && job.status !== REMINDER_JOB_STATUS.OVERDUE) continue;
    const sess = state.classSessions?.find((x) => x.id === job.sessionId);
    if (sess?.classId === classId) pendingReminderJobs += 1;
  }
  return { futureScheduledSessions, pendingReminderJobs };
}

export function computeInheritedReminderSessionCount(state, classId) {
  let count = 0;
  for (const s of state.classSessions || []) {
    if (s.classId !== classId) continue;
    if (s.status !== SESSION_STATUS.SCHEDULED) continue;
    if (s.reminderEnabled != null || s.reminderOffsetMinutes != null) continue;
    count += 1;
  }
  return count;
}

export function formatAttendanceAuditLine(audit, state) {
  const st = (state.students || []).find((s) => s.id === audit.studentId);
  const name = st?.name || audit.studentId;
  const oldV = audit.oldValue;
  const newV = audit.newValue;
  const oldLabel = oldV?.statusLabelAtSave || oldV?.statusId || '—';
  const newLabel = newV?.statusLabelAtSave || newV?.statusId || '—';
  const note = newV?.note ? ` · Ghi chú: ${newV.note}` : '';
  const mins = newV?.minutesLate != null ? ` · Trễ ${newV.minutesLate} phút` : '';
  const actor = newV?.updatedBy || '—';
  return `${audit.at} · ${name}: ${oldLabel} → ${newLabel}${note}${mins} · ${audit.reason} (${actor})`;
}

export function defaultAttendanceCatalog() {
  return [
    { id: 'present', label: 'Có mặt', sortOrder: 0, active: true },
    { id: 'absent', label: 'Vắng', sortOrder: 1, active: true },
    { id: 'late', label: 'Đi muộn', sortOrder: 2, active: true },
  ];
}

/** @param {string} iso */
export function parseIso(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Local calendar YYYY-MM-DD in UTC+7 for an instant. */
export function localDateKey(iso) {
  const d = parseIso(iso);
  if (!d) return null;
  const shifted = d.getTime() + BA_UTC_OFFSET_MIN * MS_MIN;
  const u = new Date(shifted);
  const y = u.getUTCFullYear();
  const m = String(u.getUTCMonth() + 1).padStart(2, '0');
  const day = String(u.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Weekday 0=Sun..6=Sat in UTC+7 at instant. */
export function localWeekday(iso) {
  const d = parseIso(iso);
  if (!d) return null;
  const shifted = d.getTime() + BA_UTC_OFFSET_MIN * MS_MIN;
  return new Date(shifted).getUTCDay();
}

/** Build UTC ISO from local date + HH:mm in UTC+7. */
export function localDateTimeToUtcIso(dateKey, timeHm) {
  const [y, m, d] = String(dateKey).split('-').map(Number);
  const [hh, mm] = String(timeHm).split(':').map(Number);
  if (!y || !m || !d || Number.isNaN(hh) || Number.isNaN(mm)) return null;
  const utcMs = Date.UTC(y, m - 1, d, hh, mm, 0, 0) - BA_UTC_OFFSET_MIN * MS_MIN;
  return new Date(utcMs).toISOString();
}

/** datetime-local value in configured UTC+7 (not browser local). */
export function utcIsoToBaLocalInput(iso) {
  if (!iso) return '';
  const d = parseIso(iso);
  if (!d) return '';
  const shifted = d.getTime() + BA_UTC_OFFSET_MIN * MS_MIN;
  const u = new Date(shifted);
  const pad = (n) => String(n).padStart(2, '0');
  return `${u.getUTCFullYear()}-${pad(u.getUTCMonth() + 1)}-${pad(u.getUTCDate())}T${pad(u.getUTCHours())}:${pad(u.getUTCMinutes())}`;
}

/** Parse datetime-local as UTC+7 wall time → UTC ISO. */
export function baLocalInputToUtcIso(value) {
  if (!value) return null;
  const m = String(value).trim().match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return null;
  return localDateTimeToUtcIso(`${m[1]}-${m[2]}-${m[3]}`, `${m[4]}:${m[5]}`);
}

export function validateSessionTimes(startIso, endIso) {
  const s = parseIso(startIso);
  const e = parseIso(endIso);
  if (!s || !e) return { ok: false, error: 'Thời gian không hợp lệ.' };
  if (e.getTime() <= s.getTime()) {
    return { ok: false, error: 'Giờ kết thúc phải sau giờ bắt đầu.' };
  }
  return { ok: true, start: s, end: e };
}

/** Strict interval timestamps for memberships / parent links (open end = null only). */
export function validateIntervalTimestamps(effectiveFrom, effectiveTo) {
  const from = parseIso(effectiveFrom);
  if (!from) return { ok: false, error: 'Thời điểm bắt đầu không hợp lệ.' };
  if (effectiveTo == null || effectiveTo === '') return { ok: true };
  const to = parseIso(effectiveTo);
  if (!to) return { ok: false, error: 'Thời điểm kết thúc không hợp lệ.' };
  if (to.getTime() <= from.getTime()) {
    return { ok: false, error: 'Thời điểm kết thúc phải sau thời điểm bắt đầu.' };
  }
  return { ok: true };
}

export function assertUniqueParentCode(parents, code, excludeId) {
  const trimmed = String(code || '').trim();
  if (!trimmed) return { ok: true };
  for (const p of parents || []) {
    if (p.id === excludeId) continue;
    if (String(p.code || '').trim() === trimmed) {
      return { ok: false, error: 'Mã phụ huynh đã được dùng.' };
    }
  }
  return { ok: true };
}

export function attendanceStatusInUse(state, statusId) {
  return (state.attendanceRecords || []).some((r) => r.statusId === statusId);
}

export function classifyMembershipMutation(prior, row) {
  if (!prior) return 'initial';
  if (!prior.effectiveTo && row.effectiveTo) return 'end';
  if (prior.effectiveTo && !row.effectiveTo && prior.id === row.id) return 'rejoin';
  if (!prior.effectiveTo && !row.effectiveTo && prior.id !== row.id) return 'rejoin';
  return 'edit';
}

function sessionRequiresRetroImpactWithoutAttendance(session, nowIso) {
  if (String(session.startAt) < String(nowIso)) return true;
  if (
    session.status === SESSION_STATUS.COMPLETED
    && session.endAt
    && String(session.endAt) <= String(nowIso)
  ) {
    return true;
  }
  return false;
}

/**
 * Sessions whose roster membership for this student would change; include attendance keys.
 * Saved attendance on any session (including future) counts when roster would change.
 * Sessions without attendance count only when started/completed before `nowIso`.
 */
export function computeMembershipRetroactiveImpact(state, prior, next, { nowIso = new Date().toISOString() } = {}) {
  const row = next || prior;
  if (!row) return { hasImpact: false, sessionIds: [], attendanceRecordIds: [] };
  const { classId, studentId } = row;
  const sessionIds = [];
  const attendanceRecordIds = [];
  for (const session of state.classSessions || []) {
    if (session.classId !== classId) continue;
    const rec = (state.attendanceRecords || []).find(
      (r) => r.sessionId === session.id && r.studentId === studentId,
    );
    const before = prior
      ? isMembershipActive(prior, session.startAt)
      : studentActiveInClassAt(state, studentId, classId, session.startAt, row.id);
    const after = isMembershipActive(next, session.startAt);
    if (before === after) continue;
    if (!rec && !sessionRequiresRetroImpactWithoutAttendance(session, nowIso)) continue;
    sessionIds.push(session.id);
    if (rec) attendanceRecordIds.push(`${rec.sessionId}:${rec.studentId}`);
  }
  return {
    hasImpact: sessionIds.length > 0,
    sessionIds,
    attendanceRecordIds,
  };
}

function studentActiveInClassAt(state, studentId, classId, atIso, excludeMembershipId = null) {
  for (const m of state.memberships || []) {
    if (m.id === excludeMembershipId) continue;
    if (m.studentId !== studentId || m.classId !== classId) continue;
    if (isMembershipActive(m, atIso)) return true;
  }
  return false;
}

/** [from,to) membership effective at instant t. */
export function isMembershipActive(m, atIso) {
  const t = parseIso(atIso)?.getTime();
  if (t == null) return false;
  const from = parseIso(m.effectiveFrom)?.getTime();
  if (from == null || t < from) return false;
  if (m.effectiveTo) {
    const to = parseIso(m.effectiveTo)?.getTime();
    if (to != null && t >= to) return false;
  }
  return true;
}

export function membershipsForClassAt(memberships, classId, atIso) {
  return (memberships || []).filter(
    (m) => m.classId === classId && isMembershipActive(m, atIso),
  );
}

export function countActiveStudentsAt(memberships, classId, atIso) {
  const ids = new Set(membershipsForClassAt(memberships, classId, atIso).map((m) => m.studentId));
  return ids.size;
}

export function intervalsOverlap(aFrom, aTo, bFrom, bTo) {
  const af = parseIso(aFrom)?.getTime();
  const at = aTo ? parseIso(aTo)?.getTime() : null;
  const bf = parseIso(bFrom)?.getTime();
  const bt = bTo ? parseIso(bTo)?.getTime() : null;
  if (af == null || bf == null) return false;
  const aEnd = at ?? Number.POSITIVE_INFINITY;
  const bEnd = bt ?? Number.POSITIVE_INFINITY;
  return af < bEnd && bf < aEnd;
}

export function assertNoMembershipOverlap(memberships, { classId, studentId, effectiveFrom, effectiveTo, excludeId }) {
  for (const m of memberships || []) {
    if (m.id === excludeId) continue;
    if (m.classId !== classId || m.studentId !== studentId) continue;
    if (intervalsOverlap(effectiveFrom, effectiveTo, m.effectiveFrom, m.effectiveTo)) {
      return { ok: false, error: 'Khoảng tham gia lớp bị chồng lấn với bản ghi hiện có.' };
    }
  }
  return { ok: true };
}

export function assertNoParentLinkOverlap(links, { parentId, studentId, effectiveFrom, effectiveTo, excludeId }) {
  for (const l of links || []) {
    if (l.id === excludeId) continue;
    if (l.parentId !== parentId || l.studentId !== studentId) continue;
    if (intervalsOverlap(effectiveFrom, effectiveTo, l.effectiveFrom, l.effectiveTo)) {
      return { ok: false, error: 'Khoảng liên kết phụ huynh bị chồng lấn.' };
    }
  }
  return { ok: true };
}

export function getClassKind(cls) {
  return cls?.kind === CLASS_KIND.ONE_TO_ONE ? CLASS_KIND.ONE_TO_ONE : CLASS_KIND.GROUP;
}

/** AC01 — at most one student membership interval in 1:1 class (full overlap, not instant-only). */
export function assertOneToOneCapacity(
  memberships,
  classes,
  classId,
  effectiveFrom,
  addingStudentId,
  excludeMembershipId,
  effectiveTo = null,
) {
  const cls = classes.find((c) => c.id === classId);
  if (!cls || getClassKind(cls) !== CLASS_KIND.ONE_TO_ONE) return { ok: true };
  for (const m of memberships || []) {
    if (m.id === excludeMembershipId) continue;
    if (m.classId !== classId) continue;
    if (m.studentId === addingStudentId) continue;
    if (intervalsOverlap(effectiveFrom, effectiveTo, m.effectiveFrom, m.effectiveTo)) {
      return { ok: false, error: 'Lớp 1:1 chỉ cho phép một học sinh đang tham gia tại một thời điểm.' };
    }
  }
  return { ok: true };
}

export function assertOneToOneClassConversion(memberships, classes, classId, proposedKind = null) {
  const cls = classes.find((c) => c.id === classId);
  if (!cls) return { ok: true };
  const targetKind = proposedKind ?? getClassKind(cls);
  if (targetKind !== CLASS_KIND.ONE_TO_ONE) return { ok: true };
  const classMems = (memberships || []).filter((m) => m.classId === classId);
  for (let i = 0; i < classMems.length; i += 1) {
    for (let j = i + 1; j < classMems.length; j += 1) {
      const a = classMems[i];
      const b = classMems[j];
      if (a.studentId === b.studentId) continue;
      if (intervalsOverlap(a.effectiveFrom, a.effectiveTo, b.effectiveFrom, b.effectiveTo)) {
        return { ok: false, error: 'Không thể chuyển lớp 1:1 khi có nhiều học sinh đang tham gia.' };
      }
    }
  }
  return { ok: true };
}

export function parentLinksEffectiveAt(links, studentId, atIso) {
  return (links || []).filter(
    (l) => l.studentId === studentId && isMembershipActive(l, atIso),
  );
}

/** Canonical mock recipient key: phone normalized, else email, else profile id. */
export function canonicalRecipientKey(profile) {
  const phone = String(profile.phone || '').replace(/\D/g, '');
  if (phone) return `phone:${phone}`;
  const email = String(profile.email || '').trim().toLowerCase();
  if (email) return `email:${email}`;
  return `id:${profile.profileId || profile.id}`;
}

/**
 * Build deduped recipient list at session start (AC13, AC14).
 * @returns {{ recipients: object[], skipped: object[] }}
 */
export function buildSessionRecipientRoster(state, session) {
  const at = session.startAt;
  const classId = session.classId;
  const mems = membershipsForClassAt(state.memberships || [], classId, at);
  const recipients = [];
  const skipped = [];
  const seen = new Map();

  for (const m of mems) {
    const st = (state.students || []).find((s) => s.id === m.studentId);
    if (!st || st.status === 'inactive') continue;
    const stProfile = {
      profileId: st.id,
      role: 'student',
      displayName: st.name,
      phone: st.phone || st.contactPhone || '',
      email: st.email || st.contactEmail || '',
      relatedStudentIds: [st.id],
    };
    pushRecipient(stProfile, recipients, skipped, seen);

    for (const link of parentLinksEffectiveAt(state.parentStudentLinks || [], st.id, at)) {
      const parent = (state.parents || []).find((p) => p.id === link.parentId);
      if (!parent || parent.status === 'inactive') continue;
      const rel = link.relationship || parent.relationship || '';
      const pProfile = {
        profileId: parent.id,
        role: 'parent',
        displayName: parent.name,
        phone: parent.phone || '',
        email: parent.email || '',
        relationship: rel,
        relatedStudentIds: [st.id],
      };
      pushRecipient(pProfile, recipients, skipped, seen);
    }
  }
  return { recipients, skipped };
}

export function unionRecipientSnapshots(oldRoster, newRoster) {
  const map = new Map();
  for (const r of [...(oldRoster.recipients || []), ...(oldRoster.skipped || [])]) {
    const key = r.canonicalKey || canonicalRecipientKey(r);
    map.set(key, { ...r, canonicalKey: key, skipped: r.skipped ?? !!r.skipReason });
  }
  for (const r of [...(newRoster.recipients || []), ...(newRoster.skipped || [])]) {
    const key = r.canonicalKey || canonicalRecipientKey(r);
    if (!map.has(key)) {
      map.set(key, { ...r, canonicalKey: key, skipped: r.skipped ?? !!r.skipReason });
    } else {
      const existing = map.get(key);
      existing.relatedStudentIds = [...new Set([
        ...(existing.relatedStudentIds || []),
        ...(r.relatedStudentIds || []),
      ])];
    }
  }
  return [...map.values()];
}

export function mergeFrozenRecipientUnions(existing, added) {
  const map = new Map();
  for (const r of [...(existing || []), ...(added || [])]) {
    const key = r.canonicalKey || canonicalRecipientKey(r);
    if (!map.has(key)) {
      map.set(key, { ...r, canonicalKey: key, skipped: r.skipped ?? !!r.skipReason });
    } else {
      const ex = map.get(key);
      ex.relatedStudentIds = [...new Set([
        ...(ex.relatedStudentIds || []),
        ...(r.relatedStudentIds || []),
      ])];
    }
  }
  return [...map.values()];
}

export function freezeSessionRosterSnapshot(roster) {
  return [
    ...(roster.recipients || []).map((r) => ({ ...r, skipped: false })),
    ...(roster.skipped || []).map((r) => ({ ...r, skipped: true })),
  ];
}

export function rosterFromFrozenUnion(frozenUnion) {
  const recipients = [];
  const skipped = [];
  for (const r of frozenUnion || []) {
    const row = { ...r, canonicalKey: r.canonicalKey || canonicalRecipientKey(r) };
    const isSkipped = row.skipped === true || !!row.skipReason
      || !(String(row.phone || '').trim() || String(row.email || '').trim());
    if (isSkipped) {
      skipped.push({
        ...row,
        skipped: true,
        skipReason: row.skipReason || 'Thiếu thông tin liên hệ',
      });
    } else {
      recipients.push({ ...row, skipped: false });
    }
  }
  return { recipients, skipped };
}

export function isValidReminderType(type) {
  return Object.values(REMINDER_TYPE).includes(type);
}

export function validateNotificationTypeForSession(type, session) {
  if (!isValidReminderType(type)) return { ok: false, code: 'bad-type' };
  if (type === REMINDER_TYPE.SESSION_REMINDER) {
    if (session.status === SESSION_STATUS.CANCELLED) return { ok: false, code: 'cancelled-session' };
    return { ok: true };
  }
  if (type === REMINDER_TYPE.SESSION_CANCEL) {
    if (session.status !== SESSION_STATUS.CANCELLED) return { ok: false, code: 'not-cancelled' };
    return { ok: true };
  }
  if (type === REMINDER_TYPE.SESSION_CHANGE) {
    if (session.status === SESSION_STATUS.CANCELLED) return { ok: false, code: 'cancelled-session' };
    if (!session.changeNotifyRosterUnion?.length) return { ok: false, code: 'no-change-roster' };
    return { ok: true };
  }
  return { ok: false, code: 'bad-type' };
}

export function getLatestRescheduleForSession(state, sessionId) {
  const rows = (state.sessionHistory || []).filter(
    (h) => h.sessionId === sessionId && h.action === 'reschedule',
  );
  return rows.length ? rows[rows.length - 1] : null;
}

export function resolveNotificationRecipients(state, session, type) {
  const check = validateNotificationTypeForSession(type, session);
  if (!check.ok) return { ok: false, code: check.code };
  if (type === REMINDER_TYPE.SESSION_CHANGE) {
    const split = rosterFromFrozenUnion(session.changeNotifyRosterUnion);
    return { ok: true, ...split };
  }
  if (type === REMINDER_TYPE.SESSION_CANCEL) {
    if (session.cancelNotifyRosterUnion?.length) {
      const split = rosterFromFrozenUnion(session.cancelNotifyRosterUnion);
      return { ok: true, ...split };
    }
    const atCancel = buildSessionRecipientRoster(state, {
      ...session,
      status: SESSION_STATUS.SCHEDULED,
    });
    return { ok: true, ...atCancel };
  }
  const live = buildSessionRecipientRoster(state, session);
  return { ok: true, ...live };
}

function stablePreviewHash(input) {
  let h = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `pc-${(h >>> 0).toString(16)}`;
}

export function buildPreviewCaptureKey({ sessionId, type, content, recipients, skipped }) {
  const payload = JSON.stringify({
    sessionId,
    type,
    content,
    recipients: (recipients || []).map((r) => r.canonicalKey).sort(),
    skipped: (skipped || []).map((r) => r.canonicalKey).sort(),
  });
  return stablePreviewHash(payload);
}

export function validateManualSendConfirm(body) {
  let outcome = body?.outcome;
  if (outcome === 'confirmed') outcome = MANUAL_SEND_OUTCOME.TEACHER_CONFIRMED_SUCCESS;
  if (outcome === 'failed') outcome = MANUAL_SEND_OUTCOME.FAILED;
  if (!Object.values(MANUAL_SEND_OUTCOME).includes(outcome)) {
    return { ok: false, code: 'bad-outcome' };
  }
  const notes = String(body?.note || body?.notes || '').trim();
  if (notes.length > MANUAL_NOTES_MAX) return { ok: false, code: 'notes-long' };
  const declaredSentAt = body?.declaredSentAt;
  if (declaredSentAt != null && String(declaredSentAt).trim()) {
    if (!parseIso(declaredSentAt)) return { ok: false, code: 'bad-time' };
  }
  if (outcome !== MANUAL_SEND_OUTCOME.UNPROCESSED && !declaredSentAt) {
    return { ok: false, code: 'time-required' };
  }
  return { ok: true, notes, declaredSentAt: declaredSentAt || null, outcome };
}

function pushRecipient(profile, recipients, skipped, seen) {
  const key = canonicalRecipientKey(profile);
  const hasContact = !!(String(profile.phone || '').trim() || String(profile.email || '').trim());
  if (!hasContact) {
    skipped.push({
      ...profile,
      canonicalKey: key,
      skipped: true,
      skipReason: 'Thiếu thông tin liên hệ',
    });
    return;
  }
  if (seen.has(key)) {
    const existing = seen.get(key);
    existing.relatedStudentIds = [...new Set([...existing.relatedStudentIds, ...profile.relatedStudentIds])];
    if (profile.role === 'parent' && profile.relationship) {
      existing.relatedLinks = existing.relatedLinks || [];
      existing.relatedLinks.push({ studentIds: profile.relatedStudentIds, relationship: profile.relationship });
    }
    return;
  }
  const row = {
    ...profile,
    canonicalKey: key,
    skipped: false,
    relatedLinks: profile.role === 'parent'
      ? [{ studentIds: profile.relatedStudentIds, relationship: profile.relationship || '' }]
      : [],
  };
  seen.set(key, row);
  recipients.push(row);
}

export function sessionsOverlap(aStart, aEnd, bStart, bEnd) {
  const as = parseIso(aStart)?.getTime();
  const ae = parseIso(aEnd)?.getTime();
  const bs = parseIso(bStart)?.getTime();
  const be = parseIso(bEnd)?.getTime();
  if (as == null || ae == null || bs == null || be == null) return false;
  if (ae === bs || be === as) return false;
  return as < be && bs < ae;
}

export function findTeacherSessionConflicts(allSessions, candidate, excludeId = null) {
  const conflicts = [];
  for (const s of allSessions || []) {
    if (s.id === excludeId) continue;
    if (s.status === SESSION_STATUS.CANCELLED) continue;
    if (sessionsOverlap(candidate.startAt, candidate.endAt, s.startAt, s.endAt)) {
      conflicts.push(s);
    }
  }
  return conflicts;
}

/** Preview recurring sessions AC03. */
export function previewRecurringSessions({
  classId,
  weekdays,
  startTime,
  endTime,
  rangeFromDate,
  rangeToDate,
  existingSessions = [],
  templateId = null,
  classRow = null,
}) {
  const validated = validateRecurringScheduleInput({
    classId,
    weekdays,
    startTime,
    endTime,
    rangeFromDate,
    rangeToDate,
  }, { classRow });
  if (!validated.ok) return { ok: false, error: validated.error, sessions: [] };
  const out = [];
  const dupKeys = new Set(
    (existingSessions || [])
      .filter((s) => s.status !== SESSION_STATUS.CANCELLED)
      .map((s) => `${s.classId}|${s.startAt}`),
  );
  const from = parseIso(localDateTimeToUtcIso(validated.rangeFromDate, '00:00'));
  const to = parseIso(localDateTimeToUtcIso(validated.rangeToDate, '23:59'));
  const wdSet = new Set(validated.weekdays);
  startTime = validated.startTime;
  endTime = validated.endTime;
  for (let t = from.getTime(); t <= to.getTime(); t += MS_DAY) {
    const dayIso = new Date(t).toISOString();
    const key = localDateKey(dayIso);
    const wd = localWeekday(dayIso);
    if (!wdSet.has(wd)) continue;
    const startAt = localDateTimeToUtcIso(key, startTime);
    const endAt = localDateTimeToUtcIso(key, endTime);
    const tv = validateSessionTimes(startAt, endAt);
    if (!tv.ok) return { ok: false, error: tv.error, sessions: [] };
    const dedupeKey = `${classId}|${startAt}`;
    const exists = dupKeys.has(dedupeKey);
    out.push({
      classId,
      templateId,
      startAt,
      endAt,
      status: SESSION_STATUS.SCHEDULED,
      duplicateOfExisting: exists,
      dedupeKey,
    });
  }
  return { ok: true, sessions: out };
}

export function sessionRevisionKey(session) {
  return `${session.id}:${session.revision ?? 0}`;
}

export function computeReminderDueAt(sessionStartIso, offsetMinutes) {
  const start = parseIso(sessionStartIso);
  if (!start) return null;
  const off = Math.max(0, Number(offsetMinutes) || 0);
  return new Date(start.getTime() - off * MS_MIN).toISOString();
}

export function resolveSessionReminderConfig(session, cls) {
  const enabled = session.reminderEnabled ?? cls?.defaultReminderEnabled ?? false;
  const offset = session.reminderOffsetMinutes ?? cls?.defaultReminderOffsetMinutes ?? 60;
  return { enabled: !!enabled, offsetMinutes: Math.max(0, Number(offset) || 0) };
}

export function buildReminderJobId(sessionId, type, revision) {
  return `${sessionId}:${type}:${revision}`;
}

export function buildNotificationContent(session, cls, type, changeContext = null) {
  const startLocal = formatSessionLocal(session.startAt);
  const lines = [
    type === REMINDER_TYPE.SESSION_CANCEL
      ? `Thông báo hủy buổi — ${cls?.name || 'Lớp'}`
      : type === REMINDER_TYPE.SESSION_CHANGE
        ? `Thông báo đổi lịch — ${cls?.name || 'Lớp'}`
        : `Nhắc lịch học — ${cls?.name || 'Lớp'}`,
  ];
  if (type === REMINDER_TYPE.SESSION_CHANGE && changeContext?.oldStart) {
    lines.push(`Giờ cũ: ${formatSessionLocal(changeContext.oldStart)} – ${formatSessionLocal(changeContext.oldEnd)}`);
    lines.push(`Giờ mới: ${formatSessionLocal(changeContext.newStart || session.startAt)} – ${formatSessionLocal(changeContext.newEnd || session.endAt)}`);
  } else if (type === REMINDER_TYPE.SESSION_CANCEL) {
    lines.push(`Buổi đã hủy — thời gian dự kiến: ${startLocal}`);
  } else {
    lines.push(`Thời gian: ${startLocal}`);
  }
  if (session.meetingUrl || cls?.meetingUrl) {
    lines.push(`Link học: ${session.meetingUrl || cls.meetingUrl}`);
  }
  if (session.notes) lines.push(`Ghi chú buổi: ${session.notes}`);
  lines.push(MOCK_PROVIDER_LABEL);
  return lines.join('\n');
}

export function formatSessionLocal(startIso) {
  const d = parseIso(startIso);
  if (!d) return '—';
  const shifted = d.getTime() + BA_UTC_OFFSET_MIN * MS_MIN;
  const u = new Date(shifted);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(u.getUTCDate())}/${pad(u.getUTCMonth() + 1)}/${u.getUTCFullYear()} ${pad(u.getUTCHours())}:${pad(u.getUTCMinutes())}`;
}

/** Deterministic mock outcomes (AC15, AC16). */
export function runMockSend(recipients, scenario, perRecipient = {}) {
  const mode = scenario || 'all-success';
  return recipients.map((r) => {
    const key = r.canonicalKey || canonicalRecipientKey(r);
    let success = mode === 'all-success';
    if (mode === 'all-fail') success = false;
    if (mode === 'per-recipient' && Object.prototype.hasOwnProperty.call(perRecipient, key)) {
      success = !!perRecipient[key];
    }
    return {
      canonicalKey: key,
      status: success ? BATCH_RECIPIENT_STATUS.MOCK_SUCCESS : BATCH_RECIPIENT_STATUS.MOCK_FAIL,
      error: success ? null : (perRecipient[`${key}:error`] || 'mock-fail'),
      at: new Date().toISOString(),
    };
  });
}

export function getActiveAttendanceStatuses(catalog) {
  return [...(catalog || [])]
    .filter((s) => s.active !== false)
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
}

/** Report cards/filters: include inactive catalog entries and legacy ids when counts > 0. */
export function getReportAttendanceStatusEntries(catalog, countsByStatus) {
  const counts = countsByStatus || {};
  const entries = [];
  const seen = new Set();
  for (const st of catalog || []) {
    seen.add(st.id);
    const count = counts[st.id] ?? 0;
    if (st.active === false && !count) continue;
    entries.push({
      id: st.id,
      label: st.active === false ? `${st.label} (ngừng sử dụng)` : st.label,
      sortOrder: st.sortOrder ?? 0,
      count,
    });
  }
  for (const [id, count] of Object.entries(counts)) {
    if (!count || seen.has(id)) continue;
    const snap = (catalog || []).find((s) => s.id === id);
    const base = snap?.label || id;
    entries.push({
      id,
      label: `${base} (ngừng sử dụng)`,
      sortOrder: snap?.sortOrder ?? 999,
      count,
    });
  }
  return entries.sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
}

export function attendanceRosterForSession(state, session) {
  if (session.status === SESSION_STATUS.CANCELLED) return [];
  return membershipsForClassAt(state.memberships || [], session.classId, session.startAt);
}

export function getCurrentAttendance(state, sessionId, studentId) {
  return (state.attendanceRecords || []).find(
    (r) => r.sessionId === sessionId && r.studentId === studentId,
  ) || null;
}

/** Reports AC11 — student-session rows in range. */
export function computeAttendanceReport(state, filters) {
  const {
    classId = null,
    studentId = null,
    fromDate = null,
    toDate = null,
    includeFuture = false,
    nowIso = new Date().toISOString(),
  } = filters;
  const statusCatalog = state.attendanceStatusCatalog || defaultAttendanceCatalog();
  const statusIds = statusCatalog.map((s) => s.id);
  const countsByStatus = Object.fromEntries(statusIds.map((id) => [id, 0]));
  let unmarked = 0;
  let cancelledSessions = 0;
  const drilldown = [];
  const sessions = (state.classSessions || []).filter((s) => {
    if (classId && s.classId !== classId) return false;
    const dk = localDateKey(s.startAt);
    if (fromDate && dk < fromDate) return false;
    if (toDate && dk > toDate) return false;
    if (!includeFuture && parseIso(s.startAt)?.getTime() > parseIso(nowIso)?.getTime()) return false;
    if (studentId) {
      const roster = membershipsForClassAt(state.memberships || [], s.classId, s.startAt);
      if (!roster.some((m) => m.studentId === studentId)) return false;
    }
    return true;
  });

  for (const session of sessions) {
    if (session.status === SESSION_STATUS.CANCELLED) {
      if (studentId) {
        const roster = membershipsForClassAt(state.memberships || [], session.classId, session.startAt);
        if (!roster.some((m) => m.studentId === studentId)) continue;
      }
      cancelledSessions += 1;
      drilldown.push({ session, kind: 'cancelled' });
      continue;
    }
    const roster = attendanceRosterForSession(state, session);
    for (const m of roster) {
      if (studentId && m.studentId !== studentId) continue;
      const rec = getCurrentAttendance(state, session.id, m.studentId);
      if (!rec || !rec.statusId) {
        unmarked += 1;
        drilldown.push({ session, studentId: m.studentId, kind: 'unmarked' });
      } else if (countsByStatus[rec.statusId] != null) {
        countsByStatus[rec.statusId] += 1;
        drilldown.push({ session, studentId: m.studentId, kind: 'status', statusId: rec.statusId });
      } else {
        countsByStatus[rec.statusId] = (countsByStatus[rec.statusId] ?? 0) + 1;
        drilldown.push({ session, studentId: m.studentId, kind: 'legacy-status', statusId: rec.statusId });
      }
    }
  }

  const nonCancelledStudentSessions = Object.values(countsByStatus).reduce((a, b) => a + b, 0) + unmarked;
  return {
    countsByStatus,
    unmarked,
    cancelledSessions,
    sessionCount: sessions.length,
    studentSessionRows: nonCancelledStudentSessions,
    drilldown,
  };
}

export function migrateLegacyMemberships(state) {
  if (!state.memberships) state.memberships = [];
  if (!state.parents) state.parents = [];
  if (!state.parentStudentLinks) state.parentStudentLinks = [];
  if (!state.classSessions) state.classSessions = [];
  if (!state.scheduleTemplates) state.scheduleTemplates = [];
  if (!state.attendanceStatusCatalog?.length) {
    state.attendanceStatusCatalog = defaultAttendanceCatalog();
  }
  if (!state.attendanceRecords) state.attendanceRecords = [];
  if (!state.attendanceAudit) state.attendanceAudit = [];
  if (!state.sessionHistory) state.sessionHistory = [];
  if (!state.reminderJobs) state.reminderJobs = [];
  if (!state.notificationBatches) state.notificationBatches = [];
  if (!state.notificationAttempts) state.notificationAttempts = [];
  if (!state.manualSendEvents) state.manualSendEvents = [];
  if (!state.membershipAudit) state.membershipAudit = [];
  if (!state.baSettings) state.baSettings = { timezone: BA_TIMEZONE };

  for (const cls of state.classes || []) {
    if (!cls.kind) cls.kind = CLASS_KIND.GROUP;
    if (!cls.status) cls.status = CLASS_STATUS.ACTIVE;
    if (!Array.isArray(cls.studentIds)) cls.studentIds = [];
  }
  for (const st of state.students || []) {
    if (!st.status) st.status = 'active';
    if (!st.classId) continue;
    const hasAnyMembership = state.memberships.some(
      (m) => m.classId === st.classId && m.studentId === st.id,
    );
    if (!hasAnyMembership) {
      state.memberships.push({
        id: `legacy-${st.id}-${st.classId}`,
        classId: st.classId,
        studentId: st.id,
        effectiveFrom: st.enrolledAt || clsCreatedAt(state, st.classId) || '1970-01-01T00:00:00.000Z',
        effectiveTo: null,
        source: 'legacy-classId',
      });
    }
    syncClassStudentIds(state, st.classId);
  }
  return state;
}

function clsCreatedAt(state, classId) {
  return state.classes?.find((c) => c.id === classId)?.createdAt || null;
}

export function syncClassStudentIds(state, classId) {
  const cls = state.classes?.find((c) => c.id === classId);
  if (!cls) return;
  const now = new Date().toISOString();
  const active = membershipsForClassAt(state.memberships || [], classId, now);
  cls.studentIds = [...new Set(active.map((m) => m.studentId))];
}

/** Primary legacy classId plus classes with an active membership at `atIso`. */
export function studentAssignmentClassIds(student, memberships, atIso = new Date().toISOString()) {
  const ids = new Set();
  if (student?.classId) ids.add(student.classId);
  for (const m of memberships || []) {
    if (m.studentId !== student?.id) continue;
    if (isMembershipActive(m, atIso)) ids.add(m.classId);
  }
  return ids;
}

export function studentCanAccessAssignmentClass(student, assignmentClassId, memberships, atIso = new Date().toISOString()) {
  return studentAssignmentClassIds(student, memberships, atIso).has(assignmentClassId);
}

/** Validate YYYY-MM-DD for attendance report filters; empty/null is allowed. */
export function parseReportDateYmd(raw) {
  if (raw == null || raw === '' || raw === 'undefined') return { ok: true, value: null };
  const str = String(raw).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(str)) return { ok: false, error: 'invalid-format' };
  const [y, m, d] = str.split('-').map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (
    probe.getUTCFullYear() !== y
    || probe.getUTCMonth() !== m - 1
    || probe.getUTCDate() !== d
  ) {
    return { ok: false, error: 'invalid-calendar' };
  }
  return { ok: true, value: str };
}

export function syncStudentClassIdFromPrimaryMembership(state, studentId) {
  const st = state.students?.find((s) => s.id === studentId);
  if (!st) return;
  const open = (state.memberships || [])
    .filter((m) => m.studentId === studentId && !m.effectiveTo)
    .sort((a, b) => String(b.effectiveFrom).localeCompare(String(a.effectiveFrom)));
  if (open[0]) st.classId = open[0].classId;
}

export function stripBaFromStudentSnapshot(data) {
  const copy = { ...data };
  delete copy.parents;
  delete copy.parentStudentLinks;
  delete copy.memberships;
  delete copy.classSessions;
  delete copy.scheduleTemplates;
  delete copy.attendanceStatusCatalog;
  delete copy.attendanceRecords;
  delete copy.attendanceAudit;
  delete copy.sessionHistory;
  delete copy.reminderJobs;
  delete copy.notificationBatches;
  delete copy.notificationAttempts;
  delete copy.manualSendEvents;
  delete copy.membershipAudit;
  delete copy.baSettings;
  if (copy.classes) {
    copy.classes = copy.classes.map((c) => {
      const { defaultReminderEnabled, defaultReminderOffsetMinutes, kind, code, subject, notes, meetingUrl, status, studentIds, ...rest } = c;
      return rest;
    });
  }
  if (copy.students) {
    copy.students = copy.students.map((s) => {
      const { phone, email, contactPhone, contactEmail, notes, status, code, ...rest } = s;
      return rest;
    });
  }
  return copy;
}

export function teacherBaSnapshot(state) {
  return {
    parents: state.parents || [],
    parentStudentLinks: state.parentStudentLinks || [],
    memberships: state.memberships || [],
    classSessions: state.classSessions || [],
    scheduleTemplates: state.scheduleTemplates || [],
    attendanceStatusCatalog: state.attendanceStatusCatalog || defaultAttendanceCatalog(),
    attendanceRecords: state.attendanceRecords || [],
    attendanceAudit: state.attendanceAudit || [],
    sessionHistory: state.sessionHistory || [],
    reminderJobs: state.reminderJobs || [],
    notificationBatches: state.notificationBatches || [],
    notificationAttempts: state.notificationAttempts || [],
    manualSendEvents: state.manualSendEvents || [],
    membershipAudit: state.membershipAudit || [],
    baSettings: state.baSettings || { timezone: BA_TIMEZONE },
    baMockLabel: MOCK_PROVIDER_LABEL,
    serverMustStayRunning: true,
  };
}
