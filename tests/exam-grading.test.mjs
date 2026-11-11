import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  startBaTestServer,
  api,
  teacherSetup,
  loadTeacherData,
} from './ba-test-helpers.mjs';
import {
  buildSampleExamPdf,
  waitForImportJob,
} from './exam-fixtures.mjs';
import { EXAM_GRADING_MODE, EXAM_ATTEMPT_GRADING_STATUS, EXAM_ATTEMPT_STATUS } from '../dist/exam-domain.js';
import { STATE_FILE, SQLITE_FILE } from '../server/store-state.mjs';

function jarHeader(jar) {
  return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
}

function attachServerCleanup(t, ctx) {
  t.after(async () => {
    await ctx.close();
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });
}

/** In-progress / ungraded rows may omit score10 (undefined) or use null; never a number. */
function assertNoScore10(score10) {
  assert.ok(score10 == null, `expected absent score, got ${score10}`);
  assert.notEqual(typeof score10, 'number');
}

async function uploadPdf(base, jar, buffer) {
  const res = await fetch(`${base}/api/teacher/attachments`, {
    method: 'POST',
    headers: {
      cookie: jarHeader(jar),
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

async function createStudentAccount(ctx, tJar, classId, { username, name }) {
  const studentId = randomUUID();
  await api(ctx.base, tJar, '/api/teacher/record/students', {
    method: 'PUT',
    body: { id: studentId, name, classId },
  });
  await api(ctx.base, tJar, '/api/teacher/accounts/students', {
    method: 'POST',
    body: { studentId, username, temporaryPassword: 'temppass123' },
  });
  let sJar = (await api(ctx.base, {}, '/api/auth/csrf')).jar;
  const login = await api(ctx.base, sJar, '/api/auth/login', {
    method: 'POST',
    body: { username, password: 'temppass123' },
  });
  assert.equal(login.res.status, 200);
  sJar = login.jar;
  const changed = await api(ctx.base, sJar, '/api/auth/change-password', {
    method: 'POST',
    body: { currentPassword: '', newPassword: 'studentpass123' },
  });
  assert.equal(changed.res.status, 200);
  return { studentId, sJar: changed.jar };
}

async function setupClassTwoStudents(ctx, tJar) {
  const classId = randomUUID();
  await api(ctx.base, tJar, '/api/teacher/record/classes', {
    method: 'PUT',
    body: {
      id: classId,
      name: 'Lớp chấm',
      scheduleDays: ['Thứ 3'],
      scheduleTime: '18:00',
      createdAt: '2025-01-01T00:00:00.000Z',
    },
  });
  const s1 = await createStudentAccount(ctx, tJar, classId, { username: 'hsgrade1', name: 'HS1' });
  const s2 = await createStudentAccount(ctx, tJar, classId, { username: 'hsgrade2', name: 'HS2' });
  return { classId, ...s1, s2Jar: s2.sJar, student2Id: s2.studentId };
}

async function importDraftWithoutKeys(ctx, tJar) {
  const attId = await uploadPdf(ctx.base, tJar, buildSampleExamPdf());
  const started = await api(ctx.base, tJar, '/api/teacher/exams/imports', {
    method: 'POST',
    body: { sourceAttachmentId: attId, keyPages: [2], title: 'Thi' },
  });
  assert.equal(started.res.status, 200);
  const job = await waitForImportJob(ctx.base, tJar, started.data.jobId);
  const draftRes = await api(ctx.base, tJar, `/api/teacher/exams/drafts/${job.draftId}`);
  assert.equal(draftRes.res.status, 200);
  const draft = draftRes.data.draft;
  assert.ok((draft.questions || []).length >= 2, 'fixture PDF must expose at least 2 questions');
  const questions = draft.questions.slice(0, 2).map((q) => ({ ...q, correctOptionId: null }));
  const saved = await api(ctx.base, tJar, `/api/teacher/exams/drafts/${draft.id}`, {
    method: 'PUT',
    body: {
      title: draft.title,
      questions,
      passages: draft.passages,
      sections: draft.sections,
      teacherConfirmedReview: true,
      gradingMode: EXAM_GRADING_MODE.TEACHER_MANUAL_LATER,
      baseRevision: draft.revision,
    },
  });
  assert.equal(saved.res.status, 200);
  return {
    ...draft,
    questions,
    revision: saved.data.revision,
    gradingMode: EXAM_GRADING_MODE.TEACHER_MANUAL_LATER,
  };
}

async function answerAndSubmit(ctx, sJar, assignmentId, questions, picks) {
  const start = await api(ctx.base, sJar, '/api/student/exams/attempts/start', {
    method: 'POST',
    body: { assignmentId },
  });
  assert.equal(start.res.status, 200);
  const attemptId = start.data.attemptId;
  let rev = 0;
  for (let i = 0; i < questions.length; i += 1) {
    const q = questions[i];
    const opt = picks[i] ?? q.options[0].id;
    const save = await api(ctx.base, sJar, `/api/student/exams/attempts/${attemptId}/answers`, {
      method: 'POST',
      body: { questionId: q.id, optionId: opt, baseRevision: rev },
    });
    assert.equal(save.res.status, 200);
    rev = save.data.revision;
  }
  const sub = await api(ctx.base, sJar, `/api/student/exams/attempts/${attemptId}/submit`, {
    method: 'POST',
    body: {},
  });
  assert.equal(sub.res.status, 200);
  return { attemptId, submit: sub.data };
}

function assertStoreBacked(dataDir) {
  const sqlitePath = path.join(dataDir, SQLITE_FILE);
  const jsonPath = path.join(dataDir, STATE_FILE);
  assert.ok(fs.existsSync(sqlitePath) || fs.existsSync(jsonPath), 'expected persisted store on disk');
}

test('exam grading: shared version two students partial keys regrades in-progress untouched', async (t) => {
  const ctx = await startBaTestServer({ initialNow: '2025-06-01T12:00:00.000Z' });
  attachServerCleanup(t, ctx);
  const tJar = await teacherSetup(ctx);
  const { classId, sJar, s2Jar } = await setupClassTwoStudents(ctx, tJar);

  const draft = await importDraftWithoutKeys(ctx, tJar);
  const pub = await api(ctx.base, tJar, `/api/teacher/exams/drafts/${draft.id}/publish`, {
    method: 'POST',
    body: {},
  });
  assert.equal(pub.res.status, 200, pub.data?.error);
  const versionId = pub.data.versionId;

  const autoDraft = await importDraftWithoutKeys(ctx, tJar);
  await api(ctx.base, tJar, `/api/teacher/exams/drafts/${autoDraft.id}`, {
    method: 'PUT',
    body: {
      title: autoDraft.title,
      questions: autoDraft.questions,
      passages: autoDraft.passages,
      sections: autoDraft.sections,
      teacherConfirmedReview: true,
      gradingMode: EXAM_GRADING_MODE.AUTOMATIC,
      baseRevision: autoDraft.revision,
    },
  });
  const pubFail = await api(ctx.base, tJar, `/api/teacher/exams/drafts/${autoDraft.id}/publish`, {
    method: 'POST',
    body: {},
  });
  assert.equal(pubFail.res.status, 400);

  const assign = await api(ctx.base, tJar, '/api/teacher/exams/assignments', {
    method: 'POST',
    body: {
      versionId,
      classId,
      title: 'Giao',
      openAt: '2025-06-01T00:00:00.000Z',
      dueAt: '2035-06-02T00:00:00.000Z',
      timeLimitMinutes: 60,
      attemptLimit: 2,
      showScore: true,
      showAnswersAfter: 'after-submit',
    },
  });
  assert.equal(assign.res.status, 200);
  const assignmentId = assign.data.assignmentId;
  const [q1, q2] = draft.questions;
  const correctPick = [q1.options[0].id, q2.options[1].id ?? q2.options[0].id];

  const sub1 = await answerAndSubmit(ctx, sJar, assignmentId, draft.questions, correctPick);
  assert.equal(sub1.submit.score10, undefined);
  assert.equal(sub1.submit.gradingStatus, EXAM_ATTEMPT_GRADING_STATUS.PENDING);

  const sub2 = await answerAndSubmit(ctx, s2Jar, assignmentId, draft.questions, correctPick);
  assert.equal(sub2.submit.gradingStatus, EXAM_ATTEMPT_GRADING_STATUS.PENDING);

  const inProgressStart = await api(ctx.base, sJar, '/api/student/exams/attempts/start', {
    method: 'POST',
    body: { assignmentId },
  });
  assert.equal(inProgressStart.res.status, 200);
  const inProgressId = inProgressStart.data.attemptId;

  const partialKey = await api(ctx.base, tJar, `/api/teacher/exams/versions/${versionId}/answer-key`, {
    method: 'PUT',
    body: { keys: { [q2.id]: correctPick[1] }, baseRevision: 1 },
  });
  assert.equal(partialKey.res.status, 200);
  assert.ok(partialKey.data.regradedCount >= 2);

  assertStoreBacked(ctx.dataDir);
  const gradingAfterPartial = await api(
    ctx.base,
    tJar,
    `/api/teacher/exams/assignments/${assignmentId}/grading`,
  );
  assert.equal(gradingAfterPartial.res.status, 200);
  assert.equal(gradingAfterPartial.data.version.confirmedAnswerKey?.[q2.id], correctPick[1]);
  assert.equal(gradingAfterPartial.data.version.confirmedAnswerKey?.[q1.id], undefined);
  const teacherSnap = await loadTeacherData(ctx, tJar);
  assert.ok((teacherSnap.examAssignments || []).some((a) => a.id === assignmentId));

  const detail1 = await api(ctx.base, sJar, `/api/student/exams/assignments/${assignmentId}`);
  assert.equal(detail1.data.exam.result, null);
  assert.equal(detail1.data.exam.attempt.id, inProgressId);
  assert.equal(detail1.data.exam.attempt.status, EXAM_ATTEMPT_STATUS.IN_PROGRESS);
  assert.equal(detail1.data.exam.attempt.gradingStatus, null);

  const detail2 = await api(ctx.base, s2Jar, `/api/student/exams/assignments/${assignmentId}`);
  assert.equal(detail2.data.exam.result.gradingStatus, EXAM_ATTEMPT_GRADING_STATUS.PARTIAL);
  assert.equal(detail2.data.exam.result.score10, null);

  const gradingPanel = await api(ctx.base, tJar, `/api/teacher/exams/assignments/${assignmentId}/grading`);
  assert.equal(gradingPanel.res.status, 200);
  assert.equal(gradingPanel.data.attempts.length, 2);
  const sub1TeacherRow = gradingPanel.data.attempts.find((r) => r.attemptId === sub1.attemptId);
  const sub2TeacherRow = gradingPanel.data.attempts.find((r) => r.attemptId === sub2.attemptId);
  assert.equal(sub1TeacherRow.gradingStatus, EXAM_ATTEMPT_GRADING_STATUS.PARTIAL);
  assert.equal(sub2TeacherRow.gradingStatus, EXAM_ATTEMPT_GRADING_STATUS.PARTIAL);

  const assignSummary = await api(
    ctx.base,
    tJar,
    `/api/teacher/exams/assignments/${assignmentId}/summary`,
  );
  const sub1SummaryRow = assignSummary.data.summary.find((r) => r.attemptId === sub1.attemptId);
  assert.equal(sub1SummaryRow.gradingStatus, EXAM_ATTEMPT_GRADING_STATUS.PARTIAL);

  const inProgRow = assignSummary.data.summary.find((r) => r.attemptId === inProgressId);
  assert.equal(inProgRow.status, EXAM_ATTEMPT_STATUS.IN_PROGRESS);
  assertNoScore10(inProgRow.score10);
  assert.equal(inProgRow.gradingStatus, null);

  const completeKey = await api(ctx.base, tJar, `/api/teacher/exams/versions/${versionId}/answer-key`, {
    method: 'PUT',
    body: {
      keys: { [q1.id]: correctPick[0], [q2.id]: correctPick[1] },
      baseRevision: partialKey.data.answerKeyRevision,
    },
  });
  assert.equal(completeKey.res.status, 200);
  assert.ok(completeKey.data.regradedCount >= 2);

  const after1 = await api(ctx.base, sJar, `/api/student/exams/assignments/${assignmentId}`);
  assert.equal(after1.data.exam.result, null);
  assert.equal(after1.data.exam.attempt.id, inProgressId);

  const after2 = await api(ctx.base, s2Jar, `/api/student/exams/assignments/${assignmentId}`);
  assert.equal(after2.data.exam.result.score10, 10);

  const gradingComplete = await api(
    ctx.base,
    tJar,
    `/api/teacher/exams/assignments/${assignmentId}/grading`,
  );
  assert.equal(
    gradingComplete.data.attempts.find((r) => r.attemptId === sub1.attemptId).score10,
    10,
  );
  assert.equal(
    gradingComplete.data.attempts.find((r) => r.attemptId === sub2.attemptId).score10,
    10,
  );

  const inProgAfter = (await api(
    ctx.base,
    tJar,
    `/api/teacher/exams/assignments/${assignmentId}/summary`,
  )).data.summary.find((r) => r.attemptId === inProgressId);
  assert.equal(inProgAfter.status, EXAM_ATTEMPT_STATUS.IN_PROGRESS);
  assertNoScore10(inProgAfter.score10);

  const studentWrite = await api(ctx.base, sJar, `/api/teacher/exams/versions/${versionId}/answer-key`, {
    method: 'PUT',
    body: { keys: { [q1.id]: q1.options[1]?.id || q1.options[0].id }, baseRevision: 1 },
  });
  assert.equal(studentWrite.res.status, 403);

  const studentGrading = await api(ctx.base, sJar, `/api/teacher/exams/assignments/${assignmentId}/grading`);
  assert.equal(studentGrading.res.status, 403);

  const wrongOverwrite = await api(ctx.base, tJar, `/api/teacher/exams/versions/${versionId}/answer-key`, {
    method: 'PUT',
    body: { keys: { [q1.id]: q1.options[1]?.id || q1.options[0].id }, baseRevision: completeKey.data.answerKeyRevision },
  });
  assert.equal(wrongOverwrite.res.status, 409);
  assert.ok(wrongOverwrite.data?.conflicts?.length);

  const confirmedOverwrite = await api(ctx.base, tJar, `/api/teacher/exams/versions/${versionId}/answer-key`, {
    method: 'PUT',
    body: {
      keys: { [q1.id]: q1.options[1]?.id || q1.options[0].id },
      baseRevision: completeKey.data.answerKeyRevision,
      confirmOverwrite: true,
    },
  });
  assert.equal(confirmedOverwrite.res.status, 200);
  assert.ok(confirmedOverwrite.data.regradedCount >= 2);

  const rescoredTeacher = await api(
    ctx.base,
    tJar,
    `/api/teacher/exams/assignments/${assignmentId}/grading`,
  );
  assert.equal(
    rescoredTeacher.data.attempts.find((r) => r.attemptId === sub1.attemptId).score10,
    5,
  );
  assert.equal(
    rescoredTeacher.data.attempts.find((r) => r.attemptId === sub2.attemptId).score10,
    5,
  );

  const rescored = await api(ctx.base, sJar, `/api/student/exams/assignments/${assignmentId}`);
  assert.equal(rescored.data.exam.result, null);
});

test('exam grading: answer-key revision conflict returns 409', async (t) => {
  const ctx = await startBaTestServer({ initialNow: '2025-06-01T12:00:00.000Z' });
  attachServerCleanup(t, ctx);
  const tJar = await teacherSetup(ctx, 'tchr2');
  const draft = await importDraftWithoutKeys(ctx, tJar);
  const pub = await api(ctx.base, tJar, `/api/teacher/exams/drafts/${draft.id}/publish`, { method: 'POST', body: {} });
  const versionId = pub.data.versionId;
  const q1 = draft.questions[0];
  const missingRev = await api(ctx.base, tJar, `/api/teacher/exams/versions/${versionId}/answer-key`, {
    method: 'PUT',
    body: { keys: { [q1.id]: q1.options[0].id } },
  });
  assert.equal(missingRev.res.status, 400);
  const badRev = await api(ctx.base, tJar, `/api/teacher/exams/versions/${versionId}/answer-key`, {
    method: 'PUT',
    body: { keys: { [q1.id]: q1.options[0].id }, baseRevision: 0 },
  });
  assert.equal(badRev.res.status, 400);
  const first = await api(ctx.base, tJar, `/api/teacher/exams/versions/${versionId}/answer-key`, {
    method: 'PUT',
    body: { keys: { [q1.id]: q1.options[0].id }, baseRevision: 1 },
  });
  assert.equal(first.res.status, 200);
  const idempotent = await api(ctx.base, tJar, `/api/teacher/exams/versions/${versionId}/answer-key`, {
    method: 'PUT',
    body: { keys: { [q1.id]: q1.options[0].id }, baseRevision: first.data.answerKeyRevision },
  });
  assert.equal(idempotent.res.status, 200);
  assert.equal(idempotent.data.idempotent, true);
  assert.equal(idempotent.data.answerKeyRevision, first.data.answerKeyRevision);
  assert.equal(idempotent.data.regradedCount, 0);
  const stale = await api(ctx.base, tJar, `/api/teacher/exams/versions/${versionId}/answer-key`, {
    method: 'PUT',
    body: { keys: { [q1.id]: q1.options[1]?.id || q1.options[0].id }, baseRevision: 1 },
  });
  assert.equal(stale.res.status, 409);
});
