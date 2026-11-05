import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { localDateTimeToUtcIso } from '../dist/ba-domain.js';
import {
  startBaTestServer,
  teacherSetup,
  api,
  seedClassStudent,
  loadTeacherData,
  studentLoginAfterPasswordChange,
  backdateOpenMembership,
} from './ba-test-helpers.mjs';

test('AC23: overlap returns 409 without confirmOverlap', async (t) => {
  const ctx = await startBaTestServer();
  t.after(async () => {
    await ctx.close();
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });
  const jar = await teacherSetup(ctx);
  const { classId } = await seedClassStudent(ctx, jar);
  const startAt = localDateTimeToUtcIso('2026-12-01', '19:00');
  const endAt = localDateTimeToUtcIso('2026-12-01', '20:00');
  const first = await api(ctx.base, jar, '/api/teacher/ba/sessions/adhoc', {
    method: 'PUT',
    body: { classId, startAt, endAt },
  });
  assert.equal(first.res.status, 200);
  const second = await api(ctx.base, jar, '/api/teacher/ba/sessions/adhoc', {
    method: 'PUT',
    body: { classId, startAt, endAt },
  });
  assert.equal(second.res.status, 409);
  const ok = await api(ctx.base, jar, '/api/teacher/ba/sessions/adhoc', {
    method: 'PUT',
    body: { classId, startAt, endAt, confirmOverlap: true },
  });
  assert.equal(ok.res.status, 200);
});

test('CSRF: BA mutation without token rejected', async (t) => {
  const ctx = await startBaTestServer();
  t.after(async () => {
    await ctx.close();
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });
  const jar = await teacherSetup(ctx);
  const bad = await fetch(`${ctx.base}/api/teacher/ba/parents`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', cookie: `bn_session=${jar.bn_session}` },
    body: JSON.stringify({ name: 'X' }),
  });
  assert.equal(bad.status, 403);
});

test('IDOR: student session cannot access teacher BA data snapshot fields', async (t) => {
  const ctx = await startBaTestServer();
  t.after(async () => {
    await ctx.close();
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });
  let jar = await teacherSetup(ctx);
  const { classId, studentId } = await seedClassStudent(ctx, jar, { studentName: 'Em HS' });
  await api(ctx.base, jar, '/api/teacher/ba/parents', {
    method: 'PUT',
    body: { name: 'Phụ huynh bí mật', phone: '0900123456' },
  });
  const acc = await api(ctx.base, jar, '/api/teacher/accounts/students', {
    method: 'POST',
    body: { studentId, username: 'emhs1', temporaryPassword: 'temppass123' },
  });
  assert.equal(acc.res.status, 200);
  jar = await api(ctx.base, jar, '/api/auth/logout', { method: 'POST', body: {} }).then((r) => r.jar);
  jar = await studentLoginAfterPasswordChange(ctx, 'emhs1', 'temppass123');
  const data = await api(ctx.base, jar, '/api/data');
  assert.equal(data.res.status, 200);
  assert.equal(data.data.data.parents, undefined);
  assert.equal(data.data.data.classSessions, undefined);
  assert.equal(data.data.data.memberships, undefined);
});

test('AC03 HTTP: schedule apply idempotent operationId', async (t) => {
  const ctx = await startBaTestServer();
  t.after(async () => {
    await ctx.close();
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });
  const jar = await teacherSetup(ctx);
  const { classId } = await seedClassStudent(ctx, jar);
  const op = 'op-recur-1';
  const scheduleInput = {
    classId,
    weekdays: [2],
    startTime: '18:00',
    endTime: '19:00',
    rangeFromDate: '2026-06-01',
    rangeToDate: '2026-06-30',
  };
  const preview = await api(ctx.base, jar, '/api/teacher/ba/schedule/preview', {
    method: 'POST',
    body: scheduleInput,
  });
  assert.equal(preview.res.status, 200);
  const body = {
    operationId: op,
    ...scheduleInput,
    confirmOverlap: true,
    previewFingerprint: preview.data.previewFingerprint,
  };
  const a = await api(ctx.base, jar, '/api/teacher/ba/schedule/apply', { method: 'POST', body });
  const b = await api(ctx.base, jar, '/api/teacher/ba/schedule/apply', { method: 'POST', body });
  assert.equal(a.res.status, 200);
  assert.equal(b.res.status, 200);
  assert.equal(b.data.replay, true);
  assert.deepEqual(b.data.createdIds, a.data.createdIds);
  assert.deepEqual(b.data.templateId, a.data.templateId);
  const data = await loadTeacherData(ctx, jar);
  const created = data.classSessions.filter((s) => s.classId === classId);
  const uniqueStarts = new Set(created.map((s) => s.startAt));
  assert.equal(uniqueStarts.size, created.length);
});

test('AC05: reschedule bumps revision and resets pending reminder job', async (t) => {
  const ctx = await startBaTestServer();
  t.after(async () => {
    await ctx.close();
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });
  const jar = await teacherSetup(ctx);
  const { classId } = await seedClassStudent(ctx, jar);
  const startAt = localDateTimeToUtcIso('2027-01-05', '19:00');
  const endAt = localDateTimeToUtcIso('2027-01-05', '20:00');
  const adhoc = await api(ctx.base, jar, '/api/teacher/ba/sessions/adhoc', {
    method: 'PUT',
    body: { classId, startAt, endAt, reminderEnabled: true, reminderOffsetMinutes: 120 },
  });
  const sessionId = adhoc.data.id;
  const beforeJobs = (await loadTeacherData(ctx, jar)).reminderJobs.filter((j) => j.sessionId === sessionId);
  assert.equal(beforeJobs.length, 1);
  const newStart = localDateTimeToUtcIso('2027-01-05', '21:00');
  const newEnd = localDateTimeToUtcIso('2027-01-05', '22:00');
  await api(ctx.base, jar, `/api/teacher/ba/sessions/${sessionId}/reschedule`, {
    method: 'POST',
    body: { startAt: newStart, endAt: newEnd, reason: 'Đổi giờ', confirmOverlap: true },
  });
  const data = await loadTeacherData(ctx, jar);
  const session = data.classSessions.find((s) => s.id === sessionId);
  assert.equal(session.revision, 1);
  const cancelled = data.reminderJobs.filter((j) => j.sessionId === sessionId && j.status === 'cancelled');
  const pending = data.reminderJobs.filter((j) => j.sessionId === sessionId && j.status === 'pending');
  assert.ok(cancelled.length >= 1);
  assert.ok(pending.length >= 1);
});

test('Student blocked from BA teacher API', async (t) => {
  const ctx = await startBaTestServer();
  t.after(async () => {
    await ctx.close();
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });
  let jar = await teacherSetup(ctx);
  const { classId, studentId } = await seedClassStudent(ctx, jar);
  await api(ctx.base, jar, '/api/teacher/accounts/students', {
    method: 'POST',
    body: { studentId, username: 'stu1', temporaryPassword: 'temppass123' },
  });
  jar = await api(ctx.base, jar, '/api/auth/logout', { method: 'POST', body: {} }).then((r) => r.jar);
  jar = await studentLoginAfterPasswordChange(ctx, 'stu1', 'temppass123');
  const r = await api(ctx.base, jar, '/api/teacher/ba/parents', {
    method: 'PUT',
    body: { name: 'Hack' },
  });
  assert.equal(r.res.status, 403);
});

test('Retry successful mock requires confirmSuccessRetry', async (t) => {
  const ctx = await startBaTestServer();
  t.after(async () => {
    await ctx.close();
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });
  const jar = await teacherSetup(ctx);
  const { classId, studentId } = await seedClassStudent(ctx, jar);
  await api(ctx.base, jar, '/api/teacher/record/students', {
    method: 'PUT',
    body: { id: studentId, name: 'Em', classId, phone: '0900111222' },
  });
  const startAt = localDateTimeToUtcIso('2029-03-01', '19:00');
  const endAt = localDateTimeToUtcIso('2029-03-01', '20:00');
  const adhoc = await api(ctx.base, jar, '/api/teacher/ba/sessions/adhoc', {
    method: 'PUT',
    body: { classId, startAt, endAt },
  });
  await api(ctx.base, jar, '/api/teacher/ba/notifications/send-mock', {
    method: 'POST',
    body: { sessionId: adhoc.data.id, scenario: 'all-success' },
  });
  const attempt = (await loadTeacherData(ctx, jar)).notificationAttempts.find((a) => a.status === 'mock-success');
  const bad = await api(ctx.base, jar, '/api/teacher/ba/notifications/retry', {
    method: 'POST',
    body: { attemptId: attempt.id, scenario: 'all-success' },
  });
  assert.equal(bad.res.status, 409);
});

test('A1: future reminder due+1ms dispatches exactly one batch on two ticks', async (t) => {
  const ctx = await startBaTestServer();
  t.after(async () => {
    await ctx.close();
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });
  const jar = await teacherSetup(ctx);
  const { classId } = await seedClassStudent(ctx, jar);
  const startAt = localDateTimeToUtcIso('2026-08-01', '19:00');
  const endAt = localDateTimeToUtcIso('2026-08-01', '20:00');
  const adhoc = await api(ctx.base, jar, '/api/teacher/ba/sessions/adhoc', {
    method: 'PUT',
    body: { classId, startAt, endAt, reminderEnabled: true, reminderOffsetMinutes: 0 },
  });
  const sessionId = adhoc.data.id;
  const { computeReminderDueAt } = await import('../dist/ba-domain.js');
  const dueAt = computeReminderDueAt(startAt, 0);
  ctx.clock.set(new Date(new Date(dueAt).getTime() + 1).toISOString());
  const late = ctx.clock.getNow();
  await api(ctx.base, jar, '/api/teacher/ba/reminders/tick', { method: 'POST', body: { nowIso: late } });
  await api(ctx.base, jar, '/api/teacher/ba/reminders/tick', { method: 'POST', body: { nowIso: late } });
  const data = await loadTeacherData(ctx, jar);
  const batches = data.notificationBatches.filter((b) => b.sessionId === sessionId);
  assert.equal(batches.length, 1);
});

test('A1: past-due job creation stays overdue with zero auto batches', async (t) => {
  const ctx = await startBaTestServer();
  t.after(async () => {
    await ctx.close();
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });
  const jar = await teacherSetup(ctx);
  const { classId } = await seedClassStudent(ctx, jar);
  ctx.clock.set('2026-12-01T00:00:00.000Z');
  const startAt = localDateTimeToUtcIso('2026-06-01', '19:00');
  const endAt = localDateTimeToUtcIso('2026-06-01', '20:00');
  const adhoc = await api(ctx.base, jar, '/api/teacher/ba/sessions/adhoc', {
    method: 'PUT',
    body: { classId, startAt, endAt, reminderEnabled: true, reminderOffsetMinutes: 0 },
  });
  const sessionId = adhoc.data.id;
  await api(ctx.base, jar, '/api/teacher/ba/reminders/tick', {
    method: 'POST',
    body: { nowIso: ctx.clock.getNow() },
  });
  const data = await loadTeacherData(ctx, jar);
  const job = data.reminderJobs.find((j) => j.sessionId === sessionId);
  assert.equal(job.status, 'overdue');
  assert.equal(data.notificationBatches.filter((b) => b.sessionId === sessionId).length, 0);
});

test('A1: worker stop prevents scheduled ticks', async (t) => {
  const ctx = await startBaTestServer({ reminderWindowMs: 10 });
  t.after(async () => {
    await ctx.close();
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });
  let ticks = 0;
  const origTick = ctx.reminderWorker.tick.bind(ctx.reminderWorker);
  ctx.reminderWorker.tick = async () => {
    ticks += 1;
    return origTick();
  };
  ctx.reminderWorker.stop();
  await new Promise((r) => setTimeout(r, 35));
  assert.equal(ticks, 0);
});

test('A2: attendance report API rejects invalid calendar date', async (t) => {
  const ctx = await startBaTestServer();
  t.after(async () => {
    await ctx.close();
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });
  const jar = await teacherSetup(ctx);
  const bad = await api(ctx.base, jar, '/api/teacher/ba/reports/attendance?fromDate=2026-02-30');
  assert.equal(bad.res.status, 400);
});

test('A2: serializeBaQuery omits empty filters', async () => {
  const { serializeBaQuery } = await import('../dist/ba-api.js');
  const qs = serializeBaQuery({
    classId: undefined,
    studentId: '',
    fromDate: null,
    includeFuture: '1',
    zero: 0,
    off: false,
  });
  assert.ok(!qs.includes('undefined'));
  assert.ok(!qs.includes('classId'));
  assert.ok(qs.includes('includeFuture=1'));
  assert.ok(qs.includes('zero=0'));
  assert.ok(qs.includes('off=false'));
});

test('A2: default attendance report returns eligible unmarked row', async (t) => {
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
  const startAt = localDateTimeToUtcIso('2026-06-02', '19:00');
  const endAt = localDateTimeToUtcIso('2026-06-02', '20:00');
  const adhoc = await api(ctx.base, jar, '/api/teacher/ba/sessions/adhoc', {
    method: 'PUT',
    body: { classId, startAt, endAt },
  });
  assert.equal(adhoc.res.status, 200);
  ctx.clock.set('2026-12-01T00:00:00.000Z');
  const rep = await api(
    ctx.base,
    jar,
    '/api/teacher/ba/reports/attendance?fromDate=2026-06-01&toDate=2026-06-30',
  );
  assert.equal(rep.res.status, 200);
  assert.equal(rep.data.report.unmarked, 1);
});

test('A3: second class membership keeps primary classId and homework access', async (t) => {
  const ctx = await startBaTestServer();
  t.after(async () => {
    await ctx.close();
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });
  let jar = await teacherSetup(ctx);
  const { classId: c1, studentId } = await seedClassStudent(ctx, jar, { className: 'C1' });
  const c2 = randomUUID();
  const classC2 = await api(ctx.base, jar, '/api/teacher/record/classes', {
    method: 'PUT',
    body: { id: c2, name: 'C2', scheduleDays: ['Tue'], scheduleTime: '18:00' },
  });
  assert.equal(classC2.res.status, 200);
  const c3 = randomUUID();
  const classC3 = await api(ctx.base, jar, '/api/teacher/record/classes', {
    method: 'PUT',
    body: { id: c3, name: 'C3', scheduleDays: ['Wed'], scheduleTime: '18:00' },
  });
  assert.equal(classC3.res.status, 200);
  const a1 = randomUUID();
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
  const putA1 = await api(ctx.base, jar, '/api/teacher/record/assignments', {
    method: 'PUT',
    body: assignmentBody(a1, c1, 'HW C1'),
  });
  assert.equal(putA1.res.status, 200);
  const putA2 = await api(ctx.base, jar, '/api/teacher/record/assignments', {
    method: 'PUT',
    body: assignmentBody(a2, c2, 'HW C2'),
  });
  assert.equal(putA2.res.status, 200);
  const putA3 = await api(ctx.base, jar, '/api/teacher/record/assignments', {
    method: 'PUT',
    body: assignmentBody(a3, c3, 'HW C3'),
  });
  assert.equal(putA3.res.status, 200);
  const mem2 = await api(ctx.base, jar, '/api/teacher/ba/memberships', {
    method: 'PUT',
    body: {
      classId: c2,
      studentId,
      effectiveFrom: '2026-01-01T00:00:00.000Z',
      effectiveTo: null,
    },
  });
  assert.equal(mem2.res.status, 200);
  const teacherData = await loadTeacherData(ctx, jar);
  const st = teacherData.students.find((s) => s.id === studentId);
  assert.equal(st.classId, c1);
  const acc = await api(ctx.base, jar, '/api/teacher/accounts/students', {
    method: 'POST',
    body: { studentId, username: 'multiclass', temporaryPassword: 'temppass123' },
  });
  assert.equal(acc.res.status, 200);
  jar = await api(ctx.base, jar, '/api/auth/logout', { method: 'POST', body: {} }).then((r) => r.jar);
  ctx.clock.set('2026-06-15T00:00:00.000Z');
  jar = await studentLoginAfterPasswordChange(ctx, 'multiclass', 'temppass123');
  const studentData = await api(ctx.base, jar, '/api/data');
  assert.equal(studentData.res.status, 200);
  const ids = new Set((studentData.data.data.assignments || []).map((a) => a.id));
  assert.ok(ids.has(a1), 'C1 homework remains visible');
  assert.ok(ids.has(a2), 'C2 homework visible with active membership');
  assert.ok(!ids.has(a3), 'unrelated C3 forbidden');
});
