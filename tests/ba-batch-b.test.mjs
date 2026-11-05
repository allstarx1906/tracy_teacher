import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
  validateIntervalTimestamps,
  computeMembershipRetroactiveImpact,
  migrateLegacyMemberships,
  localDateTimeToUtcIso,
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
import { registerDirtyProbe, isGloballyDirty } from '../dist/ux-forms.js';
import {
  installBaDomEnvironment,
  findDomNodes,
} from './helper-browser-window.mjs';
import {
  beginBaViewScope,
  registerBaViewDirty,
  runBaScopedSubmit,
  resolveBaOperationId,
  ackBaOperation,
} from '../dist/ba-ui-scoped.js';
import {
  bumpRequestEpoch,
  fetchMe,
} from '../dist/api-client.js';

test('validateIntervalTimestamps rejects end before start', () => {
  const bad = validateIntervalTimestamps('2026-01-02T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  assert.equal(bad.ok, false);
  assert.ok(validateIntervalTimestamps('2026-01-01T00:00:00.000Z', null).ok);
});

test('HTTP: parent link overlap and bad foreign keys', async (t) => {
  const ctx = await startBaTestServer();
  t.after(async () => {
    await ctx.close();
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });
  const jar = await teacherSetup(ctx);
  const { studentId } = await seedClassStudent(ctx, jar);
  const p1 = await api(ctx.base, jar, '/api/teacher/ba/parents', {
    method: 'PUT',
    body: { name: 'Ba', operationId: randomUUID() },
  });
  assert.equal(p1.res.status, 200);
  const parentId = p1.data.id;
  const link = await api(ctx.base, jar, '/api/teacher/ba/parent-links', {
    method: 'PUT',
    body: {
      parentId,
      studentId,
      relationship: 'Bố',
      effectiveFrom: '2020-01-01T00:00:00.000Z',
      operationId: randomUUID(),
    },
  });
  assert.equal(link.res.status, 200);
  const overlap = await api(ctx.base, jar, '/api/teacher/ba/parent-links', {
    method: 'PUT',
    body: {
      parentId,
      studentId,
      relationship: 'Bố',
      effectiveFrom: '2021-01-01T00:00:00.000Z',
      operationId: randomUUID(),
    },
  });
  assert.equal(overlap.res.status, 400);
  const badParent = await api(ctx.base, jar, '/api/teacher/ba/parent-links', {
    method: 'PUT',
    body: { parentId: randomUUID(), studentId, relationship: 'X', operationId: randomUUID() },
  });
  assert.equal(badParent.res.status, 400);
});

test('HTTP: duplicate parent code rejected', async (t) => {
  const ctx = await startBaTestServer();
  t.after(async () => {
    await ctx.close();
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });
  const jar = await teacherSetup(ctx);
  await api(ctx.base, jar, '/api/teacher/ba/parents', {
    method: 'PUT',
    body: { name: 'A', code: 'PH-01', operationId: randomUUID() },
  });
  const dup = await api(ctx.base, jar, '/api/teacher/ba/parents', {
    method: 'PUT',
    body: { name: 'B', code: 'PH-01', operationId: randomUUID() },
  });
  assert.equal(dup.res.status, 400);
});

test('HTTP: retroactive membership 409 then confirm writes audit', async (t) => {
  const ctx = await startBaTestServer();
  t.after(async () => {
    await ctx.close();
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });
  const jar = await teacherSetup(ctx);
  const { classId, studentId } = await seedClassStudent(ctx, jar);
  await backdateOpenMembership(ctx, jar, {
    classId,
    studentId,
    effectiveFrom: '2026-06-01T00:00:00.000Z',
  });
  const startAt = localDateTimeToUtcIso('2026-06-15', '19:00');
  const endAt = localDateTimeToUtcIso('2026-06-15', '20:00');
  const adhoc = await api(ctx.base, jar, '/api/teacher/ba/sessions/adhoc', {
    method: 'PUT',
    body: { classId, startAt, endAt },
  });
  assert.equal(adhoc.res.status, 200);
  const attPut = await api(ctx.base, jar, '/api/teacher/ba/attendance/record', {
    method: 'PUT',
    body: {
      sessionId: adhoc.data.id,
      studentId,
      statusId: 'present',
      operationId: randomUUID(),
    },
  });
  assert.equal(attPut.res.status, 200);
  const data = await loadTeacherData(ctx, jar);
  const mem = data.memberships.find((m) => m.classId === classId && m.studentId === studentId);
  const first = await api(ctx.base, jar, '/api/teacher/ba/memberships', {
    method: 'PUT',
    body: {
      id: mem.id,
      classId,
      studentId,
      effectiveFrom: '2026-07-01T00:00:00.000Z',
      effectiveTo: null,
      operationId: randomUUID(),
    },
  });
  assert.equal(first.res.status, 409);
  assert.ok(first.data.impact?.sessionIds?.includes(adhoc.data.id));
  const ok = await api(ctx.base, jar, '/api/teacher/ba/memberships', {
    method: 'PUT',
    body: {
      id: mem.id,
      classId,
      studentId,
      effectiveFrom: '2026-07-01T00:00:00.000Z',
      effectiveTo: null,
      confirmImpact: true,
      reason: 'Điều chỉnh hồi tố có kiểm tra',
      operationId: randomUUID(),
    },
  });
  assert.equal(ok.res.status, 200);
  const after = await loadTeacherData(ctx, jar);
  assert.ok(after.membershipAudit?.length >= 1);
  assert.equal(after.membershipAudit.at(-1).reason, 'Điều chỉnh hồi tố có kiểm tra');
});

test('HTTP: inactive attendance status rejected for new record', async (t) => {
  const ctx = await startBaTestServer();
  t.after(async () => {
    await ctx.close();
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });
  const jar = await teacherSetup(ctx);
  const { classId, studentId } = await seedClassStudent(ctx, jar);
  await api(ctx.base, jar, '/api/teacher/ba/attendance/catalog', {
    method: 'PUT',
    body: { id: 'retired', label: 'Cũ', sortOrder: 9, active: false, operationId: randomUUID() },
  });
  const startAt = localDateTimeToUtcIso('2026-09-01', '19:00');
  const endAt = localDateTimeToUtcIso('2026-09-01', '20:00');
  const adhoc = await api(ctx.base, jar, '/api/teacher/ba/sessions/adhoc', {
    method: 'PUT',
    body: { classId, startAt, endAt },
  });
  const bad = await api(ctx.base, jar, '/api/teacher/ba/attendance/record', {
    method: 'PUT',
    body: {
      sessionId: adhoc.data.id,
      studentId,
      statusId: 'retired',
      operationId: randomUUID(),
    },
  });
  assert.equal(bad.res.status, 400);
});

test('domain: computeMembershipRetroactiveImpact detects roster change', () => {
  const state = migrateLegacyMemberships({
    classes: [{ id: 'c1', name: 'G', scheduleDays: [], scheduleTime: '09:00', createdAt: '2020-01-01T00:00:00.000Z' }],
    students: [{ id: 's1', name: 'Em', classId: 'c1' }],
    memberships: [{
      id: 'm1', classId: 'c1', studentId: 's1', effectiveFrom: '2026-01-01T00:00:00.000Z', effectiveTo: null,
    }],
    classSessions: [{
      id: 'sess1',
      classId: 'c1',
      startAt: localDateTimeToUtcIso('2026-06-02', '19:00'),
      endAt: localDateTimeToUtcIso('2026-06-02', '20:00'),
      status: 'scheduled',
    }],
  });
  const prior = state.memberships[0];
  const next = { ...prior, effectiveFrom: '2026-07-01T00:00:00.000Z' };
  const impact = computeMembershipRetroactiveImpact(state, prior, next, { nowIso: '2026-12-01T00:00:00.000Z' });
  assert.equal(impact.hasImpact, true);
  assert.deepEqual(impact.sessionIds, ['sess1']);
});

test('domain: future session without attendance is not retro impact at injected now 2025', () => {
  const state = migrateLegacyMemberships({
    classes: [{ id: 'c1', name: 'G', scheduleDays: [], scheduleTime: '09:00', createdAt: '2020-01-01T00:00:00.000Z' }],
    students: [{ id: 's1', name: 'Em', classId: 'c1' }],
    memberships: [{
      id: 'm1', classId: 'c1', studentId: 's1', effectiveFrom: '2026-06-01T00:00:00.000Z', effectiveTo: null,
    }],
    classSessions: [{
      id: 'sess-future',
      classId: 'c1',
      startAt: localDateTimeToUtcIso('2026-06-15', '19:00'),
      endAt: localDateTimeToUtcIso('2026-06-15', '20:00'),
      status: 'scheduled',
    }],
    attendanceRecords: [],
  });
  const prior = state.memberships[0];
  const next = { ...prior, effectiveFrom: '2026-07-01T00:00:00.000Z' };
  const impact = computeMembershipRetroactiveImpact(state, prior, next, { nowIso: '2025-01-01T00:00:00.000Z' });
  assert.equal(impact.hasImpact, false);
});

test('domain: future session with saved attendance is retro impact when roster changes', () => {
  const sessionId = 'sess-future-att';
  const state = migrateLegacyMemberships({
    classes: [{ id: 'c1', name: 'G', scheduleDays: [], scheduleTime: '09:00', createdAt: '2020-01-01T00:00:00.000Z' }],
    students: [{ id: 's1', name: 'Em', classId: 'c1' }],
    memberships: [{
      id: 'm1', classId: 'c1', studentId: 's1', effectiveFrom: '2026-06-01T00:00:00.000Z', effectiveTo: null,
    }],
    classSessions: [{
      id: sessionId,
      classId: 'c1',
      startAt: localDateTimeToUtcIso('2026-06-15', '19:00'),
      endAt: localDateTimeToUtcIso('2026-06-15', '20:00'),
      status: 'scheduled',
    }],
    attendanceRecords: [{ sessionId, studentId: 's1', statusId: 'present' }],
  });
  const prior = state.memberships[0];
  const next = { ...prior, effectiveFrom: '2026-07-01T00:00:00.000Z' };
  const impact = computeMembershipRetroactiveImpact(state, prior, next, { nowIso: '2025-01-01T00:00:00.000Z' });
  assert.equal(impact.hasImpact, true);
  assert.deepEqual(impact.sessionIds, [sessionId]);
  assert.deepEqual(impact.attendanceRecordIds, [`${sessionId}:s1`]);
});

test('HTTP: attendanceFutureJune2026 at injected now 2025 returns 200 without retro impact', async (t) => {
  const ctx = await startBaTestServer({ initialNow: '2025-01-01T00:00:00.000Z' });
  t.after(async () => {
    await ctx.close();
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });
  const jar = await teacherSetup(ctx);
  const { classId, studentId } = await seedClassStudent(ctx, jar);
  await backdateOpenMembership(ctx, jar, {
    classId,
    studentId,
    effectiveFrom: '2026-06-01T00:00:00.000Z',
  });
  const startAt = localDateTimeToUtcIso('2026-06-15', '19:00');
  const endAt = localDateTimeToUtcIso('2026-06-15', '20:00');
  const adhoc = await api(ctx.base, jar, '/api/teacher/ba/sessions/adhoc', {
    method: 'PUT',
    body: { classId, startAt, endAt },
  });
  assert.equal(adhoc.res.status, 200);
  const attPut = await api(ctx.base, jar, '/api/teacher/ba/attendance/record', {
    method: 'PUT',
    body: {
      sessionId: adhoc.data.id,
      studentId,
      statusId: 'present',
      operationId: randomUUID(),
    },
  });
  assert.equal(attPut.res.status, 200);
  const data = await loadTeacherData(ctx, jar);
  const mem = data.memberships.find((m) => m.classId === classId && m.studentId === studentId);
  const ok = await api(ctx.base, jar, '/api/teacher/ba/memberships', {
    method: 'PUT',
    body: {
      id: mem.id,
      classId,
      studentId,
      effectiveFrom: '2026-06-05T00:00:00.000Z',
      effectiveTo: null,
      operationId: randomUUID(),
    },
  });
  assert.equal(ok.res.status, 200);
});

test('parseBaRoute includes memberships and catalog', () => {
  assert.equal(parseBaRoute(['tutor', 'memberships']).view, 'tutor-memberships');
  assert.equal(parseBaRoute(['tutor', 'catalog']).view, 'tutor-catalog');
});

function jarCookie(jar) {
  return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
}

/** True Node/browser fetch baseline — always restore here after scoped DOM tests. */
const BASELINE_FETCH = globalThis.fetch;
const BASELINE_DOCUMENT = globalThis.document;

function installScopedSubmitFetchMock(t, { data = {}, meUser = { role: 'teacher', username: 't', mustChangePassword: false } } = {}) {
  const parentFetch = globalThis.fetch;
  globalThis.document = { cookie: 'bn_csrf=test-csrf' };
  globalThis.fetch = async (url, init) => {
    const path = String(url);
    if (path.endsWith('/api/data')) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: async () => ({ data }),
      };
    }
    if (path.endsWith('/api/auth/me')) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: async () => ({ user: meUser }),
      };
    }
    if (parentFetch !== BASELINE_FETCH && parentFetch !== globalThis.fetch) {
      return parentFetch(url, init);
    }
    throw new Error(`unexpected fetch ${path}`);
  };
  t.after(() => {
    globalThis.fetch = BASELINE_FETCH;
    globalThis.document = BASELINE_DOCUMENT;
  });
}

async function flushAsync(times = 12) {
  for (let i = 0; i < times; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test('DOM: parents edit sends existing id on save', async (t) => {
  const serverCtx = await startBaTestServer();
  t.after(async () => {
    await serverCtx.close();
    fs.rmSync(serverCtx.dataDir, { recursive: true, force: true });
  });
  const jar = await teacherSetup(serverCtx);
  installBaBrowserApiFixture(t, serverCtx, jar);
  await fetchMe();
  const created = await api(serverCtx.base, jar, '/api/teacher/ba/parents', {
    method: 'PUT',
    body: { name: 'Mẹ', operationId: randomUUID() },
  });
  assert.equal(created.res.status, 200);
  const parentId = created.data.id;

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
  assert.equal(tryRenderBaView(ctx, { view: 'tutor-parents' }), true);
  const editBtns = findDomNodes(root, (n) => n.tagName === 'BUTTON' && n.textContent === 'Sửa');
  assert.ok(editBtns.length >= 1, 'accessible Sửa button');
  editBtns[0].dispatchEvent({ type: 'click' });
  const nameInputs = findDomNodes(
    root,
    (n) => n.tagName === 'INPUT' && n.getAttribute('aria-label') === 'Họ tên phụ huynh',
  );
  assert.equal(nameInputs[0]?.value, 'Mẹ');
  nameInputs[0].value = 'Mẹ cập nhật';
  nameInputs[0].dispatchEvent({ type: 'input' });
  const saveBtn = findDomNodes(root, (n) => n.tagName === 'BUTTON' && n.textContent === 'Lưu phụ huynh')[0];
  saveBtn.dispatchEvent({ type: 'click' });
  await flushAsync();
  const after = await loadTeacherData(serverCtx, jar);
  const row = after.parents.find((p) => p.id === parentId);
  assert.ok(row);
  assert.equal(row.name, 'Mẹ cập nhật');
  registerDirtyProbe(null);
});

test('aggregated dirty probe across two fields in parents view', (t) => {
  installBaDomEnvironment(t, { confirm: () => true });
  const root = document.getElementById('app-root');
  const ctx = {
    isTeacher: () => true,
    navigate: () => {},
    renderApp: () => {},
    toastOk: () => {},
    toastErr: () => {},
    state: {
      data: {
        classes: [],
        students: [],
        parents: [],
        parentStudentLinks: [],
        memberships: [],
        attendanceStatusCatalog: [],
      },
    },
  };
  tryRenderBaView(ctx, { view: 'tutor-parents' });
  const inputs = findDomNodes(
    root,
    (n) => n.tagName === 'INPUT' && n.getAttribute('aria-label') === 'Họ tên phụ huynh',
  );
  assert.equal(inputs.length, 1);
  inputs[0].value = 'X';
  inputs[0].dispatchEvent({ type: 'input' });
  assert.equal(isGloballyDirty(), true);
  registerDirtyProbe(null);
});

test('aggregated dirty probe spans parent and link forms', (t) => {
  installBaDomEnvironment(t, { confirm: () => true });
  const root = document.getElementById('app-root');
  const ctx = {
    isTeacher: () => true,
    navigate: () => {},
    renderApp: () => {},
    toastOk: () => {},
    toastErr: () => {},
    state: {
      data: {
        classes: [],
        students: [{ id: 's1', name: 'Em' }],
        parents: [{ id: 'p1', name: 'Ba', status: 'active' }],
        parentStudentLinks: [],
        memberships: [],
        attendanceStatusCatalog: [],
      },
    },
  };
  tryRenderBaView(ctx, { view: 'tutor-parents' });
  const nameIn = findDomNodes(
    root,
    (n) => n.tagName === 'INPUT' && n.getAttribute('aria-label') === 'Họ tên phụ huynh',
  )[0];
  const relIn = findDomNodes(
    root,
    (n) => n.tagName === 'INPUT' && n.getAttribute('aria-label') === 'Quan hệ',
  )[0];
  assert.ok(nameIn && relIn);
  nameIn.value = 'Ba mới';
  nameIn.dispatchEvent({ type: 'input' });
  relIn.value = 'Bố';
  relIn.dispatchEvent({ type: 'input' });
  assert.equal(isGloballyDirty(), true);
  registerDirtyProbe(null);
});

test('runBaScopedSubmit: rapid double submit performs one write', async (t) => {
  installScopedSubmitFetchMock(t);
  installBaDomEnvironment(t);
  await fetchMe();
  const scope = beginBaViewScope();
  t.after(() => scope.dispose());
  let writes = 0;
  let releaseWrite;
  const writeGate = new Promise((resolve) => { releaseWrite = resolve; });
  const field = document.createElement('input');
  field.type = 'text';
  field.value = 'keep';
  const btn = document.createElement('button');
  btn.textContent = 'Lưu';
  const dirty = registerBaViewDirty(scope, [field]);
  const ctx = { toastOk() {}, toastErr() {}, state: { data: {} }, renderApp() {} };
  const opts = {
    guardKey: 'test-double',
    btn,
    fields: [field],
    buttons: [btn],
    dirtyProbe: dirty,
    readPayload: () => ({ value: field.value }),
    write: async () => {
      writes += 1;
      await writeGate;
    },
    successMessage: 'ok',
  };
  const p1 = runBaScopedSubmit(ctx, scope, opts);
  const p2 = runBaScopedSubmit(ctx, scope, opts);
  await flushAsync(4);
  releaseWrite();
  await Promise.all([p1, p2]);
  assert.equal(writes, 1);
});

test('runBaScopedSubmit: failed save keeps field values and stable operationId', async (t) => {
  installScopedSubmitFetchMock(t);
  installBaDomEnvironment(t);
  await fetchMe();
  const scope = beginBaViewScope();
  t.after(() => scope.dispose());
  const field = document.createElement('input');
  field.type = 'text';
  field.value = 'alpha';
  const btn = document.createElement('button');
  btn.textContent = 'Lưu';
  const dirty = registerBaViewDirty(scope, [field]);
  const ctx = { toastOk() {}, toastErr() {}, state: { data: {} }, renderApp() {} };
  const readPayload = () => ({ value: field.value });
  const id1 = resolveBaOperationId('fail-key', readPayload());
  const result = await runBaScopedSubmit(ctx, scope, {
    guardKey: 'fail-key',
    btn,
    fields: [field],
    buttons: [btn],
    dirtyProbe: dirty,
    readPayload,
    write: async () => {
      throw new Error('save failed');
    },
    successMessage: 'ok',
  });
  assert.equal(result.ok, false);
  assert.equal(field.value, 'alpha');
  const id2 = resolveBaOperationId('fail-key', readPayload());
  assert.equal(id2, id1);
  ackBaOperation('fail-key');
});

test('runBaScopedSubmit: post-save edit before ack keeps dirty state', async (t) => {
  installScopedSubmitFetchMock(t);
  installBaDomEnvironment(t);
  await fetchMe();
  const scope = beginBaViewScope();
  t.after(() => scope.dispose());
  const field = document.createElement('input');
  field.type = 'text';
  field.value = '';
  const btn = document.createElement('button');
  const dirty = registerBaViewDirty(scope, [field]);
  field.value = 'v1';
  field.dispatchEvent({ type: 'input' });
  assert.equal(dirty(), true);
  let releaseWrite;
  const writeGate = new Promise((resolve) => { releaseWrite = resolve; });
  let captured;
  const renderCalls = [];
  const ctx = {
    toastOk() {},
    toastErr() {},
    state: { data: {} },
    renderApp() { renderCalls.push(1); },
  };
  const readPayload = () => ({ value: field.value });
  const pending = runBaScopedSubmit(ctx, scope, {
    guardKey: 'ack-key',
    btn,
    fields: [field],
    buttons: [btn],
    dirtyProbe: dirty,
    readPayload,
    write: async (body) => {
      captured = body.value;
      await writeGate;
    },
    successMessage: 'ok',
  });
  await flushAsync(2);
  assert.equal(captured, 'v1');
  field.value = 'v2';
  field.dispatchEvent({ type: 'input' });
  releaseWrite();
  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal(result.matchesSnapshot, false);
  assert.equal(field.value, 'v2');
  assert.equal(isGloballyDirty(), true);
  assert.equal(renderCalls.length, 0);
});

test('runBaScopedSubmit: auxiliary buttons unlock after save', async (t) => {
  installScopedSubmitFetchMock(t);
  installBaDomEnvironment(t);
  await fetchMe();
  const scope = beginBaViewScope();
  t.after(() => scope.dispose());
  let releaseWrite;
  const writeGate = new Promise((resolve) => { releaseWrite = resolve; });
  const field = document.createElement('input');
  field.value = 'a';
  const saveBtn = document.createElement('button');
  const auxBtn = document.createElement('button');
  auxBtn.textContent = 'Phụ';
  const dirty = registerBaViewDirty(scope, [field]);
  const ctx = { toastOk() {}, toastErr() {}, state: { data: {} }, renderApp() {} };
  const pending = runBaScopedSubmit(ctx, scope, {
    guardKey: 'aux-unlock',
    btn: saveBtn,
    fields: [field],
    buttons: [saveBtn, auxBtn],
    dirtyProbe: dirty,
    readPayload: () => ({ value: field.value }),
    write: async () => { await writeGate; },
    successMessage: 'ok',
  });
  await flushAsync(2);
  assert.equal(auxBtn.disabled, true);
  assert.equal(auxBtn.dataset.baLocked, '1');
  releaseWrite();
  await pending;
  assert.equal(auxBtn.disabled, false);
  assert.equal(auxBtn.dataset.baLocked, undefined);
});

test('runBaScopedSubmit: inherently disabled fields stay disabled after save', async (t) => {
  installScopedSubmitFetchMock(t);
  installBaDomEnvironment(t);
  await fetchMe();
  const scope = beginBaViewScope();
  t.after(() => scope.dispose());
  const lockedField = document.createElement('input');
  lockedField.disabled = true;
  lockedField.value = 'readonly';
  const editable = document.createElement('input');
  editable.value = 'edit';
  const btn = document.createElement('button');
  const dirty = registerBaViewDirty(scope, [lockedField, editable]);
  const ctx = { toastOk() {}, toastErr() {}, state: { data: {} }, renderApp() {} };
  await runBaScopedSubmit(ctx, scope, {
    guardKey: 'inherent-disabled',
    btn,
    fields: [lockedField, editable],
    buttons: [btn],
    dirtyProbe: dirty,
    readPayload: () => ({ locked: lockedField.value, edit: editable.value }),
    write: async () => {},
    successMessage: 'ok',
  });
  assert.equal(lockedField.disabled, true);
  assert.equal(editable.disabled, false);
});

test('runBaScopedSubmit: reload failure retries without replaying mutation', async (t) => {
  installScopedSubmitFetchMock(t);
  installBaDomEnvironment(t);
  await fetchMe();
  const scope = beginBaViewScope();
  t.after(() => scope.dispose());
  let dataFetches = 0;
  const scopedFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const path = String(url);
    if (path.endsWith('/api/data')) {
      dataFetches += 1;
      if (dataFetches === 1) {
        return { ok: false, status: 500, headers: { get: () => 'application/json' }, json: async () => ({}) };
      }
    }
    return scopedFetch(url, init);
  };

  let writes = 0;
  const field = document.createElement('input');
  field.value = 'same';
  const btn = document.createElement('button');
  const dirty = registerBaViewDirty(scope, [field]);
  const ctx = { toastOk() {}, toastErr() {}, state: { data: {} }, renderApp() {} };
  const readPayload = () => ({ value: field.value });
  const firstOp = resolveBaOperationId('reload-key', readPayload());
  const fail = await runBaScopedSubmit(ctx, scope, {
    guardKey: 'reload-key',
    btn,
    fields: [field],
    buttons: [btn],
    dirtyProbe: dirty,
    readPayload,
    write: async () => { writes += 1; },
    successMessage: 'ok',
  });
  assert.equal(fail.reloadFailed, true);
  assert.equal(writes, 1);
  const afterAckOp = resolveBaOperationId('reload-key', readPayload());
  assert.notEqual(afterAckOp, firstOp);

  const retry = await runBaScopedSubmit(ctx, scope, {
    guardKey: 'reload-key',
    btn,
    fields: [field],
    buttons: [btn],
    dirtyProbe: dirty,
    readPayload,
    write: async () => { writes += 1; },
    successMessage: 'ok',
  });
  assert.equal(retry.ok, true);
  assert.equal(writes, 1);

  field.value = 'changed';
  const changedOp = resolveBaOperationId('reload-key', readPayload());
  assert.notEqual(changedOp, afterAckOp);
  await runBaScopedSubmit(ctx, scope, {
    guardKey: 'reload-key',
    btn,
    fields: [field],
    buttons: [btn],
    dirtyProbe: dirty,
    readPayload,
    write: async () => { writes += 1; },
    successMessage: 'ok',
  });
  assert.equal(writes, 2);
});

test('runBaScopedSubmit: disposed view scope ignores late reload success', async (t) => {
  installScopedSubmitFetchMock(t);
  installBaDomEnvironment(t);
  await fetchMe();
  const scope = beginBaViewScope();
  const gen = scope.generation;
  assert.ok(typeof gen === 'number');
  const scope2 = beginBaViewScope();
  assert.ok(scope2.generation > gen);
  t.after(() => scope2.dispose());

  let releaseWrite;
  const writeGate = new Promise((resolve) => { releaseWrite = resolve; });
  const field = document.createElement('input');
  field.value = 'z';
  const renderCalls = [];
  const ctx = {
    toastOk() {},
    toastErr() {},
    state: { data: {} },
    renderApp() { renderCalls.push(1); },
  };
  const pending = runBaScopedSubmit(ctx, scope, {
    guardKey: 'disposed-scope',
    fields: [field],
    readPayload: () => ({ value: field.value }),
    write: async () => { await writeGate; },
    successMessage: 'saved',
  });
  await flushAsync(2);
  releaseWrite();
  const result = await pending;
  assert.equal(result.stale, true);
  assert.equal(renderCalls.length, 0);
});

test('runBaScopedSubmit: success toast notes remaining edits when snapshot diverges', async (t) => {
  installScopedSubmitFetchMock(t);
  installBaDomEnvironment(t);
  await fetchMe();
  const scope = beginBaViewScope();
  t.after(() => scope.dispose());
  let releaseWrite;
  const writeGate = new Promise((resolve) => { releaseWrite = resolve; });
  const field = document.createElement('input');
  field.value = 'v1';
  const dirty = registerBaViewDirty(scope, [field]);
  const toasts = [];
  const ctx = {
    toastOk: (m) => toasts.push(m),
    toastErr() {},
    state: { data: {} },
    renderApp() {},
  };
  const pending = runBaScopedSubmit(ctx, scope, {
    guardKey: 'toast-key',
    fields: [field],
    dirtyProbe: dirty,
    readPayload: () => ({ value: field.value }),
    write: async () => { await writeGate; },
    successMessage: 'Đã lưu',
  });
  await flushAsync(2);
  field.value = 'v2';
  field.dispatchEvent({ type: 'input' });
  releaseWrite();
  await pending;
  assert.ok(toasts.some((m) => m.includes('còn thay đổi')));
});

test('runBaScopedSubmit: stale epoch skips success reload side effects', async (t) => {
  installScopedSubmitFetchMock(t);
  installBaDomEnvironment(t);
  await fetchMe();
  const scope = beginBaViewScope();
  t.after(() => scope.dispose());
  const field = document.createElement('input');
  field.value = 'z';
  const errors = [];
  const ctx = {
    toastOk() {},
    toastErr: (m) => errors.push(m),
    state: { data: {} },
    renderApp() {
      throw new Error('renderApp should not run when stale');
    },
  };
  const result = await runBaScopedSubmit(ctx, scope, {
    guardKey: 'stale-key',
    fields: [field],
    readPayload: () => ({ value: field.value }),
    write: async () => {
      bumpRequestEpoch();
    },
    successMessage: 'saved',
  });
  assert.equal(result.stale, true);
  assert.equal(errors.length, 0);
});

test('installScopedSubmitFetchMock restores global fetch baseline', async (t) => {
  installScopedSubmitFetchMock(t);
  assert.notEqual(globalThis.fetch, BASELINE_FETCH);
  await flushAsync(1);
});

test('global fetch remains baseline for HTTP after scoped DOM tests', () => {
  assert.equal(globalThis.fetch, BASELINE_FETCH);
});

test('HTTP: membership rejoin opens a new interval after end', async (t) => {
  const ctx = await startBaTestServer();
  t.after(async () => {
    await ctx.close();
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });
  const jar = await teacherSetup(ctx);
  const { classId, studentId } = await seedClassStudent(ctx, jar);
  let data = await loadTeacherData(ctx, jar);
  const open = data.memberships.find((m) => m.classId === classId && m.studentId === studentId && !m.effectiveTo);
  assert.ok(open);
  const ended = await api(ctx.base, jar, '/api/teacher/ba/memberships', {
    method: 'PUT',
    body: {
      id: open.id,
      classId,
      studentId,
      effectiveFrom: open.effectiveFrom,
      effectiveTo: '2026-03-01T00:00:00.000Z',
      operationId: randomUUID(),
    },
  });
  assert.equal(ended.res.status, 200);
  const rejoin = await api(ctx.base, jar, '/api/teacher/ba/memberships', {
    method: 'PUT',
    body: {
      classId,
      studentId,
      effectiveFrom: '2026-04-01T00:00:00.000Z',
      effectiveTo: null,
      operationId: randomUUID(),
    },
  });
  assert.equal(rejoin.res.status, 200);
  data = await loadTeacherData(ctx, jar);
  const forPair = data.memberships.filter((m) => m.classId === classId && m.studentId === studentId);
  assert.equal(forPair.length, 2);
  assert.ok(forPair.some((m) => m.effectiveTo === '2026-03-01T00:00:00.000Z'));
  assert.ok(forPair.some((m) => !m.effectiveTo && m.effectiveFrom === '2026-04-01T00:00:00.000Z'));
});

test('HTTP: one-to-one class rejects overlapping full-interval membership', async (t) => {
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
  const second = await api(ctx.base, jar, '/api/teacher/record/students', {
    method: 'PUT',
    body: { id: s2, name: 'HS 2', classId },
  });
  assert.equal(second.res.status, 400);
});

test('HTTP: membership audit history retains reason label', async (t) => {
  const ctx = await startBaTestServer();
  t.after(async () => {
    await ctx.close();
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });
  const jar = await teacherSetup(ctx);
  const { classId, studentId } = await seedClassStudent(ctx, jar);
  await backdateOpenMembership(ctx, jar, {
    classId,
    studentId,
    effectiveFrom: '2026-06-01T00:00:00.000Z',
  });
  const startAt = localDateTimeToUtcIso('2026-06-15', '19:00');
  const endAt = localDateTimeToUtcIso('2026-06-15', '20:00');
  const adhoc = await api(ctx.base, jar, '/api/teacher/ba/sessions/adhoc', {
    method: 'PUT',
    body: { classId, startAt, endAt },
  });
  assert.equal(adhoc.res.status, 200);
  const data = await loadTeacherData(ctx, jar);
  const mem = data.memberships.find((m) => m.classId === classId && m.studentId === studentId);
  const ok = await api(ctx.base, jar, '/api/teacher/ba/memberships', {
    method: 'PUT',
    body: {
      id: mem.id,
      classId,
      studentId,
      effectiveFrom: '2026-07-01T00:00:00.000Z',
      effectiveTo: null,
      confirmImpact: true,
      reason: 'Nhãn lịch sử kiểm tra',
      operationId: randomUUID(),
    },
  });
  assert.equal(ok.res.status, 200);
  const after = await loadTeacherData(ctx, jar);
  const entry = after.membershipAudit?.at(-1);
  assert.ok(entry);
  assert.equal(entry.reason, 'Nhãn lịch sử kiểm tra');
  assert.ok(entry.action);
});

test('HTTP: membership identity move rejected', async (t) => {
  const ctx = await startBaTestServer();
  t.after(async () => {
    await ctx.close();
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });
  const jar = await teacherSetup(ctx);
  const { classId, studentId } = await seedClassStudent(ctx, jar);
  const c2 = randomUUID();
  await api(ctx.base, jar, '/api/teacher/record/classes', {
    method: 'PUT',
    body: { id: c2, name: 'C2', scheduleDays: ['Tue'], scheduleTime: '18:00' },
  });
  const data = await loadTeacherData(ctx, jar);
  const mem = data.memberships.find((m) => m.classId === classId && m.studentId === studentId);
  const bad = await api(ctx.base, jar, '/api/teacher/ba/memberships', {
    method: 'PUT',
    body: {
      id: mem.id,
      classId: c2,
      studentId,
      effectiveFrom: mem.effectiveFrom,
      operationId: randomUUID(),
    },
  });
  assert.equal(bad.res.status, 400);
});
