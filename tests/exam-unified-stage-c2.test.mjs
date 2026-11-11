import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
  EXAM_DELIVERY_MODE,
  EXAM_SKILL,
  EXAM_QUESTION_TYPE,
  EXAM_ATTEMPT_STATUS,
  EXAM_ATTEMPT_GRADING_STATUS,
  assignmentScoringDenominator,
  computeFinalAttemptScore,
  parseExamMetadataFilters,
} from '../dist/exam-domain.js';
import { startBaTestServer, api, teacherSetup } from './ba-test-helpers.mjs';
import { installBaDomEnvironment } from './helper-browser-window.mjs';
import { renderExamSourceReadView } from '../dist/exam-ui-source.js';

function minimalMp3Buffer() {
  return Buffer.from([
    0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  ]);
}

async function uploadAudio(ctx, tJar, buf, name = 'clip.mp3') {
  const res = await fetch(`${ctx.base}/api/teacher/attachments`, {
    method: 'POST',
    headers: {
      cookie: Object.entries(tJar).map(([k, v]) => `${k}=${v}`).join('; '),
      'content-type': 'audio/mpeg',
      'x-bn-csrf': tJar.bn_csrf,
      'x-bn-filename': encodeURIComponent(name),
    },
    body: buf,
  });
  const data = await res.json();
  assert.equal(res.status, 200, JSON.stringify(data));
  return data.id;
}

async function seedVersionWithQuestions(ctx, tJar, teacherId, title, questions) {
  const versionId = randomUUID();
  const { createStore } = await import('../server/store.mjs');
  const store = createStore(ctx.dataDir);
  await store.mutate((s) => {
    s.examVersions.push({
      id: versionId,
      teacherAccountId: teacherId,
      title,
      sections: [{ id: 's1', title: 'P', order: 1 }],
      passages: [],
      questions,
      gradingMode: 'automatic',
      confirmedAnswerKey: Object.fromEntries(
        questions.filter((q) => q.correctOptionId).map((q) => [q.id, q.correctOptionId]),
      ),
      publishedAt: '2025-01-01T00:00:00.000Z',
    });
  });
  await store.close();
  return versionId;
}

test('API: summary and compose-source metadata filters return counts', async (t) => {
  const ctx = await startBaTestServer({ initialNow: '2025-06-01T12:00:00.000Z' });
  t.after(async () => {
    await ctx.close();
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });
  const tJar = await teacherSetup(ctx);
  const me = await api(ctx.base, tJar, '/api/auth/me');
  const teacherId = me.data.user.id;
  const v1 = await seedVersionWithQuestions(ctx, tJar, teacherId, 'Listen bank', [{
    id: 'q1', sectionId: 's1', displayNumber: '1', stemText: 'L',
    requiresAudio: true, skill: EXAM_SKILL.LISTENING,
    questionType: EXAM_QUESTION_TYPE.SINGLE_CHOICE,
    options: [{ id: 'A', text: 'a' }],
    correctOptionId: 'A',
    points: 1,
  }]);
  await seedVersionWithQuestions(ctx, tJar, teacherId, 'Read bank', [{
    id: 'q2', sectionId: 's1', displayNumber: '1', stemText: 'R',
    skill: EXAM_SKILL.READING,
    questionType: EXAM_QUESTION_TYPE.SINGLE_CHOICE,
    options: [{ id: 'A', text: 'a' }],
    correctOptionId: 'A',
    points: 1,
  }]);

  const filtered = await api(ctx.base, tJar, `/api/teacher/exams/summary?skills=${EXAM_SKILL.LISTENING}`);
  assert.equal(filtered.res.status, 200);
  assert.equal(filtered.data.filterQualification.matchingVersionCount, 1);
  assert.equal(filtered.data.filterQualification.matchingQuestionCount, 1);

  const source = await api(ctx.base, tJar, `/api/teacher/exams/versions/${v1}/compose-source?skills=${EXAM_SKILL.READING}`);
  assert.equal(source.res.status, 200);
  assert.equal(source.data.source.questionCount, 0);
  assert.equal(source.data.filterQualification.totalQuestionCount, 1);
});

test('API: two-source append dedup and compose-undo refuses after later save', async (t) => {
  const ctx = await startBaTestServer({ initialNow: '2025-06-01T12:00:00.000Z' });
  t.after(async () => {
    await ctx.close();
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });
  const tJar = await teacherSetup(ctx);
  const me = await api(ctx.base, tJar, '/api/auth/me');
  const teacherId = me.data.user.id;
  const vA = await seedVersionWithQuestions(ctx, tJar, teacherId, 'A', [{
    id: 'a1', sectionId: 's1', displayNumber: '1', stemText: 'A1',
    questionType: EXAM_QUESTION_TYPE.SINGLE_CHOICE,
    options: [{ id: 'A', text: 'a' }], correctOptionId: 'A', points: 1,
  }]);
  const vB = await seedVersionWithQuestions(ctx, tJar, teacherId, 'B', [{
    id: 'b1', sectionId: 's1', displayNumber: '1', stemText: 'B1',
    questionType: EXAM_QUESTION_TYPE.SINGLE_CHOICE,
    options: [{ id: 'A', text: 'a' }], correctOptionId: 'A', points: 1,
  }]);

  const target = await api(ctx.base, tJar, '/api/teacher/exams/drafts', {
    method: 'POST',
    body: { blank: true, title: 'Đích' },
  });
  const draftId = target.data.draftId;

  const appendA = await api(ctx.base, tJar, `/api/teacher/exams/drafts/${draftId}/compose-append`, {
    method: 'POST',
    body: { sourceVersionId: vA, questionIds: ['a1'] },
  });
  assert.equal(appendA.data.addedCount, 1);
  const revAfterA = appendA.data.revision;

  const dup = await api(ctx.base, tJar, `/api/teacher/exams/drafts/${draftId}/compose-append`, {
    method: 'POST',
    body: { sourceVersionId: vA, questionIds: ['a1'] },
  });
  assert.equal(dup.data.addedCount, 0);
  assert.ok(dup.data.skippedDuplicateSourceQuestions >= 1);

  const appendB = await api(ctx.base, tJar, `/api/teacher/exams/drafts/${draftId}/compose-append`, {
    method: 'POST',
    body: { sourceVersionId: vB, questionIds: ['b1'] },
  });
  assert.equal(appendB.data.addedCount, 1);

  const got = await api(ctx.base, tJar, `/api/teacher/exams/drafts/${draftId}`);
  assert.equal(got.data.draft.questions.length, 2);

  await api(ctx.base, tJar, `/api/teacher/exams/drafts/${draftId}`, {
    method: 'PUT',
    body: {
      title: 'Đích',
      questions: got.data.draft.questions,
      passages: got.data.draft.passages,
      sections: got.data.draft.sections,
      baseRevision: got.data.draft.revision,
      teacherConfirmedReview: false,
    },
  });

  const undoFail = await api(ctx.base, tJar, `/api/teacher/exams/drafts/${draftId}/compose-undo`, {
    method: 'POST',
    body: { baseRevision: appendB.data.revision },
  });
  assert.equal(undoFail.res.status, 409);

  const blank = await api(ctx.base, tJar, '/api/teacher/exams/drafts', {
    method: 'POST',
    body: { blank: true, title: 'Undo lab' },
  });
  const labId = blank.data.draftId;
  const addOnce = await api(ctx.base, tJar, `/api/teacher/exams/drafts/${labId}/compose-append`, {
    method: 'POST',
    body: { sourceVersionId: vA, questionIds: ['a1'] },
  });
  const undoOk = await api(ctx.base, tJar, `/api/teacher/exams/drafts/${labId}/compose-undo`, {
    method: 'POST',
    body: { baseRevision: addOnce.data.revision },
  });
  assert.equal(undoOk.res.status, 200);
  const afterUndo = await api(ctx.base, tJar, `/api/teacher/exams/drafts/${labId}`);
  assert.equal(afterUndo.data.draft.questions.length, 0);
});

test('API: draft media publishes and student hears snapshotted audio bytes', async (t) => {
  const ctx = await startBaTestServer({ initialNow: '2025-06-01T12:00:00.000Z' });
  t.after(async () => {
    await ctx.close();
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });
  const tJar = await teacherSetup(ctx);
  const me = await api(ctx.base, tJar, '/api/auth/me');
  const teacherId = me.data.user.id;
  const audio1 = await uploadAudio(ctx, tJar, minimalMp3Buffer(), 'old.mp3');
  const audio2 = await uploadAudio(ctx, tJar, Buffer.concat([minimalMp3Buffer(), Buffer.from([1, 2, 3])]), 'new.mp3');
  const blank = await api(ctx.base, tJar, '/api/teacher/exams/drafts', {
    method: 'POST',
    body: { blank: true, title: 'Audio draft' },
  });
  assert.equal(blank.res.status, 200, JSON.stringify(blank.data));
  const draftId = blank.data.draftId;
  const attached = await api(ctx.base, tJar, `/api/teacher/exams/drafts/${draftId}/media`, {
    method: 'PUT',
    body: { action: 'attach', audioAttachmentId: audio1, baseMediaRevision: 0 },
  });
  assert.equal(attached.res.status, 200, JSON.stringify(attached.data));
  const mediaRevision = attached.data.mediaRevision;
  const saved = await api(ctx.base, tJar, `/api/teacher/exams/drafts/${draftId}`, {
    method: 'PUT',
    body: {
      title: 'Audio draft',
      questions: [{
        id: 'q1', sectionId: 's1', displayNumber: '1', stemText: 'L',
        requiresAudio: true,
        options: [{ id: 'A', text: 'a' }, { id: 'B', text: 'b' }],
        correctOptionId: 'A',
        points: 1,
      }],
      sections: [{ id: 's1', title: 'P', order: 1 }],
      passages: [],
      teacherConfirmedReview: true,
      baseRevision: 0,
    },
  });
  assert.equal(saved.res.status, 200, JSON.stringify(saved.data));
  const pub = await api(ctx.base, tJar, `/api/teacher/exams/drafts/${draftId}/publish`, { method: 'POST', body: {} });
  assert.equal(pub.res.status, 200, JSON.stringify(pub.data));
  const versionId = pub.data.versionId;

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
  const assign = await api(ctx.base, tJar, '/api/teacher/exams/assignments', {
    method: 'POST',
    body: {
      versionId,
      classId,
      title: 'Audio assign',
      openAt: '2025-06-01T10:00:00.000Z',
      dueAt: '2035-01-01T00:00:00.000Z',
      timeLimitMinutes: 30,
      attemptLimit: 1,
    },
  });
  assert.equal(assign.res.status, 200, JSON.stringify(assign.data));
  const assignmentId = assign.data.assignmentId;

  const studentIdPre = randomUUID();
  await api(ctx.base, tJar, '/api/teacher/record/students', {
    method: 'PUT',
    body: { id: studentIdPre, name: 'HS pre', classId },
  });
  await api(ctx.base, tJar, '/api/teacher/accounts/students', {
    method: 'POST',
    body: { studentId: studentIdPre, username: 'hsaudiopre', temporaryPassword: 'temppass123' },
  });
  let preJar = (await api(ctx.base, {}, '/api/auth/csrf')).jar;
  preJar = (await api(ctx.base, preJar, '/api/auth/login', {
    method: 'POST',
    body: { username: 'hsaudiopre', password: 'temppass123' },
  })).jar;
  await api(ctx.base, preJar, '/api/auth/change-password', {
    method: 'POST',
    body: { currentPassword: '', newPassword: 'studentpass123' },
  });
  preJar = (await api(ctx.base, preJar, '/api/auth/login', {
    method: 'POST',
    body: { username: 'hsaudiopre', password: 'studentpass123' },
  })).jar;
  const preStart = await api(ctx.base, preJar, '/api/student/exams/attempts/start', {
    method: 'POST',
    body: { assignmentId },
  });
  assert.equal(preStart.res.status, 200, JSON.stringify(preStart.data));
  const afterAssign = await fetch(`${ctx.base}/api/student/exams/assignments/${assignmentId}/audio`, {
    headers: { cookie: Object.entries(preJar).map(([k, v]) => `${k}=${v}`).join('; ') },
  });
  assert.equal(afterAssign.status, 200);

  const studentId = randomUUID();
  await api(ctx.base, tJar, '/api/teacher/record/students', {
    method: 'PUT',
    body: { id: studentId, name: 'HS', classId },
  });
  await api(ctx.base, tJar, '/api/teacher/accounts/students', {
    method: 'POST',
    body: { studentId, username: 'hsaudio1', temporaryPassword: 'temppass123' },
  });
  let sJar = (await api(ctx.base, {}, '/api/auth/csrf')).jar;
  sJar = (await api(ctx.base, sJar, '/api/auth/login', {
    method: 'POST',
    body: { username: 'hsaudio1', password: 'temppass123' },
  })).jar;
  await api(ctx.base, sJar, '/api/auth/change-password', {
    method: 'POST',
    body: { currentPassword: '', newPassword: 'studentpass123' },
  });
  sJar = (await api(ctx.base, sJar, '/api/auth/login', {
    method: 'POST',
    body: { username: 'hsaudio1', password: 'studentpass123' },
  })).jar;

  const start = await api(ctx.base, sJar, '/api/student/exams/attempts/start', {
    method: 'POST',
    body: { assignmentId },
  });
  assert.equal(start.res.status, 200, JSON.stringify(start.data));
  await api(ctx.base, sJar, `/api/student/exams/attempts/${start.data.attemptId}/answers`, {
    method: 'POST',
    body: { questionId: 'q1', optionId: 'A', baseRevision: 0 },
  });
  await api(ctx.base, sJar, `/api/student/exams/attempts/${start.data.attemptId}/submit`, {
    method: 'POST',
    body: {},
  });

  const beforeReplace = await fetch(`${ctx.base}/api/student/exams/assignments/${assignmentId}/audio`, {
    headers: { cookie: Object.entries(sJar).map(([k, v]) => `${k}=${v}`).join('; ') },
  });
  assert.equal(beforeReplace.status, 200);
  const bytesBefore = Buffer.from(await beforeReplace.arrayBuffer());

  const replaceDenied = await api(ctx.base, tJar, `/api/teacher/exams/versions/${versionId}/media`, {
    method: 'PUT',
    body: { action: 'replace', audioAttachmentId: audio2, baseMediaRevision: mediaRevision },
  });
  assert.equal(replaceDenied.res.status, 400);

  const replaced = await api(ctx.base, tJar, `/api/teacher/exams/versions/${versionId}/media`, {
    method: 'PUT',
    body: {
      action: 'replace',
      audioAttachmentId: audio2,
      baseMediaRevision: mediaRevision,
      acknowledgeMediaChange: true,
    },
  });
  assert.equal(replaced.res.status, 200, JSON.stringify(replaced.data));

  const afterReplace = await fetch(`${ctx.base}/api/student/exams/assignments/${assignmentId}/audio`, {
    headers: { cookie: Object.entries(sJar).map(([k, v]) => `${k}=${v}`).join('; ') },
  });
  assert.equal(afterReplace.status, 200);
  const bytesAfter = Buffer.from(await afterReplace.arrayBuffer());
  assert.ok(bytesAfter.equals(bytesBefore));
});

test('parseExamMetadataFilters ignores empty tokens (no default unclassified)', () => {
  assert.deepEqual(parseExamMetadataFilters({ skills: '' }), { skills: [], types: [] });
  assert.deepEqual(parseExamMetadataFilters({ skills: ',,' }), { skills: [], types: [] });
  const uni = parseExamMetadataFilters({ skills: EXAM_SKILL.UNCLASSIFIED });
  assert.deepEqual(uni.skills, [EXAM_SKILL.UNCLASSIFIED]);
});

test('API: summary without filters returns versions not empty skill filter', async (t) => {
  const ctx = await startBaTestServer({ initialNow: '2025-06-01T12:00:00.000Z' });
  t.after(async () => {
    await ctx.close();
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });
  const tJar = await teacherSetup(ctx);
  const me = await api(ctx.base, tJar, '/api/auth/me');
  const teacherId = me.data.user.id;
  await seedVersionWithQuestions(ctx, tJar, teacherId, 'Read bank', [{
    id: 'q2', sectionId: 's1', displayNumber: '1', stemText: 'R',
    skill: EXAM_SKILL.READING,
    questionType: EXAM_QUESTION_TYPE.SINGLE_CHOICE,
    options: [{ id: 'A', text: 'a' }],
    correctOptionId: 'A',
    points: 1,
  }]);
  const bare = await api(ctx.base, tJar, '/api/teacher/exams/summary');
  assert.equal(bare.res.status, 200);
  assert.ok((bare.data.versions || []).length >= 1);
  assert.ok(!bare.data.filterQualification);
});

test('combined scoring scales online weight with PDF manual grade', () => {
  const version = {
    questions: [
      { id: 'q1', sectionId: 's1', displayNumber: '1', options: [{ id: 'A', text: 'a' }], correctOptionId: 'A', points: 1 },
      { id: 'q2', sectionId: 's1', displayNumber: '2', options: [{ id: 'A', text: 'a' }], correctOptionId: 'A', points: 1 },
      { id: 'q3', sectionId: 's1', displayNumber: '3', options: [{ id: 'A', text: 'a' }], correctOptionId: 'A', points: 1 },
    ],
    sections: [{ id: 's1', title: 'P', order: 1 }],
    confirmedAnswerKey: { q1: 'A', q2: 'A', q3: 'A' },
  };
  const assignment = {
    deliveryMode: EXAM_DELIVERY_MODE.COMBINED,
    onlinePartPoints: 6,
    pdfPartPoints: 4,
    selectedQuestionIds: ['q1', 'q2', 'q3'],
  };
  const attempt = {
    status: EXAM_ATTEMPT_STATUS.SUBMITTED,
    answers: { q1: 'A', q2: 'A', q3: 'A' },
    pdfManualGrade: { score: 3, maxPoints: 4 },
    gradingStatus: EXAM_ATTEMPT_GRADING_STATUS.COMPLETE,
  };
  const fin = computeFinalAttemptScore(attempt, version, assignment);
  assert.equal(fin.earnedPoints, 9);
  assert.equal(fin.totalPoints, 10);
});

test('combined assignment onlinePartPoints overrides scoring denominator', () => {
  const version = {
    questions: [
      { id: 'q1', points: 5 },
      { id: 'q2', points: 3 },
    ],
  };
  const assignment = {
    deliveryMode: EXAM_DELIVERY_MODE.COMBINED,
    pdfPartPoints: 10,
    onlinePartPoints: 20,
    selectedQuestionIds: ['q1', 'q2'],
  };
  const denom = assignmentScoringDenominator(version, assignment);
  assert.equal(denom.onlinePoints, 20);
  assert.equal(denom.pdfPoints, 10);
  assert.equal(denom.totalPoints, 30);
});

test('UI: source read view exposes filter bar and bulk add chrome', async (t) => {
  const dom = installBaDomEnvironment(t);
  const root = dom.root;
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (typeof root?.__examDispose === 'function') {
      root.__examDispose();
      delete root.__examDispose;
    }
  });
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/compose-source')) {
      return {
        ok: true,
        headers: { get: () => 'application/json' },
        json: async () => ({
          ok: true,
          source: {
            questions: [{
              id: 'q1', displayNumber: '1', composeSupported: true,
              skill: EXAM_SKILL.READING, questionType: EXAM_QUESTION_TYPE.SINGLE_CHOICE,
            }],
            groups: [],
          },
          filterQualification: { matchingQuestionCount: 1, totalQuestionCount: 1 },
        }),
      };
    }
    if (u.includes('/student-preview')) {
      return {
        ok: true,
        headers: { get: () => 'application/json' },
        json: async () => ({
          ok: true,
          exam: { title: 'X', sections: [], passages: [], questions: [] },
        }),
      };
    }
    throw new Error(u);
  };
  renderExamSourceReadView({
    navigate: () => {},
    toastErr: () => {},
    toastOk: () => {},
  }, root, 'v-src');
  await new Promise((r) => setTimeout(r, 25));
  assert.ok(root.querySelector('[data-exam-source-filter-bar]'));
  assert.ok(root.querySelector('[data-exam-source-bulk]'));
});
