import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAppRoute } from '../dist/ux-app-route.js';
import { splitAppHashPathAndQuery } from '../dist/ux-hash-navigation.js';
import { EXAM_ASSIGNMENT_PURPOSE } from '../dist/exam-domain.js';
import { tryRenderExamView } from '../dist/exam-ui.js';
import {
  installBaDomEnvironment,
  findDomNodes,
  domNodeAttributeValue,
} from './helper-browser-window.mjs';

test('splitAppHashPathAndQuery separates path segments from query', () => {
  assert.deepEqual(
    splitAppHashPathAndQuery('#/exams/assign/v-uuid?purpose=homework'),
    { path: '/exams/assign/v-uuid', query: 'purpose=homework' },
  );
  assert.deepEqual(
    splitAppHashPathAndQuery('/exams/grade/a1?attemptId=t2'),
    { path: '/exams/grade/a1', query: 'attemptId=t2' },
  );
  assert.deepEqual(splitAppHashPathAndQuery('#'), { path: '/dashboard', query: '' });
});

test('parseAppRoute strips query from exam assign and grade IDs', () => {
  const assign = parseAppRoute('#/exams/assign/version-abc?purpose=homework');
  assert.equal(assign.view, 'exams-assign');
  assert.equal(assign.versionId, 'version-abc');
  assert.equal('purpose' in assign, false);

  const assignResult = parseAppRoute('#/exams/assign/version-abc?assignment=asgn-99');
  assert.equal(assignResult.versionId, 'version-abc');

  const grade = parseAppRoute('#/exams/grade/grd-1?attemptId=att-2');
  assert.equal(grade.view, 'exams-grade');
  assert.equal(grade.assignmentId, 'grd-1');
});

test('parseAppRoute homework assign hash drives preview fetch with bare version id', async (t) => {
  installBaDomEnvironment(t, { cookie: 'bn_csrf=ui-test-csrf' });
  const root = document.getElementById('app-root');
  const versionId = 'clean-version-id';
  const fetchUrls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    fetchUrls.push(String(url));
    if (String(url).includes('/student-preview')) {
      return {
        ok: true,
        headers: { get: () => 'application/json' },
        json: async () => ({
          ok: true,
          exam: {
            versionId,
            title: 'Đề',
            sections: [],
            passages: [],
            questions: [{ id: 'q1', displayNumber: '1', stemText: 'One', options: [] }],
          },
        }),
      };
    }
    return {
      ok: true,
      headers: { get: () => 'application/json' },
      json: async () => ({ ok: true }),
    };
  };
  const originalLocation = globalThis.location;
  globalThis.location = {
    ...originalLocation,
    hash: `#/exams/assign/${versionId}?purpose=${EXAM_ASSIGNMENT_PURPOSE.HOMEWORK}`,
  };
  try {
    const route = parseAppRoute(globalThis.location.hash);
    assert.equal(route.versionId, versionId);
    const ctx = {
      isTeacher: () => true,
      navigate: () => {},
      toastOk: () => {},
      toastErr: (m) => { throw new Error(m); },
      state: { data: { classes: [{ id: 'c1', name: 'Lớp A' }] } },
    };
    tryRenderExamView(ctx, route);
    await new Promise((r) => setTimeout(r, 0));
    const previewUrl = fetchUrls.find((u) => u.includes('/student-preview'));
    assert.ok(previewUrl, 'expected student-preview fetch');
    assert.ok(previewUrl.includes(`/versions/${encodeURIComponent(versionId)}/student-preview`));
    assert.equal(previewUrl.includes('?'), false);
    assert.equal(previewUrl.includes('%3F'), false);
    const hwRadio = findDomNodes(root, (n) => n.id === 'exam-assign-purpose-hw')[0];
    assert.ok(hwRadio?.checked, 'homework purpose radio should be selected from hash query');
    const summary = findDomNodes(root, (n) => domNodeAttributeValue(n, 'data-exam-selection-summary') != null)[0];
    assert.match(summary?.textContent || '', /1\/1/);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.location = originalLocation;
  }
});
