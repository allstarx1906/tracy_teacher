import { randomUUID } from 'node:crypto';
import {
  assertNoMembershipOverlap,
  assertNoParentLinkOverlap,
  assertOneToOneCapacity,
  assertOneToOneClassConversion,
  attendanceRosterForSession,
  buildNotificationContent,
  buildSessionRecipientRoster,
  buildPreviewCaptureKey,
  computeAttendanceReport,
  parseReportDateYmd,
  findTeacherSessionConflicts,
  getActiveAttendanceStatuses,
  getClassKind,
  CLASS_KIND,
  CLASS_STATUS,
  previewRecurringSessions,
  runMockSend,
  SESSION_STATUS,
  REMINDER_TYPE,
  validateSessionTimes,
  validateRecurringScheduleInput,
  buildScheduleApplyFingerprint,
  computeClassArchiveImpact,
  validateIntervalTimestamps,
  assertUniqueParentCode,
  assertUniqueClassCode,
  validateHttpMeetingUrl,
  normalizeOptionalCode,
  computeMembershipRetroactiveImpact,
  classifyMembershipMutation,
  syncClassStudentIds,
  membershipsForClassAt,
  MOCK_PROVIDER_LABEL,
  BATCH_RECIPIENT_STATUS,
  unionRecipientSnapshots,
  freezeSessionRosterSnapshot,
  resolveNotificationRecipients,
  getLatestRescheduleForSession,
  validateManualSendConfirm,
  MANUAL_SEND_OUTCOME,
  isValidReminderType,
  mergeFrozenRecipientUnions,
} from '../dist/ba-domain.js';
import { rebuildSessionReminderJobs, cancelPendingJobsForSession } from './ba-reminder-worker.mjs';

function requireTeacher(auth, res, error) {
  if (!auth || auth.role !== 'teacher') {
    error(res, 403, 'Chỉ giáo viên được phép.');
    return false;
  }
  return true;
}

function splitOperationId(body) {
  if (!body || typeof body !== 'object') return { operationId: null, payload: body };
  const operationId = typeof body.operationId === 'string' ? body.operationId : null;
  const payload = { ...body };
  delete payload.operationId;
  return { operationId, payload };
}

function validateAttendanceStatus(state, statusId, prev) {
  if (!statusId) return { ok: false, code: 'missing-status' };
  const catalog = state.attendanceStatusCatalog || [];
  const row = catalog.find((s) => s.id === statusId);
  if (!row) return { ok: false, code: 'unknown-status' };
  if (row.active !== false) return { ok: true, label: row.label };
  if (prev && prev.statusId === statusId) {
    return { ok: true, label: prev.statusLabelAtSave || row.label };
  }
  return { ok: false, code: 'inactive-status' };
}

function buildNotificationPackage(state, session, type) {
  const resolved = resolveNotificationRecipients(state, session, type);
  if (!resolved.ok) return resolved;
  const cls = state.classes.find((c) => c.id === session.classId);
  const changeContext = type === REMINDER_TYPE.SESSION_CHANGE
    ? getLatestRescheduleForSession(state, session.id)
    : null;
  const content = buildNotificationContent(session, cls, type, changeContext);
  const previewCaptureKey = buildPreviewCaptureKey({
    sessionId: session.id,
    type,
    content,
    recipients: resolved.recipients,
    skipped: resolved.skipped,
  });
  const recipientsSnapshot = [
    ...resolved.recipients.map((r) => ({ ...r, skipped: false })),
    ...resolved.skipped.map((r) => ({ ...r, skipped: true })),
  ];
  return {
    ok: true,
    content,
    recipients: resolved.recipients,
    skipped: resolved.skipped,
    previewCaptureKey,
    recipientsSnapshot,
    changeContext,
  };
}

function findManualRecipientSnapshot(state, body) {
  const session = state.classSessions.find((s) => s.id === body.sessionId);
  if (!session) throw new Error('missing-session');
  const key = String(body.canonicalKey || '').trim();
  if (!key) throw new Error('bad-recipient');
  if (body.batchId) {
    const batch = state.notificationBatches.find((b) => b.id === body.batchId);
    if (!batch || batch.sessionId !== session.id) throw new Error('bad-batch');
    const snap = (batch.recipientsSnapshot || []).find((r) => r.canonicalKey === key);
    if (!snap) throw new Error('bad-recipient');
    return { session, batch, snap, pkg: null };
  }
  const type = isValidReminderType(body.type) ? body.type : REMINDER_TYPE.SESSION_REMINDER;
  const pkg = buildNotificationPackage(state, session, type);
  if (!pkg.ok) throw new Error('bad-preview');
  const snap = pkg.recipientsSnapshot.find((r) => r.canonicalKey === key);
  if (!snap) throw new Error('bad-recipient');
  return { session, batch: null, snap, pkg };
}

function applyInheritedReminderDefaults(state, classId, cls, getNow) {
  for (const session of state.classSessions || []) {
    if (session.classId !== classId) continue;
    if (session.status !== SESSION_STATUS.SCHEDULED) continue;
    if (session.reminderEnabled != null || session.reminderOffsetMinutes != null) continue;
    rebuildSessionReminderJobs(state, session, getNow);
  }
}

function cancelPendingReminderJobsForClass(state, classId) {
  for (const job of state.reminderJobs || []) {
    if (job.status !== 'pending' && job.status !== 'overdue') continue;
    const sess = state.classSessions?.find((s) => s.id === job.sessionId);
    if (sess?.classId === classId) job.status = 'cancelled';
  }
}

/**
 * @returns {Promise<boolean>} true if request was handled
 */
export async function tryHandleBaTeacherApi(ctx) {
  const {
    req, res, pathname, auth, store, hostHeader, cookies,
    readJsonBody, error, json, runWithReplay, assertMutationHeaders,
    loadLiveAuth, withCommitAuth,
  } = ctx;

  const getNow = ctx.getNow || (() => new Date().toISOString());

  if (!pathname.startsWith('/api/teacher/ba/')) return false;
  if (!requireTeacher(auth, res, error)) return true;

  const mutating = req.method !== 'GET' && req.method !== 'HEAD';
  if (mutating && !assertMutationHeaders(req, hostHeader, cookies.bn_csrf, req.headers['x-bn-csrf'])) {
    error(res, 403, 'Yêu cầu không hợp lệ.');
    return true;
  }

  if (pathname === '/api/teacher/ba/parents' && req.method === 'PUT') {
    const rec = await readJsonBody(req);
    try {
      const replayOut = await runWithReplay(store, auth, 'ba.parent.put', rec?.operationId, rec, (s) => {
        const row = {
          id: rec.id || randomUUID(),
          code: String(rec.code || '').trim(),
          name: String(rec.name || '').trim(),
          phone: String(rec.phone || '').trim(),
          email: String(rec.email || '').trim(),
          notes: String(rec.notes || '').trim(),
          status: rec.status === 'inactive' ? 'inactive' : 'active',
        };
        if (!row.name) throw new Error('bad-name');
        const codeCheck = assertUniqueParentCode(s.parents, row.code, row.id);
        if (!codeCheck.ok) throw new Error(`code:${codeCheck.error}`);
        const idx = (s.parents || []).findIndex((p) => p.id === row.id);
        if (idx >= 0) s.parents[idx] = { ...s.parents[idx], ...row };
        else s.parents.push(row);
        return { client: { ok: true, id: row.id }, stored: { ok: true, id: row.id } };
      });
      if (!replayOut.ok) { error(res, replayOut.status, replayOut.error); return true; }
      json(res, 200, replayOut.result);
    } catch (e) {
      const m = String(e?.message || '');
      if (m === 'bad-name') { error(res, 400, 'Cần họ tên phụ huynh.'); return true; }
      if (m.startsWith('code:')) { error(res, 400, m.slice(5)); return true; }
      throw e;
    }
    return true;
  }

  if (pathname === '/api/teacher/ba/parent-links' && req.method === 'PUT') {
    const rec = await readJsonBody(req);
    try {
      const replayOut = await runWithReplay(store, auth, 'ba.parentLink.put', rec?.operationId, rec, (s) => {
        const row = {
          id: rec.id || randomUUID(),
          parentId: rec.parentId,
          studentId: rec.studentId,
          relationship: String(rec.relationship || '').trim(),
          effectiveFrom: rec.effectiveFrom || getNow(),
          effectiveTo: rec.effectiveTo || null,
        };
        if (!row.parentId || !row.studentId) throw new Error('bad-link');
        if (!s.parents.some((p) => p.id === row.parentId)) throw new Error('bad-parent');
        if (!s.students.some((st) => st.id === row.studentId)) throw new Error('bad-student');
        const iv = validateIntervalTimestamps(row.effectiveFrom, row.effectiveTo);
        if (!iv.ok) throw new Error(`interval:${iv.error}`);
        const overlap = assertNoParentLinkOverlap(s.parentStudentLinks, {
          parentId: row.parentId,
          studentId: row.studentId,
          effectiveFrom: row.effectiveFrom,
          effectiveTo: row.effectiveTo,
          excludeId: row.id,
        });
        if (!overlap.ok) throw new Error(`overlap:${overlap.error}`);
        const idx = (s.parentStudentLinks || []).findIndex((l) => l.id === row.id);
        if (idx >= 0) s.parentStudentLinks[idx] = row;
        else s.parentStudentLinks.push(row);
        return { client: { ok: true, id: row.id }, stored: { ok: true, id: row.id } };
      });
      if (!replayOut.ok) { error(res, replayOut.status, replayOut.error); return true; }
      json(res, 200, replayOut.result);
    } catch (e) {
      const m = String(e?.message || '');
      if (m === 'bad-link') { error(res, 400, 'Thiếu phụ huynh hoặc học sinh.'); return true; }
      if (m === 'bad-parent') { error(res, 400, 'Phụ huynh không tồn tại.'); return true; }
      if (m === 'bad-student') { error(res, 400, 'Học sinh không tồn tại.'); return true; }
      if (m.startsWith('interval:')) { error(res, 400, m.slice(9)); return true; }
      if (m.startsWith('overlap:')) { error(res, 400, m.slice(8)); return true; }
      throw e;
    }
    return true;
  }

  if (pathname === '/api/teacher/ba/memberships' && req.method === 'PUT') {
    const rec = await readJsonBody(req);
    try {
      const replayOut = await runWithReplay(store, auth, 'ba.membership.put', rec?.operationId, rec, (s) => {
        if (!s.membershipAudit) s.membershipAudit = [];
        const row = {
          id: rec.id || randomUUID(),
          classId: rec.classId,
          studentId: rec.studentId,
          effectiveFrom: rec.effectiveFrom || getNow(),
          effectiveTo: rec.effectiveTo || null,
        };
        if (!s.classes.some((c) => c.id === row.classId)) throw new Error('bad-class');
        if (!s.students.some((st) => st.id === row.studentId)) throw new Error('bad-student');
        const iv = validateIntervalTimestamps(row.effectiveFrom, row.effectiveTo);
        if (!iv.ok) throw new Error(`interval:${iv.error}`);
        const idx = s.memberships.findIndex((m) => m.id === row.id);
        const prior = idx >= 0 ? { ...s.memberships[idx] } : null;
        if (prior && (prior.classId !== row.classId || prior.studentId !== row.studentId)) {
          throw new Error('identity-move');
        }
        const ov = assertNoMembershipOverlap(s.memberships, {
          classId: row.classId,
          studentId: row.studentId,
          effectiveFrom: row.effectiveFrom,
          effectiveTo: row.effectiveTo,
          excludeId: row.id,
        });
        if (!ov.ok) throw new Error(`overlap:${ov.error}`);
        const cap = assertOneToOneCapacity(
          s.memberships, s.classes, row.classId, row.effectiveFrom, row.studentId, row.id, row.effectiveTo,
        );
        if (!cap.ok) throw new Error(`one-to-one:${cap.error}`);
        const impact = computeMembershipRetroactiveImpact(s, prior, row, { nowIso: getNow() });
        if (impact.hasImpact) {
          if (!rec.confirmImpact) {
            const err = new Error('retro-impact');
            err.impact = impact;
            throw err;
          }
          const reason = String(rec.reason || '').trim();
          if (!reason) throw new Error('reason-required');
        }
        if (idx >= 0) s.memberships[idx] = row;
        else s.memberships.push(row);
        syncClassStudentIds(s, row.classId);
        if (prior && prior.classId !== row.classId) syncClassStudentIds(s, prior.classId);
        s.membershipAudit.push({
          id: randomUUID(),
          membershipId: row.id,
          action: classifyMembershipMutation(prior, row),
          oldValue: prior,
          newValue: { ...row },
          reason: String(rec.reason || '').trim() || (prior ? 'Cập nhật' : 'Khởi tạo'),
          actor: auth.username || 'teacher',
          at: getNow(),
          impactSessionIds: impact.sessionIds || [],
          impactAttendanceKeys: impact.attendanceRecordIds || [],
        });
        return { client: { ok: true, id: row.id }, stored: { ok: true, id: row.id } };
      });
      if (!replayOut.ok) { error(res, replayOut.status, replayOut.error); return true; }
      json(res, 200, replayOut.result);
    } catch (e) {
      const msg = String(e?.message || '');
      if (msg === 'retro-impact') {
        json(res, 409, {
          error: 'Thay đổi ảnh hưởng lịch sử buổi/điểm danh — cần confirmImpact và lý do.',
          impact: e.impact,
        });
        return true;
      }
      if (msg.startsWith('overlap:')) { error(res, 400, msg.slice(8)); return true; }
      if (msg.startsWith('one-to-one:')) { error(res, 400, msg.slice(11)); return true; }
      if (msg.startsWith('interval:')) { error(res, 400, msg.slice(9)); return true; }
      if (msg === 'bad-class') { error(res, 400, 'Lớp không tồn tại.'); return true; }
      if (msg === 'bad-student') { error(res, 400, 'Học sinh không tồn tại.'); return true; }
      if (msg === 'identity-move') {
        error(res, 400, 'Không được đổi lớp/học sinh trên cùng một khoảng tham gia.');
        return true;
      }
      if (msg === 'reason-required') {
        error(res, 400, 'Cần lý do khi xác nhận tác động hồi tố.');
        return true;
      }
      throw e;
    }
    return true;
  }

  if (pathname === '/api/teacher/ba/classes/meta' && req.method === 'PUT') {
    const rec = await readJsonBody(req);
    try {
      const replayOut = await runWithReplay(store, auth, 'ba.classMeta.put', rec?.operationId, rec, (s) => {
      const cls = s.classes.find((c) => c.id === rec.classId);
      if (!cls) throw new Error('bad-class');
      if (rec.kind) {
        const nextKind = rec.kind === CLASS_KIND.ONE_TO_ONE ? CLASS_KIND.ONE_TO_ONE : CLASS_KIND.GROUP;
        if (nextKind === CLASS_KIND.ONE_TO_ONE && getClassKind(cls) !== CLASS_KIND.ONE_TO_ONE) {
          const conv = assertOneToOneClassConversion(s.memberships, s.classes, cls.id, CLASS_KIND.ONE_TO_ONE);
          if (!conv.ok) throw new Error(`one-to-one:${conv.error}`);
        }
        cls.kind = nextKind;
      }
      if (rec.code != null) {
        const code = normalizeOptionalCode(rec.code);
        if (code) {
          const uniq = assertUniqueClassCode(s.classes, code, cls.id);
          if (!uniq.ok) throw new Error(`dup-code:${uniq.error}`);
        }
        cls.code = code;
      }
      if (rec.subject != null) cls.subject = String(rec.subject).trim();
      if (rec.notes != null) cls.notes = String(rec.notes).trim();
      if (rec.meetingUrl != null) {
        const mv = validateHttpMeetingUrl(rec.meetingUrl);
        if (!mv.ok) throw new Error(`meeting-url:${mv.error}`);
        cls.meetingUrl = mv.value;
      }
      if (rec.status === CLASS_STATUS.ARCHIVED) {
        if (!rec.confirmArchiveImpact) throw new Error('archive-confirm');
        cls.status = CLASS_STATUS.ARCHIVED;
        cancelPendingReminderJobsForClass(s, cls.id);
      } else if (rec.status === CLASS_STATUS.ACTIVE) {
        cls.status = CLASS_STATUS.ACTIVE;
      }
      const defaultChanged = rec.defaultReminderEnabled != null || rec.defaultReminderOffsetMinutes != null;
      if (defaultChanged && !rec.confirmDefaultReminderImpact) throw new Error('default-reminder-confirm');
      if (rec.defaultReminderEnabled != null) cls.defaultReminderEnabled = !!rec.defaultReminderEnabled;
      if (rec.defaultReminderOffsetMinutes != null) {
        cls.defaultReminderOffsetMinutes = Math.max(0, Number(rec.defaultReminderOffsetMinutes) || 0);
      }
      if (defaultChanged) applyInheritedReminderDefaults(s, cls.id, cls, getNow);
      return { client: { ok: true, classId: cls.id }, stored: { ok: true, classId: cls.id } };
    });
      if (!replayOut.ok) { error(res, replayOut.status, replayOut.error); return true; }
      json(res, 200, replayOut.result);
    } catch (e) {
      const m = e?.message;
      if (m === 'bad-class') { error(res, 400, 'Lớp không tồn tại.'); return true; }
      if (m === 'archive-confirm') { error(res, 409, 'Cần xác nhận tác động lưu trữ lớp (confirmArchiveImpact).'); return true; }
      if (m === 'default-reminder-confirm') {
        error(res, 409, 'Cần xác nhận cập nhật nhắc mặc định (confirmDefaultReminderImpact).');
        return true;
      }
      if (String(m).startsWith('one-to-one:')) { error(res, 400, m.slice(11)); return true; }
      if (String(m).startsWith('dup-code:')) { error(res, 400, m.slice(9)); return true; }
      if (String(m).startsWith('meeting-url:')) { error(res, 400, m.slice(12)); return true; }
      throw e;
    }
    return true;
  }

  if (pathname === '/api/teacher/ba/schedule/preview' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const state = await store.read();
    const cls = state.classes.find((c) => c.id === body.classId);
    if (!cls) { error(res, 400, 'Lớp không tồn tại.'); return true; }
    const preview = previewRecurringSessions({
      classId: body.classId,
      weekdays: body.weekdays,
      startTime: body.startTime,
      endTime: body.endTime,
      rangeFromDate: body.rangeFromDate,
      rangeToDate: body.rangeToDate,
      existingSessions: state.classSessions,
      classRow: cls,
    });
    if (!preview.ok) { error(res, 400, preview.error); return true; }
    const conflicts = [];
    for (const cand of preview.sessions) {
      const c = findTeacherSessionConflicts(state.classSessions, cand);
      if (c.length) conflicts.push({ session: cand, conflicts: c.map((x) => x.id) });
    }
    const validated = validateRecurringScheduleInput(body, { classRow: cls });
    const previewFingerprint = buildScheduleApplyFingerprint(preview.sessions, validated.ok ? validated : body);
    json(res, 200, {
      ok: true,
      sessions: preview.sessions,
      conflicts,
      previewFingerprint,
      mockLabel: MOCK_PROVIDER_LABEL,
    });
    return true;
  }

  if (pathname === '/api/teacher/ba/schedule/apply' && req.method === 'POST') {
    const bodyRaw = await readJsonBody(req);
    const { operationId, payload: body } = splitOperationId(bodyRaw);
    try {
      const replayOut = await runWithReplay(store, auth, 'ba.schedule.apply', operationId, body, (s) => {
        const cls = s.classes.find((c) => c.id === body.classId);
        if (!cls) throw new Error('bad-class');
        if (cls.status === CLASS_STATUS.ARCHIVED) throw new Error('archived');
        const preview = previewRecurringSessions({
          classId: body.classId,
          weekdays: body.weekdays,
          startTime: body.startTime,
          endTime: body.endTime,
          rangeFromDate: body.rangeFromDate,
          rangeToDate: body.rangeToDate,
          existingSessions: s.classSessions,
          templateId: body.templateId,
          classRow: cls,
        });
        if (!preview.ok) throw new Error(`preview:${preview.error}`);
        const validated = validateRecurringScheduleInput(body, { classRow: cls });
        const fingerprint = buildScheduleApplyFingerprint(preview.sessions, validated.ok ? validated : body);
        if (!body.previewFingerprint || body.previewFingerprint !== fingerprint) {
          throw new Error('stale-preview');
        }
        const templateId = body.templateId || randomUUID();
        if (!s.scheduleTemplates.find((t) => t.id === templateId)) {
          s.scheduleTemplates.push({
            id: templateId,
            classId: body.classId,
            weekdays: body.weekdays,
            startTime: body.startTime,
            endTime: body.endTime,
            rangeFromDate: body.rangeFromDate,
            rangeToDate: body.rangeToDate,
            createdAt: new Date().toISOString(),
          });
        }
        const created = [];
        const allowOverlap = !!body.confirmOverlap;
        for (const cand of preview.sessions) {
          if (cand.duplicateOfExisting) continue;
          const conf = findTeacherSessionConflicts(s.classSessions, cand);
          if (conf.length && !allowOverlap) throw new Error('conflict');
          const row = {
            id: randomUUID(),
            classId: body.classId,
            templateId,
            startAt: cand.startAt,
            endAt: cand.endAt,
            status: SESSION_STATUS.SCHEDULED,
            revision: 0,
            reminderEnabled: body.reminderEnabled,
            reminderOffsetMinutes: body.reminderOffsetMinutes,
            meetingUrl: body.meetingUrl || '',
            notes: body.notes || '',
            createdAt: new Date().toISOString(),
          };
          s.classSessions.push(row);
          rebuildSessionReminderJobs(s, row, getNow);
          created.push(row.id);
        }
        const result = { ok: true, createdIds: created, templateId };
        return { client: result, stored: result };
      });
      if (!replayOut.ok) { error(res, replayOut.status, replayOut.error); return true; }
      json(res, 200, replayOut.result);
    } catch (e) {
      if (e?.message === 'conflict') { error(res, 409, 'Lịch bị chồng giờ — xác nhận confirmOverlap để tiếp tục.'); return true; }
      if (e?.message === 'stale-preview') {
        error(res, 409, 'Xem trước đã cũ — xem trước lại trước khi lưu.');
        return true;
      }
      if (e?.message === 'archived') { error(res, 400, 'Lớp đã lưu trữ — không áp dụng lịch lặp.'); return true; }
      if (e?.message === 'bad-class') { error(res, 400, 'Lớp không tồn tại.'); return true; }
      if (String(e?.message).startsWith('preview:')) { error(res, 400, e.message.slice(8)); return true; }
      throw e;
    }
    return true;
  }

  if (pathname === '/api/teacher/ba/sessions/adhoc' && req.method === 'PUT') {
    const rec = await readJsonBody(req);
    try {
      const replayOut = await runWithReplay(store, auth, 'ba.session.adhoc', rec?.operationId, rec, (s) => {
        const cls = s.classes.find((c) => c.id === rec.classId);
        if (!cls) throw new Error('bad-class');
        if (cls.status === CLASS_STATUS.ARCHIVED) throw new Error('archived');
        if (rec.id) {
          const existing = s.classSessions.find((x) => x.id === rec.id);
          if (existing) {
            if (Object.prototype.hasOwnProperty.call(rec, 'reminderEnabled')) {
              existing.reminderEnabled = rec.reminderEnabled === null ? null : !!rec.reminderEnabled;
            }
            if (Object.prototype.hasOwnProperty.call(rec, 'reminderOffsetMinutes')) {
              existing.reminderOffsetMinutes = rec.reminderOffsetMinutes === null
                ? null
                : Math.max(0, Number(rec.reminderOffsetMinutes) || 0);
            }
            if (Object.prototype.hasOwnProperty.call(rec, 'meetingUrl')) {
              const mv = validateHttpMeetingUrl(rec.meetingUrl);
              if (!mv.ok) throw new Error(`meeting-url:${mv.error}`);
              existing.meetingUrl = mv.value;
            }
            if (Object.prototype.hasOwnProperty.call(rec, 'notes')) {
              existing.notes = String(rec.notes ?? '').trim();
            }
            rebuildSessionReminderJobs(s, existing, getNow);
            return { client: { ok: true, id: existing.id }, stored: { ok: true, id: existing.id } };
          }
        }
        let meetingUrl = '';
        if (rec.meetingUrl != null && String(rec.meetingUrl).trim()) {
          const mv = validateHttpMeetingUrl(rec.meetingUrl);
          if (!mv.ok) throw new Error(`meeting-url:${mv.error}`);
          meetingUrl = mv.value;
        }
        const tv = validateSessionTimes(rec.startAt, rec.endAt);
        if (!tv.ok) throw new Error(`time:${tv.error}`);
        const cand = { startAt: rec.startAt, endAt: rec.endAt };
        const conf = findTeacherSessionConflicts(s.classSessions, cand, rec.id);
        if (conf.length && !rec.confirmOverlap) throw new Error('conflict');
        const row = {
          id: rec.id || randomUUID(),
          classId: rec.classId,
          startAt: rec.startAt,
          endAt: rec.endAt,
          status: SESSION_STATUS.SCHEDULED,
          revision: 0,
          meetingUrl: meetingUrl || rec.meetingUrl || '',
          notes: rec.notes != null ? String(rec.notes).trim() : '',
          reminderEnabled: rec.reminderEnabled,
          reminderOffsetMinutes: rec.reminderOffsetMinutes,
          createdAt: new Date().toISOString(),
        };
        s.classSessions.push(row);
        rebuildSessionReminderJobs(s, row, getNow);
        return { client: { ok: true, id: row.id }, stored: { ok: true, id: row.id } };
      });
      if (!replayOut.ok) { error(res, replayOut.status, replayOut.error); return true; }
      json(res, 200, replayOut.result);
    } catch (e) {
      if (e?.message === 'conflict') { error(res, 409, 'Lịch bị chồng giờ.'); return true; }
      if (e?.message === 'archived') { error(res, 400, 'Lớp đã lưu trữ — không tạo buổi mới.'); return true; }
      if (e?.message === 'bad-class') { error(res, 400, 'Lớp không tồn tại.'); return true; }
      if (String(e?.message).startsWith('time:')) { error(res, 400, e.message.slice(5)); return true; }
      if (String(e?.message).startsWith('meeting-url:')) { error(res, 400, e.message.slice(12)); return true; }
      throw e;
    }
    return true;
  }

  const sessionAction = pathname.match(/^\/api\/teacher\/ba\/sessions\/([^/]+)\/(reschedule|cancel|complete)$/);
  if (sessionAction && req.method === 'POST') {
    const sessionId = sessionAction[1];
    const action = sessionAction[2];
    const body = await readJsonBody(req);
    try {
      const replayOut = await runWithReplay(store, auth, `ba.session.${action}`, body?.operationId, { sessionId, ...body }, (s) => {
        const session = s.classSessions.find((x) => x.id === sessionId);
        if (!session) throw new Error('missing');
        if (action === 'cancel') {
          if (session.status === SESSION_STATUS.CANCELLED) throw new Error('already-cancelled');
          const cancelReason = String(body.reason || '').trim();
          if (!cancelReason) throw new Error('reason-required');
          const rosterAtCancel = buildSessionRecipientRoster(s, session);
          const frozenCurrent = freezeSessionRosterSnapshot(rosterAtCancel);
          session.cancelNotifyRosterUnion = mergeFrozenRecipientUnions(
            session.cancelNotifyRosterUnion,
            mergeFrozenRecipientUnions(session.changeNotifyRosterUnion, frozenCurrent),
          );
          const oldStatus = session.status;
          const oldStart = session.startAt;
          const oldEnd = session.endAt;
          session.status = SESSION_STATUS.CANCELLED;
          session.cancelReason = cancelReason;
          session.cancelledAt = new Date().toISOString();
          s.sessionHistory.push({
            id: randomUUID(),
            sessionId,
            action: 'cancel',
            reason: session.cancelReason,
            oldStatus,
            newStatus: SESSION_STATUS.CANCELLED,
            oldStart,
            oldEnd,
            newStart: session.startAt,
            newEnd: session.endAt,
            operator: auth.username || 'teacher',
            at: session.cancelledAt,
          });
          cancelPendingJobsForSession(s, sessionId);
        } else if (action === 'complete') {
          if (session.status === SESSION_STATUS.CANCELLED) throw new Error('cancelled');
          if (session.status === SESSION_STATUS.COMPLETED) throw new Error('already-completed');
          const prevStatus = session.status;
          session.status = SESSION_STATUS.COMPLETED;
          session.completedAt = new Date().toISOString();
          s.sessionHistory.push({
            id: randomUUID(),
            sessionId,
            action: 'complete',
            oldStatus: prevStatus,
            newStatus: SESSION_STATUS.COMPLETED,
            at: session.completedAt,
            operator: auth.username || 'teacher',
          });
        } else if (action === 'reschedule') {
          if (session.status === SESSION_STATUS.CANCELLED) throw new Error('cancelled');
          if (session.status === SESSION_STATUS.COMPLETED) throw new Error('completed');
          const rescheduleReason = String(body.reason || '').trim();
          if (!rescheduleReason) throw new Error('reason-required');
          const tv = validateSessionTimes(body.startAt, body.endAt);
          if (!tv.ok) throw new Error(`time:${tv.error}`);
          const oldStart = session.startAt;
          const oldEnd = session.endAt;
          const rosterBefore = buildSessionRecipientRoster(s, session);
          const conf = findTeacherSessionConflicts(s.classSessions, { startAt: body.startAt, endAt: body.endAt }, sessionId);
          if (conf.length && !body.confirmOverlap) throw new Error('conflict');
          session.startAt = body.startAt;
          session.endAt = body.endAt;
          session.revision = (session.revision ?? 0) + 1;
          const rosterAfter = buildSessionRecipientRoster(s, session);
          const unionThis = unionRecipientSnapshots(rosterBefore, rosterAfter);
          session.changeNotifyRosterUnion = mergeFrozenRecipientUnions(
            session.changeNotifyRosterUnion,
            unionThis,
          );
          s.sessionHistory.push({
            id: randomUUID(),
            sessionId,
            action: 'reschedule',
            reason: rescheduleReason,
            oldStart,
            oldEnd,
            newStart: session.startAt,
            newEnd: session.endAt,
            oldReminderEnabled: session.reminderEnabled,
            oldReminderOffsetMinutes: session.reminderOffsetMinutes,
            operator: auth.username || 'teacher',
            at: new Date().toISOString(),
          });
          rebuildSessionReminderJobs(s, session, getNow);
        }
        return { client: { ok: true, sessionId }, stored: { ok: true, sessionId } };
      });
      if (!replayOut.ok) { error(res, replayOut.status, replayOut.error); return true; }
      json(res, 200, replayOut.result);
    } catch (e) {
      const m = e?.message;
      if (m === 'missing') { error(res, 404, 'Không tìm thấy buổi.'); return true; }
      if (m === 'conflict') { error(res, 409, 'Lịch bị chồng giờ.'); return true; }
      if (m === 'cancelled' || m === 'completed' || m === 'already-cancelled' || m === 'already-completed') {
        error(res, 400, 'Không thể thao tác buổi ở trạng thái hiện tại.');
        return true;
      }
      if (m === 'reason-required') {
        error(res, 400, 'Cần lý do (không được để trống).');
        return true;
      }
      if (String(m).startsWith('time:')) { error(res, 400, m.slice(5)); return true; }
      throw e;
    }
    return true;
  }

  if (pathname === '/api/teacher/ba/attendance/catalog' && req.method === 'PUT') {
    const rec = await readJsonBody(req);
    try {
      const replayOut = await runWithReplay(store, auth, 'ba.attendance.catalog', rec?.operationId, rec, (s) => {
        const row = {
          id: rec.id || randomUUID(),
          label: String(rec.label || '').trim(),
          sortOrder: Number(rec.sortOrder),
          active: rec.active !== false,
        };
        if (!row.label) throw new Error('bad-label');
        if (!Number.isFinite(row.sortOrder)) throw new Error('bad-order');
        const idx = s.attendanceStatusCatalog.findIndex((x) => x.id === row.id);
        if (idx >= 0) {
          const prev = s.attendanceStatusCatalog[idx];
          s.attendanceStatusCatalog[idx] = { ...prev, label: row.label, sortOrder: row.sortOrder, active: row.active };
        } else {
          if (s.attendanceStatusCatalog.some((x) => x.id === row.id)) throw new Error('bad-id');
          s.attendanceStatusCatalog.push(row);
        }
        s.attendanceStatusCatalog.sort((a, b) => (a.sortOrder - b.sortOrder) || a.id.localeCompare(b.id));
        return { client: { ok: true, id: row.id }, stored: { ok: true, id: row.id } };
      });
      if (!replayOut.ok) { error(res, replayOut.status, replayOut.error); return true; }
      json(res, 200, replayOut.result);
    } catch (e) {
      const m = String(e?.message || '');
      if (m === 'bad-label') { error(res, 400, 'Cần tên trạng thái.'); return true; }
      if (m === 'bad-order') { error(res, 400, 'Thứ tự sắp xếp không hợp lệ.'); return true; }
      throw e;
    }
    return true;
  }

  if (pathname === '/api/teacher/ba/attendance/record' && req.method === 'PUT') {
    const rec = await readJsonBody(req);
    try {
      const replayOut = await runWithReplay(store, auth, 'ba.attendance.record', rec?.operationId, rec, (s) => {
        const session = s.classSessions.find((x) => x.id === rec.sessionId);
        if (!session) throw new Error('missing');
        if (session.status === SESSION_STATUS.CANCELLED) throw new Error('cancelled');
        const roster = attendanceRosterForSession(s, session);
        if (!roster.some((m) => m.studentId === rec.studentId)) throw new Error('not-roster');
        const prev = s.attendanceRecords.find(
          (r) => r.sessionId === rec.sessionId && r.studentId === rec.studentId,
        );
        if (prev && rec.expectedRevision != null && prev.revision !== rec.expectedRevision) {
          throw new Error('revision');
        }
        if (prev) {
          if (rec.expectedRevision == null) throw new Error('revision-required');
          if (!String(rec.correctionReason || '').trim()) throw new Error('reason-required');
        }
        const stCheck = validateAttendanceStatus(s, rec.statusId, prev);
        if (!stCheck.ok) throw new Error(stCheck.code);
        const next = {
          sessionId: rec.sessionId,
          studentId: rec.studentId,
          statusId: rec.statusId,
          statusLabelAtSave: stCheck.label,
          note: String(rec.note || '').trim(),
          minutesLate: rec.minutesLate != null ? Math.max(0, Number(rec.minutesLate) || 0) : null,
          revision: (prev?.revision ?? 0) + 1,
          updatedAt: new Date().toISOString(),
          updatedBy: 'teacher',
        };
        if (prev) {
          s.attendanceAudit.push({
            id: randomUUID(),
            sessionId: rec.sessionId,
            studentId: rec.studentId,
            reason: String(rec.correctionReason || '').trim(),
            oldValue: { ...prev },
            newValue: { ...next },
            at: next.updatedAt,
          });
          Object.assign(prev, next);
        } else {
          s.attendanceAudit.push({
            id: randomUUID(),
            sessionId: rec.sessionId,
            studentId: rec.studentId,
            reason: 'Khởi tạo',
            oldValue: null,
            newValue: { ...next },
            at: next.updatedAt,
          });
          s.attendanceRecords.push(next);
        }
        return { client: { ok: true, revision: next.revision }, stored: { ok: true, revision: next.revision } };
      });
      if (!replayOut.ok) { error(res, replayOut.status, replayOut.error); return true; }
      json(res, 200, replayOut.result);
    } catch (e) {
      const m = e?.message;
      if (m === 'cancelled') { error(res, 400, 'Buổi đã hủy — không điểm danh.'); return true; }
      if (m === 'revision') { error(res, 409, 'Dữ liệu điểm danh đã thay đổi ở tab khác.'); return true; }
      if (m === 'not-roster') { error(res, 400, 'Học sinh không thuộc danh sách buổi.'); return true; }
      if (m === 'missing') { error(res, 404, 'Không tìm thấy buổi.'); return true; }
      if (m === 'missing-status') { error(res, 400, 'Chọn trạng thái điểm danh.'); return true; }
      if (m === 'unknown-status') { error(res, 400, 'Trạng thái điểm danh không hợp lệ.'); return true; }
      if (m === 'inactive-status') { error(res, 400, 'Trạng thái điểm danh đã ngừng dùng.'); return true; }
      if (m === 'reason-required') { error(res, 400, 'Cần lý do khi sửa điểm danh.'); return true; }
      if (m === 'revision-required') { error(res, 400, 'Thiếu revision khi sửa điểm danh.'); return true; }
      throw e;
    }
    return true;
  }

  if (pathname === '/api/teacher/ba/reports/attendance' && req.method === 'GET') {
    const state = await store.read();
    const q = new URL(`http://x${req.url}`).searchParams;
    const classIdRaw = q.get('classId');
    const studentIdRaw = q.get('studentId');
    const classId = classIdRaw && classIdRaw !== 'undefined' ? classIdRaw : null;
    const studentId = studentIdRaw && studentIdRaw !== 'undefined' ? studentIdRaw : null;
    const fromParsed = parseReportDateYmd(q.get('fromDate'));
    if (!fromParsed.ok) {
      error(res, 400, fromParsed.error === 'invalid-format' ? 'Ngày bắt đầu không đúng định dạng YYYY-MM-DD.' : 'Ngày bắt đầu không hợp lệ.');
      return true;
    }
    const toParsed = parseReportDateYmd(q.get('toDate'));
    if (!toParsed.ok) {
      error(res, 400, toParsed.error === 'invalid-format' ? 'Ngày kết thúc không đúng định dạng YYYY-MM-DD.' : 'Ngày kết thúc không hợp lệ.');
      return true;
    }
    if (fromParsed.value && toParsed.value && fromParsed.value > toParsed.value) {
      error(res, 400, 'Ngày bắt đầu phải trước hoặc bằng ngày kết thúc.');
      return true;
    }
    const report = computeAttendanceReport(state, {
      classId,
      studentId,
      fromDate: fromParsed.value,
      toDate: toParsed.value,
      includeFuture: q.get('includeFuture') === '1',
      nowIso: getNow(),
    });
    json(res, 200, { ok: true, report });
    return true;
  }

  if (pathname === '/api/teacher/ba/notifications/preview' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const state = await store.read();
    const session = state.classSessions.find((s) => s.id === body.sessionId);
    if (!session) { error(res, 404, 'Không tìm thấy buổi.'); return true; }
    const type = body.type || REMINDER_TYPE.SESSION_REMINDER;
    if (!isValidReminderType(type)) { error(res, 400, 'Loại thông báo không hợp lệ.'); return true; }
    const pkg = buildNotificationPackage(state, session, type);
    if (!pkg.ok) {
      const msg = pkg.code === 'cancelled-session' ? 'Buổi đã hủy — không gửi nhắc lịch.'
        : pkg.code === 'not-cancelled' ? 'Chỉ gửi thông báo hủy khi buổi đã hủy.'
          : pkg.code === 'no-change-roster' ? 'Chưa có lịch sử đổi giờ cho buổi này.'
            : 'Loại thông báo không hợp lệ.';
      error(res, 400, msg);
      return true;
    }
    json(res, 200, {
      ok: true,
      type,
      content: pkg.content,
      recipients: pkg.recipients,
      skipped: pkg.skipped,
      previewCaptureKey: pkg.previewCaptureKey,
      mockLabel: MOCK_PROVIDER_LABEL,
    });
    return true;
  }

  if (pathname === '/api/teacher/ba/notifications/send-mock' && req.method === 'POST') {
    const body = await readJsonBody(req);
    try {
      const replayOut = await runWithReplay(store, auth, 'ba.notify.mock', body?.operationId, body, (s) => {
        const session = s.classSessions.find((x) => x.id === body.sessionId);
        if (!session) throw new Error('missing');
        const type = body.type || REMINDER_TYPE.SESSION_REMINDER;
        if (!isValidReminderType(type)) throw new Error('bad-type');
        const pkg = buildNotificationPackage(s, session, type);
        if (!pkg.ok) throw new Error(pkg.code);
        if (body.previewCaptureKey && body.previewCaptureKey !== pkg.previewCaptureKey) {
          throw new Error('stale-preview');
        }
        const batchId = randomUUID();
        const attemptId = randomUUID();
        const now = new Date().toISOString();
        s.notificationBatches.push({
          id: batchId,
          sessionId: session.id,
          type,
          createdAt: now,
          contentSnapshot: pkg.content,
          provider: 'mock',
          mode: body.mode || 'manual-mock',
          mockLabel: MOCK_PROVIDER_LABEL,
          initiator: auth.username || 'teacher',
          scenario: body.scenario || 'all-success',
          recipientsSnapshot: pkg.recipientsSnapshot,
          previewCaptureKey: pkg.previewCaptureKey,
        });
        const results = runMockSend(pkg.recipients, body.scenario || 'all-success', body.perRecipient || {});
        for (const r of results) {
          const snap = pkg.recipientsSnapshot.find((x) => x.canonicalKey === r.canonicalKey);
          s.notificationAttempts.push({
            id: randomUUID(),
            batchId,
            attemptId,
            canonicalKey: r.canonicalKey,
            status: r.status,
            error: r.error,
            at: r.at,
            auto: false,
            recipientSnapshot: snap ? { ...snap } : null,
          });
        }
        for (const sk of pkg.skipped) {
          s.notificationAttempts.push({
            id: randomUUID(),
            batchId,
            attemptId,
            canonicalKey: sk.canonicalKey,
            status: BATCH_RECIPIENT_STATUS.SKIPPED,
            error: sk.skipReason,
            at: now,
            auto: false,
            recipientSnapshot: { ...sk, skipped: true },
          });
        }
        return {
          client: {
            ok: true,
            batchId,
            attemptId,
            mockLabel: MOCK_PROVIDER_LABEL,
            previewCaptureKey: pkg.previewCaptureKey,
          },
          stored: { ok: true, batchId },
        };
      });
      if (!replayOut.ok) { error(res, replayOut.status, replayOut.error); return true; }
      json(res, 200, replayOut.result);
    } catch (e) {
      const m = e?.message;
      if (m === 'missing') { error(res, 404, 'Không tìm thấy buổi.'); return true; }
      if (m === 'stale-preview') { error(res, 409, 'Xem trước đã hết hạn — tải lại trước khi gửi.'); return true; }
      if (m === 'cancelled-session' || m === 'not-cancelled' || m === 'no-change-roster' || m === 'bad-type') {
        error(res, 400, 'Không thể gửi loại thông báo này cho buổi hiện tại.');
        return true;
      }
      throw e;
    }
    return true;
  }

  if (pathname === '/api/teacher/ba/notifications/retry' && req.method === 'POST') {
    const body = await readJsonBody(req);
    try {
      const replayOut = await runWithReplay(store, auth, 'ba.notify.retry', body?.operationId, body, (s) => {
      const prevAttempt = s.notificationAttempts.find((a) => a.id === body.attemptId);
      if (!prevAttempt) throw new Error('missing');
      const batch = s.notificationBatches.find((b) => b.id === prevAttempt.batchId);
      if (!batch) throw new Error('missing');
      const snap = batch.recipientsSnapshot.find((r) => r.canonicalKey === prevAttempt.canonicalKey);
      if (!snap || snap.skipped) throw new Error('bad-target');
      if (prevAttempt.status === BATCH_RECIPIENT_STATUS.MOCK_SUCCESS && !body.confirmSuccessRetry) {
        throw new Error('confirm-success-retry');
      }
      const attemptId = randomUUID();
      const results = runMockSend([snap], body.scenario || 'all-success', body.perRecipient || {});
      for (const r of results) {
        s.notificationAttempts.push({
          id: randomUUID(),
          batchId: batch.id,
          attemptId,
          priorAttemptId: prevAttempt.id,
          canonicalKey: r.canonicalKey,
          status: r.status,
          error: r.error,
          at: r.at,
          auto: false,
          recipientSnapshot: snap ? { ...snap } : null,
        });
      }
      return { client: { ok: true, attemptId }, stored: { ok: true, attemptId } };
    });
      if (!replayOut.ok) { error(res, replayOut.status, replayOut.error); return true; }
      json(res, 200, replayOut.result);
    } catch (e) {
      const m = e?.message;
      if (m === 'missing') { error(res, 404, 'Không tìm thấy lần gửi.'); return true; }
      if (m === 'bad-target') { error(res, 400, 'Không thể thử lại người nhận này.'); return true; }
      if (m === 'confirm-success-retry') {
        error(res, 409, 'Cần confirmSuccessRetry để gửi lại lần đã thành công.');
        return true;
      }
      throw e;
    }
    return true;
  }

  if (pathname === '/api/teacher/ba/manual-send/confirm' && req.method === 'POST') {
    const body = await readJsonBody(req);
    try {
      const replayOut = await runWithReplay(store, auth, 'ba.manual.confirm', body?.operationId, body, (s) => {
        if (!body?.sessionId || !s.classSessions.some((x) => x.id === body.sessionId)) {
          throw new Error('missing-session');
        }
        const manualCheck = validateManualSendConfirm(body);
        if (!manualCheck.ok) throw new Error(manualCheck.code);
        const { session, batch, snap, pkg } = findManualRecipientSnapshot(s, body);
        if (snap.skipped && !body.teacherProvidedChannel) {
          if (manualCheck.declaredSentAt && body.outcome !== MANUAL_SEND_OUTCOME.UNPROCESSED) {
            throw new Error('missing-channel');
          }
        }
        const contentSnapshot = batch?.contentSnapshot
          || pkg?.content
          || buildNotificationPackage(s, session, batch?.type || body.type || REMINDER_TYPE.SESSION_REMINDER).content;
        s.manualSendEvents.push({
          id: randomUUID(),
          sessionId: session.id,
          batchId: batch?.id || body.batchId || null,
          canonicalKey: snap.canonicalKey,
          channel: String(body.channel || body.teacherProvidedChannel || '').trim(),
          outcome: manualCheck.outcome,
          note: manualCheck.notes,
          notes: manualCheck.notes,
          declaredSentAt: manualCheck.declaredSentAt,
          recordedAt: new Date().toISOString(),
          actor: auth.username || 'teacher',
          contentSnapshot,
          recipientSnapshot: { ...snap },
          teacherProvidedChannel: body.teacherProvidedChannel || null,
          label: 'Giáo viên ghi nhận gửi thủ công (không xác minh Zalo thật)',
        });
        return { client: { ok: true }, stored: { ok: true } };
      });
      if (!replayOut.ok) { error(res, replayOut.status, replayOut.error); return true; }
      json(res, 200, replayOut.result);
    } catch (e) {
      const m = e?.message;
      if (m === 'missing-session') { error(res, 404, 'Không tìm thấy buổi.'); return true; }
      if (m === 'bad-batch' || m === 'bad-recipient' || m === 'bad-preview') {
        error(res, 400, 'Người nhận không khớp buổi hoặc batch đã chọn.');
        return true;
      }
      if (m === 'bad-outcome') { error(res, 400, 'Kết quả ghi nhận không hợp lệ.'); return true; }
      if (m === 'bad-time') { error(res, 400, 'Thời gian gửi không hợp lệ.'); return true; }
      if (m === 'time-required') { error(res, 400, 'Cần thời gian gửi khi ghi nhận kết quả.'); return true; }
      if (m === 'notes-long') { error(res, 400, 'Ghi chú quá dài.'); return true; }
      if (m === 'missing-channel') {
        error(res, 400, 'Thiếu liên hệ — cần kênh giáo viên cung cấp hoặc để chưa xử lý.');
        return true;
      }
      throw e;
    }
    return true;
  }

  if (pathname === '/api/teacher/ba/reminders/tick' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const live = await ctx.loadLiveAuth(res, cookies);
    if (!live) return true;
    const now = body.nowIso || new Date().toISOString();
    try {
      await store.mutate(ctx.withCommitAuth(live.auth, (state) => {
        const { runReminderTick } = ctx.reminderFns;
        const latenessWindowMs = ctx.reminderLatenessWindowMs;
        runReminderTick(state, now, () => now, {
          includeOverdue: !!body.processOverdue,
          latenessWindowMs,
        });
      }));
    } catch (e) {
      if (e?.message === 'session-revoked') {
        error(res, 401, 'Phiên đăng nhập không còn hợp lệ.');
        return true;
      }
      throw e;
    }
    json(res, 200, { ok: true });
    return true;
  }

  return false;
}

/** Sync membership when legacy student record PUT changes classId. */
export function syncMembershipOnStudentPut(state, rec, previous, getNow = () => new Date().toISOString()) {
  if (!rec?.classId || !rec?.id) return;
  const prevClass = previous?.classId;
  if (prevClass === rec.classId) return;
  const now = getNow();
  if (prevClass) {
    for (const m of state.memberships || []) {
      if (m.studentId === rec.id && m.classId === prevClass && !m.effectiveTo) {
        m.effectiveTo = now;
      }
    }
  }
  const overlap = assertNoMembershipOverlap(state.memberships, {
    classId: rec.classId,
    studentId: rec.id,
    effectiveFrom: now,
    effectiveTo: null,
    excludeId: null,
  });
  if (!overlap.ok) return;
  const cap = assertOneToOneCapacity(state.memberships, state.classes, rec.classId, now, rec.id, null);
  if (!cap.ok) throw new Error(`one-to-one:${cap.error}`);
  state.memberships.push({
    id: randomUUID(),
    classId: rec.classId,
    studentId: rec.id,
    effectiveFrom: now,
    effectiveTo: null,
    source: 'student-put',
  });
  syncClassStudentIds(state, rec.classId);
  if (prevClass) syncClassStudentIds(state, prevClass);
}

export { getActiveAttendanceStatuses, getClassKind, membershipsForClassAt };
