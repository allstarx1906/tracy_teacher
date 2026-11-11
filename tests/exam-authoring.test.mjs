import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
  startBaTestServer,
  api,
  teacherSetup,
  loadTeacherData,
  studentLoginAfterPasswordChange,
} from './ba-test-helpers.mjs';
import { createStore } from '../server/store.mjs';
import {
  buildSampleExamPdf,
  waitForImportJob,
} from './exam-fixtures.mjs';
import {
  validateDraftForPublish,
  EXAM_GRADING_MODE,
} from '../dist/exam-domain.js';

async function uploadPdf(base, jar, buffer) {
  const res = await fetch(`${base}/api/teacher/attachments`, {
    method: 'POST',
    headers: {
      cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; '),
      'content-type': 'application/pdf',
      'x-bn-csrf': jar.bn_csrf,
      'x-bn-filename': encodeURIComponent('exam.pdf'),
    },
    body: buffer,
  });
  const data = await res.json();
  assert.equal(res.status, 200, data.error);
  return data.id;
}

async function importAndPublish(ctx, tJar) {
  const attId = await uploadPdf(ctx.base, tJar, buildSampleExamPdf());
  const started = await api(ctx.base, tJar, '/api/teacher/exams/imports', {
    method: 'POST',
    body: { sourceAttachmentId: attId, keyPages: [2], title: 'Nguồn soạn' },
  });
  const job = await waitForImportJob(ctx.base, tJar, started.data.jobId);
  const draftRes = await api(ctx.base, tJar, `/api/teacher/exams/drafts/${job.draftId}`);
  const draft = draftRes.data.draft;
  await api(ctx.base, tJar, `/api/teacher/exams/drafts/${draft.id}`, {
    method: 'PUT',
    body: {
      title: draft.title,
      questions: draft.questions,
      passages: draft.passages,
      sections: draft.sections,
      teacherConfirmedReview: true,
      baseRevision: draft.revision,
    },
  });
  const pub = await api(ctx.base, tJar, `/api/teacher/exams/drafts/${draft.id}/publish`, {
    method: 'POST',
    body: {},
  });
  return {
    versionId: pub.data.versionId,
    sourceDraft: draft,
  };
}

test('authoring: compose two questions remaps shared group and leaves source unchanged', async (t) => {
  const ctx = await startBaTestServer({ initialNow: '2025-06-01T10:00:00.000Z' });
  t.after(async () => {
    await ctx.close();
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });
  const tJar = await teacherSetup(ctx);
  const { versionId, sourceDraft } = await importAndPublish(ctx, tJar);
  const qIds = sourceDraft.questions.slice(0, 2).map((q) => q.id);
  const sourceBefore = JSON.stringify(sourceDraft.questions);

  const created = await api(ctx.base, tJar, '/api/teacher/exams/drafts', {
    method: 'POST',
    body: { sourceVersionId: versionId, questionIds: qIds, title: 'Bản soạn' },
  });
  assert.equal(created.res.status, 200, created.data.error);
  const newDraftId = created.data.draftId;
  assert.ok(newDraftId);

  const draftRes = await api(ctx.base, tJar, `/api/teacher/exams/drafts/${newDraftId}`);
  const composed = draftRes.data.draft;
  assert.equal(composed.questions.length, 2);
  assert.notEqual(composed.questions[0].id, qIds[0]);
  assert.equal(composed.questions[0].sourceQuestionId, qIds[0]);
  assert.ok(composed.questions[0].originalDisplayNumber);
  assert.ok(composed.questions[0].correctOptionId);
  const groupIds = new Set(composed.questions.map((q) => q.passageId).filter(Boolean));
  assert.equal(groupIds.size, 1);
  assert.equal(composed.passages.length, 1);
  assert.notEqual(composed.passages[0].id, sourceDraft.passages[0]?.id);
  const grp = composed.passages[0];
  if (grp.sectionId) {
    assert.ok(composed.questions.every((q) => q.sectionId === grp.sectionId));
  }

  const sourceAfterRes = await api(ctx.base, tJar, `/api/teacher/exams/drafts/${sourceDraft.id}`);
  assert.equal(JSON.stringify(sourceAfterRes.data.draft.questions), sourceBefore);
});

test('authoring: blank draft saves without class and publish needs validation not class', async (t) => {
  const ctx = await startBaTestServer({ initialNow: '2025-06-01T10:00:00.000Z' });
  t.after(async () => {
    await ctx.close();
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });
  const tJar = await teacherSetup(ctx);
  const created = await api(ctx.base, tJar, '/api/teacher/exams/drafts', {
    method: 'POST',
    body: { blank: true, title: 'Nháp trống' },
  });
  assert.equal(created.res.status, 200);
  const draftId = created.data.draftId;
  const got = await api(ctx.base, tJar, `/api/teacher/exams/drafts/${draftId}`);
  const sections = got.data.draft.sections;
  const put = await api(ctx.base, tJar, `/api/teacher/exams/drafts/${draftId}`, {
    method: 'PUT',
    body: {
      title: 'Nháp trống',
      questions: [],
      passages: [],
      sections,
      baseRevision: got.data.draft.revision,
    },
  });
  assert.equal(put.res.status, 200);
  const pub = await api(ctx.base, tJar, `/api/teacher/exams/drafts/${draftId}/publish`, {
    method: 'POST',
    body: {},
  });
  assert.equal(pub.res.status, 400);
});

test('authoring: rejects foreign question ids and non-owner source', async (t) => {
  const ctx = await startBaTestServer({ initialNow: '2025-06-01T10:00:00.000Z' });
  t.after(async () => {
    await ctx.close();
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });
  const tJar = await teacherSetup(ctx);
  const { versionId, sourceDraft } = await importAndPublish(ctx, tJar);
  const bad = await api(ctx.base, tJar, '/api/teacher/exams/drafts', {
    method: 'POST',
    body: { sourceVersionId: versionId, questionIds: ['not-a-real-id'] },
  });
  assert.equal(bad.res.status, 400);
  const dup = await api(ctx.base, tJar, '/api/teacher/exams/drafts', {
    method: 'POST',
    body: {
      sourceVersionId: versionId,
      questionIds: [sourceDraft.questions[0].id, sourceDraft.questions[0].id],
    },
  });
  assert.equal(dup.res.status, 400);

  const ownedVersion = (await loadTeacherData(ctx, tJar)).examVersions.find((v) => v.id === versionId);
  assert.ok(ownedVersion);
  const foreignVersionId = randomUUID();
  const foreignTeacherAccountId = randomUUID();
  const foreignStore = createStore(ctx.dataDir);
  await foreignStore.mutate((s) => {
    s.examVersions.push({
      ...JSON.parse(JSON.stringify(ownedVersion)),
      id: foreignVersionId,
      teacherAccountId: foreignTeacherAccountId,
    });
  });
  await foreignStore.close();

  const other = await api(ctx.base, tJar, '/api/teacher/exams/drafts', {
    method: 'POST',
    body: { sourceVersionId: foreignVersionId, questionIds: [sourceDraft.questions[0].id] },
  });
  assert.equal(other.res.status, 404);
});

test('authoring: reorder remove persist; manual missing key allowed for giao vs context blocks', async (t) => {
  const ctx = await startBaTestServer({ initialNow: '2025-06-01T10:00:00.000Z' });
  t.after(async () => {
    await ctx.close();
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });
  const tJar = await teacherSetup(ctx);
  const { versionId, sourceDraft } = await importAndPublish(ctx, tJar);
  const qIds = sourceDraft.questions.map((q) => q.id);
  const created = await api(ctx.base, tJar, '/api/teacher/exams/drafts', {
    method: 'POST',
    body: { sourceVersionId: versionId, questionIds: qIds },
  });
  const draftId = created.data.draftId;
  let draft = (await api(ctx.base, tJar, `/api/teacher/exams/drafts/${draftId}`)).data.draft;
  const reordered = [...draft.questions].reverse().map((q, i) => ({ ...q, order: i + 1 }));
  const removed = reordered.slice(1);
  await api(ctx.base, tJar, `/api/teacher/exams/drafts/${draftId}`, {
    method: 'PUT',
    body: {
      title: draft.title,
      questions: removed,
      passages: draft.passages,
      sections: draft.sections,
      gradingMode: EXAM_GRADING_MODE.TEACHER_MANUAL_LATER,
      baseRevision: draft.revision,
    },
  });
  draft = (await api(ctx.base, tJar, `/api/teacher/exams/drafts/${draftId}`)).data.draft;
  assert.equal(draft.questions.length, removed.length);
  draft.questions[0].correctOptionId = null;
  const checkManual = validateDraftForPublish({
    ...draft,
    teacherConfirmedReview: true,
    gradingMode: EXAM_GRADING_MODE.TEACHER_MANUAL_LATER,
  });
  assert.equal(checkManual.ok, true, checkManual.errors.join('; '));

  if (draft.passages?.length) {
    const raw = draft.passages[0];
    raw.contextConfirmed = false;
    raw.requiresContext = true;
    const g = draft.passages[0];
    if (g.documents?.length) {
      g.documents[0].bodyText = '';
    }
    const checkCtx = validateDraftForPublish({
      ...draft,
      teacherConfirmedReview: true,
      gradingMode: EXAM_GRADING_MODE.TEACHER_MANUAL_LATER,
    });
    assert.equal(checkCtx.ok, false);
  }
});

test('authoring: create draft operation replay returns same draftId', async (t) => {
  const ctx = await startBaTestServer({ initialNow: '2025-06-01T10:00:00.000Z' });
  t.after(async () => {
    await ctx.close();
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });
  const tJar = await teacherSetup(ctx);
  const op = 'op-compose-replay-1';
  const a = await api(ctx.base, tJar, '/api/teacher/exams/drafts', {
    method: 'POST',
    body: { blank: true, operationId: op },
  });
  const b = await api(ctx.base, tJar, '/api/teacher/exams/drafts', {
    method: 'POST',
    body: { blank: true, operationId: op },
  });
  assert.equal(a.res.status, 200);
  assert.equal(b.res.status, 200);
  assert.equal(a.data.draftId, b.data.draftId);

  const conflict = await api(ctx.base, tJar, '/api/teacher/exams/drafts', {
    method: 'POST',
    body: { blank: true, operationId: op, title: 'Khác tiêu đề' },
  });
  assert.equal(conflict.res.status, 409);
});

test('authoring: published student preview and assignment detail follow question order not array order', async (t) => {
  const ctx = await startBaTestServer({ initialNow: '2025-06-01T10:00:00.000Z' });
  t.after(async () => {
    await ctx.close();
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });
  const tJar = await teacherSetup(ctx);
  const created = await api(ctx.base, tJar, '/api/teacher/exams/drafts', {
    method: 'POST',
    body: { blank: true, title: '[TEST] order pipeline' },
  });
  assert.equal(created.res.status, 200);
  const draftId = created.data.draftId;
  let draft = (await api(ctx.base, tJar, `/api/teacher/exams/drafts/${draftId}`)).data.draft;
  const sectionId = draft.sections[0].id;
  const questions = [
    {
      id: 'q-array-first',
      sectionId,
      displayNumber: '1',
      order: 2,
      stemText: 'Array slot 1',
      options: [{ id: 'A', text: 'a' }, { id: 'B', text: 'b' }],
      correctOptionId: 'A',
    },
    {
      id: 'q-array-second',
      sectionId,
      displayNumber: '2',
      order: 1,
      stemText: 'Array slot 2',
      options: [{ id: 'A', text: 'a' }, { id: 'B', text: 'b' }],
      correctOptionId: 'B',
    },
  ];
  const saved = await api(ctx.base, tJar, `/api/teacher/exams/drafts/${draftId}`, {
    method: 'PUT',
    body: {
      title: draft.title,
      questions,
      passages: [],
      sections: draft.sections,
      teacherConfirmedReview: true,
      gradingMode: EXAM_GRADING_MODE.AUTOMATIC,
      baseRevision: draft.revision,
    },
  });
  assert.equal(saved.res.status, 200, saved.data.error);
  draft = (await api(ctx.base, tJar, `/api/teacher/exams/drafts/${draftId}`)).data.draft;
  assert.deepEqual(draft.questions.map((q) => q.id), ['q-array-first', 'q-array-second']);
  assert.equal(draft.questions[0].order, 2);
  assert.equal(draft.questions[1].order, 1);

  const pub = await api(ctx.base, tJar, `/api/teacher/exams/drafts/${draftId}/publish`, {
    method: 'POST',
    body: {},
  });
  assert.equal(pub.res.status, 200, pub.data.error);
  const versionId = pub.data.versionId;
  async function readPublishedVersion() {
    const store = createStore(ctx.dataDir);
    try {
      return (await store.read()).examVersions.find((v) => v.id === versionId);
    } finally {
      await store.close();
    }
  }
  const published = await readPublishedVersion();
  assert.ok(published);
  assert.equal(JSON.stringify({ questions: published.questions.map((q) => ({ id: q.id, order: q.order })) }),
    JSON.stringify({ questions: questions.map((q) => ({ id: q.id, order: q.order })) }));

  const preview = await api(ctx.base, tJar, `/api/teacher/exams/versions/${versionId}/student-preview`);
  assert.equal(preview.res.status, 200);
  assert.deepEqual(
    preview.data.exam.questions.map((q) => q.id),
    ['q-array-second', 'q-array-first'],
  );

  const classId = randomUUID();
  const studentId = randomUUID();
  await api(ctx.base, tJar, '/api/teacher/record/classes', {
    method: 'PUT',
    body: {
      id: classId,
      name: 'Lớp order',
      scheduleDays: ['Thứ 3'],
      scheduleTime: '18:00',
      createdAt: '2025-01-01T00:00:00.000Z',
    },
  });
  await api(ctx.base, tJar, '/api/teacher/record/students', {
    method: 'PUT',
    body: { id: studentId, name: 'HS order', classId },
  });
  const acc = await api(ctx.base, tJar, '/api/teacher/accounts/students', {
    method: 'POST',
    body: { studentId, username: 'hsorder', temporaryPassword: 'temppass123' },
  });
  assert.equal(acc.res.status, 200);
  const sJar = await studentLoginAfterPasswordChange(ctx, 'hsorder', 'temppass123', 'studentpass123');

  const assign = await api(ctx.base, tJar, '/api/teacher/exams/assignments', {
    method: 'POST',
    body: {
      versionId,
      classId,
      openAt: '2025-06-01T08:00:00.000Z',
      dueAt: '2025-06-02T08:00:00.000Z',
      timeLimitMinutes: 30,
      attemptLimit: 1,
    },
  });
  assert.equal(assign.res.status, 200, assign.data.error);
  const detail = await api(ctx.base, sJar, `/api/student/exams/assignments/${assign.data.assignmentId}`);
  assert.equal(detail.res.status, 200);
  assert.deepEqual(
    detail.data.exam.questions.map((q) => q.id),
    ['q-array-second', 'q-array-first'],
  );
  assert.deepEqual(await readPublishedVersion(), published,
    'preview and student projection must not mutate the published snapshot');
});

test('authoring: multi-source create orders questions A1,A2 then B1,B2 by slice (not interleaved)', async (t) => {
  const ctx = await startBaTestServer({ initialNow: '2025-06-01T10:00:00.000Z' });
  t.after(async () => {
    await ctx.close();
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });
  const tJar = await teacherSetup(ctx);
  const pubA = await importAndPublish(ctx, tJar);
  const pubB = await importAndPublish(ctx, tJar);
  const [a0, a1] = pubA.sourceDraft.questions;
  const [b0, b1] = pubB.sourceDraft.questions;
  const created = await api(ctx.base, tJar, '/api/teacher/exams/drafts', {
    method: 'POST',
    body: {
      sources: [
        { sourceVersionId: pubA.versionId, questionIds: [a0.id, a1.id] },
        { sourceVersionId: pubB.versionId, questionIds: [b0.id, b1.id] },
      ],
      title: '[TEST] thứ tự gộp nguồn',
    },
  });
  assert.equal(created.res.status, 200, created.data?.error);
  const got = await api(ctx.base, tJar, `/api/teacher/exams/drafts/${created.data.draftId}`);
  const d = got.data.draft;
  assert.equal(d.questions.length, 4);
  const vids = d.questions.map((q) => q.sourceVersionId);
  assert.deepEqual(vids, [pubA.versionId, pubA.versionId, pubB.versionId, pubB.versionId]);
  assert.deepEqual(d.questions.map((q) => q.displayNumber), ['1', '2', '3', '4']);
  const srcPairs = d.questions.map((q) => `${q.sourceVersionId}|${q.sourceQuestionId}`);
  assert.deepEqual(srcPairs, [
    `${pubA.versionId}|${a0.id}`,
    `${pubA.versionId}|${a1.id}`,
    `${pubB.versionId}|${b0.id}`,
    `${pubB.versionId}|${b1.id}`,
  ]);
});

test('authoring: compose-append adds second source after existing questions with next global numbers', async (t) => {
  const ctx = await startBaTestServer({ initialNow: '2025-06-01T10:00:00.000Z' });
  t.after(async () => {
    await ctx.close();
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });
  const tJar = await teacherSetup(ctx);
  const pubA = await importAndPublish(ctx, tJar);
  const pubB = await importAndPublish(ctx, tJar);
  const a0 = pubA.sourceDraft.questions[0].id;
  const [b0, b1] = pubB.sourceDraft.questions.map((q) => q.id);
  const created = await api(ctx.base, tJar, '/api/teacher/exams/drafts', {
    method: 'POST',
    body: { sourceVersionId: pubA.versionId, questionIds: [a0] },
  });
  assert.equal(created.res.status, 200);
  const draftId = created.data.draftId;
  const append = await api(ctx.base, tJar, `/api/teacher/exams/drafts/${draftId}/compose-append`, {
    method: 'POST',
    body: { sourceVersionId: pubB.versionId, questionIds: [b0, b1] },
  });
  assert.equal(append.res.status, 200, append.data?.error);
  assert.equal(append.data.addedCount, 2);
  const d = append.data.draft;
  assert.equal(d.questions.length, 3);
  const vids = d.questions.map((q) => q.sourceVersionId);
  assert.deepEqual(vids, [pubA.versionId, pubB.versionId, pubB.versionId]);
  assert.deepEqual(d.questions.map((q) => q.displayNumber), ['1', '2', '3']);
});

test('authoring: multi-source draft merges two exams with bindings and shared passage context', async (t) => {
  const ctx = await startBaTestServer({ initialNow: '2025-06-01T10:00:00.000Z' });
  t.after(async () => {
    await ctx.close();
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });
  const tJar = await teacherSetup(ctx);
  const pubA = await importAndPublish(ctx, tJar);
  const pubB = await importAndPublish(ctx, tJar);
  const qA = pubA.sourceDraft.questions[0].id;
  const qB = pubB.sourceDraft.questions[0].id;
  const created = await api(ctx.base, tJar, '/api/teacher/exams/drafts', {
    method: 'POST',
    body: {
      sources: [
        { sourceVersionId: pubA.versionId, questionIds: [qA] },
        { sourceVersionId: pubB.versionId, questionIds: [qB] },
      ],
      title: '[TEST] gộp hai đề',
    },
  });
  assert.equal(created.res.status, 200, created.data?.error);
  const got = await api(ctx.base, tJar, `/api/teacher/exams/drafts/${created.data.draftId}`);
  const d = got.data.draft;
  assert.equal(d.questions.length, 2);
  const vids = new Set(d.questions.map((q) => q.sourceVersionId));
  assert.equal(vids.size, 2);
  assert.ok(d.composedSourceExamBindings?.[pubA.versionId]?.sourceAttachmentId);
  assert.ok(d.composedSourceExamBindings?.[pubB.versionId]?.sourceAttachmentId);
  assert.ok(d.passages.length >= 1);
});

test('authoring: append saves dirty edits preserves stem and appends after max order', async (t) => {
  const ctx = await startBaTestServer({ initialNow: '2025-06-01T10:00:00.000Z' });
  t.after(async () => {
    await ctx.close();
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });
  const tJar = await teacherSetup(ctx);
  const { versionId, sourceDraft } = await importAndPublish(ctx, tJar);
  const q0 = sourceDraft.questions[0].id;
  const q1 = sourceDraft.questions[1].id;
  const created = await api(ctx.base, tJar, '/api/teacher/exams/drafts', {
    method: 'POST',
    body: { sourceVersionId: versionId, questionIds: [q0] },
  });
  assert.equal(created.res.status, 200);
  const draftId = created.data.draftId;
  let draft = (await api(ctx.base, tJar, `/api/teacher/exams/drafts/${draftId}`)).data.draft;
  draft.questions[0].stemText = 'ĐÃ SỬA GIỮ CHỖ';
  const put = await api(ctx.base, tJar, `/api/teacher/exams/drafts/${draftId}`, {
    method: 'PUT',
    body: {
      title: draft.title,
      questions: draft.questions,
      passages: draft.passages,
      sections: draft.sections,
      teacherConfirmedReview: true,
      baseRevision: draft.revision,
    },
  });
  assert.equal(put.res.status, 200);
  const append = await api(ctx.base, tJar, `/api/teacher/exams/drafts/${draftId}/compose-append`, {
    method: 'POST',
    body: { sourceVersionId: versionId, questionIds: [q1] },
  });
  assert.equal(append.res.status, 200, append.data?.error);
  assert.equal(append.data.addedCount, 1);
  draft = append.data.draft;
  assert.equal(draft.questions[0].stemText, 'ĐÃ SỬA GIỮ CHỖ');
  const orders = draft.questions.map((q) => q.order).sort((a, b) => a - b);
  assert.deepEqual(orders, [1, 2]);
});

test('authoring: append skips duplicate source question', async (t) => {
  const ctx = await startBaTestServer({ initialNow: '2025-06-01T10:00:00.000Z' });
  t.after(async () => {
    await ctx.close();
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });
  const tJar = await teacherSetup(ctx);
  const { versionId, sourceDraft } = await importAndPublish(ctx, tJar);
  const q0 = sourceDraft.questions[0].id;
  const created = await api(ctx.base, tJar, '/api/teacher/exams/drafts', {
    method: 'POST',
    body: { sourceVersionId: versionId, questionIds: [q0] },
  });
  const draftId = created.data.draftId;
  const append = await api(ctx.base, tJar, `/api/teacher/exams/drafts/${draftId}/compose-append`, {
    method: 'POST',
    body: { sourceVersionId: versionId, questionIds: [q0] },
  });
  assert.equal(append.res.status, 200);
  assert.equal(append.data.addedCount, 0);
  assert.ok(append.data.skippedDuplicateSourceQuestions >= 1);
});

test('authoring: append rejects non-owner source version', async (t) => {
  const ctx = await startBaTestServer({ initialNow: '2025-06-01T10:00:00.000Z' });
  t.after(async () => {
    await ctx.close();
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });
  const tJar = await teacherSetup(ctx);
  const { versionId, sourceDraft } = await importAndPublish(ctx, tJar);
  const created = await api(ctx.base, tJar, '/api/teacher/exams/drafts', {
    method: 'POST',
    body: { blank: true, title: 'Nháp' },
  });
  const draftId = created.data.draftId;
  const foreignVersionId = randomUUID();
  const foreignTeacherAccountId = randomUUID();
  const ownedVersion = (await loadTeacherData(ctx, tJar)).examVersions.find((v) => v.id === versionId);
  assert.ok(ownedVersion);
  const foreignStore = createStore(ctx.dataDir);
  await foreignStore.mutate((s) => {
    s.examVersions.push({
      ...JSON.parse(JSON.stringify(ownedVersion)),
      id: foreignVersionId,
      teacherAccountId: foreignTeacherAccountId,
    });
  });
  await foreignStore.close();
  const append = await api(ctx.base, tJar, `/api/teacher/exams/drafts/${draftId}/compose-append`, {
    method: 'POST',
    body: { sourceVersionId: foreignVersionId, questionIds: [sourceDraft.questions[0].id] },
  });
  assert.equal(append.res.status, 404);
});

test('authoring: multi-source student preview follows global order', async (t) => {
  const ctx = await startBaTestServer({ initialNow: '2025-06-01T10:00:00.000Z' });
  t.after(async () => {
    await ctx.close();
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });
  const tJar = await teacherSetup(ctx);
  const a = await importAndPublish(ctx, tJar);
  const b = await importAndPublish(ctx, tJar);
  const created = await api(ctx.base, tJar, '/api/teacher/exams/drafts', {
    method: 'POST',
    body: {
      sources: [
        { sourceVersionId: a.versionId, questionIds: [a.sourceDraft.questions[0].id] },
        { sourceVersionId: b.versionId, questionIds: [b.sourceDraft.questions[0].id] },
      ],
    },
  });
  const draftId = created.data.draftId;
  let draft = (await api(ctx.base, tJar, `/api/teacher/exams/drafts/${draftId}`)).data.draft;
  const [x, y] = draft.questions;
  await api(ctx.base, tJar, `/api/teacher/exams/drafts/${draftId}`, {
    method: 'PUT',
    body: {
      title: draft.title,
      questions: [
        { ...x, order: 2 },
        { ...y, order: 1 },
      ],
      passages: draft.passages,
      sections: draft.sections,
      teacherConfirmedReview: true,
      gradingMode: EXAM_GRADING_MODE.AUTOMATIC,
      baseRevision: draft.revision,
    },
  });
  draft = (await api(ctx.base, tJar, `/api/teacher/exams/drafts/${draftId}`)).data.draft;
  const pub = await api(ctx.base, tJar, `/api/teacher/exams/drafts/${draftId}/publish`, { method: 'POST', body: {} });
  assert.equal(pub.res.status, 200, pub.data?.error);
  const preview = await api(ctx.base, tJar, `/api/teacher/exams/versions/${pub.data.versionId}/student-preview`);
  assert.equal(preview.res.status, 200);
  assert.deepEqual(
    preview.data.exam.questions.map((q) => q.id),
    [draft.questions[1].id, draft.questions[0].id],
  );
});
