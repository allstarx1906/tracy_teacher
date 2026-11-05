import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
  assertOneToOneCapacity,
  buildSessionRecipientRoster,
  computeAttendanceReport,
  computeReminderDueAt,
  migrateLegacyMemberships,
  previewRecurringSessions,
  runMockSend,
  SESSION_STATUS,
  CLASS_KIND,
  localDateTimeToUtcIso,
  canonicalRecipientKey,
} from '../dist/ba-domain.js';
import {
  startBaTestServer,
  teacherSetup,
  api,
  seedClassStudent,
  loadTeacherData,
  backdateOpenMembership,
} from './ba-test-helpers.mjs';
import {
  processDueJobs,
  flagOverdueJobs,
  startupOverdueRecovery,
  runReminderTick,
  reminderLatenessWindowMs,
} from '../server/ba-reminder-worker.mjs';
import { REMINDER_TYPE, REMINDER_JOB_STATUS, sessionRevisionKey } from '../dist/ba-domain.js';

test('AC01 / migration: legacy classId creates membership without breaking assignments shape', () => {
  const state = {
    meta: { version: 1 },
    classes: [],
    students: [],
    assignments: [],
  };
  state.classes.push({
    id: 'c1',
    name: 'Legacy',
    scheduleDays: [],
    scheduleTime: '10:00',
    createdAt: '2020-01-01T00:00:00.000Z',
  });
  state.students.push({ id: 's1', name: 'Lan', classId: 'c1' });
  state.assignments.push({ id: 'a1', classId: 'c1', title: 'HW', attachmentIds: [] });
  migrateLegacyMemberships(state);
  assert.equal(state.memberships.length, 1);
  assert.equal(state.assignments.length, 1);
  assert.ok(state.classes[0].studentIds.includes('s1'));
});

test('AC01: one-to-one rejects second active student', () => {
  const memberships = [
    { id: 'm1', classId: 'c1', studentId: 's1', effectiveFrom: '2020-01-01T00:00:00.000Z', effectiveTo: null },
  ];
  const classes = [{ id: 'c1', kind: CLASS_KIND.ONE_TO_ONE }];
  const r = assertOneToOneCapacity(memberships, classes, 'c1', '2026-01-01T00:00:00.000Z', 's2', null);
  assert.equal(r.ok, false);
});

test('AC02: parent links visible from roster builder', () => {
  const state = migrateLegacyMemberships({
    classes: [{ id: 'c1', name: 'G', scheduleDays: [], scheduleTime: '09:00', createdAt: '2020-01-01T00:00:00.000Z' }],
    students: [{ id: 's1', name: 'Bé', classId: 'c1', phone: '0900111222' }],
    memberships: [{ id: 'm1', classId: 'c1', studentId: 's1', effectiveFrom: '2020-01-01T00:00:00.000Z' }],
    parents: [{ id: 'p1', name: 'Mẹ', phone: '0900333444', status: 'active' }],
    parentStudentLinks: [{
      id: 'l1', parentId: 'p1', studentId: 's1', relationship: 'Mẹ', effectiveFrom: '2020-01-01T00:00:00.000Z',
    }],
  });
  const session = {
    id: 'sess1',
    classId: 'c1',
    startAt: '2026-06-01T12:00:00.000Z',
    endAt: '2026-06-01T13:00:00.000Z',
  };
  const { recipients } = buildSessionRecipientRoster(state, session);
  assert.ok(recipients.some((r) => r.role === 'student'));
  assert.ok(recipients.some((r) => r.role === 'parent'));
});

test('AC03: preview recurring stable keys', () => {
  const preview = previewRecurringSessions({
    classId: 'c1',
    weekdays: [1],
    startTime: '19:00',
    endTime: '20:00',
    rangeFromDate: '2026-06-01',
    rangeToDate: '2026-06-14',
    existingSessions: [],
  });
  assert.equal(preview.ok, true);
  assert.ok(preview.sessions.length >= 1);
});

test('AC11: report counts unmarked separately from cancelled', () => {
  const state = migrateLegacyMemberships({
    classes: [{ id: 'c1', name: 'G', scheduleDays: [], scheduleTime: '09:00', createdAt: '2020-01-01T00:00:00.000Z' }],
    students: [{ id: 's1', name: 'Bé', classId: 'c1' }],
    memberships: [{ id: 'm1', classId: 'c1', studentId: 's1', effectiveFrom: '2020-01-01T00:00:00.000Z' }],
    classSessions: [
      {
        id: 'ok',
        classId: 'c1',
        startAt: localDateTimeToUtcIso('2026-06-02', '19:00'),
        endAt: localDateTimeToUtcIso('2026-06-02', '20:00'),
        status: SESSION_STATUS.SCHEDULED,
      },
      {
        id: 'cancel',
        classId: 'c1',
        startAt: localDateTimeToUtcIso('2026-06-03', '19:00'),
        endAt: localDateTimeToUtcIso('2026-06-03', '20:00'),
        status: SESSION_STATUS.CANCELLED,
      },
    ],
  });
  const report = computeAttendanceReport(state, {
    fromDate: '2026-06-01',
    toDate: '2026-06-30',
    nowIso: '2026-12-01T00:00:00.000Z',
  });
  assert.equal(report.unmarked, 1);
  assert.equal(report.cancelledSessions, 1);
});

test('AC13/AC14: dedup parent + skipped missing contact', () => {
  const state = migrateLegacyMemberships({
    classes: [{ id: 'c1', name: 'G', scheduleDays: [], scheduleTime: '09:00', createdAt: '2020-01-01T00:00:00.000Z' }],
    students: [
      { id: 's1', name: 'A', classId: 'c1', phone: '0900111222' },
      { id: 's2', name: 'B', classId: 'c1', phone: '0900111222' },
    ],
    memberships: [
      { id: 'm1', classId: 'c1', studentId: 's1', effectiveFrom: '2020-01-01T00:00:00.000Z' },
      { id: 'm2', classId: 'c1', studentId: 's2', effectiveFrom: '2020-01-01T00:00:00.000Z' },
    ],
    parents: [{ id: 'p1', name: 'Chung', phone: '0900111222', status: 'active' }],
    parentStudentLinks: [
      { id: 'l1', parentId: 'p1', studentId: 's1', relationship: 'Mẹ', effectiveFrom: '2020-01-01T00:00:00.000Z' },
      { id: 'l2', parentId: 'p1', studentId: 's2', relationship: 'Mẹ', effectiveFrom: '2020-01-01T00:00:00.000Z' },
    ],
  });
  const session = {
    classId: 'c1',
    startAt: '2026-06-01T12:00:00.000Z',
    endAt: '2026-06-01T13:00:00.000Z',
  };
  const { recipients, skipped } = buildSessionRecipientRoster(state, session);
  const phoneRecipients = recipients.filter((r) => canonicalRecipientKey(r).startsWith('phone:'));
  assert.equal(phoneRecipients.length, 1);
  state.parents.push({ id: 'p2', name: 'NoContact', status: 'active' });
  state.parentStudentLinks.push({
    id: 'l3', parentId: 'p2', studentId: 's1', relationship: 'Bố', effectiveFrom: '2020-01-01T00:00:00.000Z',
  });
  const again = buildSessionRecipientRoster(state, session);
  assert.ok(again.skipped.some((s) => s.skipReason.includes('Thiếu')));
});

test('AC15/AC16: deterministic mock results', () => {
  const recipients = [{ canonicalKey: 'a' }, { canonicalKey: 'b' }];
  const ok = runMockSend(recipients, 'all-success');
  assert.ok(ok.every((x) => x.status === 'mock-success'));
  const fail = runMockSend(recipients, 'per-recipient', { a: true, b: false });
  assert.equal(fail[0].status, 'mock-success');
  assert.equal(fail[1].status, 'mock-fail');
});

test('AC12: reminder due offset', () => {
  const start = localDateTimeToUtcIso('2026-06-02', '19:00');
  const due = computeReminderDueAt(start, 60);
  assert.ok(due < start);
});

test('A1 unit: process due pending before flagging overdue dispatches once', () => {
  const now = '2026-06-01T12:00:01.000Z';
  const dueAt = '2026-06-01T12:00:00.000Z';
  const state = {
    classes: [{ id: 'c1', name: 'G' }],
    students: [],
    memberships: [],
    classSessions: [{
      id: 's1',
      classId: 'c1',
      startAt: '2026-06-01T13:00:00.000Z',
      endAt: '2026-06-01T14:00:00.000Z',
      status: SESSION_STATUS.SCHEDULED,
      revision: 0,
    }],
    reminderJobs: [{
      id: 'j1',
      sessionId: 's1',
      type: REMINDER_TYPE.SESSION_REMINDER,
      sessionRevisionKey: sessionRevisionKey({ id: 's1', revision: 0 }),
      dueAt,
      status: REMINDER_JOB_STATUS.PENDING,
    }],
    notificationBatches: [],
    notificationAttempts: [],
  };
  runReminderTick(state, now, () => now, { latenessWindowMs: reminderLatenessWindowMs() });
  assert.equal(state.notificationBatches.length, 1);
  assert.equal(state.reminderJobs[0].status, REMINDER_JOB_STATUS.DONE);
});

test('E1: stale pending reminder becomes overdue with zero batches', () => {
  const now = '2026-02-01T12:00:00.000Z';
  const state = {
    classes: [{ id: 'c1', name: 'G' }],
    classSessions: [{
      id: 's1',
      classId: 'c1',
      startAt: '2026-02-01T13:00:00.000Z',
      endAt: '2026-02-01T14:00:00.000Z',
      status: SESSION_STATUS.SCHEDULED,
      revision: 0,
    }],
    reminderJobs: [{
      id: 'j1',
      sessionId: 's1',
      type: REMINDER_TYPE.SESSION_REMINDER,
      sessionRevisionKey: sessionRevisionKey({ id: 's1', revision: 0 }),
      dueAt: '2026-01-20T12:00:00.000Z',
      status: REMINDER_JOB_STATUS.PENDING,
    }],
    notificationBatches: [],
    notificationAttempts: [],
  };
  runReminderTick(state, now, () => now, { latenessWindowMs: reminderLatenessWindowMs() });
  assert.equal(state.notificationBatches.length, 0);
  assert.equal(state.reminderJobs[0].status, REMINDER_JOB_STATUS.OVERDUE);
});

test('A1 unit: startup recovery marks overdue without dispatch', () => {
  const now = '2026-06-01T12:00:00.000Z';
  const state = {
    reminderJobs: [{
      id: 'j1',
      sessionId: 's1',
      dueAt: '2026-06-01T11:00:00.000Z',
      status: REMINDER_JOB_STATUS.PENDING,
    }],
    notificationBatches: [],
  };
  startupOverdueRecovery(state, now, reminderLatenessWindowMs());
  assert.equal(state.reminderJobs[0].status, REMINDER_JOB_STATUS.OVERDUE);
  assert.equal(state.notificationBatches.length, 0);
});

test('AC24: no leave/makeup fee routes', async (t) => {
  const ctx = await startBaTestServer();
  t.after(async () => {
    await ctx.close();
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });
  const jar = await teacherSetup(ctx);
  for (const path of ['/api/teacher/ba/leave', '/api/teacher/ba/makeup', '/api/teacher/ba/fees']) {
    const r = await api(ctx.base, jar, path, { method: 'POST', body: {} });
    assert.notEqual(r.res.status, 200);
  }
});

test('HTTP workflow: membership one-to-one + adhoc session + cancel (AC04/AC06)', async (t) => {
  const ctx = await startBaTestServer();
  t.after(async () => {
    await ctx.close();
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });
  const jar = await teacherSetup(ctx);
  const { classId, studentId } = await seedClassStudent(ctx, jar);
  await api(ctx.base, jar, '/api/teacher/ba/classes/meta', {
    method: 'PUT',
    body: { classId, kind: 'one-to-one' },
  });
  const s2 = randomUUID();
  const deny = await api(ctx.base, jar, '/api/teacher/record/students', {
    method: 'PUT',
    body: { id: s2, name: 'HS 2', classId },
  });
  assert.equal(deny.res.status, 400);
  const startAt = localDateTimeToUtcIso('2026-07-01', '19:00');
  const endAt = localDateTimeToUtcIso('2026-07-01', '20:00');
  const adhoc = await api(ctx.base, jar, '/api/teacher/ba/sessions/adhoc', {
    method: 'PUT',
    body: { classId, startAt, endAt },
  });
  assert.equal(adhoc.res.status, 200);
  const sessionId = adhoc.data.id;
  const cancel = await api(ctx.base, jar, `/api/teacher/ba/sessions/${sessionId}/cancel`, {
    method: 'POST',
    body: { reason: 'test' },
  });
  assert.equal(cancel.res.status, 200);
  const att = await api(ctx.base, jar, '/api/teacher/ba/attendance/record', {
    method: 'PUT',
    body: { sessionId, studentId, statusId: 'present' },
  });
  assert.equal(att.res.status, 400);
});

test('AC10: attendance audit on correction', async (t) => {
  const ctx = await startBaTestServer();
  t.after(async () => {
    await ctx.close();
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });
  const jar = await teacherSetup(ctx);
  const { classId, studentId } = await seedClassStudent(ctx, jar);
  const memBack = await backdateOpenMembership(ctx, jar, {
    classId,
    studentId,
    effectiveFrom: '2020-01-01T00:00:00.000Z',
  });
  assert.equal(memBack.res.status, 200);
  const startAt = localDateTimeToUtcIso('2026-08-01', '19:00');
  const endAt = localDateTimeToUtcIso('2026-08-01', '20:00');
  const adhoc = await api(ctx.base, jar, '/api/teacher/ba/sessions/adhoc', {
    method: 'PUT',
    body: { classId, startAt, endAt },
  });
  assert.equal(adhoc.res.status, 200);
  const sessionId = adhoc.data.id;
  const initial = await api(ctx.base, jar, '/api/teacher/ba/attendance/record', {
    method: 'PUT',
    body: { sessionId, studentId, statusId: 'present' },
  });
  assert.equal(initial.res.status, 200);
  const corrected = await api(ctx.base, jar, '/api/teacher/ba/attendance/record', {
    method: 'PUT',
    body: {
      sessionId,
      studentId,
      statusId: 'absent',
      correctionReason: 'Sửa',
      expectedRevision: 1,
    },
  });
  assert.equal(corrected.res.status, 200);
  const data = await loadTeacherData(ctx, jar);
  assert.ok(data.attendanceAudit.length >= 1);
});

test('AC17/AC18: mock send + reminder tick idempotent', async (t) => {
  const ctx = await startBaTestServer();
  t.after(async () => {
    await ctx.close();
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });
  const jar = await teacherSetup(ctx);
  const { classId, studentId } = await seedClassStudent(ctx, jar, { studentName: 'Em' });
  const memBack = await backdateOpenMembership(ctx, jar, {
    classId,
    studentId,
    effectiveFrom: '2020-01-01T00:00:00.000Z',
  });
  assert.equal(memBack.res.status, 200);
  const studentPut = await api(ctx.base, jar, '/api/teacher/record/students', {
    method: 'PUT',
    body: { id: studentId, name: 'Em', classId, phone: '0900999888' },
  });
  assert.equal(studentPut.res.status, 200);
  const startAt = localDateTimeToUtcIso('2026-09-01', '19:00');
  const endAt = localDateTimeToUtcIso('2026-09-01', '20:00');
  const adhoc = await api(ctx.base, jar, '/api/teacher/ba/sessions/adhoc', {
    method: 'PUT',
    body: {
      classId,
      startAt,
      endAt,
      reminderEnabled: true,
      reminderOffsetMinutes: 0,
    },
  });
  assert.equal(adhoc.res.status, 200);
  const sessionId = adhoc.data.id;
  const dueNow = computeReminderDueAt(startAt, 0);
  const tick1 = await api(ctx.base, jar, '/api/teacher/ba/reminders/tick', { method: 'POST', body: { nowIso: dueNow } });
  assert.equal(tick1.res.status, 200);
  const tick2 = await api(ctx.base, jar, '/api/teacher/ba/reminders/tick', { method: 'POST', body: { nowIso: dueNow } });
  assert.equal(tick2.res.status, 200);
  const data = await loadTeacherData(ctx, jar);
  const batches = data.notificationBatches.filter((b) => b.sessionId === sessionId);
  assert.equal(batches.length, 1);
  const mock = await api(ctx.base, jar, '/api/teacher/ba/notifications/send-mock', {
    method: 'POST',
    body: { sessionId, scenario: 'all-fail' },
  });
  assert.equal(mock.res.status, 200);
  const retryTarget = (await loadTeacherData(ctx, jar)).notificationAttempts.find((a) => a.status === 'mock-fail');
  assert.ok(retryTarget, 'expected a mock-fail attempt to retry');
  const before = (await loadTeacherData(ctx, jar)).notificationAttempts.length;
  const retry = await api(ctx.base, jar, '/api/teacher/ba/notifications/retry', {
    method: 'POST',
    body: { attemptId: retryTarget.id, scenario: 'all-success' },
  });
  assert.equal(retry.res.status, 200);
  const after = (await loadTeacherData(ctx, jar)).notificationAttempts.length;
  assert.equal(after, before + 1);
});

test('AC20: manual confirm does not alter mock attempts', async (t) => {
  const ctx = await startBaTestServer();
  t.after(async () => {
    await ctx.close();
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });
  const jar = await teacherSetup(ctx);
  const { classId, studentId } = await seedClassStudent(ctx, jar);
  await api(ctx.base, jar, '/api/teacher/record/students', {
    method: 'PUT',
    body: { id: studentId, name: 'Em', classId, phone: '0900888777' },
  });
  const startAt = localDateTimeToUtcIso('2026-10-01', '19:00');
  const endAt = localDateTimeToUtcIso('2026-10-01', '20:00');
  const adhoc = await api(ctx.base, jar, '/api/teacher/ba/sessions/adhoc', {
    method: 'PUT',
    body: { classId, startAt, endAt },
  });
  const sessionId = adhoc.data.id;
  await api(ctx.base, jar, '/api/teacher/ba/notifications/send-mock', {
    method: 'POST',
    body: { sessionId, scenario: 'all-fail' },
  });
  const mid = await loadTeacherData(ctx, jar);
  const batch = mid.notificationBatches[mid.notificationBatches.length - 1];
  const snap = batch.recipientsSnapshot.find((r) => !r.skipped);
  assert.ok(snap);
  const before = mid.notificationAttempts.length;
  await api(ctx.base, jar, '/api/teacher/ba/manual-send/confirm', {
    method: 'POST',
    body: {
      sessionId,
      batchId: batch.id,
      canonicalKey: snap.canonicalKey,
      channel: 'Zalo tay',
      outcome: 'teacher-confirmed-success',
      declaredSentAt: '2026-10-01T10:00:00.000Z',
      note: 'Gửi ngoài mock',
    },
  });
  const data = await loadTeacherData(ctx, jar);
  assert.equal(data.notificationAttempts.length, before);
  assert.equal(data.manualSendEvents.length, 1);
});

test('AC22: archive class meta preserves sessions', async (t) => {
  const ctx = await startBaTestServer();
  t.after(async () => {
    await ctx.close();
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });
  const jar = await teacherSetup(ctx);
  const { classId } = await seedClassStudent(ctx, jar);
  const startAt = localDateTimeToUtcIso('2026-11-01', '19:00');
  const endAt = localDateTimeToUtcIso('2026-11-01', '20:00');
  await api(ctx.base, jar, '/api/teacher/ba/sessions/adhoc', {
    method: 'PUT',
    body: { classId, startAt, endAt },
  });
  await api(ctx.base, jar, '/api/teacher/ba/classes/meta', {
    method: 'PUT',
    body: { classId, status: 'archived', confirmArchiveImpact: true },
  });
  const data = await loadTeacherData(ctx, jar);
  assert.equal(data.classes.find((c) => c.id === classId).status, 'archived');
  assert.ok(data.classSessions.length >= 1);
});

test('AC19: overdue flagged before dispatch; tick at due creates one batch', async (t) => {
  const ctx = await startBaTestServer();
  t.after(async () => {
    await ctx.close();
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });
  const jar = await teacherSetup(ctx);
  const { classId } = await seedClassStudent(ctx, jar);
  const startAt = localDateTimeToUtcIso('2028-01-10', '19:00');
  const endAt = localDateTimeToUtcIso('2028-01-10', '20:00');
  const adhoc = await api(ctx.base, jar, '/api/teacher/ba/sessions/adhoc', {
    method: 'PUT',
    body: { classId, startAt, endAt, reminderEnabled: true, reminderOffsetMinutes: 0 },
  });
  const sessionId = adhoc.data.id;
  const dueAt = computeReminderDueAt(startAt, 0);
  const late = new Date(new Date(dueAt).getTime() + 1).toISOString();
  await api(ctx.base, jar, '/api/teacher/ba/reminders/tick', { method: 'POST', body: { nowIso: late } });
  let data = await loadTeacherData(ctx, jar);
  let batches = data.notificationBatches.filter((b) => b.sessionId === sessionId);
  assert.equal(batches.length, 1, 'due+1ms tick must dispatch exactly once');
  await api(ctx.base, jar, '/api/teacher/ba/reminders/tick', { method: 'POST', body: { nowIso: late } });
  data = await loadTeacherData(ctx, jar);
  batches = data.notificationBatches.filter((b) => b.sessionId === sessionId);
  assert.equal(batches.length, 1, 'second tick must not duplicate batch');
});

test('AC21: notification batch keeps recipient snapshot after catalog rename', async (t) => {
  const ctx = await startBaTestServer();
  t.after(async () => {
    await ctx.close();
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });
  const jar = await teacherSetup(ctx);
  const { classId, studentId } = await seedClassStudent(ctx, jar);
  await api(ctx.base, jar, '/api/teacher/record/students', {
    method: 'PUT',
    body: { id: studentId, name: 'Em', classId, phone: '0900777666' },
  });
  const startAt = localDateTimeToUtcIso('2028-02-01', '19:00');
  const endAt = localDateTimeToUtcIso('2028-02-01', '20:00');
  const adhoc = await api(ctx.base, jar, '/api/teacher/ba/sessions/adhoc', {
    method: 'PUT',
    body: { classId, startAt, endAt },
  });
  await api(ctx.base, jar, '/api/teacher/ba/notifications/send-mock', {
    method: 'POST',
    body: { sessionId: adhoc.data.id, scenario: 'all-success' },
  });
  const before = await loadTeacherData(ctx, jar);
  const batch = before.notificationBatches[before.notificationBatches.length - 1];
  const snapName = batch.recipientsSnapshot.find((r) => r.role === 'student')?.displayName;
  await api(ctx.base, jar, '/api/teacher/record/students', {
    method: 'PUT',
    body: { id: studentId, name: 'Em Đổi tên', classId, phone: '0900777666' },
  });
  const after = await loadTeacherData(ctx, jar);
  const frozen = after.notificationBatches.find((b) => b.id === batch.id);
  assert.equal(frozen.recipientsSnapshot.find((r) => r.role === 'student')?.displayName, snapName);
});

test('migration: ended membership not reopened from legacy classId', () => {
  const state = migrateLegacyMemberships({
    classes: [{
      id: 'c1',
      name: 'L',
      scheduleDays: [],
      scheduleTime: '09:00',
      createdAt: '2020-01-01T00:00:00.000Z',
    }],
    students: [{ id: 's1', name: 'Lan', classId: 'c1' }],
    memberships: [{
      id: 'm-ended',
      classId: 'c1',
      studentId: 's1',
      effectiveFrom: '2020-01-01T00:00:00.000Z',
      effectiveTo: '2021-06-01T00:00:00.000Z',
    }],
  });
  assert.equal(state.memberships.length, 1);
  assert.ok(state.memberships[0].effectiveTo);
});

test('AC11: student filter ignores cancelled sessions without enrollment', () => {
  const state = migrateLegacyMemberships({
    classes: [{ id: 'c1', name: 'G', scheduleDays: [], scheduleTime: '09:00', createdAt: '2020-01-01T00:00:00.000Z' }],
    students: [
      { id: 's1', name: 'Enrolled', classId: 'c1' },
      { id: 's2', name: 'Never' },
    ],
    memberships: [{ id: 'm1', classId: 'c1', studentId: 's1', effectiveFrom: '2020-01-01T00:00:00.000Z' }],
    classSessions: [{
      id: 'cancel',
      classId: 'c1',
      startAt: localDateTimeToUtcIso('2026-06-03', '19:00'),
      endAt: localDateTimeToUtcIso('2026-06-03', '20:00'),
      status: SESSION_STATUS.CANCELLED,
    }],
  });
  const report = computeAttendanceReport(state, {
    studentId: 's2',
    fromDate: '2026-06-01',
    toDate: '2026-06-30',
    nowIso: '2026-12-01T00:00:00.000Z',
  });
  assert.equal(report.cancelledSessions, 0);
});
