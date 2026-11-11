import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
  startBaTestServer,
  api,
  teacherSetup,
} from './ba-test-helpers.mjs';
import {
  buildSampleExamPdf,
  buildRasterImageOnlyPdf,
} from './exam-fixtures.mjs';
import {
  EXAM_DELIVERY_MODE,
  validateDraftForPublish,
} from '../dist/exam-domain.js';
import { installBaDomEnvironment, findDomNodes, aggregateDomTextContent } from './helper-browser-window.mjs';
import { renderExamAssignView } from '../dist/exam-ui-teacher.js';

async function uploadPdf(base, jar, buffer, name = 'sheet.pdf') {
  const res = await fetch(`${base}/api/teacher/attachments`, {
    method: 'POST',
    headers: {
      cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; '),
      'content-type': 'application/pdf',
      'x-bn-csrf': jar.bn_csrf,
      'x-bn-filename': encodeURIComponent(name),
    },
    body: buffer,
  });
  const data = await res.json();
  assert.equal(res.status, 200, JSON.stringify(data));
  return data.id;
}

async function setupClass(ctx, tJar) {
  const classId = randomUUID();
  await api(ctx.base, tJar, '/api/teacher/record/classes', {
    method: 'PUT',
    body: {
      id: classId,
      name: 'Lớp C1',
      scheduleDays: ['Thứ 2'],
      scheduleTime: '18:00',
      createdAt: '2025-01-01T00:00:00.000Z',
    },
  });
  return classId;
}

test('pdf-only draft with needsOcr can publish', () => {
  const draft = {
    title: 'Scan',
    sourceAttachmentId: 'att',
    explicitPdfOnly: true,
    questions: [],
    needsOcr: true,
    needsOcrPageNumbers: [1],
    teacherConfirmedReview: true,
    needsReview: false,
  };
  const v = validateDraftForPublish(draft);
  assert.equal(v.ok, true);
  assert.equal(v.pdfOnly, true);
});

test('API: pdf-only digital upload publish assign', async (t) => {
  const ctx = await startBaTestServer({ initialNow: '2025-06-01T12:00:00.000Z' });
  t.after(async () => {
    await ctx.close();
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });
  const tJar = await teacherSetup(ctx);
  const attId = await uploadPdf(ctx.base, tJar, buildSampleExamPdf());
  const created = await api(ctx.base, tJar, '/api/teacher/exams/pdf-only-drafts', {
    method: 'POST',
    body: { sourceAttachmentId: attId, title: 'PDF only digital' },
  });
  assert.equal(created.res.status, 200, created.data?.error);
  const draftId = created.data.draftId;
  const bankExamId = created.data.bankExamId;
  assert.ok(bankExamId);

  const pub = await api(ctx.base, tJar, `/api/teacher/exams/drafts/${draftId}/publish`, { method: 'POST', body: {} });
  assert.equal(pub.res.status, 200, pub.data?.error);
  const versionId = pub.data.versionId;

  const bank = await api(ctx.base, tJar, `/api/teacher/exams/banks/${bankExamId}`);
  assert.equal(bank.res.status, 200);
  assert.equal(bank.data.bank.activeVersionId, versionId);

  const classId = await setupClass(ctx, tJar);
  const assign = await api(ctx.base, tJar, '/api/teacher/exams/assignments', {
    method: 'POST',
    body: {
      versionId,
      classId,
      title: 'PDF assign',
      openAt: '2025-06-01T10:00:00.000Z',
      dueAt: '2025-06-02T10:00:00.000Z',
      timeLimitMinutes: 30,
      attemptLimit: 1,
      deliveryMode: EXAM_DELIVERY_MODE.PDF,
    },
  });
  assert.equal(assign.res.status, 200, assign.data?.error);

  const revise = await api(ctx.base, tJar, `/api/teacher/exams/versions/${versionId}/revise`, { method: 'POST', body: {} });
  assert.equal(revise.res.status, 200);
  assert.equal(revise.data.bankExamId, bankExamId);
});

test('API: scan pdf-only needsOcr still publishes', async (t) => {
  const ctx = await startBaTestServer({ initialNow: '2025-06-01T12:00:00.000Z' });
  t.after(async () => {
    await ctx.close();
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });
  const tJar = await teacherSetup(ctx);
  const attId = await uploadPdf(ctx.base, tJar, buildRasterImageOnlyPdf(), 'scan.pdf');
  const created = await api(ctx.base, tJar, '/api/teacher/exams/pdf-only-drafts', {
    method: 'POST',
    body: { sourceAttachmentId: attId, title: 'Scan PDF', needsOcr: true, needsOcrPageNumbers: [1] },
  });
  assert.equal(created.res.status, 200);
  const pub = await api(ctx.base, tJar, `/api/teacher/exams/drafts/${created.data.draftId}/publish`, { method: 'POST', body: {} });
  assert.equal(pub.res.status, 200, pub.data?.error);
});

test('assign form exposes mandatory delivery controls', async (t) => {
  const dom = installBaDomEnvironment(t);
  const root = dom.root || document.getElementById('app-root');
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (typeof root?.__examDispose === 'function') {
      root.__examDispose();
      delete root.__examDispose;
    }
  });
  const ctx = {
    isTeacher: () => true,
    navigate: () => {},
    toastErr: () => {},
    toastOk: () => {},
    state: { data: { classes: [{ id: 'c1', name: 'Lớp' }] } },
  };
  globalThis.fetch = async (url) => {
    if (String(url).includes('/student-preview')) {
      return {
        ok: true,
        headers: { get: () => 'application/json' },
        json: async () => ({
          ok: true,
          exam: { title: 'Mix', versionId: 'v1', sections: [], passages: [], questions: [{ id: 'q1', displayNumber: '1', stemText: 'Q' }] },
          version: { id: 'v1', sourceAttachmentId: 'att', sourcePdfPageCount: 2, pdfOnly: false, audioState: 'pending' },
        }),
      };
    }
    throw new Error(url);
  };
  renderExamAssignView(ctx, root, 'v1');
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(root.querySelector('[data-exam-assign-delivery-fieldset]'));
  assert.ok(root.querySelector('[data-exam-assign-review-summary]'));
  assert.ok(findDomNodes(root, (n) => n.getAttribute?.('data-exam-action') === 'assign-from-bank').length === 0);
  assert.ok(aggregateDomTextContent(root).includes('Chế độ giao bài'));
});
