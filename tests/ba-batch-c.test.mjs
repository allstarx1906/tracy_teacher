import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
  localDateTimeToUtcIso,
  REMINDER_TYPE,
  MANUAL_SEND_OUTCOME,
  canonicalRecipientKey,
  buildSessionRecipientRoster,
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
import {
  installBaDomEnvironment,
  findDomNodes,
  installNavigatorWithoutClipboardFixture,
} from './helper-browser-window.mjs';
import { tryRenderBaView } from '../dist/ba-ui.js';
import { fetchMe } from '../dist/api-client.js';

function jarCookie(jar) {
  return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
}

function phoneCanonicalKey(phone) {
  return canonicalRecipientKey({ phone });
}

function previewRecipientKeys(previewData) {
  return new Set([
    ...(previewData.recipients || []).map((r) => r.canonicalKey),
    ...(previewData.skipped || []).map((r) => r.canonicalKey),
  ]);
}

function rosterStudentIds(roster) {
  const ids = new Set();
  for (const r of [...(roster.recipients || []), ...(roster.skipped || [])]) {
    for (const sid of r.relatedStudentIds || []) ids.add(sid);
  }
  return ids;
}

async function flushAsync(times = 12) {
  for (let i = 0; i < times; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test('HTTP: change notify union after reschedule across membership boundary', async (t) => {
  const ctx = await startBaTestServer();
  t.after(async () => {
    await ctx.close();
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });
  const jar = await teacherSetup(ctx);
  const phoneA = '0900100001';
  const phoneB = '0900100002';
  const phoneC = '0900100003';
  const keyA = phoneCanonicalKey(phoneA);
  const keyB = phoneCanonicalKey(phoneB);
  const keyC = phoneCanonicalKey(phoneC);

  const { classId, studentId: s1 } = await seedClassStudent(ctx, jar, { studentName: 'Em A' });
  const putA = await api(ctx.base, jar, '/api/teacher/record/students', {
    method: 'PUT',
    body: { id: s1, name: 'Em A', classId, phone: phoneA },
  });
  assert.equal(putA.res.status, 200, `student A phone setup: ${JSON.stringify(putA.data)}`);
  const memBackA = await backdateOpenMembership(ctx, jar, {
    classId,
    studentId: s1,
    effectiveFrom: '2020-01-01T00:00:00.000Z',
  });
  assert.equal(memBackA.res.status, 200);
  let data = await loadTeacherData(ctx, jar);
  const memA = data.memberships.find((m) => m.classId === classId && m.studentId === s1);
  assert.ok(memA);
  const endA = await api(ctx.base, jar, '/api/teacher/ba/memberships', {
    method: 'PUT',
    body: {
      id: memA.id,
      classId,
      studentId: s1,
      effectiveFrom: memA.effectiveFrom,
      effectiveTo: '2026-08-01T00:00:00.000Z',
      operationId: randomUUID(),
    },
  });
  assert.equal(endA.res.status, 200);

  const s2 = randomUUID();
  const putB = await api(ctx.base, jar, '/api/teacher/record/students', {
    method: 'PUT',
    body: { id: s2, name: 'Em B', classId, phone: phoneB },
  });
  assert.equal(putB.res.status, 200, `student B setup: ${JSON.stringify(putB.data)}`);
  const memBackB = await backdateOpenMembership(ctx, jar, {
    classId,
    studentId: s2,
    effectiveFrom: '2026-08-01T00:00:00.000Z',
  });
  assert.equal(memBackB.res.status, 200);
  data = await loadTeacherData(ctx, jar);
  const memB = data.memberships.find((m) => m.classId === classId && m.studentId === s2);
  assert.ok(memB);
  const endB = await api(ctx.base, jar, '/api/teacher/ba/memberships', {
    method: 'PUT',
    body: {
      id: memB.id,
      classId,
      studentId: s2,
      effectiveFrom: memB.effectiveFrom,
      effectiveTo: '2026-09-01T00:00:00.000Z',
      operationId: randomUUID(),
    },
  });
  assert.equal(endB.res.status, 200);

  const s3 = randomUUID();
  const putC = await api(ctx.base, jar, '/api/teacher/record/students', {
    method: 'PUT',
    body: { id: s3, name: 'Em C', classId, phone: phoneC },
  });
  assert.equal(putC.res.status, 200, `student C setup: ${JSON.stringify(putC.data)}`);
  const memBackC = await backdateOpenMembership(ctx, jar, {
    classId,
    studentId: s3,
    effectiveFrom: '2026-09-01T00:00:00.000Z',
  });
  assert.equal(memBackC.res.status, 200);

  data = await loadTeacherData(ctx, jar);
  const rowA = data.memberships.find((m) => m.classId === classId && m.studentId === s1);
  const rowB = data.memberships.find((m) => m.classId === classId && m.studentId === s2);
  const rowC = data.memberships.find((m) => m.classId === classId && m.studentId === s3);
  assert.ok(rowA);
  assert.equal(rowA.effectiveTo, '2026-08-01T00:00:00.000Z');
  assert.ok(rowB);
  assert.equal(rowB.effectiveFrom, '2026-08-01T00:00:00.000Z');
  assert.equal(rowB.effectiveTo, '2026-09-01T00:00:00.000Z');
  assert.ok(rowC);
  assert.equal(rowC.effectiveFrom, '2026-09-01T00:00:00.000Z');
  assert.equal(rowC.effectiveTo, null);

  const startAt = localDateTimeToUtcIso('2026-07-15', '19:00');
  const endAt = localDateTimeToUtcIso('2026-07-15', '20:00');
  const adhoc = await api(ctx.base, jar, '/api/teacher/ba/sessions/adhoc', {
    method: 'PUT',
    body: { classId, startAt, endAt },
  });
  assert.equal(adhoc.res.status, 200);
  const sessionId = adhoc.data.id;

  const preChange = await api(ctx.base, jar, '/api/teacher/ba/notifications/preview', {
    method: 'POST',
    body: { sessionId, type: REMINDER_TYPE.SESSION_CHANGE },
  });
  assert.equal(preChange.res.status, 400);

  data = await loadTeacherData(ctx, jar);
  const sessionJuly = data.classSessions.find((s) => s.id === sessionId);
  const rosterJuly = buildSessionRecipientRoster(data, sessionJuly);
  assert.ok(rosterStudentIds(rosterJuly).has(s1));
  assert.ok(!rosterStudentIds(rosterJuly).has(s2));
  assert.ok(!rosterStudentIds(rosterJuly).has(s3));

  const reschedule1 = await api(ctx.base, jar, `/api/teacher/ba/sessions/${sessionId}/reschedule`, {
    method: 'POST',
    body: {
      startAt: localDateTimeToUtcIso('2026-08-15', '19:00'),
      endAt: localDateTimeToUtcIso('2026-08-15', '20:00'),
      reason: 'Đổi sang kỳ B',
      confirmOverlap: true,
    },
  });
  assert.equal(reschedule1.res.status, 200);

  data = await loadTeacherData(ctx, jar);
  const sessionAug = data.classSessions.find((s) => s.id === sessionId);
  const rosterAug = buildSessionRecipientRoster(data, sessionAug);
  assert.ok(!rosterStudentIds(rosterAug).has(s1));
  assert.ok(rosterStudentIds(rosterAug).has(s2));
  assert.ok(!rosterStudentIds(rosterAug).has(s3));

  const preview1 = await api(ctx.base, jar, '/api/teacher/ba/notifications/preview', {
    method: 'POST',
    body: { sessionId, type: REMINDER_TYPE.SESSION_CHANGE },
  });
  assert.equal(preview1.res.status, 200);
  const keys1 = previewRecipientKeys(preview1.data);
  assert.ok(keys1.has(keyA), `roster-before key missing; got ${[...keys1].join(',')}`);
  assert.ok(keys1.has(keyB), `roster-after key missing; got ${[...keys1].join(',')}`);
  assert.ok(!keys1.has(keyC));

  const send1 = await api(ctx.base, jar, '/api/teacher/ba/notifications/send-mock', {
    method: 'POST',
    body: {
      sessionId,
      type: REMINDER_TYPE.SESSION_CHANGE,
      scenario: 'all-success',
      previewCaptureKey: preview1.data.previewCaptureKey,
    },
  });
  assert.equal(send1.res.status, 200);
  data = await loadTeacherData(ctx, jar);
  const batch1 = data.notificationBatches.at(-1);
  assert.ok(batch1);
  const snapKeys1 = new Set((batch1.recipientsSnapshot || []).map((r) => r.canonicalKey));
  assert.ok(snapKeys1.has(keyA));
  assert.ok(snapKeys1.has(keyB));

  const reschedule2 = await api(ctx.base, jar, `/api/teacher/ba/sessions/${sessionId}/reschedule`, {
    method: 'POST',
    body: {
      startAt: localDateTimeToUtcIso('2026-09-15', '19:00'),
      endAt: localDateTimeToUtcIso('2026-09-15', '20:00'),
      reason: 'Đổi sang kỳ C',
      confirmOverlap: true,
    },
  });
  assert.equal(reschedule2.res.status, 200);

  data = await loadTeacherData(ctx, jar);
  const sessionSep = data.classSessions.find((s) => s.id === sessionId);
  const rosterSep = buildSessionRecipientRoster(data, sessionSep);
  assert.ok(!rosterStudentIds(rosterSep).has(s1));
  assert.ok(!rosterStudentIds(rosterSep).has(s2));
  assert.ok(rosterStudentIds(rosterSep).has(s3));

  const preview2 = await api(ctx.base, jar, '/api/teacher/ba/notifications/preview', {
    method: 'POST',
    body: { sessionId, type: REMINDER_TYPE.SESSION_CHANGE },
  });
  assert.equal(preview2.res.status, 200);
  const keys2 = previewRecipientKeys(preview2.data);
  assert.ok(keys2.has(keyA));
  assert.ok(keys2.has(keyB));
  assert.ok(keys2.has(keyC));

  const renameA = await api(ctx.base, jar, '/api/teacher/record/students', {
    method: 'PUT',
    body: { id: s1, name: 'Em A đổi tên', classId, phone: '0900999999' },
  });
  assert.equal(renameA.res.status, 200);
  data = await loadTeacherData(ctx, jar);
  const frozenBatch = data.notificationBatches.find((b) => b.id === batch1.id);
  const frozenA = frozenBatch.recipientsSnapshot.find((r) => r.canonicalKey === keyA);
  assert.ok(frozenA);
  assert.equal(frozenA.displayName, 'Em A');
  assert.equal(frozenA.phone, phoneA);

  const previewAfterRename = await api(ctx.base, jar, '/api/teacher/ba/notifications/preview', {
    method: 'POST',
    body: { sessionId, type: REMINDER_TYPE.SESSION_CHANGE },
  });
  assert.equal(previewAfterRename.res.status, 200);
  const unionA = [...previewAfterRename.data.recipients, ...previewAfterRename.data.skipped]
    .find((r) => r.canonicalKey === keyA);
  assert.ok(unionA);
  assert.equal(unionA.phone, phoneA);
  assert.equal(unionA.displayName, 'Em A');
});

test('HTTP: cancellation notice uses roster frozen at cancel', async (t) => {
  const ctx = await startBaTestServer();
  t.after(async () => {
    await ctx.close();
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });
  const jar = await teacherSetup(ctx);
  const { classId, studentId } = await seedClassStudent(ctx, jar);
  await api(ctx.base, jar, '/api/teacher/record/students', {
    method: 'PUT',
    body: { id: studentId, name: 'Em', classId, phone: '0900333444' },
  });
  const startAt = localDateTimeToUtcIso('2026-09-10', '19:00');
  const endAt = localDateTimeToUtcIso('2026-09-10', '20:00');
  const adhoc = await api(ctx.base, jar, '/api/teacher/ba/sessions/adhoc', {
    method: 'PUT',
    body: { classId, startAt, endAt },
  });
  const sessionId = adhoc.data.id;
  await api(ctx.base, jar, `/api/teacher/ba/sessions/${sessionId}/cancel`, {
    method: 'POST',
    body: { reason: 'Hủy test' },
  });
  const preview = await api(ctx.base, jar, '/api/teacher/ba/notifications/preview', {
    method: 'POST',
    body: { sessionId, type: REMINDER_TYPE.SESSION_CANCEL },
  });
  assert.equal(preview.res.status, 200);
  assert.ok(preview.data.content.includes('hủy') || preview.data.content.includes('Hủy'));
  assert.equal(preview.data.recipients.length, 1);
});

test('HTTP: skipped recipient retry rejected', async (t) => {
  const ctx = await startBaTestServer();
  t.after(async () => {
    await ctx.close();
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });
  const jar = await teacherSetup(ctx);
  const { classId, studentId } = await seedClassStudent(ctx, jar, { studentName: 'NoPhone' });
  const startAt = localDateTimeToUtcIso('2026-09-20', '19:00');
  const endAt = localDateTimeToUtcIso('2026-09-20', '20:00');
  const adhoc = await api(ctx.base, jar, '/api/teacher/ba/sessions/adhoc', {
    method: 'PUT',
    body: { classId, startAt, endAt },
  });
  await api(ctx.base, jar, '/api/teacher/ba/notifications/send-mock', {
    method: 'POST',
    body: { sessionId: adhoc.data.id, scenario: 'all-success' },
  });
  const skipped = (await loadTeacherData(ctx, jar)).notificationAttempts.find((a) => a.status === 'skipped');
  assert.ok(skipped);
  const retry = await api(ctx.base, jar, '/api/teacher/ba/notifications/retry', {
    method: 'POST',
    body: { attemptId: skipped.id, scenario: 'all-success' },
  });
  assert.equal(retry.res.status, 400);
});

test('HTTP: manual confirm rejects bogus session and recipient key', async (t) => {
  const ctx = await startBaTestServer();
  t.after(async () => {
    await ctx.close();
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });
  const jar = await teacherSetup(ctx);
  const badSession = await api(ctx.base, jar, '/api/teacher/ba/manual-send/confirm', {
    method: 'POST',
    body: {
      sessionId: randomUUID(),
      canonicalKey: 'phone:1',
      outcome: MANUAL_SEND_OUTCOME.UNPROCESSED,
    },
  });
  assert.equal(badSession.res.status, 404);
  const { classId } = await seedClassStudent(ctx, jar);
  const startAt = localDateTimeToUtcIso('2026-10-05', '19:00');
  const endAt = localDateTimeToUtcIso('2026-10-05', '20:00');
  const adhoc = await api(ctx.base, jar, '/api/teacher/ba/sessions/adhoc', {
    method: 'PUT',
    body: { classId, startAt, endAt },
  });
  const badKey = await api(ctx.base, jar, '/api/teacher/ba/manual-send/confirm', {
    method: 'POST',
    body: {
      sessionId: adhoc.data.id,
      canonicalKey: 'phone:9999999999',
      outcome: MANUAL_SEND_OUTCOME.UNPROCESSED,
    },
  });
  assert.equal(badKey.res.status, 400);
});

test('HTTP: manual confirm with batch snapshot does not alter mock attempts', async (t) => {
  const ctx = await startBaTestServer();
  t.after(async () => {
    await ctx.close();
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });
  const jar = await teacherSetup(ctx);
  const { classId, studentId } = await seedClassStudent(ctx, jar);
  await api(ctx.base, jar, '/api/teacher/record/students', {
    method: 'PUT',
    body: { id: studentId, name: 'Em', classId, phone: '0900555666' },
  });
  const startAt = localDateTimeToUtcIso('2026-10-10', '19:00');
  const endAt = localDateTimeToUtcIso('2026-10-10', '20:00');
  const adhoc = await api(ctx.base, jar, '/api/teacher/ba/sessions/adhoc', {
    method: 'PUT',
    body: { classId, startAt, endAt },
  });
  const sessionId = adhoc.data.id;
  await api(ctx.base, jar, '/api/teacher/ba/notifications/send-mock', {
    method: 'POST',
    body: { sessionId, scenario: 'all-fail' },
  });
  const data = await loadTeacherData(ctx, jar);
  const batch = data.notificationBatches.at(-1);
  const snap = batch.recipientsSnapshot.find((r) => !r.skipped);
  assert.ok(snap);
  const beforeAttempts = data.notificationAttempts.length;
  const beforeJobs = data.reminderJobs.length;
  const ok = await api(ctx.base, jar, '/api/teacher/ba/manual-send/confirm', {
    method: 'POST',
    body: {
      sessionId,
      batchId: batch.id,
      canonicalKey: snap.canonicalKey,
      channel: 'Zalo tay',
      outcome: MANUAL_SEND_OUTCOME.TEACHER_CONFIRMED_SUCCESS,
      declaredSentAt: '2026-10-10T12:00:00.000Z',
      note: 'Đã nhắn tay',
    },
  });
  assert.equal(ok.res.status, 200);
  const after = await loadTeacherData(ctx, jar);
  assert.equal(after.notificationAttempts.length, beforeAttempts);
  assert.equal(after.reminderJobs.length, beforeJobs);
  assert.equal(after.manualSendEvents.length, 1);
  assert.equal(after.manualSendEvents[0].canonicalKey, snap.canonicalKey);
});

test('HTTP: per-recipient mock batch exposes all recipient rows', async (t) => {
  const ctx = await startBaTestServer();
  t.after(async () => {
    await ctx.close();
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });
  const jar = await teacherSetup(ctx);
  const { classId, studentId: s0 } = await seedClassStudent(ctx, jar, { studentName: 'S0' });
  const putS0 = await api(ctx.base, jar, '/api/teacher/record/students', {
    method: 'PUT',
    body: { id: s0, name: 'S0', classId, phone: '0900400001' },
  });
  assert.equal(putS0.res.status, 200);
  const phones = ['0900400002', '0900400003', '0900400004'];
  for (let i = 0; i < phones.length; i += 1) {
    const id = randomUUID();
    const put = await api(ctx.base, jar, '/api/teacher/record/students', {
      method: 'PUT',
      body: { id, name: `S${i + 1}`, classId, phone: phones[i] },
    });
    assert.equal(put.res.status, 200);
  }
  const allPhones = ['0900400001', ...phones];
  const startAt = localDateTimeToUtcIso('2026-11-05', '19:00');
  const endAt = localDateTimeToUtcIso('2026-11-05', '20:00');
  const adhoc = await api(ctx.base, jar, '/api/teacher/ba/sessions/adhoc', {
    method: 'PUT',
    body: { classId, startAt, endAt },
  });
  assert.equal(adhoc.res.status, 200);
  const perRecipient = {
    [phoneCanonicalKey(allPhones[0])]: true,
    [phoneCanonicalKey(allPhones[1])]: false,
    [phoneCanonicalKey(allPhones[2])]: true,
    [phoneCanonicalKey(allPhones[3])]: false,
  };
  await api(ctx.base, jar, '/api/teacher/ba/notifications/send-mock', {
    method: 'POST',
    body: { sessionId: adhoc.data.id, scenario: 'per-recipient', perRecipient },
  });
  const data = await loadTeacherData(ctx, jar);
  const batch = data.notificationBatches.at(-1);
  const attempts = data.notificationAttempts.filter((a) => a.batchId === batch.id);
  assert.ok(attempts.length >= 4);
  assert.equal(batch.recipientsSnapshot.filter((r) => !r.skipped).length, 4);
});

test('DOM: notifications view renders type selector and honest mock banner', async (t) => {
  const serverCtx = await startBaTestServer();
  t.after(async () => {
    await serverCtx.close();
    fs.rmSync(serverCtx.dataDir, { recursive: true, force: true });
  });
  const jar = await teacherSetup(serverCtx);
  installBaBrowserApiFixture(t, serverCtx, jar);
  await fetchMe();
  installBaDomEnvironment(t, { confirm: () => true, cookie: jarCookie(jar) });
  const root = document.getElementById('app-root');
  const data = await loadTeacherData(serverCtx, jar);
  const ctx = {
    isTeacher: () => true,
    navigate: () => {},
    renderApp: () => {},
    toastOk: () => {},
    toastErr: () => {},
    state: { data },
  };
  assert.equal(tryRenderBaView(ctx, { view: 'tutor-notifications' }), true);
  const typeSel = findDomNodes(root, (n) => n.tagName === 'SELECT' && n.getAttribute('aria-label') === 'Loại thông báo');
  assert.equal(typeSel.length, 1);
  const banners = findDomNodes(root, (n) => n.textContent?.includes('MÔ PHỎNG'));
  assert.ok(banners.length >= 1);
});

test('DOM: preview and send mock post captured API payloads', async (t) => {
  const serverCtx = await startBaTestServer();
  t.after(async () => {
    await serverCtx.close();
    fs.rmSync(serverCtx.dataDir, { recursive: true, force: true });
  });
  const jar = await teacherSetup(serverCtx);
  installBaBrowserApiFixture(t, serverCtx, jar);
  const postBodies = [];
  const apiFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const method = String(options.method || 'GET').toUpperCase();
    if (method === 'POST' && typeof options.body === 'string') {
      try {
        postBodies.push(JSON.parse(options.body));
      } catch {
        postBodies.push(options.body);
      }
    }
    return apiFetch(url, options);
  };
  await fetchMe();
  const { classId, studentId } = await seedClassStudent(serverCtx, jar);
  const put = await api(serverCtx.base, jar, '/api/teacher/record/students', {
    method: 'PUT',
    body: { id: studentId, name: 'Em UI', classId, phone: '0900666777' },
  });
  assert.equal(put.res.status, 200);
  await backdateOpenMembership(serverCtx, jar, {
    classId,
    studentId,
    effectiveFrom: '2020-01-01T00:00:00.000Z',
  });
  const startAt = localDateTimeToUtcIso('2026-12-01', '19:00');
  const endAt = localDateTimeToUtcIso('2026-12-01', '20:00');
  const adhoc = await api(serverCtx.base, jar, '/api/teacher/ba/sessions/adhoc', {
    method: 'PUT',
    body: { classId, startAt, endAt },
  });
  assert.equal(adhoc.res.status, 200);
  const sessionId = adhoc.data.id;

  installBaDomEnvironment(t, { confirm: () => true, cookie: jarCookie(jar) });
  const root = document.getElementById('app-root');
  let data = await loadTeacherData(serverCtx, jar);
  const ctx = {
    isTeacher: () => true,
    navigate: () => {},
    renderApp: async () => {
      data = await loadTeacherData(serverCtx, jar);
      ctx.state.data = data;
    },
    toastOk: () => {},
    toastErr: () => {},
    state: { data },
  };
  assert.equal(tryRenderBaView(ctx, { view: 'tutor-notifications' }), true);
  const sessionSelect = findDomNodes(root, (n) => n.tagName === 'SELECT' && n.getAttribute('aria-label') === 'Chọn buổi')[0];
  sessionSelect.value = sessionId;
  sessionSelect.dispatchEvent({ type: 'change' });
  const previewBtn = findDomNodes(root, (n) => n.tagName === 'BUTTON' && n.textContent === 'Xem trước chi tiết')[0];
  previewBtn.dispatchEvent({ type: 'click' });
  await flushAsync();
  const previewReq = postBodies.find((b) => b.sessionId === sessionId && b.scenario == null && b.canonicalKey == null);
  assert.ok(previewReq, `preview POST missing; bodies=${JSON.stringify(postBodies)}`);
  const previewBox = findDomNodes(root, (n) => n.tagName === 'PRE' && n.getAttribute('aria-live') === 'polite')[0];
  assert.ok(previewBox.textContent.includes('Em UI'));

  const sendBtn = findDomNodes(root, (n) => n.tagName === 'BUTTON' && n.textContent === 'Gửi mock')[0];
  sendBtn.dispatchEvent({ type: 'click' });
  await flushAsync();
  const sendBody = postBodies.filter((b) => b.scenario != null).at(-1);
  assert.ok(sendBody);
  assert.equal(sendBody.sessionId, sessionId);
  assert.equal(sendBody.scenario, 'all-success');
  assert.ok(sendBody.previewCaptureKey);
  assert.ok(sendBody.operationId);
});

test('DOM: manual picker submits confirm payload from batch snapshot', async (t) => {
  const serverCtx = await startBaTestServer();
  t.after(async () => {
    await serverCtx.close();
    fs.rmSync(serverCtx.dataDir, { recursive: true, force: true });
  });
  const jar = await teacherSetup(serverCtx);
  installBaBrowserApiFixture(t, serverCtx, jar);
  const postBodies = [];
  const apiFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const method = String(options.method || 'GET').toUpperCase();
    if (method === 'POST' && typeof options.body === 'string') {
      try {
        postBodies.push(JSON.parse(options.body));
      } catch {
        postBodies.push(options.body);
      }
    }
    return apiFetch(url, options);
  };
  await fetchMe();
  const { classId, studentId } = await seedClassStudent(serverCtx, jar);
  const put = await api(serverCtx.base, jar, '/api/teacher/record/students', {
    method: 'PUT',
    body: { id: studentId, name: 'Em manual', classId, phone: '0900444333' },
  });
  assert.equal(put.res.status, 200);
  await backdateOpenMembership(serverCtx, jar, {
    classId,
    studentId,
    effectiveFrom: '2020-01-01T00:00:00.000Z',
  });
  const startAt = localDateTimeToUtcIso('2026-12-10', '19:00');
  const endAt = localDateTimeToUtcIso('2026-12-10', '20:00');
  const adhoc = await api(serverCtx.base, jar, '/api/teacher/ba/sessions/adhoc', {
    method: 'PUT',
    body: { classId, startAt, endAt },
  });
  assert.equal(adhoc.res.status, 200);
  const sessionId = adhoc.data.id;
  await api(serverCtx.base, jar, '/api/teacher/ba/notifications/send-mock', {
    method: 'POST',
    body: { sessionId, scenario: 'all-fail' },
  });
  const seeded = await loadTeacherData(serverCtx, jar);
  const batch = seeded.notificationBatches.at(-1);
  const snap = batch.recipientsSnapshot.find((r) => !r.skipped);
  assert.ok(snap);

  installBaDomEnvironment(t, { confirm: () => true, cookie: jarCookie(jar) });
  const root = document.getElementById('app-root');
  const ctx = {
    isTeacher: () => true,
    navigate: () => {},
    renderApp: async () => {},
    toastOk: () => {},
    toastErr: () => {},
    state: { data: seeded },
  };
  assert.equal(tryRenderBaView(ctx, { view: 'tutor-notifications' }), true);
  const sessionSelect = findDomNodes(root, (n) => n.tagName === 'SELECT' && n.getAttribute('aria-label') === 'Chọn buổi')[0];
  sessionSelect.value = sessionId;
  sessionSelect.dispatchEvent({ type: 'change' });
  const batchSel = findDomNodes(root, (n) => n.tagName === 'SELECT' && n.getAttribute('aria-label') === 'Batch (tuỳ chọn)')[0];
  batchSel.value = batch.id;
  batchSel.dispatchEvent({ type: 'change' });
  const recipientSel = findDomNodes(root, (n) => n.tagName === 'SELECT' && n.getAttribute('aria-label') === 'Người nhận từ snapshot')[0];
  assert.ok(recipientSel.value);
  assert.equal(recipientSel.value, snap.canonicalKey);
  const channel = findDomNodes(root, (n) => n.tagName === 'INPUT' && n.getAttribute('aria-label') === 'Kênh gửi')[0];
  channel.value = 'Zalo tay';
  channel.dispatchEvent({ type: 'input' });
  const outcomeSel = findDomNodes(root, (n) => n.tagName === 'SELECT' && n.getAttribute('aria-label') === 'Kết quả ghi nhận')[0];
  outcomeSel.value = MANUAL_SEND_OUTCOME.TEACHER_CONFIRMED_SUCCESS;
  outcomeSel.dispatchEvent({ type: 'change' });
  const timeIn = findDomNodes(root, (n) => n.tagName === 'INPUT' && n.getAttribute('aria-label') === 'Thời gian gửi thực tế')[0];
  timeIn.value = '2026-12-10T12:00';
  timeIn.dispatchEvent({ type: 'input' });
  const notes = findDomNodes(root, (n) => n.tagName === 'TEXTAREA' && n.getAttribute('aria-label') === 'Ghi chú')[0];
  notes.value = 'Đã nhắn ngoài mock';
  notes.dispatchEvent({ type: 'input' });
  const saveBtn = findDomNodes(root, (n) => n.tagName === 'BUTTON' && n.textContent === 'Ghi nhận thủ công')[0];
  saveBtn.dispatchEvent({ type: 'click' });
  await flushAsync();
  const manualBody = postBodies.find((b) => b.canonicalKey === snap.canonicalKey && b.outcome);
  assert.ok(manualBody);
  assert.equal(manualBody.sessionId, sessionId);
  assert.equal(manualBody.batchId, batch.id);
  assert.equal(manualBody.channel, 'Zalo tay');
  assert.equal(manualBody.note, 'Đã nhắn ngoài mock');
  assert.ok(manualBody.declaredSentAt);
});

test('DOM: copy fallback shows error when clipboard unavailable', async (t) => {
  const serverCtx = await startBaTestServer();
  t.after(async () => {
    await serverCtx.close();
    fs.rmSync(serverCtx.dataDir, { recursive: true, force: true });
  });
  const jar = await teacherSetup(serverCtx);
  installBaBrowserApiFixture(t, serverCtx, jar);
  await fetchMe();
  const { classId, studentId } = await seedClassStudent(serverCtx, jar);
  const put = await api(serverCtx.base, jar, '/api/teacher/record/students', {
    method: 'PUT',
    body: { id: studentId, name: 'Em copy', classId, phone: '0900111222' },
  });
  assert.equal(put.res.status, 200);
  await backdateOpenMembership(serverCtx, jar, {
    classId,
    studentId,
    effectiveFrom: '2020-01-01T00:00:00.000Z',
  });
  const startAt = localDateTimeToUtcIso('2026-12-05', '19:00');
  const endAt = localDateTimeToUtcIso('2026-12-05', '20:00');
  const adhoc = await api(serverCtx.base, jar, '/api/teacher/ba/sessions/adhoc', {
    method: 'PUT',
    body: { classId, startAt, endAt },
  });
  assert.equal(adhoc.res.status, 200);

  installBaDomEnvironment(t, { confirm: () => true, cookie: jarCookie(jar) });
  installNavigatorWithoutClipboardFixture(t);
  const root = document.getElementById('app-root');
  const toastErrors = [];
  let data = await loadTeacherData(serverCtx, jar);
  const ctx = {
    isTeacher: () => true,
    navigate: () => {},
    renderApp: async () => {
      data = await loadTeacherData(serverCtx, jar);
      ctx.state.data = data;
    },
    toastOk: () => {},
    toastErr: (m) => toastErrors.push(m),
    state: { data },
  };
  assert.equal(tryRenderBaView(ctx, { view: 'tutor-notifications' }), true);
  const copyContent = findDomNodes(root, (n) => n.tagName === 'BUTTON' && n.textContent === 'Copy nội dung')[0];
  copyContent.dispatchEvent({ type: 'click' });
  assert.ok(toastErrors.some((m) => m.includes('Chưa có nội dung')));
  const copyContacts = findDomNodes(root, (n) => n.tagName === 'BUTTON' && n.textContent === 'Copy danh sách liên hệ')[0];
  copyContacts.dispatchEvent({ type: 'click' });
  assert.ok(toastErrors.some((m) => m.includes('Chưa có danh sách')));
  toastErrors.length = 0;
  const sessionSelect = findDomNodes(root, (n) => n.tagName === 'SELECT' && n.getAttribute('aria-label') === 'Chọn buổi')[0];
  sessionSelect.value = adhoc.data.id;
  sessionSelect.dispatchEvent({ type: 'change' });
  const previewBtn = findDomNodes(root, (n) => n.tagName === 'BUTTON' && n.textContent === 'Xem trước chi tiết')[0];
  previewBtn.dispatchEvent({ type: 'click' });
  await flushAsync();
  copyContent.dispatchEvent({ type: 'click' });
  await flushAsync();
  assert.ok(toastErrors.some((m) => m.includes('Không sao chép được')), toastErrors.join('|'));
});

test('DOM: batch detail shows per-recipient attempt chain after mock send', async (t) => {
  const serverCtx = await startBaTestServer();
  t.after(async () => {
    await serverCtx.close();
    fs.rmSync(serverCtx.dataDir, { recursive: true, force: true });
  });
  const jar = await teacherSetup(serverCtx);
  installBaBrowserApiFixture(t, serverCtx, jar);
  await fetchMe();
  const { classId, studentId } = await seedClassStudent(serverCtx, jar);
  const put = await api(serverCtx.base, jar, '/api/teacher/record/students', {
    method: 'PUT',
    body: { id: studentId, name: 'Em hist', classId, phone: '0900222111' },
  });
  assert.equal(put.res.status, 200);
  await backdateOpenMembership(serverCtx, jar, {
    classId,
    studentId,
    effectiveFrom: '2020-01-01T00:00:00.000Z',
  });
  const startAt = localDateTimeToUtcIso('2026-12-20', '19:00');
  const endAt = localDateTimeToUtcIso('2026-12-20', '20:00');
  const adhoc = await api(serverCtx.base, jar, '/api/teacher/ba/sessions/adhoc', {
    method: 'PUT',
    body: { classId, startAt, endAt },
  });
  assert.equal(adhoc.res.status, 200);
  await api(serverCtx.base, jar, '/api/teacher/ba/notifications/send-mock', {
    method: 'POST',
    body: { sessionId: adhoc.data.id, scenario: 'all-fail' },
  });
  const data = await loadTeacherData(serverCtx, jar);
  const batch = data.notificationBatches.at(-1);
  const attempts = data.notificationAttempts.filter((a) => a.batchId === batch.id);
  assert.ok(attempts.length >= 1);

  installBaDomEnvironment(t, { confirm: () => true, cookie: jarCookie(jar) });
  const root = document.getElementById('app-root');
  const ctx = {
    isTeacher: () => true,
    navigate: () => {},
    renderApp: () => {},
    toastOk: () => {},
    toastErr: () => {},
    state: { data },
  };
  assert.equal(tryRenderBaView(ctx, { view: 'tutor-notifications' }), true);
  const batchBtns = findDomNodes(
    root,
    (n) => n.tagName === 'BUTTON' && n.textContent?.includes(batch.type || 'reminder'),
  );
  assert.ok(batchBtns.length >= 1);
  batchBtns[0].dispatchEvent({ type: 'click' });
  const detailLines = findDomNodes(root, (n) => n.textContent?.startsWith('↳'));
  assert.ok(detailLines.length >= attempts.length);
  const configLines = findDomNodes(root, (n) => n.textContent?.includes('Mode:') && n.textContent?.includes('Capture:'));
  assert.ok(configLines.length >= 1);
});
