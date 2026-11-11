import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
  EXAM_QUESTION_TYPE,
  EXAM_ATTEMPT_GRADING_STATUS,
  EXAM_ATTEMPT_STATUS,
  EXAM_GRADING_MODE,
  normalizeExamQuestionType,
  isChoiceBasedQuestion,
  isManualOnlyQuestion,
  isStudentResponseQuestion,
  summarizeExamItems,
  gradeAttempt,
  mergeVersionTextAnswerKeyUpdate,
  resolveTextAnswerKey,
  validateAttemptAnswerPatch,
  validateAttemptAnswersForSubmit,
  projectExamVersionForStudent,
  regradeSubmittedAttemptsForVersion,
  validateDraftForPublish,
  shortAnswerTextsMatch,
} from '../dist/exam-domain.js';
import { startBaTestServer, api, teacherSetup } from './ba-test-helpers.mjs';
import { resolveAttemptVersion, teacherOwnsExamAttempt } from '../server/exam-state.mjs';

function mixedFixtureVersion() {
  const passageId = 'grp_wb';
  return {
    id: 'v-mixed',
    title: 'Mixed',
    gradingMode: EXAM_GRADING_MODE.AUTOMATIC,
    sections: [{ id: 's1', title: 'Phần 1', order: 1 }],
    passages: [{
      id: passageId,
      sectionId: 's1',
      title: 'Word bank',
      bodyText: 'ctx',
      sourceWordBankUseOnce: true,
      wordBankWords: [{ id: 'w1', text: 'alpha' }, { id: 'w2', text: 'beta' }],
    }],
    questions: [
      {
        id: 'q_mcq',
        sectionId: 's1',
        displayNumber: '1',
        stemText: 'MCQ',
        options: [{ id: 'A', text: 'a' }, { id: 'B', text: 'b' }],
        correctOptionId: 'A',
        points: 2,
      },
      {
        id: 'q_short',
        questionType: EXAM_QUESTION_TYPE.SHORT_ANSWER,
        sectionId: 's1',
        displayNumber: '2',
        stemText: 'Short',
        options: [],
        acceptedAnswers: ['Paris'],
        maxWords: 2,
        points: 1,
      },
      {
        id: 'q_essay',
        questionType: EXAM_QUESTION_TYPE.ESSAY,
        sectionId: 's1',
        displayNumber: 'W',
        unnumberedActivity: true,
        stemText: 'Write',
        essayTopics: [{ id: 'A', label: 'Topic A' }],
        minWords: 1,
        maxWords: 500,
        points: 5,
        options: [],
      },
      {
        id: 'q_oral',
        questionType: EXAM_QUESTION_TYPE.ORAL_ASSESSMENT,
        sectionId: 's1',
        displayNumber: 'I',
        unnumberedActivity: true,
        stemText: 'Interview',
        points: 5,
        options: [],
      },
      {
        id: 'q_wb1',
        questionType: EXAM_QUESTION_TYPE.WORD_BANK,
        sectionId: 's1',
        displayNumber: '3',
        passageId,
        groupId: passageId,
        stemText: 'WB1',
        sourceWordBankUseOnce: true,
        options: [{ id: 'w1', text: 'alpha' }, { id: 'w2', text: 'beta' }],
        correctOptionId: 'w1',
        points: 1,
      },
      {
        id: 'q_wb2',
        questionType: EXAM_QUESTION_TYPE.WORD_BANK,
        sectionId: 's1',
        displayNumber: '4',
        passageId,
        groupId: passageId,
        stemText: 'WB2',
        sourceWordBankUseOnce: true,
        options: [{ id: 'w1', text: 'alpha' }, { id: 'w2', text: 'beta' }],
        correctOptionId: 'w2',
        points: 1,
      },
    ],
    confirmedAnswerKey: {},
    confirmedTextAnswerKey: {},
  };
}

test('resolveAttemptVersion falls back to assignment.versionId', () => {
  const state = {
    examVersions: [{ id: 'v1' }],
    examAssignments: [{ id: 'a1', versionId: 'v1' }],
    examAttempts: [{ id: 'at', assignmentId: 'a1' }],
  };
  assert.equal(resolveAttemptVersion(state, state.examAttempts[0])?.id, 'v1');
  assert.equal(teacherOwnsExamAttempt(state, state.examAttempts[0], 't1'), false);
});

test('legacy MCQ gradeAttempt unchanged for two-option paper', () => {
  const version = {
    questions: [
      { id: 'q1', correctOptionId: 'A', points: 2, options: [{ id: 'A' }, { id: 'B' }] },
      { id: 'q2', correctOptionId: 'B', points: 1, options: [{ id: 'A' }, { id: 'B' }] },
    ],
  };
  const graded = gradeAttempt(version, { q1: 'A', q2: 'A' });
  assert.equal(graded.earnedPoints, 2);
  assert.equal(graded.score10, 6.67);
  assert.equal(normalizeExamQuestionType(version.questions[0]), EXAM_QUESTION_TYPE.SINGLE_CHOICE);
});

test('type helpers and summarizeExamItems', () => {
  const version = mixedFixtureVersion();
  const summary = summarizeExamItems(version);
  assert.equal(summary.numberedQuestions, 4);
  assert.equal(summary.unnumberedActivities, 2);
  assert.equal(summary.respondableItems, 5);
  assert.equal(summary.manualOnlyItems, 2);
  assert.equal(summary.totalPoints, 15);
  assert.ok(isChoiceBasedQuestion(version.questions[0]));
  assert.ok(isManualOnlyQuestion(version.questions[2]));
  assert.ok(!isStudentResponseQuestion(version.questions[3]));
});

test('mixed answers grade: short auto, essay/oral pending until manual', () => {
  const version = mixedFixtureVersion();
  const answers = {
    q_mcq: 'A',
    q_short: 'paris',
    q_essay: { text: 'Hello world', topicId: 'A' },
    q_wb1: 'w1',
    q_wb2: 'w2',
  };
  const graded = gradeAttempt(version, answers);
  assert.equal(graded.gradingStatus, EXAM_ATTEMPT_GRADING_STATUS.PARTIAL);
  assert.equal(graded.score10, null);
  const manual = {
    q_essay: { score: 4, feedback: 'ok' },
    q_oral: { score: 5, feedback: 'good' },
  };
  const done = gradeAttempt(version, answers, null, manual);
  assert.equal(done.gradingStatus, EXAM_ATTEMPT_GRADING_STATUS.COMPLETE);
  assert.equal(done.earnedPoints, 14);
  assert.equal(done.totalPoints, 15);
});

test('short answer normalization case insensitive', () => {
  assert.ok(shortAnswerTextsMatch('  PARIS ', 'Paris'));
});

test('validateAttemptAnswerPatch rejects oral, unknown, overlong', () => {
  const version = mixedFixtureVersion();
  const oral = validateAttemptAnswerPatch(version, { questionId: 'q_oral', answer: 'x' });
  assert.equal(oral.ok, false);
  const unknown = validateAttemptAnswerPatch(version, { questionId: 'nope', answer: 'x' });
  assert.equal(unknown.ok, false);
  const over = validateAttemptAnswerPatch(version, {
    questionId: 'q_short',
    answer: 'one two three',
  });
  assert.equal(over.ok, false);
});

test('typed answers: short preserves case; malformed short/essay rejected on save', () => {
  const version = mixedFixtureVersion();
  const goodShort = validateAttemptAnswerPatch(version, {
    questionId: 'q_short',
    answer: '  PaRIS  ',
  });
  assert.equal(goodShort.ok, true);
  assert.equal(goodShort.value, 'PaRIS');
  const badShort = validateAttemptAnswerPatch(version, { questionId: 'q_short', answer: { x: 1 } });
  assert.equal(badShort.ok, false);
  assert.equal(badShort.code, 'bad-answer');

  const oneWordEssay = validateAttemptAnswerPatch(version, {
    questionId: 'q_essay',
    answer: { text: 'Hello', topicId: 'A' },
  });
  assert.equal(oneWordEssay.ok, true);
  assert.equal(oneWordEssay.value?.text, 'Hello');

  const badEssay = validateAttemptAnswerPatch(version, {
    questionId: 'q_essay',
    answer: { text: 42, topicId: 'A' },
  });
  assert.equal(badEssay.ok, false);
  assert.equal(badEssay.code, 'bad-answer');
});

test('essay listed topic required on submit when text present, not on draft save', () => {
  const version = {
    ...mixedFixtureVersion(),
    questions: mixedFixtureVersion().questions.map((q) => (
      q.id === 'q_essay'
        ? { ...q, minWords: 1, essayTopics: [{ id: 'A', label: 'A' }, { id: 'B', label: 'B' }] }
        : q
    )),
  };
  const draftNoTopic = validateAttemptAnswerPatch(version, {
    questionId: 'q_essay',
    answer: { text: 'Body without topic' },
  });
  assert.equal(draftNoTopic.ok, true);
  const submitNoTopic = validateAttemptAnswersForSubmit(version, {
    q_essay: { text: 'Body without topic' },
  });
  assert.equal(submitNoTopic.ok, false);
  assert.equal(submitNoTopic.code, 'missing-topic');
  const submitBadTopic = validateAttemptAnswersForSubmit(version, {
    q_essay: { text: 'Body', topicId: 'Z' },
  });
  assert.equal(submitBadTopic.ok, false);
  assert.equal(submitBadTopic.code, 'missing-topic');
  const submitOk = validateAttemptAnswersForSubmit(version, {
    q_essay: { text: 'Body', topicId: 'B' },
  });
  assert.equal(submitOk.ok, true);
});

test('essay min words enforced on submit, not draft save', () => {
  const version = {
    ...mixedFixtureVersion(),
    questions: mixedFixtureVersion().questions.map((q) => (
      q.id === 'q_essay' ? { ...q, minWords: 130 } : q
    )),
  };
  const draft = validateAttemptAnswerPatch(version, {
    questionId: 'q_essay',
    answer: { text: 'One', topicId: 'A' },
  });
  assert.equal(draft.ok, true);
  const submit = validateAttemptAnswersForSubmit(version, {
    q_essay: { text: 'One', topicId: 'A' },
  });
  assert.equal(submit.ok, false);
  assert.equal(submit.code, 'too-short');
  const words = Array.from({ length: 135 }, (_, i) => `word${i}`).join(' ');
  const longEnough = validateAttemptAnswersForSubmit(version, {
    q_essay: { text: words, topicId: 'A' },
  });
  assert.equal(longEnough.ok, true);
});

test('word bank use-once allows draft dup but blocks submit', () => {
  const version = mixedFixtureVersion();
  const answers = { q_wb1: 'w1', q_wb2: 'w1' };
  const submit = validateAttemptAnswersForSubmit(version, answers);
  assert.equal(submit.ok, false);
  assert.match(submit.error, /mỗi từ chỉ dùng một lần/i);
});

test('validateDraftForPublish rejects fake options on short answer', () => {
  const draft = {
    title: 'T',
    teacherConfirmedReview: true,
    questions: [{
      id: 'q1',
      displayNumber: '1',
      questionType: EXAM_QUESTION_TYPE.SHORT_ANSWER,
      stemText: 'S',
      options: [{ id: 'A', text: 'fake' }],
      acceptedAnswers: ['x'],
    }],
    passages: [],
    sections: [{ id: 's1' }],
  };
  const v = validateDraftForPublish(draft);
  assert.equal(v.ok, false);
});

test('manual grades accept partial short-answer score with feedback', () => {
  const version = mixedFixtureVersion();
  const graded = gradeAttempt(version, { q_short: 'wrong' }, null, {
    q_short: { score: 0.5, feedback: 'close' },
  });
  const row = graded.perQuestion.find((r) => r.questionId === 'q_short');
  assert.equal(row.earned, 0.5);
  assert.equal(row.manualFeedback, 'close');
  assert.equal(row.gradingState, 'graded');
});

test('student projection hides text keys', () => {
  const version = mixedFixtureVersion();
  const assignment = {
    id: 'a1',
    openAt: '2020-01-01T00:00:00.000Z',
    dueAt: '2099-01-01T00:00:00.000Z',
    showAnswersAfter: 'immediate',
  };
  const attempt = {
    id: 'at1',
    status: EXAM_ATTEMPT_STATUS.SUBMITTED,
    answers: { q_short: 'paris' },
    gradingStatus: EXAM_ATTEMPT_GRADING_STATUS.PARTIAL,
    gradingProjection: [{
      questionId: 'q_short',
      questionType: EXAM_QUESTION_TYPE.SHORT_ANSWER,
      correct: true,
      earned: 1,
      gradingState: 'graded',
    }],
  };
  const proj = projectExamVersionForStudent(version, assignment, attempt, '2025-01-01T00:00:00.000Z');
  const shortQ = proj.questions.find((q) => q.id === 'q_short');
  assert.equal(shortQ.questionType, EXAM_QUESTION_TYPE.SHORT_ANSWER);
  assert.equal(shortQ.acceptedAnswers, undefined);
  const perQ = proj.result?.perQuestion?.find((r) => r.questionId === 'q_short');
  assert.equal(perQ?.correctOptionId, undefined);
});

test('regrade preserves manual grades', () => {
  const version = mixedFixtureVersion();
  const state = {
    examVersions: [version],
    examAttempts: [{
      id: 'at1',
      versionId: 'v-mixed',
      assignmentId: 'asg',
      status: EXAM_ATTEMPT_STATUS.SUBMITTED,
      answers: { q_mcq: 'B', q_short: 'paris', q_wb1: 'w1', q_wb2: 'w2' },
      manualGrades: { q_essay: { score: 3 }, q_oral: { score: 4 } },
    }],
    examAssignments: [{ id: 'asg', versionId: 'v-mixed' }],
  };
  version.confirmedAnswerKey = { q_mcq: 'A' };
  regradeSubmittedAttemptsForVersion(state, 'v-mixed');
  const attempt = state.examAttempts[0];
  assert.equal(attempt.manualGrades.q_essay.score, 3);
  assert.equal(attempt.manualGrades.q_oral.score, 4);
});

test('text answer key merge conflict and overwrite', () => {
  const version = mixedFixtureVersion();
  const first = mergeVersionTextAnswerKeyUpdate(version, { q_short: ['Lyon'] });
  assert.equal(first.ok, true);
  version.confirmedTextAnswerKey = first.confirmedTextAnswerKey;
  const conflict = mergeVersionTextAnswerKeyUpdate(version, { q_short: ['Nice'] });
  assert.equal(conflict.ok, false);
  assert.ok(conflict.conflicts?.length);
  const ok = mergeVersionTextAnswerKeyUpdate(version, { q_short: ['Nice'] }, { confirmOverwrite: true });
  assert.equal(ok.ok, true);
  assert.deepEqual(resolveTextAnswerKey({ ...version, confirmedTextAnswerKey: ok.confirmedTextAnswerKey }, 'q_short'), ['Nice']);
});

test('API: mixed save reload manual grades unauthorized student', async (t) => {
  const ctx = await startBaTestServer({ initialNow: '2025-06-01T12:00:00.000Z' });
  t.after(async () => {
    await ctx.close();
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });
  const tJar = await teacherSetup(ctx);
  const me = await api(ctx.base, tJar, '/api/auth/me');
  assert.equal(me.res.status, 200);
  const teacherAcc = me.data.user;
  const version = mixedFixtureVersion();
  version.teacherAccountId = teacherAcc.id;
  const classId = randomUUID();
  await api(ctx.base, tJar, '/api/teacher/record/classes', {
    method: 'PUT',
    body: {
      id: classId,
      name: 'Lớp',
      scheduleDays: ['Thứ 2'],
      scheduleTime: '18:00',
      createdAt: '2025-01-01T00:00:00.000Z',
    },
  });
  const studentId = randomUUID();
  await api(ctx.base, tJar, '/api/teacher/record/students', {
    method: 'PUT',
    body: { id: studentId, name: 'HS', classId },
  });
  await api(ctx.base, tJar, '/api/teacher/accounts/students', {
    method: 'POST',
    body: { studentId, username: 'hsb1mix', temporaryPassword: 'temppass123' },
  });
  let sJar = (await api(ctx.base, {}, '/api/auth/csrf')).jar;
  const login = await api(ctx.base, sJar, '/api/auth/login', {
    method: 'POST',
    body: { username: 'hsb1mix', password: 'temppass123' },
  });
  sJar = login.jar;
  await api(ctx.base, sJar, '/api/auth/change-password', {
    method: 'POST',
    body: { currentPassword: '', newPassword: 'studentpass123' },
  });
  sJar = (await api(ctx.base, sJar, '/api/auth/login', {
    method: 'POST',
    body: { username: 'hsb1mix', password: 'studentpass123' },
  })).jar;

  const { createStore } = await import('../server/store.mjs');
  const store = createStore(ctx.dataDir);
  const versionId = version.id;
  const assignmentId = randomUUID();
  await store.mutate((s) => {
    s.examVersions.push(version);
    s.examAssignments.push({
      id: assignmentId,
      teacherAccountId: teacherAcc.id,
      versionId,
      classId,
      title: 'Mixed assign',
      openAt: '2025-01-01T00:00:00.000Z',
      dueAt: '2035-01-01T00:00:00.000Z',
      timeLimitMinutes: 60,
      attemptLimit: 1,
      showScore: true,
      showAnswersAfter: 'after-submit',
    });
  });
  await store.close();

  const start = await api(ctx.base, sJar, '/api/student/exams/attempts/start', {
    method: 'POST',
    body: { assignmentId },
  });
  assert.equal(start.res.status, 200);
  const attemptId = start.data.attemptId;
  let rev = 0;
  const saveShort = await api(ctx.base, sJar, `/api/student/exams/attempts/${attemptId}/answers`, {
    method: 'POST',
    body: { questionId: 'q_short', answer: 'Paris', baseRevision: rev },
  });
  assert.equal(saveShort.res.status, 200);
  rev = saveShort.data.revision;
  const reload = await api(ctx.base, sJar, `/api/student/exams/assignments/${assignmentId}`);
  assert.equal(reload.data.exam.attempt.answers.q_short, 'Paris');

  const saveEssay = await api(ctx.base, sJar, `/api/student/exams/attempts/${attemptId}/answers`, {
    method: 'POST',
    body: {
      questionId: 'q_essay',
      answer: { text: 'Hello', topicId: 'A' },
      baseRevision: rev,
    },
  });
  assert.equal(saveEssay.res.status, 200);
  rev = saveEssay.data.revision;
  const reloadEssay = await api(ctx.base, sJar, `/api/student/exams/assignments/${assignmentId}`);
  assert.deepEqual(reloadEssay.data.exam.attempt.answers.q_essay, { text: 'Hello', topicId: 'A' });

  const badTyped = await api(ctx.base, sJar, `/api/student/exams/attempts/${attemptId}/answers`, {
    method: 'POST',
    body: { questionId: 'q_short', answer: { bad: true }, baseRevision: rev },
  });
  assert.equal(badTyped.res.status, 400);

  const stale = await api(ctx.base, sJar, `/api/student/exams/attempts/${attemptId}/answers`, {
    method: 'POST',
    body: { questionId: 'q_mcq', optionId: 'A', baseRevision: 0 },
  });
  assert.equal(stale.res.status, 409);

  const dupSubmit = await api(ctx.base, sJar, `/api/student/exams/attempts/${attemptId}/answers`, {
    method: 'POST',
    body: { questionId: 'q_wb1', optionId: 'w1', baseRevision: rev },
  });
  rev = dupSubmit.data.revision;
  await api(ctx.base, sJar, `/api/student/exams/attempts/${attemptId}/answers`, {
    method: 'POST',
    body: { questionId: 'q_wb2', optionId: 'w1', baseRevision: rev },
  });

  const badSubmit = await api(ctx.base, sJar, `/api/student/exams/attempts/${attemptId}/submit`, {
    method: 'POST',
    body: {},
  });
  assert.equal(badSubmit.res.status, 400);

  await api(ctx.base, sJar, `/api/student/exams/attempts/${attemptId}/answers`, {
    method: 'POST',
    body: { questionId: 'q_wb2', optionId: 'w2', baseRevision: rev + 1 },
  });
  await api(ctx.base, sJar, `/api/student/exams/attempts/${attemptId}/answers`, {
    method: 'POST',
    body: { questionId: 'q_mcq', optionId: 'A', baseRevision: rev + 2 },
  });

  const sub = await api(ctx.base, sJar, `/api/student/exams/attempts/${attemptId}/submit`, {
    method: 'POST',
    body: {},
  });
  assert.equal(sub.res.status, 200);
  assert.equal(sub.data.gradingStatus, EXAM_ATTEMPT_GRADING_STATUS.PARTIAL);

  const studentManual = await api(ctx.base, sJar, `/api/teacher/exams/attempts/${attemptId}/manual-grades`, {
    method: 'PUT',
    body: { baseRevision: 0, marks: [{ questionId: 'q_essay', score: 99 }] },
  });
  assert.equal(studentManual.res.status, 403);

  const teacherManual = await api(ctx.base, tJar, `/api/teacher/exams/attempts/${attemptId}/manual-grades`, {
    method: 'PUT',
    body: {
      baseRevision: 0,
      marks: [
        { questionId: 'q_short', score: 0.5, feedback: 'partial credit' },
        { questionId: 'q_essay', score: 4, feedback: 'fine' },
        { questionId: 'q_oral', score: 5 },
      ],
    },
  });
  assert.equal(teacherManual.res.status, 200);
  assert.equal(teacherManual.data.gradingStatus, EXAM_ATTEMPT_GRADING_STATUS.COMPLETE);

  const over = await api(ctx.base, tJar, `/api/teacher/exams/attempts/${attemptId}/manual-grades`, {
    method: 'PUT',
    body: { baseRevision: teacherManual.data.gradingRevision, marks: [{ questionId: 'q_essay', score: 99 }] },
  });
  assert.equal(over.res.status, 400);

  const opId = randomUUID();
  const replay = await api(ctx.base, tJar, `/api/teacher/exams/attempts/${attemptId}/manual-grades`, {
    method: 'PUT',
    body: {
      operationId: opId,
      baseRevision: teacherManual.data.gradingRevision,
      marks: [{ questionId: 'q_essay', score: 4, feedback: 'fine' }],
    },
  });
  assert.equal(replay.res.status, 200);
  assert.equal(replay.data.idempotent, true);

  const opConflict = randomUUID();
  await api(ctx.base, tJar, `/api/teacher/exams/attempts/${attemptId}/manual-grades`, {
    method: 'PUT',
    body: {
      operationId: opConflict,
      baseRevision: teacherManual.data.gradingRevision,
      marks: [{ questionId: 'q_essay', score: 4, feedback: 'fine' }],
    },
  });
  const payloadConflict = await api(ctx.base, tJar, `/api/teacher/exams/attempts/${attemptId}/manual-grades`, {
    method: 'PUT',
    body: {
      operationId: opConflict,
      baseRevision: teacherManual.data.gradingRevision,
      marks: [{ questionId: 'q_essay', score: 3, feedback: 'changed' }],
    },
  });
  assert.equal(payloadConflict.res.status, 409);
});

test('API: teacher summary exposes itemSummary for numbered + activity counts', async (t) => {
  const ctx = await startBaTestServer({ initialNow: '2025-06-01T12:00:00.000Z' });
  t.after(async () => {
    await ctx.close();
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });
  const tJar = await teacherSetup(ctx);
  const me = await api(ctx.base, tJar, '/api/auth/me');
  const version = mixedFixtureVersion();
  version.teacherAccountId = me.data.user.id;
  const { createStore } = await import('../server/store.mjs');
  const store = createStore(ctx.dataDir);
  await store.mutate((s) => { s.examVersions.push(version); });
  await store.close();
  const list = await api(ctx.base, tJar, '/api/teacher/exams/summary');
  assert.equal(list.res.status, 200);
  const row = list.data.versions.find((v) => v.id === version.id);
  assert.equal(row.questionCount, version.questions.length);
  assert.equal(row.itemSummary, '4 câu + 2 hoạt động');
});

test('API: manual grades resolves version via assignment when attempt omits versionId', async (t) => {
  const ctx = await startBaTestServer({ initialNow: '2025-06-01T12:00:00.000Z' });
  t.after(async () => {
    await ctx.close();
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });
  const tJar = await teacherSetup(ctx);
  const me = await api(ctx.base, tJar, '/api/auth/me');
  const teacherAcc = me.data.user;
  const version = mixedFixtureVersion();
  version.teacherAccountId = teacherAcc.id;
  const assignmentId = randomUUID();
  const attemptId = randomUUID();
  const { createStore } = await import('../server/store.mjs');
  const store = createStore(ctx.dataDir);
  await store.mutate((s) => {
    s.examVersions.push(version);
    s.examAssignments.push({
      id: assignmentId,
      teacherAccountId: teacherAcc.id,
      versionId: version.id,
      classId: randomUUID(),
      title: 'NoVid',
      openAt: '2025-01-01T00:00:00.000Z',
      dueAt: '2035-01-01T00:00:00.000Z',
      timeLimitMinutes: 60,
      attemptLimit: 1,
      showScore: true,
      showAnswersAfter: 'after-submit',
    });
    s.examAttempts.push({
      id: attemptId,
      assignmentId,
      studentId: randomUUID(),
      status: EXAM_ATTEMPT_STATUS.SUBMITTED,
      submittedAt: '2025-06-01T12:00:00.000Z',
      answers: {},
      gradingRevision: 0,
      manualGrades: {},
    });
  });
  await store.close();
  const res = await api(ctx.base, tJar, `/api/teacher/exams/attempts/${attemptId}/manual-grades`, {
    method: 'PUT',
    body: { baseRevision: 0, marks: [{ questionId: 'q_essay', score: 2 }] },
  });
  assert.equal(res.res.status, 200);
  assert.equal(res.data.gradingRevision, 1);
});
