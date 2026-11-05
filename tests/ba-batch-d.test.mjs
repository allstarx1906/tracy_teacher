import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
  validateRecurringScheduleInput,
  parseStrictTimeHm,
  parseStrictDateYmd,
  localDateTimeToUtcIso,
  SESSION_STATUS,
} from '../dist/ba-domain.js';
import {
  startBaTestServer,
  teacherSetup,
  api,
  seedClassStudent,
  loadTeacherData,
  backdateOpenMembership,
  installBaBrowserApiFixture,
} from './ba-test-helpers.mjs';
import { tryRenderBaView, parseBaRoute } from '../dist/ba-ui.js';
import { installBaDomEnvironment, findDomNodes, aggregateDomTextContent } from './helper-browser-window.mjs';
import { isGloballyDirty } from '../dist/ux-forms.js';

function jarCookie(jar) {
  return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
}

async function flushAsync(times = 12) {
  for (let i = 0; i < times; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function bindDeferredUiToasts(uiCtx) {
  /** @type {((v: { kind: 'ok' | 'err', msg: string }) => void) | null} */
  let settle = null;
  const outcome = new Promise((resolve) => {
    settle = resolve;
  });
  const prevOk = uiCtx.toastOk;
  const prevErr = uiCtx.toastErr;
  uiCtx.toastOk = (msg) => {
    prevOk?.(msg);
    settle?.({ kind: 'ok', msg: String(msg ?? '') });
  };
  uiCtx.toastErr = (msg) => {
    prevErr?.(msg);
    settle?.({ kind: 'err', msg: String(msg ?? '') });
  };
  return {
    outcome,
    reset() {
      uiCtx.toastOk = prevOk;
      uiCtx.toastErr = prevErr;
    },
  };
}

async function waitSaveButtonBusyCycle(btn) {
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  let guard = 0;
  while (!btn.getAttribute?.('aria-busy') && guard < 200) {
    await tick();
    guard += 1;
  }
  assert.ok(btn.getAttribute?.('aria-busy'), 'expected save button to enter busy state');
  guard = 0;
  while (btn.getAttribute?.('aria-busy') && guard < 400) {
    await tick();
    guard += 1;
  }
  assert.equal(btn.getAttribute?.('aria-busy'), null, 'expected save button to leave busy state');
}

async function awaitAttendanceRowSaveComplete(saveBtn, toastBinding) {
  const [outcome] = await Promise.all([
    toastBinding.outcome,
    waitSaveButtonBusyCycle(saveBtn),
  ]);
  await flushAsync();
  return outcome;
}

test('validateRecurringScheduleInput rejects 25:00 and Feb 30', () => {
  assert.equal(parseStrictTimeHm('25:00'), null);
  assert.equal(parseStrictDateYmd('2026-02-30'), null);
  const bad = validateRecurringScheduleInput({
    classId: 'c1',
    weekdays: [1],
    startTime: '25:00',
    endTime: '20:00',
    rangeFromDate: '2026-01-01',
    rangeToDate: '2026-01-07',
  });
  assert.equal(bad.ok, false);
});

test('HTTP: recurrence preview rejects empty weekdays and archived class', async (t) => {
  const ctx = await startBaTestServer({ initialNow: '2026-01-01T12:00:00.000Z' });
  t.after(async () => {
    await ctx.close();
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });
  const jar = await teacherSetup(ctx);
  const { classId } = await seedClassStudent(ctx, jar);
  const empty = await api(ctx.base, jar, '/api/teacher/ba/schedule/preview', {
    method: 'POST',
    body: {
      classId,
      weekdays: [],
      startTime: '19:00',
      endTime: '20:00',
      rangeFromDate: '2026-01-01',
      rangeToDate: '2026-01-07',
    },
  });
  assert.equal(empty.res.status, 400);
  await api(ctx.base, jar, '/api/teacher/ba/classes/meta', {
    method: 'PUT',
    body: { classId, status: 'archived', confirmArchiveImpact: true, operationId: randomUUID() },
  });
  const arch = await api(ctx.base, jar, '/api/teacher/ba/schedule/preview', {
    method: 'POST',
    body: {
      classId,
      weekdays: [1],
      startTime: '19:00',
      endTime: '20:00',
      rangeFromDate: '2026-01-01',
      rangeToDate: '2026-01-07',
    },
  });
  assert.equal(arch.res.status, 400);
});

test('HTTP: session cancel and reschedule require reason', async (t) => {
  const ctx = await startBaTestServer({ initialNow: '2026-01-05T10:00:00.000Z' });
  t.after(async () => {
    await ctx.close();
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });
  const jar = await teacherSetup(ctx);
  const { classId } = await seedClassStudent(ctx, jar);
  const startAt = localDateTimeToUtcIso('2026-01-06', '19:00');
  const endAt = localDateTimeToUtcIso('2026-01-06', '20:00');
  const adhoc = await api(ctx.base, jar, '/api/teacher/ba/sessions/adhoc', {
    method: 'PUT',
    body: { classId, startAt, endAt, operationId: randomUUID(), confirmOverlap: true },
  });
  assert.equal(adhoc.res.status, 200);
  const sessionId = adhoc.data.id;
  const cancelBlank = await api(ctx.base, jar, `/api/teacher/ba/sessions/${sessionId}/cancel`, {
    method: 'POST',
    body: { operationId: randomUUID(), reason: '   ' },
  });
  assert.equal(cancelBlank.res.status, 400);
  const rescheduleBlank = await api(ctx.base, jar, `/api/teacher/ba/sessions/${sessionId}/reschedule`, {
    method: 'POST',
    body: {
      operationId: randomUUID(),
      startAt,
      endAt,
      reason: '',
    },
  });
  assert.equal(rescheduleBlank.res.status, 400);
});

test('HTTP: attendance revision conflict and correction audit with minutes', async (t) => {
  const ctx = await startBaTestServer({ initialNow: '2026-01-05T10:00:00.000Z' });
  t.after(async () => {
    await ctx.close();
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });
  const jar = await teacherSetup(ctx);
  const { classId, studentId } = await seedClassStudent(ctx, jar, { studentName: 'HS A' });
  await backdateOpenMembership(ctx, jar, {
    classId,
    studentId,
    effectiveFrom: '2020-01-01T00:00:00.000Z',
  });
  const startAt = localDateTimeToUtcIso('2026-01-06', '19:00');
  const endAt = localDateTimeToUtcIso('2026-01-06', '20:00');
  const adhoc = await api(ctx.base, jar, '/api/teacher/ba/sessions/adhoc', {
    method: 'PUT',
    body: { classId, startAt, endAt, operationId: randomUUID(), confirmOverlap: true },
  });
  const sessionId = adhoc.data.id;
  const data0 = await loadTeacherData(ctx, jar);
  const presentId = data0.attendanceStatusCatalog.find((s) => s.id === 'present')?.id || 'present';
  const lateId = data0.attendanceStatusCatalog.find((s) => s.id === 'late')?.id || 'late';
  const first = await api(ctx.base, jar, '/api/teacher/ba/attendance/record', {
    method: 'PUT',
    body: {
      sessionId,
      studentId,
      statusId: presentId,
      note: 'v1',
      minutesLate: 5,
      operationId: randomUUID(),
    },
  });
  assert.equal(first.res.status, 200);
  const rev1 = first.data.revision ?? 1;
  const conflict = await api(ctx.base, jar, '/api/teacher/ba/attendance/record', {
    method: 'PUT',
    body: {
      sessionId,
      studentId,
      statusId: lateId,
      expectedRevision: 0,
      correctionReason: 'Sửa',
      operationId: randomUUID(),
    },
  });
  assert.equal(conflict.res.status, 409);
  const corrected = await api(ctx.base, jar, '/api/teacher/ba/attendance/record', {
    method: 'PUT',
    body: {
      sessionId,
      studentId,
      statusId: lateId,
      expectedRevision: rev1,
      correctionReason: 'Sửa trễ',
      minutesLate: 12,
      operationId: randomUUID(),
    },
  });
  assert.equal(corrected.res.status, 200);
  const data = await loadTeacherData(ctx, jar);
  const audit = data.attendanceAudit.filter((a) => a.studentId === studentId);
  assert.ok(audit.some((a) => a.reason === 'Sửa trễ'));
  assert.equal(data.attendanceRecords.find((r) => r.studentId === studentId).minutesLate, 12);
});

test('HTTP: cancelled session attendance record preserved for read', async (t) => {
  const ctx = await startBaTestServer({ initialNow: '2026-01-05T10:00:00.000Z' });
  t.after(async () => {
    await ctx.close();
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });
  const jar = await teacherSetup(ctx);
  const { classId, studentId } = await seedClassStudent(ctx, jar);
  await backdateOpenMembership(ctx, jar, {
    classId,
    studentId,
    effectiveFrom: '2020-01-01T00:00:00.000Z',
  });
  const startAt = localDateTimeToUtcIso('2026-01-06', '19:00');
  const endAt = localDateTimeToUtcIso('2026-01-06', '20:00');
  const adhoc = await api(ctx.base, jar, '/api/teacher/ba/sessions/adhoc', {
    method: 'PUT',
    body: { classId, startAt, endAt, operationId: randomUUID(), confirmOverlap: true },
  });
  const sessionId = adhoc.data.id;
  const data0 = await loadTeacherData(ctx, jar);
  const presentId = data0.attendanceStatusCatalog[0].id;
  await api(ctx.base, jar, '/api/teacher/ba/attendance/record', {
    method: 'PUT',
    body: {
      sessionId,
      studentId,
      statusId: presentId,
      operationId: randomUUID(),
    },
  });
  await api(ctx.base, jar, `/api/teacher/ba/sessions/${sessionId}/cancel`, {
    method: 'POST',
    body: { operationId: randomUUID(), reason: 'Hủy test' },
  });
  const blocked = await api(ctx.base, jar, '/api/teacher/ba/attendance/record', {
    method: 'PUT',
    body: {
      sessionId,
      studentId,
      statusId: presentId,
      expectedRevision: 1,
      correctionReason: 'x',
      operationId: randomUUID(),
    },
  });
  assert.equal(blocked.res.status, 400);
  const data = await loadTeacherData(ctx, jar);
  assert.equal(data.classSessions.find((s) => s.id === sessionId).status, SESSION_STATUS.CANCELLED);
  assert.ok(data.attendanceRecords.some((r) => r.sessionId === sessionId));
});

test('DOM: attendance two rows keep dirty values after first save', async (t) => {
  const ctx = await startBaTestServer({ initialNow: '2026-01-05T10:00:00.000Z' });
  t.after(async () => {
    await ctx.close();
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });
  const jar = await teacherSetup(ctx);
  const { classId, studentId: s1 } = await seedClassStudent(ctx, jar, { studentName: 'HS 1' });
  const s2 = randomUUID();
  await api(ctx.base, jar, '/api/teacher/record/students', {
    method: 'PUT',
    body: { id: s2, name: 'HS 2', classId },
  });
  await backdateOpenMembership(ctx, jar, { classId, studentId: s1, effectiveFrom: '2020-01-01T00:00:00.000Z' });
  await backdateOpenMembership(ctx, jar, { classId, studentId: s2, effectiveFrom: '2020-01-01T00:00:00.000Z' });
  const startAt = localDateTimeToUtcIso('2026-01-06', '19:00');
  const endAt = localDateTimeToUtcIso('2026-01-06', '20:00');
  const adhoc = await api(ctx.base, jar, '/api/teacher/ba/sessions/adhoc', {
    method: 'PUT',
    body: { classId, startAt, endAt, operationId: randomUUID(), confirmOverlap: true },
  });
  const sessionId = adhoc.data.id;
  installBaBrowserApiFixture(t, ctx, jar);
  installBaDomEnvironment(t, { confirm: () => true, cookie: jarCookie(jar) });
  const parentFetch = globalThis.fetch;
  let releaseFirstAttendancePut;
  const firstAttendancePutGate = new Promise((resolve) => {
    releaseFirstAttendancePut = resolve;
  });
  let attendancePutCount = 0;
  const attendancePutBodies = [];
  globalThis.fetch = async (url, options = {}) => {
    const path = String(url);
    const method = String(options.method || 'GET').toUpperCase();
    if (path.includes('/api/teacher/ba/attendance/record') && method === 'PUT') {
      attendancePutCount += 1;
      if (typeof options.body === 'string') {
        attendancePutBodies.push(JSON.parse(options.body));
      }
      if (attendancePutCount === 1) {
        await firstAttendancePutGate;
      }
    }
    return parentFetch(url, options);
  };
  t.after(() => {
    globalThis.fetch = parentFetch;
  });
  const data = await loadTeacherData(ctx, jar);
  const uiCtx = {
    state: { data },
    isTeacher: () => true,
    navigate: () => {},
    renderApp: () => {},
    toastOk: () => {},
    toastErr: () => {},
  };
  const toastBinding = bindDeferredUiToasts(uiCtx);
  t.after(() => toastBinding.reset());
  const route = parseBaRoute(['tutor', 'attendance', sessionId]);
  tryRenderBaView(uiCtx, route);
  const root = document.getElementById('app-root');
  const notes = findDomNodes(root, (n) => n.tagName === 'INPUT' && n.attributes?.['aria-label']?.includes('Ghi chú'));
  assert.equal(notes.length, 2);
  notes[0].value = 'dirty-one';
  notes[1].value = 'keep-second';
  const saveBtns = findDomNodes(root, (n) => n.tagName === 'BUTTON' && aggregateDomTextContent(n) === 'Lưu dòng');
  assert.ok(saveBtns.length >= 2);
  const statusSelects = findDomNodes(root, (n) => n.tagName === 'SELECT');
  const data0 = await loadTeacherData(ctx, jar);
  statusSelects[0].value = data0.attendanceStatusCatalog[0].id;
  saveBtns[0].dispatchEvent({ type: 'click' });
  await flushAsync(2);
  assert.equal(attendancePutCount, 1);
  assert.equal(notes[1].value, 'keep-second');
  assert.equal(saveBtns[0].getAttribute?.('aria-busy'), 'true');
  releaseFirstAttendancePut();
  const firstOutcome = await awaitAttendanceRowSaveComplete(saveBtns[0], toastBinding);
  assert.equal(firstOutcome.kind, 'ok');
  assert.equal(notes[1].value, 'keep-second');
  assert.equal(isGloballyDirty(), true);
  const serverAfterFirst = await loadTeacherData(ctx, jar);
  const rec1 = serverAfterFirst.attendanceRecords.find((r) => r.sessionId === sessionId && r.studentId === s1);
  assert.ok(rec1);
  assert.equal(rec1.revision, 1);
  assert.equal(rec1.note, 'dirty-one');
  assert.equal(attendancePutBodies[0].expectedRevision, undefined);
  const corrInputs = findDomNodes(
    root,
    (n) => n.tagName === 'INPUT' && String(n.attributes?.['aria-label'] || '').includes('Lý do sửa'),
  );
  assert.equal(corrInputs.length, 1, 'correction reason field appears after first save');
  assert.ok(aggregateDomTextContent(root).includes('rev 1'), 'saved row shows revision after reload');

  statusSelects[1].value = data0.attendanceStatusCatalog[0].id;
  const secondToast = bindDeferredUiToasts(uiCtx);
  saveBtns[1].dispatchEvent({ type: 'click' });
  const secondOutcome = await awaitAttendanceRowSaveComplete(saveBtns[1], secondToast);
  secondToast.reset();
  assert.equal(secondOutcome.kind, 'ok');
  assert.equal(attendancePutCount, 2);
  assert.equal(attendancePutBodies[1].studentId, s2);
  assert.equal(attendancePutBodies[1].note, 'keep-second');
  assert.equal(attendancePutBodies[1].expectedRevision, undefined);
  assert.equal(notes[1].value, 'keep-second');
});

test('HTTP: schedule apply rejects stale preview fingerprint', async (t) => {
  const ctx = await startBaTestServer({ initialNow: '2026-01-01T12:00:00.000Z' });
  t.after(async () => {
    await ctx.close();
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });
  const jar = await teacherSetup(ctx);
  const { classId } = await seedClassStudent(ctx, jar);
  const apply = await api(ctx.base, jar, '/api/teacher/ba/schedule/apply', {
    method: 'POST',
    body: {
      classId,
      weekdays: [1],
      startTime: '19:00',
      endTime: '20:00',
      rangeFromDate: '2026-01-01',
      rangeToDate: '2026-01-07',
      previewFingerprint: 'stale',
      operationId: randomUUID(),
    },
  });
  assert.equal(apply.res.status, 409);
});

test('HTTP: class default reminder updates inherited session jobs only', async (t) => {
  const ctx = await startBaTestServer({ initialNow: '2026-01-01T12:00:00.000Z' });
  t.after(async () => {
    await ctx.close();
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });
  const jar = await teacherSetup(ctx);
  const { classId } = await seedClassStudent(ctx, jar);
  const startAt = localDateTimeToUtcIso('2026-02-01', '19:00');
  const endAt = localDateTimeToUtcIso('2026-02-01', '20:00');
  const inherited = await api(ctx.base, jar, '/api/teacher/ba/sessions/adhoc', {
    method: 'PUT',
    body: { classId, startAt, endAt, operationId: randomUUID(), confirmOverlap: true },
  });
  const overridden = await api(ctx.base, jar, '/api/teacher/ba/sessions/adhoc', {
    method: 'PUT',
    body: {
      classId,
      startAt: localDateTimeToUtcIso('2026-02-02', '19:00'),
      endAt: localDateTimeToUtcIso('2026-02-02', '20:00'),
      reminderEnabled: true,
      reminderOffsetMinutes: 15,
      operationId: randomUUID(),
      confirmOverlap: true,
    },
  });
  assert.equal(inherited.res.status, 200);
  assert.equal(overridden.res.status, 200);
  const inheritedId = inherited.data.id;
  const overriddenId = overridden.data.id;
  await api(ctx.base, jar, '/api/teacher/ba/classes/meta', {
    method: 'PUT',
    body: {
      classId,
      defaultReminderEnabled: true,
      defaultReminderOffsetMinutes: 90,
      confirmDefaultReminderImpact: true,
      operationId: randomUUID(),
    },
  });
  const after = await loadTeacherData(ctx, jar);
  const inheritedJob = after.reminderJobs.find((j) => j.sessionId === inheritedId && j.status === 'pending');
  const overrideSession = after.classSessions.find((s) => s.id === overriddenId);
  assert.ok(inheritedJob);
  assert.equal(overrideSession?.reminderOffsetMinutes, 15);
});

test('DOM: reports summary cards render without JSON dump', async (t) => {
  const ctx = await startBaTestServer({ initialNow: '2026-01-05T10:00:00.000Z' });
  t.after(async () => {
    await ctx.close();
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });
  const jar = await teacherSetup(ctx);
  installBaBrowserApiFixture(t, ctx, jar);
  installBaDomEnvironment(t, { cookie: jarCookie(jar) });
  const data = await loadTeacherData(ctx, jar);
  const uiCtx = {
    state: { data },
    isTeacher: () => true,
    navigate: () => {},
    renderApp: () => {},
    toastOk: () => {},
    toastErr: () => {},
  };
  tryRenderBaView(uiCtx, parseBaRoute(['tutor', 'reports']));
  const root = document.getElementById('app-root');
  const text = aggregateDomTextContent(root);
  assert.ok(text.includes('Báo cáo điểm danh'));
  assert.ok(!text.includes('"countsByStatus"'));
  const loadBtn = findDomNodes(root, (n) => n.tagName === 'BUTTON' && aggregateDomTextContent(n) === 'Xem báo cáo')[0];
  assert.ok(loadBtn);
  await new Promise((r) => setTimeout(r, 120));
  const after = aggregateDomTextContent(root);
  assert.ok(after.includes('Chưa điểm danh') || after.includes('Đã tải') || after.includes('Tổng hợp theo học sinh'));
});
