import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
  EXAM_DELIVERY_MODE,
  EXAM_PART_STATUS,
  EXAM_ATTEMPT_STATUS,
  EXAM_ATTEMPT_GRADING_STATUS,
  EXAM_SKILL,
  EXAM_QUESTION_TYPE,
  validateDraftForPublish,
  validateExamAssignmentInput,
  validateExamAssignmentDelivery,
  filterExamBankSources,
  filterExamQuestionsByMetadata,
  inferExamSkillFromQuestion,
  isPdfOnlyExamDraft,
  buildUnifiedExamStageApiContract,
  projectStudentPdfLayers,
  normalizeExamDeliveryMode,
  assignmentRequiredParts,
} from '../dist/exam-domain.js';
import { validateExamAudioBuffer } from '../server/exam-audio.mjs';
import { startBaTestServer, api, teacherSetup } from './ba-test-helpers.mjs';
import { buildSampleExamPdf } from './exam-fixtures.mjs';

function minimalMp3Buffer() {
  return Buffer.from([
    0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  ]);
}

function jarHeader(jar) {
  return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
}

async function uploadTeacherFile(base, jar, name, buffer, mime) {
  const res = await fetch(`${base}/api/teacher/attachments`, {
    method: 'POST',
    headers: {
      cookie: jarHeader(jar),
      'content-type': mime,
      'x-bn-csrf': jar.bn_csrf,
      'x-bn-filename': encodeURIComponent(name),
    },
    body: buffer,
  });
  const data = await res.json();
  assert.equal(res.status, 200, JSON.stringify(data));
  return data.id;
}

async function seedStudent(ctx, tJar, classId) {
  const studentId = randomUUID();
  await api(ctx.base, tJar, '/api/teacher/record/students', {
    method: 'PUT',
    body: { id: studentId, name: 'HS Unified', classId },
  });
  await api(ctx.base, tJar, '/api/teacher/accounts/students', {
    method: 'POST',
    body: { studentId, username: `hsu_${studentId.slice(0, 6)}`, temporaryPassword: 'temppass123' },
  });
  let sJar = (await api(ctx.base, {}, '/api/auth/csrf')).jar;
  const login = await api(ctx.base, sJar, '/api/auth/login', {
    method: 'POST',
    body: { username: `hsu_${studentId.slice(0, 6)}`, password: 'temppass123' },
  });
  sJar = login.jar;
  await api(ctx.base, sJar, '/api/auth/change-password', {
    method: 'POST',
    body: { currentPassword: '', newPassword: 'studentpass123' },
  });
  sJar = (await api(ctx.base, sJar, '/api/auth/login', {
    method: 'POST',
    body: { username: `hsu_${studentId.slice(0, 6)}`, password: 'studentpass123' },
  })).jar;
  return { studentId, sJar };
}

test('pdf-only publish allows empty questions with source PDF', () => {
  const draft = {
    title: 'PDF đề',
    sourceAttachmentId: 'att-pdf',
    explicitPdfOnly: true,
    questions: [],
    passages: [],
    sections: [],
    teacherConfirmedReview: true,
    needsReview: false,
  };
  assert.ok(isPdfOnlyExamDraft(draft));
  const v = validateDraftForPublish(draft);
  assert.equal(v.ok, true);
  assert.equal(v.pdfOnly, true);
});

test('filter semantics OR within skill/type AND across dimensions', () => {
  const questions = [
    { id: 'q1', questionType: EXAM_QUESTION_TYPE.SHORT_ANSWER, requiresAudio: true },
    { id: 'q2', questionType: EXAM_QUESTION_TYPE.ESSAY },
    { id: 'q3', questionType: EXAM_QUESTION_TYPE.SINGLE_CHOICE, skill: EXAM_SKILL.READING },
  ];
  const bySkill = filterExamQuestionsByMetadata(questions, {
    skills: [EXAM_SKILL.LISTENING, EXAM_SKILL.WRITING],
  });
  assert.deepEqual(bySkill.map((q) => q.id), ['q1', 'q2']);
  const byBoth = filterExamQuestionsByMetadata(questions, {
    skills: [EXAM_SKILL.READING],
    types: [EXAM_QUESTION_TYPE.SINGLE_CHOICE],
  });
  assert.deepEqual(byBoth.map((q) => q.id), ['q3']);
  const sources = filterExamBankSources([
    { id: 'a', questions },
    { id: 'b', questions: [{ id: 'x', questionType: EXAM_QUESTION_TYPE.ORAL_ASSESSMENT }] },
  ], { skills: [EXAM_SKILL.SPEAKING] });
  assert.equal(sources.length, 1);
  assert.equal(sources[0].id, 'b');
});

test('legacy assignment omits deliveryMode => online', () => {
  const now = () => '2025-06-01T12:00:00.000Z';
  const version = {
    questions: [{ id: 'q1' }],
    sourceAttachmentId: 'pdf1',
  };
  const v = validateExamAssignmentInput({
    openAt: '2025-01-01T00:00:00.000Z',
    dueAt: '2030-01-01T00:00:00.000Z',
    timeLimitMinutes: 30,
    attemptLimit: 1,
  }, now, version);
  assert.equal(v.ok, true);
  assert.equal(v.deliveryMode, EXAM_DELIVERY_MODE.ONLINE);
});

test('pdf-only version cannot be assigned online', () => {
  const version = { sourceAttachmentId: 'p', questions: [], sourcePdfPageCount: 2 };
  const d = validateExamAssignmentDelivery(version, { deliveryMode: 'online' });
  assert.equal(d.ok, false);
});

test('stage B/C API contract documents stable routes', () => {
  const c = buildUnifiedExamStageApiContract();
  assert.ok(c.studentPdfAnnotations.path.includes('pdf-annotations'));
  assert.ok(c.teacherPdfAnnotations.path.includes('pdf-annotations'));
  assert.ok(c.teacherVersionSourcePdf.path.includes('versions'));
  assert.ok(c.deliveryModes.includes('combined'));
});

test('student pdf projection hides unpublished teacher layer', () => {
  const assignment = {
    deliveryMode: EXAM_DELIVERY_MODE.PDF,
    selectedPdfPageIds: [1],
    requiredParts: { online: false, pdf: true },
  };
  const attempt = {
    status: EXAM_ATTEMPT_STATUS.SUBMITTED,
    partStatus: { pdf: EXAM_PART_STATUS.SUBMITTED },
    pdfSubmittedSnapshot: { 1: { strokes: [{ id: 's', points: [0, 0, 1, 1] }], texts: [] } },
    teacherPdfAnnotations: { 1: { strokes: [{ id: 't', points: [0.2, 0.2, 0.3, 0.3] }], texts: [] } },
    pdfFeedbackPublished: false,
    pdfManualGrade: { score: 8, maxPoints: 10, feedback: 'draft' },
  };
  const layers = projectStudentPdfLayers(attempt, assignment);
  assert.equal(Object.keys(layers.teacherPages).length, 0);
  assert.equal(layers.pdfFeedback, null);
  attempt.pdfFeedbackPublished = true;
  const pub = projectStudentPdfLayers(attempt, assignment);
  assert.ok(pub.teacherPages['1']);
  assert.equal(pub.pdfFeedback.score, 8);
});

test('audio sniff rejects non-audio bytes', () => {
  const bad = validateExamAudioBuffer(Buffer.from('%PDF-1.4'), 'x.pdf', 'application/pdf');
  assert.equal(bad.ok, false);
  const ok = validateExamAudioBuffer(minimalMp3Buffer(), 'a.mp3', 'audio/mpeg');
  assert.equal(ok.ok, true);
});

test('API: teacher may stream version source PDF without assignment', async (t) => {
  const ctx = await startBaTestServer({ initialNow: '2025-06-01T12:00:00.000Z' });
  t.after(async () => {
    await ctx.close();
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });
  const tJar = await teacherSetup(ctx);
  const me = await api(ctx.base, tJar, '/api/auth/me');
  const teacherId = me.data.user.id;
  const pdfAtt = await uploadTeacherFile(ctx.base, tJar, 'bank.pdf', buildSampleExamPdf(), 'application/pdf');
  const versionId = randomUUID();
  const foreignVersionId = randomUUID();
  const { createStore } = await import('../server/store.mjs');
  const store = createStore(ctx.dataDir);
  await store.mutate((s) => {
    s.examVersions.push({
      id: versionId,
      teacherAccountId: teacherId,
      title: 'PDF bank',
      sourceAttachmentId: pdfAtt,
      sourcePdfPageCount: 2,
      questions: [],
      sections: [],
      passages: [],
      pdfOnly: true,
      gradingMode: 'teacher-manual-later',
      publishedAt: '2025-01-01T00:00:00.000Z',
    });
    s.examVersions.push({
      id: foreignVersionId,
      teacherAccountId: randomUUID(),
      title: 'Foreign PDF',
      sourceAttachmentId: pdfAtt,
      sourcePdfPageCount: 2,
      questions: [],
      sections: [],
      passages: [],
      pdfOnly: true,
      publishedAt: '2025-01-01T00:00:00.000Z',
    });
  });
  await store.close();
  const ok = await fetch(`${ctx.base}/api/teacher/exams/versions/${versionId}/source-pdf`, {
    headers: { cookie: jarHeader(tJar) },
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('content-type'), 'application/pdf');
  const denyForeign = await fetch(`${ctx.base}/api/teacher/exams/versions/${foreignVersionId}/source-pdf`, {
    headers: { cookie: jarHeader(tJar) },
  });
  assert.equal(denyForeign.status, 404);

  const denyAnon = await fetch(`${ctx.base}/api/teacher/exams/versions/${versionId}/source-pdf`);
  assert.equal(denyAnon.status, 401);
});

test('API: pdf-only assignment annotate submit-part final pending grade', async (t) => {
  const ctx = await startBaTestServer({ initialNow: '2025-06-01T12:00:00.000Z' });
  t.after(async () => {
    await ctx.close();
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });
  const tJar = await teacherSetup(ctx);
  const me = await api(ctx.base, tJar, '/api/auth/me');
  const teacherId = me.data.user.id;
  const classId = randomUUID();
  await api(ctx.base, tJar, '/api/teacher/record/classes', {
    method: 'PUT',
    body: {
      id: classId,
      name: 'Lớp PDF',
      scheduleDays: ['Thứ 2'],
      scheduleTime: '18:00',
      createdAt: '2025-01-01T00:00:00.000Z',
    },
  });
  const pdfAtt = await uploadTeacherFile(ctx.base, tJar, 'sheet.pdf', buildSampleExamPdf(), 'application/pdf');
  const versionId = randomUUID();
  const assignmentId = randomUUID();
  const { createStore } = await import('../server/store.mjs');
  const store = createStore(ctx.dataDir);
  await store.mutate((s) => {
    s.examVersions.push({
      id: versionId,
      teacherAccountId: teacherId,
      title: 'PDF only',
      sourceAttachmentId: pdfAtt,
      sourcePdfPageCount: 2,
      questions: [],
      sections: [],
      passages: [],
      pdfOnly: true,
      gradingMode: 'teacher-manual-later',
      publishedAt: '2025-01-01T00:00:00.000Z',
    });
    s.examAssignments.push({
      id: assignmentId,
      teacherAccountId: teacherId,
      versionId,
      classId,
      title: 'Giao PDF',
      openAt: '2025-01-01T00:00:00.000Z',
      dueAt: '2035-01-01T00:00:00.000Z',
      timeLimitMinutes: 60,
      attemptLimit: 1,
      deliveryMode: EXAM_DELIVERY_MODE.PDF,
      selectedPdfPageIds: [1],
      pdfPartPoints: 10,
      sourcePdfAttachmentId: pdfAtt,
      requiredParts: { online: false, pdf: true },
    });
  });
  await store.close();

  const { sJar } = await seedStudent(ctx, tJar, classId);
  const start = await api(ctx.base, sJar, '/api/student/exams/attempts/start', {
    method: 'POST',
    body: { assignmentId },
  });
  assert.equal(start.res.status, 200);
  const attemptId = start.data.attemptId;

  const pdfRes = await fetch(`${ctx.base}/api/student/exams/assignments/${assignmentId}/source-pdf`, {
    headers: { cookie: jarHeader(sJar) },
  });
  assert.equal(pdfRes.status, 200);
  assert.equal(pdfRes.headers.get('content-type'), 'application/pdf');

  const stale = await api(ctx.base, sJar, `/api/student/exams/attempts/${attemptId}/pdf-annotations`, {
    method: 'POST',
    body: {
      page: 99,
      strokes: [],
      texts: [],
      viewport: { width: 100, height: 100, pageWidth: 100, pageHeight: 100 },
      baseRevision: 0,
    },
  });
  assert.equal(stale.res.status, 400);

  const save = await api(ctx.base, sJar, `/api/student/exams/attempts/${attemptId}/pdf-annotations`, {
    method: 'POST',
    body: {
      page: 1,
      strokes: [{ id: 's1', points: [0, 0, 1, 1] }],
      texts: [],
      viewport: { width: 600, height: 800, pageWidth: 600, pageHeight: 800 },
      baseRevision: 0,
    },
  });
  assert.equal(save.res.status, 200);
  assert.equal(save.data.revision, 1);

  const earlyFinal = await api(ctx.base, sJar, `/api/student/exams/attempts/${attemptId}/submit`, {
    method: 'POST',
    body: {},
  });
  assert.equal(earlyFinal.res.status, 400);

  const part = await api(ctx.base, sJar, `/api/student/exams/attempts/${attemptId}/submit-part`, {
    method: 'POST',
    body: { part: 'pdf' },
  });
  assert.equal(part.res.status, 200);
  assert.equal(part.data.readyForFinalSubmit, true);

  const sub = await api(ctx.base, sJar, `/api/student/exams/attempts/${attemptId}/submit`, {
    method: 'POST',
    body: {},
  });
  assert.equal(sub.res.status, 200);
  assert.equal(sub.data.gradingStatus, EXAM_ATTEMPT_GRADING_STATUS.PENDING);

  const grade = await api(ctx.base, tJar, `/api/teacher/exams/attempts/${attemptId}/pdf-manual-grade`, {
    method: 'PUT',
    body: { score: 8, feedback: 'Ổn', baseRevision: 0 },
  });
  assert.equal(grade.res.status, 200);
  assert.equal(grade.data.gradingStatus, EXAM_ATTEMPT_GRADING_STATUS.COMPLETE);

  const tAnn = await api(ctx.base, tJar, `/api/teacher/exams/attempts/${attemptId}/pdf-annotations`, {
    method: 'POST',
    body: {
      page: 1,
      strokes: [{ id: 'tf', points: [0.1, 0.1, 0.2, 0.2] }],
      texts: [],
      viewport: { width: 600, height: 800, pageWidth: 600, pageHeight: 800 },
      baseRevision: 0,
    },
  });
  assert.equal(tAnn.res.status, 200);
  assert.equal(tAnn.data.revision, 1);

  const pubGrade = await api(ctx.base, tJar, `/api/teacher/exams/attempts/${attemptId}/pdf-manual-grade`, {
    method: 'PUT',
    body: { score: 8, feedback: 'OK', baseRevision: 1, publishFeedback: true },
  });
  assert.equal(pubGrade.res.status, 200);

  const studentDetail = await api(ctx.base, sJar, `/api/student/exams/assignments/${assignmentId}`);
  assert.ok(studentDetail.data.exam.attempt.pdfLayers.teacherPages['1']);
});

test('API: combined requires both parts; student cannot spoof deliveryMode', async (t) => {
  const ctx = await startBaTestServer({ initialNow: '2025-06-01T12:00:00.000Z' });
  t.after(async () => {
    await ctx.close();
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });
  const tJar = await teacherSetup(ctx);
  const me = await api(ctx.base, tJar, '/api/auth/me');
  const teacherId = me.data.user.id;
  const classId = randomUUID();
  await api(ctx.base, tJar, '/api/teacher/record/classes', {
    method: 'PUT',
    body: {
      id: classId,
      name: 'Lớp mix',
      scheduleDays: ['Thứ 2'],
      scheduleTime: '18:00',
      createdAt: '2025-01-01T00:00:00.000Z',
    },
  });
  const pdfAtt = await uploadTeacherFile(ctx.base, tJar, 'mix.pdf', buildSampleExamPdf(), 'application/pdf');
  const versionId = randomUUID();
  const assignmentId = randomUUID();
  const { createStore } = await import('../server/store.mjs');
  const store = createStore(ctx.dataDir);
  await store.mutate((s) => {
    s.examVersions.push({
      id: versionId,
      teacherAccountId: teacherId,
      title: 'Combined',
      sourceAttachmentId: pdfAtt,
      sourcePdfPageCount: 2,
      sections: [{ id: 's1', title: 'P1', order: 1 }],
      questions: [{
        id: 'q1',
        sectionId: 's1',
        displayNumber: '1',
        stemText: 'Pick A',
        options: [{ id: 'A', text: 'a' }, { id: 'B', text: 'b' }],
        correctOptionId: 'A',
        points: 2,
      }],
      passages: [],
      gradingMode: 'automatic',
      confirmedAnswerKey: { q1: 'A' },
      publishedAt: '2025-01-01T00:00:00.000Z',
    });
    s.examAssignments.push({
      id: assignmentId,
      teacherAccountId: teacherId,
      versionId,
      classId,
      title: 'Combined assign',
      openAt: '2025-01-01T00:00:00.000Z',
      dueAt: '2035-01-01T00:00:00.000Z',
      timeLimitMinutes: 60,
      attemptLimit: 1,
      deliveryMode: EXAM_DELIVERY_MODE.COMBINED,
      selectedPdfPageIds: [1, 2],
      pdfPartPoints: 8,
      sourcePdfAttachmentId: pdfAtt,
      requiredParts: assignmentRequiredParts({ deliveryMode: EXAM_DELIVERY_MODE.COMBINED }),
    });
  });
  await store.close();
  const { sJar } = await seedStudent(ctx, tJar, classId);
  const start = await api(ctx.base, sJar, '/api/student/exams/attempts/start', {
    method: 'POST',
    body: { assignmentId },
  });
  const attemptId = start.data.attemptId;

  const spoof = await api(ctx.base, sJar, `/api/student/exams/attempts/${attemptId}/pdf-annotations`, {
    method: 'POST',
    body: {
      deliveryMode: 'online',
      page: 1,
      strokes: [],
      texts: [],
      viewport: { width: 1, height: 1, pageWidth: 1, pageHeight: 1 },
      baseRevision: 0,
    },
  });
  assert.equal(spoof.res.status, 400);

  await api(ctx.base, sJar, `/api/student/exams/attempts/${attemptId}/answers`, {
    method: 'POST',
    body: { questionId: 'q1', optionId: 'A', baseRevision: 0 },
  });
  const onlinePart = await api(ctx.base, sJar, `/api/student/exams/attempts/${attemptId}/submit-part`, {
    method: 'POST',
    body: { part: 'online' },
  });
  assert.equal(onlinePart.res.status, 200);
  assert.equal(onlinePart.data.readyForFinalSubmit, false);

  await api(ctx.base, sJar, `/api/student/exams/attempts/${attemptId}/pdf-annotations`, {
    method: 'POST',
    body: {
      page: 1,
      strokes: [{ id: 'a', points: [0, 0] }],
      texts: [],
      viewport: { width: 10, height: 10, pageWidth: 10, pageHeight: 10 },
      baseRevision: 0,
    },
  });
  const pdfPart = await api(ctx.base, sJar, `/api/student/exams/attempts/${attemptId}/submit-part`, {
    method: 'POST',
    body: { part: 'pdf' },
  });
  assert.equal(pdfPart.data.readyForFinalSubmit, true);

  const fin = await api(ctx.base, sJar, `/api/student/exams/attempts/${attemptId}/submit`, {
    method: 'POST',
    body: {},
  });
  assert.equal(fin.res.status, 200);
  assert.equal(fin.data.gradingStatus, EXAM_ATTEMPT_GRADING_STATUS.PARTIAL);
});

test('API: media replace on assigned version requires ack; snapshot preserved on submit', async (t) => {
  const ctx = await startBaTestServer({ initialNow: '2025-06-01T12:00:00.000Z' });
  t.after(async () => {
    await ctx.close();
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });
  const tJar = await teacherSetup(ctx);
  const me = await api(ctx.base, tJar, '/api/auth/me');
  const teacherId = me.data.user.id;
  const audio1 = await uploadTeacherFile(ctx.base, tJar, 'a1.mp3', minimalMp3Buffer(), 'audio/mpeg');
  const versionId = randomUUID();
  const assignmentId = randomUUID();
  const classId = randomUUID();
  await api(ctx.base, tJar, '/api/teacher/record/classes', {
    method: 'PUT',
    body: {
      id: classId,
      name: 'Audio',
      scheduleDays: ['Thứ 2'],
      scheduleTime: '18:00',
      createdAt: '2025-01-01T00:00:00.000Z',
    },
  });
  const { createStore } = await import('../server/store.mjs');
  const store = createStore(ctx.dataDir);
  await store.mutate((s) => {
    s.examVersions.push({
      id: versionId,
      teacherAccountId: teacherId,
      title: 'Listen',
      sourceAttachmentId: null,
      sourcePdfPageCount: 0,
      sections: [{ id: 's1', title: 'P', order: 1 }],
      questions: [{
        id: 'q1',
        sectionId: 's1',
        displayNumber: '1',
        stemText: 'L',
        requiresAudio: true,
        options: [{ id: 'A', text: 'a' }, { id: 'B', text: 'b' }],
        correctOptionId: 'A',
        points: 1,
      }],
      passages: [],
      audioAttachmentId: audio1,
      audioState: 'available',
      mediaRevision: 0,
      classroomPlaybackAllowed: true,
      gradingMode: 'automatic',
      confirmedAnswerKey: { q1: 'A' },
      publishedAt: '2025-01-01T00:00:00.000Z',
    });
    s.examAssignments.push({
      id: assignmentId,
      teacherAccountId: teacherId,
      versionId,
      classId,
      title: 'Audio assign',
      openAt: '2025-01-01T00:00:00.000Z',
      dueAt: '2035-01-01T00:00:00.000Z',
      timeLimitMinutes: 60,
      attemptLimit: 1,
      mediaSnapshot: {
        audioAttachmentId: audio1,
        audioState: 'available',
        mediaRevision: 0,
        classroomPlaybackAllowed: true,
      },
    });
    s.examAttempts.push({
      id: randomUUID(),
      assignmentId,
      versionId,
      studentId: randomUUID(),
      status: EXAM_ATTEMPT_STATUS.SUBMITTED,
      startedAt: '2025-06-01T10:00:00.000Z',
      submittedAt: '2025-06-01T11:00:00.000Z',
      answers: { q1: 'A' },
      submissionMediaSnapshot: {
        audioAttachmentId: audio1,
        audioState: 'available',
        mediaRevision: 0,
        classroomPlaybackAllowed: true,
      },
    });
  });
  await store.close();

  const noAck = await api(ctx.base, tJar, `/api/teacher/exams/versions/${versionId}/media`, {
    method: 'PUT',
    body: { action: 'remove', baseMediaRevision: 0 },
  });
  assert.equal(noAck.res.status, 400);

  const audio2 = await uploadTeacherFile(ctx.base, tJar, 'a2.mp3', minimalMp3Buffer(), 'audio/mpeg');
  const withAck = await api(ctx.base, tJar, `/api/teacher/exams/versions/${versionId}/media`, {
    method: 'PUT',
    body: {
      action: 'replace',
      audioAttachmentId: audio2,
      baseMediaRevision: 0,
      acknowledgeMediaChange: true,
    },
  });
  assert.equal(withAck.res.status, 200);
  assert.equal(withAck.data.mediaRevision, 1);

  const verifyStore = createStore(ctx.dataDir);
  try {
    const state2 = await verifyStore.read();
    const oldAttempt = state2.examAttempts.find((a) => a.assignmentId === assignmentId);
    assert.equal(oldAttempt.submissionMediaSnapshot.audioAttachmentId, audio1);
  } finally {
    await verifyStore.close();
  }
});

test('inferExamSkill conservative defaults', () => {
  assert.equal(inferExamSkillFromQuestion({ requiresAudio: true }), EXAM_SKILL.LISTENING);
  assert.equal(
    inferExamSkillFromQuestion({ questionType: EXAM_QUESTION_TYPE.ESSAY }),
    EXAM_SKILL.WRITING,
  );
  assert.equal(normalizeExamDeliveryMode({}), EXAM_DELIVERY_MODE.ONLINE);
});
