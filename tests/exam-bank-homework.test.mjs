import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
  startBaTestServer,
  api,
  teacherSetup,
  createControllableClock,
} from './ba-test-helpers.mjs';
import {
  buildSampleExamPdf,
  waitForImportJob,
} from './exam-fixtures.mjs';
import { EXAM_ASSIGNMENT_PURPOSE } from '../dist/exam-domain.js';

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

async function setupClassStudent(ctx, tJar) {
  const classId = randomUUID();
  const studentId = randomUUID();
  await api(ctx.base, tJar, '/api/teacher/record/classes', {
    method: 'PUT',
    body: {
      id: classId,
      name: 'Lớp HW',
      scheduleDays: ['Thứ 4'],
      scheduleTime: '19:00',
      createdAt: '2025-01-01T00:00:00.000Z',
    },
  });
  await api(ctx.base, tJar, '/api/teacher/record/students', {
    method: 'PUT',
    body: { id: studentId, name: 'HS HW', classId },
  });
  await api(ctx.base, tJar, '/api/teacher/accounts/students', {
    method: 'POST',
    body: { studentId, username: 'hshw', temporaryPassword: 'temppass123' },
  });
  let sJar = (await api(ctx.base, tJar, '/api/auth/csrf')).jar;
  const login = await api(ctx.base, sJar, '/api/auth/login', {
    method: 'POST',
    body: { username: 'hshw', password: 'temppass123' },
  });
  sJar = login.jar;
  const changed = await api(ctx.base, sJar, '/api/auth/change-password', {
    method: 'POST',
    body: { currentPassword: '', newPassword: 'studentpass123' },
  });
  return { classId, studentId, sJar: changed.jar };
}

async function importAndPublish(ctx, tJar) {
  const attId = await uploadPdf(ctx.base, tJar, buildSampleExamPdf());
  const started = await api(ctx.base, tJar, '/api/teacher/exams/imports', {
    method: 'POST',
    body: { sourceAttachmentId: attId, keyPages: [2], title: 'Kho mẫu' },
  });
  const job = await waitForImportJob(ctx.base, tJar, started.data.jobId);
  const draftRes = await api(ctx.base, tJar, `/api/teacher/exams/drafts/${job.draftId}`);
  const draft = draftRes.data.draft;
  await api(ctx.base, tJar, `/api/teacher/exams/drafts/${draft.id}`, {
    method: 'PUT',
    body: {
      title: draft.title,
      questions: draft.questions,
      teacherConfirmedReview: true,
      baseRevision: draft.revision,
    },
  });
  const pub = await api(ctx.base, tJar, `/api/teacher/exams/drafts/${draft.id}/publish`, {
    method: 'POST',
    body: {},
  });
  return { versionId: pub.data.versionId, draft };
}

test('exam bank: rejects bad selectedQuestionIds on assign', async (t) => {
  const ctx = await startBaTestServer();
  t.after(async () => {
    await ctx.close();
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });
  const tJar = await teacherSetup(ctx);
  const { classId } = await setupClassStudent(ctx, tJar);
  const { versionId, draft } = await importAndPublish(ctx, tJar);
  const q1 = draft.questions[0].id;
  const bad = await api(ctx.base, tJar, '/api/teacher/exams/assignments', {
    method: 'POST',
    body: {
      versionId,
      classId,
      title: 'Subset',
      openAt: '2025-06-01T08:00:00.000Z',
      dueAt: '2025-06-02T08:00:00.000Z',
      timeLimitMinutes: 30,
      attemptLimit: 1,
      selectedQuestionIds: [q1, q1],
    },
  });
  assert.equal(bad.res.status, 400);
  const unknown = await api(ctx.base, tJar, '/api/teacher/exams/assignments', {
    method: 'POST',
    body: {
      versionId,
      classId,
      title: 'Subset',
      openAt: '2025-06-01T08:00:00.000Z',
      dueAt: '2025-06-02T08:00:00.000Z',
      timeLimitMinutes: 30,
      attemptLimit: 1,
      selectedQuestionIds: ['missing-id'],
    },
  });
  assert.equal(unknown.res.status, 400);
  const badPurpose = await api(ctx.base, tJar, '/api/teacher/exams/assignments', {
    method: 'POST',
    body: {
      versionId,
      classId,
      title: 'Bad purpose',
      purpose: 'quiz',
      openAt: '2025-06-01T08:00:00.000Z',
      dueAt: '2025-06-02T08:00:00.000Z',
      timeLimitMinutes: 30,
      attemptLimit: 1,
    },
  });
  assert.equal(badPurpose.res.status, 400);
});

test('exam bank: subset assign scores selected only and rejects unselected answers', async (t) => {
  const clock = createControllableClock('2025-06-01T10:00:00.000Z');
  const ctx = await startBaTestServer({ clock });
  t.after(async () => {
    await ctx.close();
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });
  const tJar = await teacherSetup(ctx);
  const { classId, sJar } = await setupClassStudent(ctx, tJar);
  const { versionId, draft } = await importAndPublish(ctx, tJar);
  const q1 = draft.questions[0].id;
  const assign = await api(ctx.base, tJar, '/api/teacher/exams/assignments', {
    method: 'POST',
    body: {
      versionId,
      classId,
      title: 'Một câu',
      openAt: '2025-06-01T08:00:00.000Z',
      dueAt: '2025-06-02T08:00:00.000Z',
      timeLimitMinutes: 30,
      attemptLimit: 1,
      selectedQuestionIds: [q1],
    },
  });
  assert.equal(assign.res.status, 200);
  const assignmentId = assign.data.assignmentId;
  const start = await api(ctx.base, sJar, '/api/student/exams/attempts/start', {
    method: 'POST',
    body: { assignmentId },
  });
  const attemptId = start.data.attemptId;
  const detail = await api(ctx.base, sJar, `/api/student/exams/assignments/${assignmentId}`);
  assert.equal(detail.data.exam.questions.length, 1);
  const qOther = draft.questions.find((q) => q.id !== q1);
  const reject = await api(ctx.base, sJar, `/api/student/exams/attempts/${attemptId}/answers`, {
    method: 'POST',
    body: { questionId: qOther.id, optionId: qOther.correctOptionId, baseRevision: 0 },
  });
  assert.equal(reject.res.status, 400);
  const save = await api(ctx.base, sJar, `/api/student/exams/attempts/${attemptId}/answers`, {
    method: 'POST',
    body: { questionId: q1, optionId: draft.questions[0].correctOptionId, baseRevision: 0 },
  });
  assert.equal(save.res.status, 200);
  const submit = await api(ctx.base, sJar, `/api/student/exams/attempts/${attemptId}/submit`, {
    method: 'POST',
    body: {},
  });
  assert.equal(submit.res.status, 200);
  assert.equal(submit.data.score10, 10);
  assert.equal(submit.data.totalCount, 1);
});

test('exam bank: homework has no timer limit but enforces due date', async (t) => {
  const clock = createControllableClock('2025-06-01T10:00:00.000Z');
  const ctx = await startBaTestServer({ clock });
  t.after(async () => {
    await ctx.close();
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });
  const tJar = await teacherSetup(ctx);
  const { classId, sJar } = await setupClassStudent(ctx, tJar);
  const { versionId } = await importAndPublish(ctx, tJar);
  const assign = await api(ctx.base, tJar, '/api/teacher/exams/assignments', {
    method: 'POST',
    body: {
      versionId,
      classId,
      title: 'HW online',
      purpose: EXAM_ASSIGNMENT_PURPOSE.HOMEWORK,
      openAt: '2025-06-01T08:00:00.000Z',
      dueAt: '2025-06-02T08:00:00.000Z',
      attemptLimit: 1,
    },
  });
  assert.equal(assign.res.status, 200);
  const assignmentId = assign.data.assignmentId;
  const start1 = await api(ctx.base, sJar, '/api/student/exams/attempts/start', {
    method: 'POST',
    body: { assignmentId },
  });
  assert.equal(start1.res.status, 200);
  assert.equal(start1.data.deadlineAt, '2025-06-02T08:00:00.000Z');
  const start2 = await api(ctx.base, sJar, '/api/student/exams/attempts/start', {
    method: 'POST',
    body: { assignmentId },
  });
  assert.equal(start2.data.reused, true);
  clock.set('2025-06-03T00:00:00.000Z');
  const late = await api(ctx.base, sJar, '/api/student/exams/attempts/start', {
    method: 'POST',
    body: { assignmentId },
  });
  assert.equal(late.res.status, 403);
});

test('exam bank: GET /api/data lists exam homework beside photo assignments', async (t) => {
  const ctx = await startBaTestServer();
  t.after(async () => {
    await ctx.close();
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });
  const tJar = await teacherSetup(ctx);
  const { classId, sJar } = await setupClassStudent(ctx, tJar);
  const photoId = randomUUID();
  const attId = await uploadPdf(ctx.base, tJar, buildSampleExamPdf());
  const photoPut = await api(ctx.base, tJar, '/api/teacher/record/assignments', {
    method: 'PUT',
    body: {
      id: photoId,
      classId,
      title: 'Photo HW',
      bookRef: '',
      instructions: 'Chụp bài tập',
      dueDateISO: '2025-12-01',
      requiredPageCount: 1,
      attachmentIds: [attId],
      createdAt: '2025-01-01T00:00:00.000Z',
    },
  });
  assert.equal(photoPut.res.status, 200, photoPut.data?.error);
  const { versionId } = await importAndPublish(ctx, tJar);
  await api(ctx.base, tJar, '/api/teacher/exams/assignments', {
    method: 'POST',
    body: {
      versionId,
      classId,
      title: 'Online HW',
      purpose: EXAM_ASSIGNMENT_PURPOSE.HOMEWORK,
      openAt: '2025-06-01T08:00:00.000Z',
      dueAt: '2025-06-02T08:00:00.000Z',
      attemptLimit: 1,
    },
  });
  const teacherData = await api(ctx.base, tJar, '/api/data');
  assert.ok(teacherData.data.data.assignments.some((a) => a.id === photoId));
  assert.ok((teacherData.data.data.examAssignments || []).length >= 1);
  const studentData = await api(ctx.base, sJar, '/api/data');
  assert.ok(studentData.data.data.assignments.some((a) => a.id === photoId));
  assert.ok((studentData.data.data.examAssignments || []).length >= 1);
});

test('exam bank: answer-key regrade applies per-assignment subsets', async (t) => {
  const clock = createControllableClock('2025-06-01T10:00:00.000Z');
  const ctx = await startBaTestServer({ clock });
  t.after(async () => {
    await ctx.close();
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });
  const tJar = await teacherSetup(ctx);
  const { classId, sJar } = await setupClassStudent(ctx, tJar);
  const { versionId, draft } = await importAndPublish(ctx, tJar);
  const [q1, q2] = draft.questions.slice(0, 2);
  const a1 = await api(ctx.base, tJar, '/api/teacher/exams/assignments', {
    method: 'POST',
    body: {
      versionId,
      classId,
      title: 'Only Q1',
      openAt: '2025-06-01T08:00:00.000Z',
      dueAt: '2025-06-02T08:00:00.000Z',
      timeLimitMinutes: 30,
      attemptLimit: 1,
      selectedQuestionIds: [q1.id],
    },
  });
  const a2 = await api(ctx.base, tJar, '/api/teacher/exams/assignments', {
    method: 'POST',
    body: {
      versionId,
      classId,
      title: 'Only Q2',
      openAt: '2025-06-01T08:00:00.000Z',
      dueAt: '2025-06-02T08:00:00.000Z',
      timeLimitMinutes: 30,
      attemptLimit: 1,
      selectedQuestionIds: [q2.id],
    },
  });
  for (const [assignmentId, q, opt] of [
    [a1.data.assignmentId, q1, q1.correctOptionId],
    [a2.data.assignmentId, q2, q2.correctOptionId],
  ]) {
    const start = await api(ctx.base, sJar, '/api/student/exams/attempts/start', {
      method: 'POST',
      body: { assignmentId },
    });
    await api(ctx.base, sJar, `/api/student/exams/attempts/${start.data.attemptId}/answers`, {
      method: 'POST',
      body: { questionId: q.id, optionId: opt, baseRevision: 0 },
    });
    await api(ctx.base, sJar, `/api/student/exams/attempts/${start.data.attemptId}/submit`, {
      method: 'POST',
      body: {},
    });
  }
  await api(ctx.base, tJar, `/api/teacher/exams/versions/${versionId}/answer-key`, {
    method: 'PUT',
    body: {
      baseRevision: 1,
      keys: { [q1.id]: q1.correctOptionId },
    },
  });
  const g1 = await api(ctx.base, tJar, `/api/teacher/exams/assignments/${a1.data.assignmentId}/grading`);
  const g2 = await api(ctx.base, tJar, `/api/teacher/exams/assignments/${a2.data.assignmentId}/grading`);
  assert.equal(g1.data.version.questions.length, 1);
  assert.equal(g1.data.version.questions[0].id, q1.id);
  assert.equal(g2.data.version.questions.length, 1);
  assert.equal(g2.data.version.questions[0].id, q2.id);
  const view1 = await api(ctx.base, sJar, `/api/student/exams/assignments/${a1.data.assignmentId}`);
  assert.equal(view1.data.exam.result?.totalCount, 1);
  assert.equal(view1.data.exam.result?.score10, 10);
  await api(ctx.base, tJar, `/api/teacher/exams/versions/${versionId}/answer-key`, {
    method: 'PUT',
    body: {
      baseRevision: 2,
      keys: { [q2.id]: q2.correctOptionId },
    },
  });
  const view2b = await api(ctx.base, sJar, `/api/student/exams/assignments/${a2.data.assignmentId}`);
  assert.equal(view2b.data.exam.result?.totalCount, 1);
  assert.equal(view2b.data.exam.result?.score10, 10);
});
