import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
  REMINDER_TYPE,
  SESSION_STATUS,
  canonicalRecipientKey,
  computeMembershipRetroactiveImpact,
  localDateTimeToUtcIso,
  migrateLegacyMemberships,
  utcIsoToBaLocalInput,
  baLocalInputToUtcIso,
} from '../dist/ba-domain.js';
import {
  getStudentsInClass,
  studentCanAccessAssignmentClassClient,
} from '../dist/model.js';
import {
  runReminderTick,
  reminderLatenessWindowMs,
  startupOverdueRecovery,
  REMINDER_LATENESS_GRACE_MS,
} from '../server/ba-reminder-worker.mjs';
import { REMINDER_JOB_STATUS, sessionRevisionKey } from '../dist/ba-domain.js';
import {
  startBaTestServer,
  teacherSetup,
  api,
  loadTeacherData,
  backdateOpenMembership,
  studentLoginAfterPasswordChange,
} from './ba-test-helpers.mjs';
import { installBaDomEnvironment, aggregateDomTextContent } from './helper-browser-window.mjs';
import { el } from '../dist/ba-ui-dom.js';

function previewRecipientKeys(previewData) {
  return new Set([
    ...(previewData.recipients || []).map((r) => r.canonicalKey),
    ...(previewData.skipped || []).map((r) => r.canonicalKey),
  ]);
}
async function uploadStudentImage(base, jar) {
  const tinyPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const res = await api(base, jar, '/api/images', {
    method: 'POST',
    body: { mime: 'image/png', dataBase64: tinyPng },
  });
  assert.equal(res.res.status, 200, res.data?.error || 'image upload failed');
  assert.equal(res.res.headers.get('content-type')?.includes('application/json'), true);
  assert.ok(res.data?.id, 'image id missing');
  return res.data.id;
}

test('E1: repeated ticks do not dispatch overdue or duplicate recent due', () => {
  const lateness = reminderLatenessWindowMs(10_000);
  const dueAt = '2026-06-01T12:00:00.000Z';
  const now = '2026-06-01T12:00:05.000Z';
  const state = {
    classes: [{ id: 'c1', name: 'G' }],
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
      sessionRevisionKey: sessionRevisionKey({ id: 's1', revision: 0 }),
      dueAt,
      status: REMINDER_JOB_STATUS.PENDING,
    }],
    notificationBatches: [],
    notificationAttempts: [],
  };
  runReminderTick(state, now, () => now, { latenessWindowMs: lateness });
  assert.equal(state.notificationBatches.length, 1);
  runReminderTick(state, now, () => now, { latenessWindowMs: lateness });
  assert.equal(state.notificationBatches.length, 1);
  assert.equal(REMINDER_LATENESS_GRACE_MS > 0, true);
});

test('E1: mixed pending jobs dispatch only those within lateness window', () => {
  const lateness = reminderLatenessWindowMs(60_000);
  const now = '2026-03-01T12:00:00.000Z';
  const mkJob = (id, dueAt) => ({
    id,
    sessionId: 's1',
    sessionRevisionKey: sessionRevisionKey({ id: 's1', revision: 0 }),
    dueAt,
    status: REMINDER_JOB_STATUS.PENDING,
  });
  const state = {
    classes: [{ id: 'c1', name: 'G' }],
    classSessions: [{
      id: 's1',
      classId: 'c1',
      startAt: '2026-03-01T13:00:00.000Z',
      endAt: '2026-03-01T14:00:00.000Z',
      status: SESSION_STATUS.SCHEDULED,
      revision: 0,
    }],
    reminderJobs: [
      mkJob('recent', '2026-03-01T11:59:30.000Z'),
      mkJob('stale', '2026-02-01T12:00:00.000Z'),
    ],
    notificationBatches: [],
    notificationAttempts: [],
  };
  runReminderTick(state, now, () => now, { latenessWindowMs: lateness });
  assert.equal(state.notificationBatches.length, 1);
  assert.equal(state.reminderJobs.find((j) => j.id === 'recent').status, REMINDER_JOB_STATUS.DONE);
  assert.equal(state.reminderJobs.find((j) => j.id === 'stale').status, REMINDER_JOB_STATUS.OVERDUE);
});

test('E1: startup recovery marks all past-window pending overdue without batches', () => {
  const now = '2026-06-01T12:00:00.000Z';
  const state = {
    reminderJobs: [
      { id: 'a', dueAt: '2026-05-01T12:00:00.000Z', status: REMINDER_JOB_STATUS.PENDING },
      { id: 'b', dueAt: '2026-05-15T12:00:00.000Z', status: REMINDER_JOB_STATUS.PENDING },
    ],
    notificationBatches: [],
  };
  startupOverdueRecovery(state, now, reminderLatenessWindowMs());
  assert.ok(state.reminderJobs.every((j) => j.status === REMINDER_JOB_STATUS.OVERDUE));
  assert.equal(state.notificationBatches.length, 0);
});

test('E2: client helper and app guard accept secondary class assignment', (t) => {
  const student = { id: 's1', classId: 'c1', enrollmentClassIds: ['c1', 'c2'] };
  assert.equal(studentCanAccessAssignmentClassClient(student, 'c2', null), true);
  assert.equal(studentCanAccessAssignmentClassClient(student, 'c3', null), false);
  const appSrc = readFileSync(new URL('../dist/app.js', import.meta.url), 'utf8');
  assert.match(appSrc, /studentCanAccessAssignmentClassClient\(st, a\.classId/);
  installBaDomEnvironment(t, { confirm: () => true });
  const root = document.getElementById('app-root');
  const a = { id: 'a2', classId: 'c2', title: 'HW' };
  if (!studentCanAccessAssignmentClassClient(student, a.classId, null)) {
    root.appendChild(el('p', { className: 'empty-state' }, 'Bài tập không thuộc lớp của bạn (demo).'));
  } else {
    root.appendChild(el('p', { className: 'student-upload-ui' }, 'Nộp bài'));
  }
  assert.ok(aggregateDomTextContent(root).includes('Nộp bài'));
});

test('E2: teacher roster includes secondary member for class B', () => {
  const students = [
    { id: 's1', name: 'Lan', classId: 'c1' },
    { id: 's2', name: 'Be', classId: 'c3' },
  ];
  const memberships = [
    { id: 'm1', classId: 'c1', studentId: 's1', effectiveFrom: '2020-01-01T00:00:00.000Z' },
    { id: 'm2', classId: 'c2', studentId: 's1', effectiveFrom: '2026-01-01T00:00:00.000Z' },
  ];
  const inB = getStudentsInClass(students, 'c2', memberships, '2026-06-01T00:00:00.000Z');
  assert.deepEqual(inB.map((s) => s.id), ['s1']);
  const inC = getStudentsInClass(students, 'c3', memberships, '2026-06-01T00:00:00.000Z');
  assert.deepEqual(inC.map((s) => s.id), ['s2']);
});

test('HTTP E2: student submit allowed on C2 assignment with secondary membership', async (t) => {
  const ctx = await startBaTestServer({ initialNow: '2026-01-01T12:00:00.000Z' });
  t.after(async () => {
    await ctx.close();
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });
  const jar = await teacherSetup(ctx);
  const c1 = randomUUID();
  const c2 = randomUUID();
  const c3 = randomUUID();
  const classC1 = await api(ctx.base, jar, '/api/teacher/record/classes', {
    method: 'PUT',
    body: { id: c1, name: 'C1', scheduleDays: ['Mon'], scheduleTime: '19:00' },
  });
  assert.equal(classC1.res.status, 200, classC1.data?.error);
  const classC2 = await api(ctx.base, jar, '/api/teacher/record/classes', {
    method: 'PUT',
    body: { id: c2, name: 'C2', scheduleDays: ['Tue'], scheduleTime: '19:00' },
  });
  assert.equal(classC2.res.status, 200, classC2.data?.error);
  const classC3 = await api(ctx.base, jar, '/api/teacher/record/classes', {
    method: 'PUT',
    body: { id: c3, name: 'C3', scheduleDays: ['Wed'], scheduleTime: '19:00' },
  });
  assert.equal(classC3.res.status, 200, classC3.data?.error);
  const studentId = randomUUID();
  const studentPut = await api(ctx.base, jar, '/api/teacher/record/students', {
    method: 'PUT',
    body: { id: studentId, name: 'HS', classId: c1 },
  });
  assert.equal(studentPut.res.status, 200, studentPut.data?.error);
  const mem2 = await api(ctx.base, jar, '/api/teacher/ba/memberships', {
    method: 'PUT',
    body: {
      classId: c2,
      studentId,
      effectiveFrom: '2026-01-01T00:00:00.000Z',
      operationId: randomUUID(),
    },
  });
  assert.equal(mem2.res.status, 200, mem2.data?.error);
  const a2 = randomUUID();
  const a3 = randomUUID();
  const assignmentBody = (id, classId, title) => ({
    id,
    classId,
    title,
    bookRef: 'U1',
    dueDateISO: '2030-06-01',
    requiredPageCount: 1,
    attachmentIds: [],
  });
  const putA2 = await api(ctx.base, jar, '/api/teacher/record/assignments', {
    method: 'PUT',
    body: assignmentBody(a2, c2, 'HW C2'),
  });
  assert.equal(putA2.res.status, 200, putA2.data?.error);
  const putA3 = await api(ctx.base, jar, '/api/teacher/record/assignments', {
    method: 'PUT',
    body: assignmentBody(a3, c3, 'HW C3'),
  });
  assert.equal(putA3.res.status, 200, putA3.data?.error);
  const acc = await api(ctx.base, jar, '/api/teacher/accounts/students', {
    method: 'POST',
    body: { studentId, username: 'e2student', temporaryPassword: 'temppass123' },
  });
  assert.equal(acc.res.status, 200, acc.data?.error);
  ctx.clock.set('2026-06-15T00:00:00.000Z');
  const sJar = await studentLoginAfterPasswordChange(ctx, 'e2student', 'temppass123');
  const data = await api(ctx.base, sJar, '/api/data');
  assert.equal(data.res.status, 200, data.data?.error);
  const st = data.data.data.students[0];
  assert.ok(st.enrollmentClassIds.includes(c2));
  const assignmentIds = new Set((data.data.data.assignments || []).map((a) => a.id));
  assert.ok(assignmentIds.has(a2), 'C2 assignment visible via secondary membership');
  assert.ok(!assignmentIds.has(a3), 'C3 assignment forbidden without membership');
  const img = await uploadStudentImage(ctx.base, sJar);
  const submit = await api(ctx.base, sJar, '/api/student/submissions/submit', {
    method: 'POST',
    body: {
      assignmentId: a2,
      pageImageIds: [img],
      operationId: randomUUID(),
    },
  });
  assert.equal(submit.res.status, 200, submit.data?.error || JSON.stringify(submit.data));
});

test('HTTP E3: cancel notification union includes reschedule A+B recipients', async (t) => {
  const ctx = await startBaTestServer();
  t.after(async () => {
    await ctx.close();
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });
  const jar = await teacherSetup(ctx);
  const classId = randomUUID();
  await api(ctx.base, jar, '/api/teacher/record/classes', {
    method: 'PUT',
    body: { id: classId, name: 'G', scheduleDays: ['Mon'], scheduleTime: '19:00' },
  });
  const s1 = randomUUID();
  const s2 = randomUUID();
  const phoneA = '0900111001';
  const phoneB = '0900111002';
  await api(ctx.base, jar, '/api/teacher/record/students', {
    method: 'PUT',
    body: { id: s1, name: 'Em A', classId, phone: phoneA },
  });
  await api(ctx.base, jar, '/api/teacher/record/students', {
    method: 'PUT',
    body: { id: s2, name: 'Em B', classId, phone: phoneB },
  });
  await backdateOpenMembership(ctx, jar, { classId, studentId: s1, effectiveFrom: '2026-01-01T00:00:00.000Z' });
  await backdateOpenMembership(ctx, jar, { classId, studentId: s2, effectiveFrom: '2026-08-01T00:00:00.000Z' });
  let data = await loadTeacherData(ctx, jar);
  const rowA = data.memberships.find((m) => m.studentId === s1 && !m.effectiveTo);
  const rowB = data.memberships.find((m) => m.studentId === s2 && !m.effectiveTo);
  await api(ctx.base, jar, '/api/teacher/ba/memberships', {
    method: 'PUT',
    body: {
      id: rowA.id,
      classId,
      studentId: s1,
      effectiveFrom: rowA.effectiveFrom,
      effectiveTo: '2026-08-01T00:00:00.000Z',
      confirmImpact: true,
      reason: 'End A interval',
    },
  });
  await api(ctx.base, jar, '/api/teacher/ba/memberships', {
    method: 'PUT',
    body: {
      id: rowB.id,
      classId,
      studentId: s2,
      effectiveFrom: '2026-08-01T00:00:00.000Z',
      effectiveTo: null,
      confirmImpact: true,
      reason: 'Align B interval',
    },
  });
  const startAt = localDateTimeToUtcIso('2026-07-15', '19:00');
  const endAt = localDateTimeToUtcIso('2026-07-15', '20:00');
  const adhoc = await api(ctx.base, jar, '/api/teacher/ba/sessions/adhoc', {
    method: 'PUT',
    body: { classId, startAt, endAt },
  });
  const sessionId = adhoc.data.id;
  const keyA = canonicalRecipientKey({ phone: phoneA, role: 'student' });
  const keyB = canonicalRecipientKey({ phone: phoneB, role: 'student' });

  await api(ctx.base, jar, `/api/teacher/ba/sessions/${sessionId}/reschedule`, {
    method: 'POST',
    body: {
      startAt: localDateTimeToUtcIso('2026-08-15', '19:00'),
      endAt: localDateTimeToUtcIso('2026-08-15', '20:00'),
      reason: 'Move to B period',
      confirmOverlap: true,
    },
  });

  const changePreview = await api(ctx.base, jar, '/api/teacher/ba/notifications/preview', {
    method: 'POST',
    body: { sessionId, type: REMINDER_TYPE.SESSION_CHANGE },
  });
  assert.equal(changePreview.res.status, 200);
  const changeKeys = previewRecipientKeys(changePreview.data);
  assert.ok(changeKeys.has(keyA));
  assert.ok(changeKeys.has(keyB));

  await api(ctx.base, jar, `/api/teacher/ba/sessions/${sessionId}/cancel`, {
    method: 'POST',
    body: { reason: 'Hủy sau đổi lịch' },
  });

  const cancelPreview = await api(ctx.base, jar, '/api/teacher/ba/notifications/preview', {
    method: 'POST',
    body: { sessionId, type: REMINDER_TYPE.SESSION_CANCEL },
  });
  assert.equal(cancelPreview.res.status, 200);
  const cancelKeys = previewRecipientKeys(cancelPreview.data);
  assert.ok(cancelKeys.has(keyA), 'cancel union must retain pre-reschedule recipient');
  assert.ok(cancelKeys.has(keyB), 'cancel union must retain post-reschedule recipient');
});

test('E4: initial backdated membership reports impact before injected now', () => {
  const state = migrateLegacyMemberships({
    classes: [{ id: 'c1', name: 'G', scheduleDays: [], scheduleTime: '09:00', createdAt: '2020-01-01T00:00:00.000Z' }],
    students: [{ id: 's1', name: 'Em', classId: 'c2' }],
    memberships: [],
    classSessions: [{
      id: 'sess1',
      classId: 'c1',
      startAt: localDateTimeToUtcIso('2026-06-02', '19:00'),
      endAt: localDateTimeToUtcIso('2026-06-02', '20:00'),
      status: SESSION_STATUS.COMPLETED,
    }],
  });
  const next = {
    id: 'm-new',
    classId: 'c1',
    studentId: 's1',
    effectiveFrom: '2026-01-01T00:00:00.000Z',
    effectiveTo: null,
  };
  const impact = computeMembershipRetroactiveImpact(state, null, next, { nowIso: '2026-12-01T00:00:00.000Z' });
  assert.equal(impact.hasImpact, true);
  assert.deepEqual(impact.sessionIds, ['sess1']);
});

test('HTTP E4: new backdated membership requires confirmImpact', async (t) => {
  const ctx = await startBaTestServer({ initialNow: '2026-12-01T00:00:00.000Z' });
  t.after(async () => {
    await ctx.close();
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });
  const jar = await teacherSetup(ctx);
  const cPrimary = randomUUID();
  const cHistory = randomUUID();
  await api(ctx.base, jar, '/api/teacher/record/classes', {
    method: 'PUT',
    body: { id: cPrimary, name: 'Primary', scheduleDays: ['Mon'], scheduleTime: '19:00' },
  });
  await api(ctx.base, jar, '/api/teacher/record/classes', {
    method: 'PUT',
    body: { id: cHistory, name: 'History', scheduleDays: ['Tue'], scheduleTime: '19:00' },
  });
  const studentId = randomUUID();
  await api(ctx.base, jar, '/api/teacher/record/students', {
    method: 'PUT',
    body: { id: studentId, name: 'HS', classId: cPrimary },
  });
  const startAt = localDateTimeToUtcIso('2026-06-02', '19:00');
  const endAt = localDateTimeToUtcIso('2026-06-02', '20:00');
  const adhoc = await api(ctx.base, jar, '/api/teacher/ba/sessions/adhoc', {
    method: 'PUT',
    body: { classId: cHistory, startAt, endAt },
  });
  const sessionId = adhoc.data.id;
  await api(ctx.base, jar, `/api/teacher/ba/sessions/${sessionId}/complete`, {
    method: 'POST',
    body: {},
  });
  const blocked = await api(ctx.base, jar, '/api/teacher/ba/memberships', {
    method: 'PUT',
    body: {
      classId: cHistory,
      studentId,
      effectiveFrom: '2026-01-01T00:00:00.000Z',
    },
  });
  assert.equal(blocked.res.status, 409);
  const ok = await api(ctx.base, jar, '/api/teacher/ba/memberships', {
    method: 'PUT',
    body: {
      classId: cHistory,
      studentId,
      effectiveFrom: '2026-01-01T00:00:00.000Z',
      confirmImpact: true,
      reason: 'Backfill secondary class history',
    },
  });
  assert.equal(ok.res.status, 200);
  const data = await loadTeacherData(ctx, jar);
  const audit = data.membershipAudit.at(-1);
  assert.ok(audit);
  assert.equal(audit.oldValue, null);
  assert.ok((audit.impactSessionIds || []).includes(sessionId));
});

test('E5: membership datetime controls use UTC+7 independent of process TZ', () => {
  const iso = localDateTimeToUtcIso('2026-06-01', '19:00');
  assert.equal(iso, '2026-06-01T12:00:00.000Z');
  assert.equal(utcIsoToBaLocalInput(iso), '2026-06-01T19:00');
  assert.equal(baLocalInputToUtcIso('2026-06-01T19:00'), iso);
});

test('E5: roundtrip under TZ=UTC via child process', async () => {
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');
  const script = `
    import { localDateTimeToUtcIso, utcIsoToBaLocalInput, baLocalInputToUtcIso } from './dist/ba-domain.js';
    const iso = localDateTimeToUtcIso('2026-06-01', '19:00');
    if (iso !== '2026-06-01T12:00:00.000Z') process.exit(2);
    if (utcIsoToBaLocalInput(iso) !== '2026-06-01T19:00') process.exit(3);
    if (baLocalInputToUtcIso('2026-06-01T19:00') !== iso) process.exit(4);
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, TZ: 'UTC' },
    cwd: rootDir,
  });
  assert.equal(r.status, 0, r.stderr?.toString() || r.stdout?.toString());
});
