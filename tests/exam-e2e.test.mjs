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
  buildRasterImageOnlyPdf,
  buildTwoColumnExamPdf,
  waitForImportJob,
} from './exam-fixtures.mjs';
import { validateDraftForPublish } from '../dist/exam-domain.js';

test('exam: Node PDF extract (Windows-safe pdf.js worker URL)', async () => {
  const { buildDraftFromPdf } = await import('../server/exam-extract.mjs');
  const draft = await buildDraftFromPdf(buildSampleExamPdf(), {
    allPages: [1],
    keyPages: [2],
  });
  assert.ok(draft.questions.length >= 2);
  assert.equal(draft.needsOcr, false);
});

function jarHeader(jar) {
  return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
}

async function uploadPdf(base, jar, name, buffer) {
  const res = await fetch(`${base}/api/teacher/attachments`, {
    method: 'POST',
    headers: {
      cookie: jarHeader(jar),
      'content-type': 'application/pdf',
      'x-bn-csrf': jar.bn_csrf,
      'x-bn-filename': encodeURIComponent(name),
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
      name: 'Lớp thi',
      scheduleDays: ['Thứ 3'],
      scheduleTime: '18:00',
      createdAt: '2025-01-01T00:00:00.000Z',
    },
  });
  await api(ctx.base, tJar, '/api/teacher/record/students', {
    method: 'PUT',
    body: { id: studentId, name: 'HS Thi', classId },
  });
  const acc = await api(ctx.base, tJar, '/api/teacher/accounts/students', {
    method: 'POST',
    body: { studentId, username: 'hsthi', temporaryPassword: 'temppass123' },
  });
  assert.equal(acc.res.status, 200);
  let sJar = (await api(ctx.base, tJar, '/api/auth/csrf')).jar;
  const login = await api(ctx.base, sJar, '/api/auth/login', {
    method: 'POST',
    body: { username: 'hsthi', password: 'temppass123' },
  });
  sJar = login.jar;
  const changed = await api(ctx.base, sJar, '/api/auth/change-password', {
    method: 'POST',
    body: { currentPassword: '', newPassword: 'studentpass123' },
  });
  sJar = changed.jar;
  return { classId, studentId, sJar };
}

async function importDraft(ctx, tJar, pdfBuffer, keyPages = [2]) {
  const attId = await uploadPdf(ctx.base, tJar, 'exam.pdf', pdfBuffer);
  const started = await api(ctx.base, tJar, '/api/teacher/exams/imports', {
    method: 'POST',
    body: { sourceAttachmentId: attId, keyPages, title: 'Bài thi mẫu' },
  });
  assert.equal(started.res.status, 200);
  const job = await waitForImportJob(ctx.base, tJar, started.data.jobId);
  assert.ok(job.draftId, job.error || job.status);
  const draftRes = await api(ctx.base, tJar, `/api/teacher/exams/drafts/${job.draftId}`);
  assert.equal(draftRes.res.status, 200);
  return { job, draft: draftRes.data.draft };
}

async function publishDraft(ctx, tJar, draft) {
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
  assert.equal(pub.res.status, 200);
  return pub.data.versionId;
}

/** Save each answer with optimistic revision ACK (matches server answerRevision). */
async function saveAttemptAnswersSequentially(ctx, sJar, attemptId, questions, baseRevision) {
  let rev = baseRevision;
  for (const q of questions) {
    const save = await api(ctx.base, sJar, `/api/student/exams/attempts/${attemptId}/answers`, {
      method: 'POST',
      body: { questionId: q.id, optionId: q.correctOptionId, baseRevision: rev },
    });
    assert.equal(save.res.status, 200, save.data?.error);
    assert.ok(typeof save.data.revision === 'number');
    rev = save.data.revision;
  }
  return rev;
}

test('exam E2E: import PDF, publish, assign, student submit score', async (t) => {
  const clock = createControllableClock('2025-06-01T10:00:00.000Z');
  const ctx = await startBaTestServer({ clock });
  t.after(async () => {
    await ctx.close();
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });
  const tJar = await teacherSetup(ctx);
  const { classId, sJar } = await setupClassStudent(ctx, tJar);
  const { draft, job } = await importDraft(ctx, tJar, buildSampleExamPdf());
  assert.equal(job.needsOcr, false);
  assert.ok(draft.questions.length >= 2);

  const dup = await api(ctx.base, tJar, '/api/teacher/exams/imports', {
    method: 'POST',
    body: { sourceAttachmentId: draft.sourceAttachmentId, keyPages: [2] },
  });
  assert.equal(dup.res.status, 200);
  assert.equal(dup.data.reused, true);

  const versionId = await publishDraft(ctx, tJar, draft);
  const assign = await api(ctx.base, tJar, '/api/teacher/exams/assignments', {
    method: 'POST',
    body: {
      versionId,
      classId,
      title: 'Thi thử',
      openAt: '2025-06-01T09:00:00.000Z',
      dueAt: '2025-06-01T12:00:00.000Z',
      timeLimitMinutes: 45,
      attemptLimit: 1,
      showAnswersAfter: 'after-due',
    },
  });
  assert.equal(assign.res.status, 200);
  const assignmentId = assign.data.assignmentId;

  const detail = await api(ctx.base, sJar, `/api/student/exams/assignments/${assignmentId}`);
  assert.equal(detail.res.status, 200);
  for (const q of detail.data.exam.questions) {
    assert.equal('correctOptionId' in q, false);
  }

  const start = await api(ctx.base, sJar, '/api/student/exams/attempts/start', {
    method: 'POST',
    body: { assignmentId },
  });
  assert.equal(start.res.status, 200);
  const attemptId = start.data.attemptId;

  const q1 = draft.questions[0];
  const q2 = draft.questions[1];
  const save1 = await api(ctx.base, sJar, `/api/student/exams/attempts/${attemptId}/answers`, {
    method: 'POST',
    body: { questionId: q1.id, optionId: q1.correctOptionId, baseRevision: 0 },
  });
  assert.equal(save1.res.status, 200);
  const save2 = await api(ctx.base, sJar, `/api/student/exams/attempts/${attemptId}/answers`, {
    method: 'POST',
    body: { questionId: q2.id, optionId: q2.correctOptionId, baseRevision: save1.data.revision },
  });
  assert.equal(save2.res.status, 200);

  const submit = await api(ctx.base, sJar, `/api/student/exams/attempts/${attemptId}/submit`, {
    method: 'POST',
    body: {},
  });
  assert.equal(submit.res.status, 200);
  assert.equal(submit.data.correctCount, 2);
  assert.equal(submit.data.score10, 10);

  const submit2 = await api(ctx.base, sJar, `/api/student/exams/attempts/${attemptId}/submit`, {
    method: 'POST',
    body: {},
  });
  assert.equal(submit2.res.status, 200);
  assert.equal(submit2.data.reused, true);

  const jobLeak = await api(ctx.base, sJar, `/api/teacher/exams/imports/${job.id}`);
  assert.equal(jobLeak.res.status, 403);
});

test('exam: raster image-only PDF needs OCR and publish blocked', async (t) => {
  const ctx = await startBaTestServer({});
  t.after(async () => {
    await ctx.close();
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });
  const tJar = await teacherSetup(ctx);
  const { draft } = await importDraft(ctx, tJar, buildRasterImageOnlyPdf(), []);
  assert.equal(draft.needsOcr, true);
  assert.deepEqual(draft.needsOcrPageNumbers, [1]);
  const check = validateDraftForPublish(draft);
  assert.equal(check.ok, false);
  assert.ok(check.errors.some((e) => /Trang 1.*lớp chữ/.test(e)));
  const pub = await api(ctx.base, tJar, `/api/teacher/exams/drafts/${draft.id}/publish`, {
    method: 'POST',
    body: {},
  });
  assert.equal(pub.res.status, 400);
});

test('exam: two-column PDF parses and grades', async (t) => {
  const ctx = await startBaTestServer({ initialNow: '2025-06-01T10:00:00.000Z' });
  t.after(async () => {
    await ctx.close();
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });
  const tJar = await teacherSetup(ctx);
  const { classId, sJar } = await setupClassStudent(ctx, tJar);
  const { draft } = await importDraft(ctx, tJar, buildTwoColumnExamPdf());
  assert.equal(draft.questions.length, 2);
  const [q1, q2] = draft.questions;
  assert.equal(q1.displayNumber, '1');
  assert.match(q1.stemText, /Left column question/);
  assert.equal(q1.options.find((o) => o.id === 'A')?.text, 'one');
  assert.equal(q1.options.find((o) => o.id === 'B')?.text, 'two');
  assert.equal(q1.correctOptionId, 'A');
  assert.equal(q2.displayNumber, '2');
  assert.match(q2.stemText, /Right column question/);
  assert.equal(q2.options.find((o) => o.id === 'A')?.text, 'alpha');
  assert.equal(q2.options.find((o) => o.id === 'B')?.text, 'beta');
  assert.equal(q2.correctOptionId, 'B');

  const versionId = await publishDraft(ctx, tJar, draft);
  const assign = await api(ctx.base, tJar, '/api/teacher/exams/assignments', {
    method: 'POST',
    body: {
      versionId,
      classId,
      title: 'Hai cột',
      openAt: '2025-06-01T09:00:00.000Z',
      dueAt: '2025-06-01T12:00:00.000Z',
      timeLimitMinutes: 30,
      attemptLimit: 1,
    },
  });
  assert.equal(assign.res.status, 200);
  const assignmentId = assign.data.assignmentId;
  const start = await api(ctx.base, sJar, '/api/student/exams/attempts/start', {
    method: 'POST',
    body: { assignmentId },
  });
  assert.equal(start.res.status, 200);
  const attemptId = start.data.attemptId;

  const detail = await api(ctx.base, sJar, `/api/student/exams/assignments/${assignmentId}`);
  assert.equal(detail.res.status, 200);
  assert.equal(detail.data.exam.questions.length, 2);
  const baseRevision = detail.data.exam.attempt?.revision ?? 0;

  await saveAttemptAnswersSequentially(ctx, sJar, attemptId, draft.questions, baseRevision);

  const inProgress = await api(ctx.base, sJar, `/api/student/exams/assignments/${assignmentId}`);
  assert.equal(inProgress.data.exam.attempt.answers[q1.id], 'A');
  assert.equal(inProgress.data.exam.attempt.answers[q2.id], 'B');

  const submit = await api(ctx.base, sJar, `/api/student/exams/attempts/${attemptId}/submit`, {
    method: 'POST',
    body: {},
  });
  assert.equal(submit.res.status, 200);
  assert.equal(submit.data.correctCount, 2);
  assert.equal(submit.data.totalCount, 2);
  assert.equal(submit.data.score10, 10);

  const studentView = await api(ctx.base, sJar, `/api/student/exams/assignments/${assignmentId}`);
  assert.equal(studentView.data.exam.attempt.answers[q1.id], 'A');
  assert.equal(studentView.data.exam.attempt.answers[q2.id], 'B');

  const teacherSummary = await api(ctx.base, tJar, `/api/teacher/exams/assignments/${assignmentId}/summary`);
  assert.equal(teacherSummary.res.status, 200);
  assert.equal(teacherSummary.data.summary.length, 1);
  assert.equal(teacherSummary.data.summary[0].correctCount, 2);
  assert.equal(teacherSummary.data.summary[0].totalCount, 2);
  assert.equal(teacherSummary.data.summary[0].score10, 10);
});

test('exam: save after deadline forbidden', async (t) => {
  const clock = createControllableClock('2025-06-01T10:00:00.000Z');
  const ctx = await startBaTestServer({ clock });
  t.after(async () => {
    await ctx.close();
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });
  const tJar = await teacherSetup(ctx);
  const { classId, sJar } = await setupClassStudent(ctx, tJar);
  const { draft } = await importDraft(ctx, tJar, buildSampleExamPdf());
  const versionId = await publishDraft(ctx, tJar, draft);
  const assign = await api(ctx.base, tJar, '/api/teacher/exams/assignments', {
    method: 'POST',
    body: {
      versionId,
      classId,
      title: 'Hạn chặt',
      openAt: '2025-06-01T09:00:00.000Z',
      dueAt: '2025-06-01T10:30:00.000Z',
      timeLimitMinutes: 120,
      attemptLimit: 1,
    },
  });
  const assignmentId = assign.data.assignmentId;
  const start = await api(ctx.base, sJar, '/api/student/exams/attempts/start', {
    method: 'POST',
    body: { assignmentId },
  });
  const attemptId = start.data.attemptId;
  clock.set('2025-06-01T11:00:00.000Z');
  const save = await api(ctx.base, sJar, `/api/student/exams/attempts/${attemptId}/answers`, {
    method: 'POST',
    body: { questionId: draft.questions[0].id, optionId: 'A', baseRevision: 0 },
  });
  assert.equal(save.res.status, 403);
});

test('exam: answer revision conflict 409', async (t) => {
  const ctx = await startBaTestServer({ initialNow: '2025-06-01T10:00:00.000Z' });
  t.after(async () => {
    await ctx.close();
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });
  const tJar = await teacherSetup(ctx);
  const { classId, sJar } = await setupClassStudent(ctx, tJar);
  const { draft } = await importDraft(ctx, tJar, buildSampleExamPdf());
  const versionId = await publishDraft(ctx, tJar, draft);
  const assign = await api(ctx.base, tJar, '/api/teacher/exams/assignments', {
    method: 'POST',
    body: {
      versionId,
      classId,
      title: 'Xung đột',
      openAt: '2025-06-01T09:00:00.000Z',
      dueAt: '2025-06-01T12:00:00.000Z',
      timeLimitMinutes: 60,
      attemptLimit: 1,
    },
  });
  const start = await api(ctx.base, sJar, '/api/student/exams/attempts/start', {
    method: 'POST',
    body: { assignmentId: assign.data.assignmentId },
  });
  const attemptId = start.data.attemptId;
  const qid = draft.questions[0].id;
  await api(ctx.base, sJar, `/api/student/exams/attempts/${attemptId}/answers`, {
    method: 'POST',
    body: { questionId: qid, optionId: 'A', baseRevision: 0 },
  });
  const conflict = await api(ctx.base, sJar, `/api/student/exams/attempts/${attemptId}/answers`, {
    method: 'POST',
    body: { questionId: qid, optionId: 'B', baseRevision: 0 },
  });
  assert.equal(conflict.res.status, 409);
});

test('vendor pdfjs routes serve library', async (t) => {
  const ctx = await startBaTestServer({});
  t.after(async () => {
    await ctx.close();
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });
  const res = await fetch(`${ctx.base}/vendor/pdfjs/pdf.mjs`);
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.ok(text.includes('pdfjs') || text.length > 1000);
});

test('regression: GET /api/data keeps photo assignments alongside exam metadata', async (t) => {
  const ctx = await startBaTestServer({ initialNow: '2025-06-01T10:00:00.000Z' });
  t.after(async () => {
    await ctx.close();
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });
  const tJar = await teacherSetup(ctx);
  const classId = randomUUID();
  const assignmentId = randomUUID();
  await api(ctx.base, tJar, '/api/teacher/record/classes', {
    method: 'PUT',
    body: {
      id: classId,
      name: 'Lớp ảnh',
      scheduleDays: ['Thứ 2'],
      scheduleTime: '19:00',
      createdAt: '2025-01-01T00:00:00.000Z',
    },
  });
  const attId = await uploadPdf(ctx.base, tJar, 'sheet.pdf', buildSampleExamPdf());
  await api(ctx.base, tJar, '/api/teacher/record/assignments', {
    method: 'PUT',
    body: {
      id: assignmentId,
      classId,
      title: 'Bài ảnh',
      bookRef: '',
      instructions: 'Chụp bài',
      dueDateISO: '2026-12-15',
      requiredPageCount: 1,
      attachmentIds: [attId],
      createdAt: '2025-01-01T00:00:00.000Z',
    },
  });
  const { classId: examClassId } = await setupClassStudent(ctx, tJar);
  const { draft } = await importDraft(ctx, tJar, buildSampleExamPdf());
  const versionId = await publishDraft(ctx, tJar, draft);
  await api(ctx.base, tJar, '/api/teacher/exams/assignments', {
    method: 'POST',
    body: {
      versionId,
      classId: examClassId,
      title: 'Thi online',
      openAt: '2025-06-01T09:00:00.000Z',
      dueAt: '2025-06-01T12:00:00.000Z',
      timeLimitMinutes: 30,
      attemptLimit: 1,
    },
  });

  const teacherData = await api(ctx.base, tJar, '/api/data');
  assert.equal(teacherData.res.status, 200);
  const photoAsg = teacherData.data.data.assignments.find((a) => a.id === assignmentId);
  assert.ok(photoAsg, 'photo assignment must remain in assignments[]');
  assert.ok(photoAsg.attachments?.length >= 1, 'photo assignment attachments preserved');
  assert.ok(Array.isArray(teacherData.data.data.examDrafts));
  assert.ok(Array.isArray(teacherData.data.data.examAssignments));
  assert.ok(teacherData.data.data.examAssignments.length >= 1);
  assert.equal(
    teacherData.data.data.examAssignments.some((a) => a.classId === examClassId),
    true,
  );
});

test('exam: submit omits score when showScore is false', async (t) => {
  const ctx = await startBaTestServer({ initialNow: '2025-06-01T10:00:00.000Z' });
  t.after(async () => {
    await ctx.close();
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });
  const tJar = await teacherSetup(ctx);
  const { classId, sJar } = await setupClassStudent(ctx, tJar);
  const { draft } = await importDraft(ctx, tJar, buildSampleExamPdf());
  const versionId = await publishDraft(ctx, tJar, draft);
  const assign = await api(ctx.base, tJar, '/api/teacher/exams/assignments', {
    method: 'POST',
    body: {
      versionId,
      classId,
      title: 'Ẩn điểm',
      openAt: '2025-06-01T09:00:00.000Z',
      dueAt: '2025-06-01T12:00:00.000Z',
      timeLimitMinutes: 45,
      attemptLimit: 1,
      showScore: false,
      showAnswersAfter: 'after-due',
    },
  });
  const assignmentId = assign.data.assignmentId;
  const start = await api(ctx.base, sJar, '/api/student/exams/attempts/start', {
    method: 'POST',
    body: { assignmentId },
  });
  const attemptId = start.data.attemptId;
  let rev = 0;
  for (const q of draft.questions) {
    const save = await api(ctx.base, sJar, `/api/student/exams/attempts/${attemptId}/answers`, {
      method: 'POST',
      body: { questionId: q.id, optionId: q.correctOptionId, baseRevision: rev },
    });
    assert.equal(save.res.status, 200);
    rev = save.data.revision;
  }
  const submit = await api(ctx.base, sJar, `/api/student/exams/attempts/${attemptId}/submit`, {
    method: 'POST',
    body: {},
  });
  assert.equal(submit.res.status, 200);
  assert.equal('score10' in submit.data, false);
  assert.equal('correctCount' in submit.data, false);
});

test('exam: teacher student-preview API is owner-only', async (t) => {
  const ctx = await startBaTestServer({ initialNow: '2025-06-01T10:00:00.000Z' });
  t.after(async () => {
    await ctx.close();
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });
  const tJar = await teacherSetup(ctx);
  const { sJar } = await setupClassStudent(ctx, tJar);
  const { draft } = await importDraft(ctx, tJar, buildSampleExamPdf());
  const versionId = await publishDraft(ctx, tJar, draft);

  const teacherPrev = await api(ctx.base, tJar, `/api/teacher/exams/versions/${versionId}/student-preview`);
  assert.equal(teacherPrev.res.status, 200);
  assert.equal(teacherPrev.data.exam.questions[0].correctOptionId, undefined);

  const studentTry = await api(ctx.base, sJar, `/api/teacher/exams/versions/${versionId}/student-preview`);
  assert.equal(studentTry.res.status, 403);
});
