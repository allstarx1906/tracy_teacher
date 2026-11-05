import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { localDateTimeToUtcIso } from '../dist/ba-domain.js';
import { tryRenderBaView, parseBaRoute } from '../dist/ba-ui.js';
import { registerDirtyProbe, isGloballyDirty } from '../dist/ux-forms.js';
import {
  startBaTestServer,
  teacherSetup,
  loadTeacherData,
  installBaBrowserApiFixture,
  seedClassStudent,
  backdateOpenMembership,
  api,
} from './ba-test-helpers.mjs';
import {
  installBaDomEnvironment,
  findDomNodes,
  aggregateDomTextContent,
  domElementClassName,
  domElementIsHidden,
  fixedUtc7NoonIso,
  installFixedUtc7TestClock,
  waitForReportsLoad,
} from './helper-browser-window.mjs';
import fs from 'node:fs';

function jarCookie(jar) {
  return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
}

function classIncludes(node, token) {
  return domElementClassName(node).split(/\s+/).includes(token);
}

function findStudentDetailButton(root, studentId) {
  return findDomNodes(
    root,
    (n) => n.tagName === 'BUTTON'
      && n.getAttribute?.('data-action') === 'detail'
      && n.getAttribute?.('data-student-id') === studentId,
  )[0];
}

function findReportsDetailPanel(root) {
  return findDomNodes(root, (n) => classIncludes(n, 'ba-reports-detail'))[0];
}

test('reports view: auto load, no dirty on filter change, detail action', async (t) => {
  const anchorDate = '2026-06-15';
  const serverNow = fixedUtc7NoonIso(anchorDate);
  const ctx = await startBaTestServer({ initialNow: serverNow });
  t.after(async () => {
    await ctx.close();
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });
  const jar = await teacherSetup(ctx);
  const { classId, studentId } = await seedClassStudent(ctx, jar, { studentName: 'HS Reports UX' });
  await backdateOpenMembership(ctx, jar, {
    classId,
    studentId,
    effectiveFrom: '2020-01-01T00:00:00.000Z',
  });
  const startAt = localDateTimeToUtcIso('2026-06-10', '19:00');
  const endAt = localDateTimeToUtcIso('2026-06-10', '20:00');
  const adhoc = await api(ctx.base, jar, '/api/teacher/ba/sessions/adhoc', {
    method: 'PUT',
    body: { classId, startAt, endAt, operationId: randomUUID(), confirmOverlap: true },
  });
  assert.equal(adhoc.res.status, 200);

  installBaBrowserApiFixture(t, ctx, jar);
  installBaDomEnvironment(t, { cookie: jarCookie(jar) });
  installFixedUtc7TestClock(t, anchorDate);

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
  assert.ok(aggregateDomTextContent(root).includes('Báo cáo điểm danh'));

  await waitForReportsLoad(root);

  const tableWrap = findDomNodes(root, (n) => classIncludes(n, 'ba-reports-table-wrap'))[0];
  assert.ok(tableWrap, 'student table host should exist after load');
  assert.equal(domElementIsHidden(tableWrap), false, 'student table should be visible after load');

  const studentRow = findDomNodes(
    root,
    (n) => n.tagName === 'TR' && n.getAttribute?.('data-student-id') === studentId,
  )[0];
  assert.ok(studentRow, 'seeded student should appear in the report table');
  assert.ok(aggregateDomTextContent(studentRow).includes('HS Reports UX'));

  let detailBtn = findStudentDetailButton(root, studentId);
  assert.ok(detailBtn, 'student row should expose Chi tiết');
  detailBtn.dispatchEvent({ type: 'click' });
  let detail = findReportsDetailPanel(root);
  assert.ok(detail);
  assert.equal(domElementIsHidden(detail), false, 'detail panel should open before filter draft change');

  const classSel = findDomNodes(root, (n) => n.tagName === 'SELECT' && classIncludes(n, 'ba-reports-class-select'))[0];
  assert.ok(classSel);
  registerDirtyProbe(null);
  classSel.value = classId;
  classSel.dispatchEvent({ type: 'change' });
  assert.equal(isGloballyDirty(), false, 'report filters must not register view dirty');
  registerDirtyProbe(null);

  const banner = findDomNodes(root, (n) => classIncludes(n, 'ba-reports-draft-banner'))[0];
  assert.ok(banner);
  assert.equal(domElementIsHidden(banner), false, 'draft banner should show when filters differ from applied');

  assert.equal(domElementIsHidden(tableWrap), true, 'stale table hidden while draft is dirty');

  const loadBtn = findDomNodes(
    root,
    (n) => n.tagName === 'BUTTON' && n.getAttribute?.('data-action') === 'load-report',
  )[0];
  assert.ok(loadBtn);
  loadBtn.dispatchEvent({ type: 'click' });
  await waitForReportsLoad(root);
  assert.equal(domElementIsHidden(tableWrap), false, 'table visible after applying filters');

  detailBtn = findStudentDetailButton(root, studentId);
  assert.ok(detailBtn, 'student still listed after refilter');
  detailBtn.dispatchEvent({ type: 'click' });
  detail = findReportsDetailPanel(root);
  assert.ok(detail);
  assert.equal(domElementIsHidden(detail), false, 'detail panel opens on refiltered report');
});
