import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
  computeAttendanceReport,
  getReportAttendanceStatusEntries,
  localDateTimeToUtcIso,
  computeReminderDueAt,
  resolveSessionReminderConfig,
  BA_WEEKDAY_LABELS,
  formatBaSessionStatus,
  canonicalRecipientKey,
  buildSessionRecipientRoster,
} from '../dist/ba-domain.js';
import { isGloballyDirty, registerDirtyProbe } from '../dist/ux-forms.js';
import { tryRenderBaView } from '../dist/ba-ui.js';
import {
  startBaTestServer,
  teacherSetup,
  api,
  loadTeacherData,
  seedClassStudent,
  backdateOpenMembership,
  installBaBrowserApiFixture,
} from './ba-test-helpers.mjs';
import {
  installBaDomEnvironment,
  findDomNodes,
  aggregateDomTextContent,
} from './helper-browser-window.mjs';
import { fetchMe } from '../dist/api-client.js';

function jarCookie(jar) {
  return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
}

async function flushAsync(times = 12) {
  for (let i = 0; i < times; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function awaitPreviewBoxSignal(previewBox, signal, guard = 400) {
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  for (let i = 0; i < guard; i += 1) {
    const text = previewBox.textContent || '';
    if (text.includes(signal) && !text.startsWith('Chưa có xem trước')) return text;
    await tick();
  }
  throw new Error(`preview did not complete; got: ${String(previewBox.textContent).slice(0, 240)}`);
}

async function waitSendButtonBusyCycle(btn) {
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  let guard = 0;
  while (!btn.getAttribute?.('aria-busy') && guard < 200) {
    await tick();
    guard += 1;
  }
  assert.ok(btn.getAttribute?.('aria-busy'), 'expected send button to enter busy state');
  guard = 0;
  while (btn.getAttribute?.('aria-busy') && guard < 400) {
    await tick();
    guard += 1;
  }
  assert.equal(btn.getAttribute?.('aria-busy'), null, 'expected send button to leave busy state');
}

test('F1 HTTP: student PUT respects inactive status and unique code', async (t) => {
  const ctx = await startBaTestServer();
  t.after(async () => {
    await ctx.close();
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });
  const jar = await teacherSetup(ctx);
  const { classId, studentId } = await seedClassStudent(ctx, jar);
  const dupCode = await api(ctx.base, jar, '/api/teacher/record/students', {
    method: 'PUT',
    body: { id: randomUUID(), name: 'Other', classId, code: 'HS-01', operationId: randomUUID() },
  });
  assert.equal(dupCode.res.status, 200);
  const conflict = await api(ctx.base, jar, '/api/teacher/record/students', {
    method: 'PUT',
    body: { id: studentId, name: 'HS', classId, code: 'HS-01', operationId: randomUUID() },
  });
  assert.equal(conflict.res.status, 400);
  const off = await api(ctx.base, jar, '/api/teacher/record/students', {
    method: 'PUT',
    body: {
      id: studentId,
      name: 'HS',
      classId,
      phone: '0900111222',
      status: 'inactive',
      operationId: randomUUID(),
    },
  });
  assert.equal(off.res.status, 200);
  const data = await loadTeacherData(ctx, jar);
  const st = data.students.find((s) => s.id === studentId);
  assert.equal(st.status, 'inactive');
  assert.equal(st.phone, '0900111222');
  const mem = data.memberships.find((m) => m.studentId === studentId && !m.effectiveTo);
  assert.ok(mem, 'deactivation must not auto-end membership');
});

test('F3 HTTP: null reminder fields reset session inheritance and rebuild job', async (t) => {
  const ctx = await startBaTestServer({ initialNow: '2026-01-01T12:00:00.000Z' });
  t.after(async () => {
    await ctx.close();
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });
  const jar = await teacherSetup(ctx);
  const { classId } = await seedClassStudent(ctx, jar);
  await api(ctx.base, jar, '/api/teacher/ba/classes/meta', {
    method: 'PUT',
    body: {
      classId,
      defaultReminderEnabled: true,
      defaultReminderOffsetMinutes: 30,
      confirmDefaultReminderImpact: true,
      operationId: randomUUID(),
    },
  });
  const startAt = localDateTimeToUtcIso('2026-06-10', '19:00');
  const endAt = localDateTimeToUtcIso('2026-06-10', '20:00');
  const adhoc = await api(ctx.base, jar, '/api/teacher/ba/sessions/adhoc', {
    method: 'PUT',
    body: {
      classId,
      startAt,
      endAt,
      reminderEnabled: false,
      reminderOffsetMinutes: 5,
      operationId: randomUUID(),
    },
  });
  assert.equal(adhoc.res.status, 200);
  const sessionId = adhoc.data.id;
  const reset = await api(ctx.base, jar, '/api/teacher/ba/sessions/adhoc', {
    method: 'PUT',
    body: {
      id: sessionId,
      classId,
      startAt,
      endAt,
      reminderEnabled: null,
      reminderOffsetMinutes: null,
      operationId: randomUUID(),
    },
  });
  assert.equal(reset.res.status, 200);
  const data = await loadTeacherData(ctx, jar);
  const session = data.classSessions.find((s) => s.id === sessionId);
  assert.equal(session.reminderEnabled, null);
  assert.equal(session.reminderOffsetMinutes, null);
  const cls = data.classes.find((c) => c.id === classId);
  const cfg = resolveSessionReminderConfig(session, cls);
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.offsetMinutes, 30);
  const job = data.reminderJobs.find((j) => j.sessionId === sessionId && j.status !== 'cancelled');
  assert.ok(job);
  assert.equal(job.dueAt, computeReminderDueAt(startAt, 30));
});

test('F4 HTTP: adhoc retry with same operationId after lost response creates one session', async (t) => {
  const ctx = await startBaTestServer();
  t.after(async () => {
    await ctx.close();
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });
  const jar = await teacherSetup(ctx);
  const { classId } = await seedClassStudent(ctx, jar);
  const startAt = localDateTimeToUtcIso('2026-08-01', '19:00');
  const endAt = localDateTimeToUtcIso('2026-08-01', '20:00');
  const op = randomUUID();
  const body = {
    classId,
    startAt,
    endAt,
    operationId: op,
  };
  const first = await api(ctx.base, jar, '/api/teacher/ba/sessions/adhoc', { method: 'PUT', body });
  assert.equal(first.res.status, 200);
  const retry = await api(ctx.base, jar, '/api/teacher/ba/sessions/adhoc', { method: 'PUT', body });
  assert.equal(retry.res.status, 200);
  assert.equal(retry.data.id, first.data.id);
  const data = await loadTeacherData(ctx, jar);
  const rows = data.classSessions.filter((s) => s.classId === classId && s.startAt === startAt);
  assert.equal(rows.length, 1);
});

test('F6: report cards include deactivated status counts', () => {
  const catalog = [
    { id: 'present', label: 'Có mặt', active: true, sortOrder: 1 },
    { id: 'custom', label: 'Tùy', active: false, sortOrder: 2 },
  ];
  const counts = { present: 2, custom: 3 };
  const entries = getReportAttendanceStatusEntries(catalog, counts);
  assert.ok(entries.some((e) => e.id === 'custom' && e.label.includes('ngừng sử dụng')));
  const report = computeAttendanceReport({
    classes: [{ id: 'c1' }],
    students: [{ id: 's1', classId: 'c1' }],
    memberships: [{ id: 'm1', classId: 'c1', studentId: 's1', effectiveFrom: '2020-01-01T00:00:00.000Z' }],
    classSessions: [{
      id: 'sess',
      classId: 'c1',
      startAt: '2026-05-01T12:00:00.000Z',
      endAt: '2026-05-01T13:00:00.000Z',
      status: 'scheduled',
    }],
    attendanceStatusCatalog: catalog,
    attendanceRecords: [{ sessionId: 'sess', studentId: 's1', statusId: 'custom' }],
  }, { includeFuture: true, nowIso: '2026-06-01T00:00:00.000Z' });
  assert.equal(report.countsByStatus.custom, 1);
});

test('F7 DOM: fresh BA parent view starts clean with implicit select value', (t) => {
  installBaDomEnvironment(t, { confirm: () => true });
  const ctx = {
    isTeacher: () => true,
    navigate: () => {},
    renderApp: () => {},
    toastOk: () => {},
    toastErr: () => {},
    state: {
      data: {
        classes: [{ id: 'c1', name: 'Lớp A' }],
        students: [{ id: 's1', name: 'HS', classId: 'c1' }],
        parents: [],
        parentStudentLinks: [],
        memberships: [],
        attendanceStatusCatalog: [],
      },
    },
  };
  tryRenderBaView(ctx, { view: 'tutor-parents' });
  assert.equal(isGloballyDirty(), false);
  registerDirtyProbe(null);
});

test('F8: weekday and session status Vietnamese labels', () => {
  assert.equal(BA_WEEKDAY_LABELS[0], 'CN');
  assert.equal(BA_WEEKDAY_LABELS[1], 'Thứ 2');
  assert.equal(formatBaSessionStatus('scheduled'), 'Đã lên lịch');
  assert.equal(formatBaSessionStatus('cancelled'), 'Đã hủy');
});

test('F5 DOM: preview populates manual recipient selector without mock batch', async (t) => {
  const serverCtx = await startBaTestServer();
  t.after(async () => {
    await serverCtx.close();
    fs.rmSync(serverCtx.dataDir, { recursive: true, force: true });
  });
  const jar = await teacherSetup(serverCtx);
  const phone = '0900555666';
  const recipientKey = canonicalRecipientKey({ phone });
  const { classId, studentId } = await seedClassStudent(serverCtx, jar, { studentName: 'HS F5' });
  const startAt = localDateTimeToUtcIso('2026-09-01', '19:00');
  const endAt = localDateTimeToUtcIso('2026-09-01', '20:00');
  const adhoc = await api(serverCtx.base, jar, '/api/teacher/ba/sessions/adhoc', {
    method: 'PUT',
    body: { classId, startAt, endAt, operationId: randomUUID() },
  });
  assert.equal(adhoc.res.status, 200);
  const sessionId = adhoc.data.id;

  const previewNoContact = await api(serverCtx.base, jar, '/api/teacher/ba/notifications/preview', {
    method: 'POST',
    body: { sessionId, type: 'session-reminder' },
  });
  assert.equal(previewNoContact.res.status, 200);
  assert.equal(previewNoContact.data.recipients.length, 0);
  assert.ok(previewNoContact.data.skipped.length >= 1, 'missing contact stays in skipped, not valid recipients');

  const putPhone = await api(serverCtx.base, jar, '/api/teacher/record/students', {
    method: 'PUT',
    body: { id: studentId, name: 'HS F5', classId, phone, operationId: randomUUID() },
  });
  assert.equal(putPhone.res.status, 200);
  assert.equal(putPhone.data.id, studentId);
  const memBack = await backdateOpenMembership(serverCtx, jar, {
    classId,
    studentId,
    effectiveFrom: '2020-01-01T00:00:00.000Z',
  });
  assert.equal(memBack.res.status, 200);

  let teacherData = await loadTeacherData(serverCtx, jar);
  const storedStudent = teacherData.students.find((s) => s.id === studentId);
  assert.equal(storedStudent.phone, phone);
  const sessionRow = teacherData.classSessions.find((s) => s.id === sessionId);
  const roster = buildSessionRecipientRoster(teacherData, sessionRow);
  assert.equal(roster.recipients.length, 1);
  assert.equal(roster.skipped.length, 0);
  assert.equal(canonicalRecipientKey(roster.recipients[0]), recipientKey);

  const previewWithPhone = await api(serverCtx.base, jar, '/api/teacher/ba/notifications/preview', {
    method: 'POST',
    body: { sessionId, type: 'session-reminder' },
  });
  assert.equal(previewWithPhone.res.status, 200);
  assert.equal(previewWithPhone.data.recipients.length, 1);
  assert.equal(previewWithPhone.data.recipients[0].canonicalKey, recipientKey);
  assert.equal(previewWithPhone.data.skipped.length, 0);

  installBaBrowserApiFixture(t, serverCtx, jar);
  const postBodies = [];
  const routedFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const method = String(options.method || 'GET').toUpperCase();
    if (method === 'POST' && typeof options.body === 'string') {
      try {
        postBodies.push(JSON.parse(options.body));
      } catch {
        postBodies.push(options.body);
      }
    }
    return routedFetch(url, options);
  };
  t.after(() => {
    globalThis.fetch = routedFetch;
  });

  await fetchMe();

  installBaDomEnvironment(t, { confirm: () => true, cookie: jarCookie(jar) });
  teacherData = await loadTeacherData(serverCtx, jar);
  const root = document.getElementById('app-root');
  const ctx = {
    isTeacher: () => true,
    navigate: () => {},
    renderApp: async () => {
      teacherData = await loadTeacherData(serverCtx, jar);
      ctx.state.data = teacherData;
    },
    toastOk: () => {},
    toastErr: () => {},
    state: { data: teacherData },
  };
  assert.equal(tryRenderBaView(ctx, { view: 'tutor-notifications' }), true);

  const sessionSel = findDomNodes(root, (n) => n.tagName === 'SELECT' && n.getAttribute('aria-label') === 'Chọn buổi')[0];
  sessionSel.value = sessionId;
  sessionSel.dispatchEvent({ type: 'change' });
  const batchSel = findDomNodes(root, (n) => n.tagName === 'SELECT' && n.getAttribute('aria-label') === 'Batch (tuỳ chọn)')[0];
  assert.equal(batchSel.value, '', 'manual picker must use live preview, not a mock batch');

  const previewBtn = findDomNodes(root, (n) => n.tagName === 'BUTTON' && n.textContent === 'Xem trước chi tiết')[0];
  const previewBox = findDomNodes(root, (n) => n.tagName === 'PRE' && n.getAttribute('aria-live') === 'polite')[0];
  previewBtn.dispatchEvent({ type: 'click' });
  const previewText = await awaitPreviewBoxSignal(previewBox, '--- Người nhận ---');
  assert.ok(previewText.includes(recipientKey));
  assert.ok(previewText.includes('HS F5'));

  const manualSel = findDomNodes(
    root,
    (n) => n.tagName === 'SELECT' && n.getAttribute('aria-label') === 'Người nhận từ snapshot',
  )[0];
  assert.equal(manualSel.childNodes.length, 1, 'one valid recipient option after preview');
  assert.equal(manualSel.value, recipientKey);

  const scenSel = findDomNodes(root, (n) => n.tagName === 'SELECT' && n.getAttribute('aria-label') === 'Kịch bản mock')[0];
  scenSel.value = 'per-recipient';
  scenSel.dispatchEvent({ type: 'change' });
  const perRecipientChecks = findDomNodes(
    root,
    (n) => n.tagName === 'INPUT' && n.getAttribute('data-recipient-key') === recipientKey,
  );
  assert.equal(perRecipientChecks.length, 1);
  assert.equal(perRecipientChecks[0].checked, false, 'first recipient defaults to mock fail');
  perRecipientChecks[0].checked = true;
  perRecipientChecks[0].dispatchEvent({ type: 'change' });

  const sendBtn = findDomNodes(root, (n) => n.tagName === 'BUTTON' && n.textContent === 'Gửi mock')[0];
  sendBtn.dispatchEvent({ type: 'click' });
  await waitSendButtonBusyCycle(sendBtn);
  await flushAsync();

  const sendBody = postBodies.filter((b) => b.scenario != null).at(-1);
  assert.ok(sendBody, `send-mock POST missing; bodies=${JSON.stringify(postBodies)}`);
  assert.equal(sendBody.sessionId, sessionId);
  assert.equal(sendBody.scenario, 'per-recipient');
  assert.equal(sendBody.perRecipient[recipientKey], true);
  assert.ok(sendBody.previewCaptureKey);

  registerDirtyProbe(null);
});
