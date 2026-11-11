import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseExamRoute,
  EXAM_NAV_ITEM,
  EXAM_QUESTION_TYPE,
  gradeAttempt,
  questionPointsPublishError,
  normalizeReadingGroup,
  validateDraftForPublish,
  missingTextLayerPublishError,
  validateReadingGroupsAndQuestions,
  projectExamVersionForStudent,
  buildTeacherPreviewExamProjection,
  parseExpectedQuestionRange,
  resolveDraftReviewNavigation,
  resolvePublishErrorNavigation,
  resolvePublishValidationError,
  publishErrorMessage,
  draftQuestionNeedsReview,
  draftQuestionSourceReviewPending,
  draftImportWarningStillActive,
  computeDraftReviewFilterCounts,
  EXAM_GRADING_MODE,
  EXAM_ATTEMPT_GRADING_STATUS,
  mergeVersionAnswerKeyUpdate,
  regradeSubmittedAttemptsForVersion,
  scanExamContentContamination,
  buildContaminationImportWarning,
  formatImportWarningDisplay,
  effectiveVersionForAssignment,
  validateExamAssignmentQuestionSelection,
  validateExamAssignmentInput,
  assignmentSelectedQuestionIds,
  EXAM_ASSIGNMENT_PURPOSE,
  sortExamQuestionsByOrder,
  formatExamChoiceOptionLabel,
  formatExamHubItemMeta,
  projectQuestionPublicForStudent,
  mergeComposedDraftSlices,
  composePublishedVersionQuestionSlice,
  parseScopedDisplayQuestionOrdinal,
  readingGroupQuestionNumbers,
} from '../dist/exam-domain.js';
import { installBaDomEnvironment, aggregateDomTextContent } from './helper-browser-window.mjs';
import { mountExamTakeQuestionUi } from '../dist/exam-ui-student.js';

test('mergeComposedDraftSlices preserves slice order A1,A2 then B1,B2 (not interleaved by per-source order)', () => {
  const vA = {
    id: 'va',
    title: 'A',
    sourceAttachmentId: 'att-a',
    sections: [{ id: 'sA', title: 'Phần 1', order: 1 }],
    passages: [],
    questions: [
      { id: 'qa1', sectionId: 'sA', displayNumber: '1', order: 2, stemText: 'A1', options: [] },
      { id: 'qa2', sectionId: 'sA', displayNumber: '2', order: 1, stemText: 'A2', options: [] },
    ],
    gradingMode: EXAM_GRADING_MODE.AUTOMATIC,
  };
  const vB = {
    id: 'vb',
    title: 'B',
    sourceAttachmentId: 'att-b',
    sections: [{ id: 'sB', title: 'Phần 1', order: 1 }],
    passages: [],
    questions: [
      { id: 'qb1', sectionId: 'sB', displayNumber: '1', order: 1, stemText: 'B1', options: [] },
      { id: 'qb2', sectionId: 'sB', displayNumber: '2', order: 2, stemText: 'B2', options: [] },
    ],
    gradingMode: EXAM_GRADING_MODE.AUTOMATIC,
  };
  const slA = composePublishedVersionQuestionSlice(vA, ['qa1', 'qa2']);
  const slB = composePublishedVersionQuestionSlice(vB, ['qb1', 'qb2']);
  const merged = mergeComposedDraftSlices([slA, slB], { title: 'Gộp' });
  assert.deepEqual(
    merged.questions.map((q) => q.stemText),
    ['A1', 'A2', 'B1', 'B2'],
  );
  assert.deepEqual(
    merged.questions.map((q) => q.displayNumber),
    ['1', '2', '3', '4'],
  );
});

test('parseExamRoute recognizes student take path', () => {
  const r = parseExamRoute(['exams', 'take', 'abc']);
  assert.equal(r.view, 'exams-take');
  assert.equal(r.assignmentId, 'abc');
});

test('EXAM_NAV_ITEM visible for teacher and student', () => {
  assert.ok(EXAM_NAV_ITEM.teacher);
  assert.ok(EXAM_NAV_ITEM.student);
});

test('gradeAttempt weights points', () => {
  const version = {
    questions: [
      { id: 'q1', correctOptionId: 'A', points: 2, options: [{ id: 'A' }, { id: 'B' }] },
      { id: 'q2', correctOptionId: 'B', points: 1, options: [{ id: 'A' }, { id: 'B' }] },
    ],
  };
  const graded = gradeAttempt(version, { q1: 'A', q2: 'A' });
  assert.equal(graded.earnedPoints, 2);
  assert.equal(graded.score10, 6.67);
});

test('validateDraftForPublish rejects non-positive explicit question points', () => {
  assert.equal(questionPointsPublishError({ displayNumber: '1', points: 2 }), null);
  assert.equal(questionPointsPublishError({ displayNumber: '1' }), null);
  const bad = validateDraftForPublish({
    title: 'T',
    teacherConfirmedReview: true,
    needsReview: false,
    questions: [{
      id: 'q1',
      displayNumber: '1',
      stemText: 'S',
      points: 0,
      options: [{ id: 'A', text: 'a' }, { id: 'B', text: 'b' }],
      correctOptionId: 'A',
    }],
    passages: [],
    sections: [{ id: 's1' }],
  });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((e) => /điểm phải là số dương/.test(String(e))));
});

test('normalizeReadingGroup lifts legacy bodyText into documents', () => {
  const g = normalizeReadingGroup({
    id: 'p1',
    sectionId: 's1',
    title: 'Questions 1-2',
    bodyText: 'Fox text',
    sourcePage: 3,
  });
  assert.equal(g.documents.length, 1);
  assert.equal(g.documents[0].bodyText, 'Fox text');
  assert.deepEqual(parseExpectedQuestionRange(g), { min: 1, max: 2 });
});

test('missingTextLayerPublishError lists physical page numbers', () => {
  const msg = missingTextLayerPublishError({ needsOcrPageNumbers: [2, 5] });
  assert.match(msg, /Trang 2, 5/);
  assert.match(msg, /lớp chữ/);
});

test('validateDraftForPublish blocks raster pages without text layer', () => {
  const draft = {
    title: 'T',
    needsOcr: true,
    needsOcrPageNumbers: [3],
    needsReview: false,
    teacherConfirmedReview: true,
    passages: [],
    questions: [{
      id: 'q1',
      sectionId: 's1',
      displayNumber: '1',
      stemText: 'S?',
      options: [{ id: 'A', text: 'a' }, { id: 'B', text: 'b' }],
      correctOptionId: 'A',
    }],
  };
  const v = validateDraftForPublish(draft);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => /Trang 3/.test(e)));
});

test('validateDraftForPublish blocks unsupported reading task', () => {
  const draft = {
    title: 'T',
    needsReview: false,
    teacherConfirmedReview: true,
    passages: [{
      id: 'g1',
      sectionId: 's1',
      title: 'Q',
      unsupportedTaskType: 'tfng',
      unsupportedReason: 'TFNG chưa hỗ trợ',
      documents: [{ id: 'd1', bodyText: 'ctx', requiresReview: false }],
    }],
    questions: [{
      id: 'q1',
      sectionId: 's1',
      displayNumber: '1',
      stemText: 'S?',
      options: [{ id: 'A', text: 'a' }, { id: 'B', text: 'b' }],
      correctOptionId: 'A',
    }],
  };
  const v = validateDraftForPublish(draft);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => /TFNG/.test(publishErrorMessage(e))));
});

test('validateReadingGroupsAndQuestions rejects orphan group reference', () => {
  const errors = validateReadingGroupsAndQuestions({
    passages: [],
    questions: [{ id: 'q1', sectionId: 's1', displayNumber: '1', passageId: 'missing' }],
  });
  assert.ok(errors.some((e) => /không tồn tại/.test(e)));
});

test('validateDraftForPublish cannot bypass missing required document via teacherConfirmedReview', () => {
  const draft = {
    title: 'T',
    needsReview: true,
    teacherConfirmedReview: true,
    passages: [{
      id: 'g1',
      sectionId: 's1',
      title: 'Questions 1-1 refer to the following text.',
      requiresContext: true,
      documents: [{ id: 'd1', bodyText: '', requiresReview: true }],
    }],
    questions: [{
      id: 'q1',
      sectionId: 's1',
      displayNumber: '1',
      stemText: 'S?',
      options: [{ id: 'A', text: 'a' }, { id: 'B', text: 'b' }],
      correctOptionId: 'A',
    }],
  };
  const v = validateDraftForPublish(draft);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => {
    if (!/thiếu nội dung (?:ngữ cảnh|nhóm câu hỏi)/i.test(publishErrorMessage(e))) return false;
    if (typeof e === 'object' && e.target) return e.target.passageId === 'g1';
    return true;
  }));
});

test('validateDraftForPublish emits unique per-group context confirmation errors', () => {
  const draft = {
    title: 'T',
    needsReview: false,
    teacherConfirmedReview: true,
    passages: [
      {
        id: 'g1',
        sectionId: 's1',
        title: 'Questions 1-2 refer to the following text.',
        sourcePage: 10,
        requiresContext: true,
        documents: [{ id: 'd1', bodyText: 'A', sourcePages: [10] }],
        contextConfirmed: false,
      },
      {
        id: 'g2',
        sectionId: 's1',
        title: 'Questions 3-4 refer to the following text.',
        sourcePage: 11,
        requiresContext: true,
        documents: [{ id: 'd2', bodyText: 'B', sourcePages: [11] }],
        contextConfirmed: false,
      },
    ],
    questions: [
      {
        id: 'q1', sectionId: 's1', displayNumber: '1', stemText: 'S?', passageId: 'g1',
        options: [{ id: 'A', text: 'a' }, { id: 'B', text: 'b' }], correctOptionId: 'A',
      },
      {
        id: 'q2', sectionId: 's1', displayNumber: '3', stemText: 'S?', passageId: 'g2',
        options: [{ id: 'A', text: 'a' }, { id: 'B', text: 'b' }], correctOptionId: 'A',
      },
    ],
  };
  const v = validateDraftForPublish(draft);
  assert.equal(v.ok, false);
  const msgs = v.errors.map(publishErrorMessage);
  assert.equal(msgs.length, 2);
  assert.notEqual(msgs[0], msgs[1]);
  const nav1 = resolvePublishValidationError(v.errors[0], draft);
  const nav2 = resolvePublishValidationError(v.errors[1], draft);
  assert.equal(nav1.targets[0].passageId, 'g1');
  assert.equal(nav2.targets[0].passageId, 'g2');
  assert.equal(nav1.targets[0].focusRole, 'contextConfirm');
});

test('contextConfirmed persists through normalizeReadingGroup', () => {
  const raw = {
    id: 'g1',
    requiresContext: true,
    contextConfirmed: true,
    documents: [{ id: 'd1', bodyText: 'ok' }],
  };
  const g = normalizeReadingGroup(raw);
  assert.equal(g.contextConfirmed, true);
  assert.equal(raw.contextConfirmed, true);
});

test('draftQuestionNeedsReview ignores missing key in teacher-manual-later mode', () => {
  const draft = minimalPublishDraft({ gradingMode: EXAM_GRADING_MODE.TEACHER_MANUAL_LATER });
  assert.equal(draftQuestionNeedsReview(draft, draft.questions[0]), false);
});

test('draftImportWarningStillActive clears resolved question stem warning', () => {
  const draft = {
    questions: [{
      id: 'q1',
      sectionId: 's1',
      displayNumber: '3',
      stemText: 'filled',
      options: [{ id: 'A', text: 'a' }, { id: 'B', text: 'b' }],
      correctOptionId: 'A',
    }],
    warnings: ['Câu 3: thiếu nội dung câu hỏi — cần rà soát.'],
  };
  assert.equal(draftImportWarningStillActive(draft.warnings[0], draft), false);
  assert.equal(draftQuestionNeedsReview(draft, draft.questions[0]), false);
});

test('computeDraftReviewFilterCounts separates clean and bad items', () => {
  const draft = {
    gradingMode: EXAM_GRADING_MODE.TEACHER_MANUAL_LATER,
    passages: [{
      id: 'g1',
      requiresContext: true,
      documents: [{ id: 'd1', bodyText: 'x' }],
      contextConfirmed: false,
    }],
    questions: [
      {
        id: 'q1', sectionId: 's1', displayNumber: '1', stemText: 'ok', passageId: 'g1',
        options: [{ id: 'A', text: 'a' }, { id: 'B', text: 'b' }], correctOptionId: null,
      },
      {
        id: 'q2', sectionId: 's1', displayNumber: '2', stemText: '', passageId: 'g1',
        options: [{ id: 'A', text: 'a' }, { id: 'B', text: 'b' }], correctOptionId: 'A',
      },
    ],
  };
  const c = computeDraftReviewFilterCounts(draft);
  assert.equal(c.groupsNeedReview, 1);
  assert.equal(c.questionsNeedReview, 1);
  assert.equal(draftQuestionNeedsReview(draft, draft.questions[0]), false);
  assert.equal(draftQuestionNeedsReview(draft, draft.questions[1]), true);
});

test('projectExamVersionForStudent exposes documents without answer keys', () => {
  const version = {
    id: 'v1',
    title: 'T',
    sections: [],
    passages: [{
      id: 'g1',
      title: 'Questions 1-1',
      bodyText: 'legacy',
      documents: [{ id: 'd1', title: 'Doc', type: 'article', bodyText: 'Body', order: 0 }],
    }],
    questions: [{
      id: 'q1',
      sectionId: 's1',
      displayNumber: '1',
      stemText: 'Stem',
      options: [{ id: 'A', label: 'A', text: 'opt' }],
      correctOptionId: 'A',
      passageId: 'g1',
    }],
  };
  const proj = projectExamVersionForStudent(version, { showAnswersAfter: 'after-due' }, null, new Date().toISOString());
  assert.equal(proj.passages[0].documents[0].bodyText, 'Body');
  assert.equal(proj.questions[0].correctOptionId, undefined);
});

test('buildTeacherPreviewExamProjection strips answer keys and confirmed keys', () => {
  const draft = {
    id: 'd1',
    title: 'Preview',
    sections: [],
    passages: [],
    questions: [{
      id: 'q1',
      displayNumber: '1',
      stemText: '?',
      options: [{ id: 'A', label: 'A', text: 'a' }, { id: 'B', label: 'B', text: 'b' }],
      correctOptionId: 'B',
    }],
  };
  const proj = buildTeacherPreviewExamProjection(draft);
  assert.equal(proj.questions[0].correctOptionId, undefined);
  assert.equal(proj.questions[0].options.length, 2);
  assert.equal(proj.attempt?.status, 'in-progress');
  assert.equal(proj.assignment?.showAnswersAfter, 'never');
});

test('formatImportWarningDisplay maps legacy stored warning copy for UI only', () => {
  assert.equal(
    formatImportWarningDisplay('Câu 3: thiếu lựa chọn — cần rà soát.'),
    'Câu 3: thiếu lựa chọn — cần kiểm tra.',
  );
  assert.equal(
    formatImportWarningDisplay('Chưa có trang khóa — cần nhập khóa thủ công trước khi xuất bản.'),
    'Chưa có trang đáp án — bổ sung đáp án thủ công hoặc chọn giáo viên chấm sau.',
  );
  assert.match(
    formatImportWarningDisplay('Nhóm câu 1–1: thiếu nội dung ngữ cảnh bắt buộc (hình/đoạn đọc) — bổ sung trước khi xuất bản.'),
    /nhóm câu hỏi bắt buộc/,
  );
});

test('resolveDraftReviewNavigation maps question warnings to question targets', () => {
  const draft = {
    sections: [{ id: 's1', title: 'Reading' }],
    questions: [{ id: 'q9', sectionId: 's1', displayNumber: '9', stemText: '?' }],
    passages: [],
  };
  const nav = resolveDraftReviewNavigation('Câu 9: thiếu nội dung câu hỏi — cần rà soát.', draft);
  assert.equal(nav.actionable, true);
  assert.equal(nav.targets.length, 1);
  assert.equal(nav.targets[0].questionId, 'q9');
  assert.equal(nav.targets[0].focusRole, 'stem');
  const navNew = resolveDraftReviewNavigation('Câu 9: thiếu nội dung câu hỏi — cần kiểm tra.', draft);
  assert.equal(navNew.targets[0].questionId, 'q9');
});

test('resolveDraftReviewNavigation key-page warnings work in manual mode (legacy and new copy)', () => {
  const draft = minimalPublishDraft({ gradingMode: EXAM_GRADING_MODE.TEACHER_MANUAL_LATER });
  for (const msg of [
    'Chưa có trang khóa — cần nhập khóa thủ công trước khi xuất bản.',
    'Chưa có trang đáp án — bổ sung đáp án thủ công hoặc chọn giáo viên chấm sau.',
  ]) {
    const nav = resolveDraftReviewNavigation(msg, draft);
    assert.equal(nav.actionable, true);
    assert.ok(nav.targets.some((t) => t.kind === 'gradingMode'));
    assert.match(nav.guidance, /giáo viên chấm sau|chấm sau/i);
  }
});

test('resolvePublishErrorNavigation accepts legacy group context messages', () => {
  const draft = {
    title: 'T',
    passages: [{
      id: 'g1',
      title: 'Questions 1-1 refer to the following text.',
      requiresContext: true,
      documents: [{ id: 'd1', bodyText: '', requiresReview: true }],
    }],
    questions: [],
  };
  const legacy = resolvePublishErrorNavigation(
    'Nhóm câu 1–1: thiếu nội dung ngữ cảnh bắt buộc (hình/đoạn đọc) — bổ sung trước khi xuất bản.',
    draft,
  );
  assert.equal(legacy.actionable, true);
  assert.equal(legacy.targets[0].passageId, 'g1');
  const modern = resolvePublishValidationError({
    message: 'Nhóm câu 1–1: thiếu nội dung nhóm câu hỏi bắt buộc (hình hoặc đoạn đọc) — bổ sung trước khi xuất bản.',
    target: { type: 'passage', passageId: 'g1', focusRole: 'body' },
  }, draft);
  assert.equal(modern.targets[0].passageId, 'g1');
});

test('resolveDraftReviewNavigation treats blank page warnings as informational', () => {
  const nav = resolveDraftReviewNavigation('Trang 2: trang trắng (không có nội dung) — bỏ qua khi trích câu hỏi.', {
    questions: [],
    passages: [],
  });
  assert.equal(nav.informational, true);
  assert.equal(nav.actionable, false);
  assert.equal(nav.targets.length, 0);
});

test('resolvePublishErrorNavigation maps missing title to title target', () => {
  const nav = resolvePublishErrorNavigation('Thiếu tiêu đề bài thi.', { questions: [], passages: [] });
  assert.equal(nav.actionable, true);
  assert.equal(nav.targets[0].kind, 'title');
});

function minimalPublishDraft(overrides = {}) {
  return {
    title: 'T',
    needsReview: false,
    teacherConfirmedReview: true,
    passages: [],
    questions: [{
      id: 'q1',
      sectionId: 's1',
      displayNumber: '1',
      stemText: 'S?',
      options: [{ id: 'A', text: 'a' }, { id: 'B', text: 'b' }],
      correctOptionId: null,
    }],
    ...overrides,
  };
}

test('validateDraftForPublish allows missing keys in teacher-manual-later mode', () => {
  const draft = minimalPublishDraft({ gradingMode: EXAM_GRADING_MODE.TEACHER_MANUAL_LATER });
  const v = validateDraftForPublish(draft);
  assert.equal(v.ok, true);
  assert.ok(v.warnings.some((w) => /chấm sau/i.test(w)));
});

test('validateDraftForPublish rejects missing keys in automatic mode', () => {
  const draft = minimalPublishDraft({ gradingMode: EXAM_GRADING_MODE.AUTOMATIC });
  const v = validateDraftForPublish(draft);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => /đáp án đúng|khóa đáp án/i.test(publishErrorMessage(e))));
});

test('gradeAttempt leaves score null until answer key complete', () => {
  const version = {
    questions: [
      { id: 'q1', options: [{ id: 'A' }, { id: 'B' }] },
      { id: 'q2', correctOptionId: 'B', options: [{ id: 'A' }, { id: 'B' }] },
    ],
    confirmedAnswerKey: { q2: 'B' },
  };
  const graded = gradeAttempt(version, { q1: 'A', q2: 'B' });
  assert.equal(graded.gradingStatus, EXAM_ATTEMPT_GRADING_STATUS.PARTIAL);
  assert.equal(graded.score10, null);
  assert.equal(graded.perQuestion[0].correct, null);
  assert.equal(graded.perQuestion[1].correct, true);
});

test('mergeVersionAnswerKeyUpdate detects conflicts without confirmOverwrite', () => {
  const version = {
    questions: [{ id: 'q1', correctOptionId: 'A', options: [{ id: 'A' }, { id: 'B' }] }],
    confirmedAnswerKey: {},
  };
  const merged = mergeVersionAnswerKeyUpdate(version, { q1: 'B' });
  assert.equal(merged.ok, false);
  assert.equal(merged.conflicts.length, 1);
});

test('effectiveVersionForAssignment keeps shared passage once for sparse group picks', () => {
  const version = {
    id: 'v1',
    sections: [{ id: 's1', title: 'R' }],
    passages: [{
      id: 'g1',
      sectionId: 's1',
      title: 'Questions 1-3 refer to the following text.',
      documents: [{ id: 'd1', bodyText: 'Fox', order: 0 }],
    }],
    questions: [
      { id: 'q1', sectionId: 's1', displayNumber: '1', passageId: 'g1', options: [] },
      { id: 'q2', sectionId: 's1', displayNumber: '2', passageId: 'g1', options: [] },
      { id: 'q3', sectionId: 's1', displayNumber: '3', passageId: 'g1', options: [] },
    ],
  };
  const assignment = { selectedQuestionIds: ['q1', 'q3'] };
  const eff = effectiveVersionForAssignment(version, assignment);
  assert.equal(eff.questions.length, 2);
  assert.equal(eff.passages.length, 1);
  assert.equal(eff.passages[0].id, 'g1');
});

test('validateExamAssignmentQuestionSelection rejects unknown duplicate and empty ids', () => {
  const version = {
    questions: [
      { id: 'q1', options: [] },
      { id: 'q2', options: [] },
    ],
  };
  assert.equal(validateExamAssignmentQuestionSelection(version, []).ok, false);
  assert.equal(validateExamAssignmentQuestionSelection(version, ['q1', 'q1']).ok, false);
  assert.equal(validateExamAssignmentQuestionSelection(version, ['nope']).ok, false);
  const ok = validateExamAssignmentQuestionSelection(version, ['q2', 'q1']);
  assert.ok(ok.ok);
  assert.deepEqual(ok.ids, ['q1', 'q2']);
});

test('validateExamAssignmentInput rejects unknown purpose but defaults omitted to exam', () => {
  const now = () => '2025-06-01T09:00:00.000Z';
  const base = {
    openAt: '2025-06-01T08:00:00.000Z',
    dueAt: '2025-06-02T08:00:00.000Z',
    timeLimitMinutes: 30,
    attemptLimit: 1,
  };
  assert.equal(validateExamAssignmentInput({ ...base, purpose: 'quiz' }, now).ok, false);
  const omitted = validateExamAssignmentInput(base, now);
  assert.ok(omitted.ok);
  assert.equal(omitted.purpose, EXAM_ASSIGNMENT_PURPOSE.EXAM);
});

test('gradeAttempt uses assignment subset denominator and ignores unselected pending keys', () => {
  const version = {
    questions: [
      { id: 'q1', correctOptionId: 'A', points: 1, options: [{ id: 'A' }, { id: 'B' }] },
      { id: 'q2', options: [{ id: 'A' }, { id: 'B' }] },
      { id: 'q3', correctOptionId: 'B', points: 1, options: [{ id: 'A' }, { id: 'B' }] },
    ],
    confirmedAnswerKey: { q1: 'A', q3: 'B' },
  };
  const assignment = { selectedQuestionIds: ['q1', 'q3'] };
  const graded = gradeAttempt(version, { q1: 'A', q3: 'B', q2: 'A' }, assignment);
  assert.equal(graded.gradingStatus, EXAM_ATTEMPT_GRADING_STATUS.COMPLETE);
  assert.equal(graded.score10, 10);
  assert.equal(graded.totalCount, 2);
});

test('regradeSubmittedAttemptsForVersion updates scores when key completed', () => {
  const version = {
    id: 'v1',
    questions: [{ id: 'q1', correctOptionId: 'A', options: [{ id: 'A' }, { id: 'B' }] }],
    confirmedAnswerKey: { q1: 'A' },
  };
  const state = {
    examVersions: [version],
    examAssignments: [{ id: 'asg1', versionId: 'v1', purpose: EXAM_ASSIGNMENT_PURPOSE.EXAM }],
    examAttempts: [{
      id: 'a1',
      assignmentId: 'asg1',
      versionId: 'v1',
      status: 'submitted',
      answers: { q1: 'A' },
    }],
  };
  assert.equal(state.examAttempts[0].score10, undefined);
  regradeSubmittedAttemptsForVersion(state, 'v1');
  assert.equal(state.examAttempts[0].gradingStatus, EXAM_ATTEMPT_GRADING_STATUS.COMPLETE);
  assert.equal(state.examAttempts[0].score10, 10);
});

test('legacy assignment without selectedQuestionIds grades all version questions', () => {
  const version = {
    questions: [
      { id: 'q1', correctOptionId: 'A', options: [{ id: 'A' }, { id: 'B' }] },
      { id: 'q2', correctOptionId: 'B', options: [{ id: 'A' }, { id: 'B' }] },
    ],
    confirmedAnswerKey: { q1: 'A', q2: 'B' },
  };
  assert.deepEqual(assignmentSelectedQuestionIds({}, version), ['q1', 'q2']);
});

test('scanExamContentContamination detects backmatter snippets in options', () => {
  const draft = {
    questions: [{
      id: 'q1',
      displayNumber: '200',
      stemText: 'Question?',
      options: [{ id: 'D', text: 'The instructions were too confusing. NO TEST MATERIAL ON THIS PAGE' }],
    }],
    passages: [],
  };
  assert.equal(scanExamContentContamination(draft).length, 1);
  const msg = buildContaminationImportWarning(draft);
  assert.match(msg, /Phát hiện nội dung đuôi PDF/);
  assert.equal(draftImportWarningStillActive(msg, draft), true);
  const nav = resolveDraftReviewNavigation(msg, draft);
  assert.match(nav.guidance, /nhập lại PDF/i);
});

test('formatExamChoiceOptionLabel suppresses duplicate label prefix for word-bank words', () => {
  assert.equal(formatExamChoiceOptionLabel({ id: 'w1', label: 'award', text: 'award' }), 'award');
  assert.equal(formatExamChoiceOptionLabel({ id: 'A', label: 'A', text: 'Alpha' }), 'A. Alpha');
  assert.equal(formatExamChoiceOptionLabel({ id: 'T', label: 'T', text: 'True' }), 'T. True');
});

test('formatExamHubItemMeta separates numbered questions and unnumbered activities', () => {
  assert.equal(formatExamHubItemMeta({ numberedQuestions: 70, unnumberedActivities: 2 }), '70 câu + 2 hoạt động');
  assert.equal(formatExamHubItemMeta({ numberedQuestions: 2, unnumberedActivities: 0 }), '2 câu');
});

test('projectQuestionPublicForStudent exposes essay topic bodyText without teacher keys', () => {
  const q = {
    id: 'q_w',
    displayNumber: 'W',
    questionType: EXAM_QUESTION_TYPE.ESSAY,
    stemText: 'Write',
    essayTopics: [
      { id: 'A', label: 'Topic A', bodyText: 'Life in 2050 at school and work.' },
      { id: 'B', label: 'Topic B', bodyText: 'A famous person and their achievements.', markingNotes: 'secret' },
    ],
    acceptedAnswers: ['nope'],
    correctOptionId: 'X',
  };
  const pub = projectQuestionPublicForStudent(q, new Map());
  assert.equal(pub.essayTopics.length, 2);
  assert.match(pub.essayTopics[1].bodyText, /achievements/i);
  assert.equal(pub.essayTopics[1].markingNotes, undefined);
  assert.equal(pub.acceptedAnswers, undefined);
});

test('sortExamQuestionsByOrder uses order field and stable array fallback without displayNumber sort', () => {
  const swapped = [
    { id: 'q1', displayNumber: '1', order: 2, stemText: 'one' },
    { id: 'q2', displayNumber: '2', order: 1, stemText: 'two' },
  ];
  assert.deepEqual(sortExamQuestionsByOrder(swapped).map((q) => q.id), ['q2', 'q1']);
  const legacy = [
    { id: 'qA', displayNumber: '99' },
    { id: 'qB', displayNumber: '1' },
  ];
  assert.deepEqual(sortExamQuestionsByOrder(legacy).map((q) => q.id), ['qA', 'qB']);
  const b1Like = [...Array(70)].map((_, i) => ({
    id: `q${i + 1}`,
    displayNumber: String(i + 1),
    order: i + 1,
  }));
  const scrambled = b1Like.slice();
  const tail = scrambled.splice(9, 6);
  scrambled.splice(13, 0, ...tail);
  const sortedNums = sortExamQuestionsByOrder(scrambled)
    .filter((q) => q.displayNumber && /^\d+$/.test(q.displayNumber))
    .map((q) => Number(q.displayNumber));
  assert.deepEqual(sortedNums, [...Array(70)].map((_, i) => i + 1));
});

test('validateExamAssignmentQuestionSelection orders subset by source order not client list', () => {
  const version = {
    questions: [
      { id: 'q1', order: 2 },
      { id: 'q2', order: 1 },
      { id: 'q3', order: 3 },
    ],
  };
  const sel = validateExamAssignmentQuestionSelection(version, ['q1', 'q3']);
  assert.deepEqual(sel.ids, ['q1', 'q3']);
  const reversedClient = validateExamAssignmentQuestionSelection(version, ['q3', 'q1']);
  assert.deepEqual(reversedClient.ids, ['q1', 'q3']);
});

test('projectExamVersionForStudent, preview projection, and mountExamTakeQuestionUi honor order field', (t) => {
  installBaDomEnvironment(t);
  const version = {
    id: 'v-order',
    title: 'Order test',
    sections: [{ id: 's1', title: 'Part' }],
    passages: [{
      id: 'g1',
      title: 'Questions 1-2',
      bodyText: 'shared passage',
      sectionId: 's1',
    }],
    questions: [
      {
        id: 'q1',
        sectionId: 's1',
        displayNumber: '1',
        order: 2,
        stemText: 'stem-one',
        passageId: 'g1',
        options: [{ id: 'A', label: 'A', text: 'a' }],
        correctOptionId: 'A',
      },
      {
        id: 'q2',
        sectionId: 's1',
        displayNumber: '2',
        order: 1,
        stemText: 'stem-two',
        passageId: 'g1',
        options: [{ id: 'A', label: 'A', text: 'a' }],
        correctOptionId: 'A',
      },
    ],
  };
  const frozen = JSON.stringify(version);
  const assignment = {
    id: 'asg1',
    openAt: '2025-06-01T08:00:00.000Z',
    dueAt: '2025-06-02T08:00:00.000Z',
    attemptLimit: 1,
    timeLimitMinutes: 60,
  };
  const proj = projectExamVersionForStudent(version, assignment, null, '2025-06-01T09:00:00.000Z');
  assert.deepEqual(proj.questions.map((q) => q.id), ['q2', 'q1']);
  assert.equal(JSON.stringify(version), frozen);

  const preview = buildTeacherPreviewExamProjection(version);
  assert.deepEqual(preview.questions.map((q) => q.id), ['q2', 'q1']);

  const host = document.createElement('div');
  mountExamTakeQuestionUi(host, preview, { answers: {}, onChoiceAnswer: () => {} });
  const text = aggregateDomTextContent(host);
  const passageCount = (text.match(/shared passage/g) || []).length;
  assert.equal(passageCount, 1, 'reading group renders once');
  const iTwo = text.indexOf('stem-two');
  const iOne = text.indexOf('stem-one');
  assert.ok(iTwo >= 0 && iOne > iTwo, 'preview UI follows order field');
});

test('parseScopedDisplayQuestionOrdinal handles exercise scoped labels and legacy numbers', () => {
  assert.equal(parseScopedDisplayQuestionOrdinal('ex10-27'), 27);
  assert.equal(parseScopedDisplayQuestionOrdinal('sample-19'), 19);
  assert.equal(parseScopedDisplayQuestionOrdinal('42'), 42);
  assert.ok(!Number.isFinite(parseScopedDisplayQuestionOrdinal('ex10-x')));
});

test('readingGroupQuestionNumbers uses linked members when declared range mismatches', () => {
  const group = {
    id: 'g1',
    title: 'Read the following passage from 31 to 36.',
    expectedQuestionRange: { min: 31, max: 36 },
    sectionId: 's1',
  };
  const questions = [
    { id: 'q27', sectionId: 's1', displayNumber: 'ex10-27', passageId: 'g1', groupId: 'g1' },
    { id: 'q28', sectionId: 's1', displayNumber: 'ex10-28', passageId: 'g1', groupId: 'g1' },
    { id: 'q29', sectionId: 's1', displayNumber: 'ex10-29', passageId: 'g1', groupId: 'g1' },
    { id: 'q19', sectionId: 's1', displayNumber: 'sample-19', passageId: 'g2', groupId: 'g2' },
  ];
  const nums = readingGroupQuestionNumbers(group, questions);
  assert.deepEqual(nums, ['ex10-27', 'ex10-28', 'ex10-29']);
  const errors = validateReadingGroupsAndQuestions(
    [group],
    questions,
  );
  assert.ok(!errors.some((e) => /ex10-27|ex10-28|ex10-29/.test(e)));
});

test('validateDraftForPublish accepts scoped healthy-diet group in teacher-manual-later mode', () => {
  const draft = {
    title: 'Grade 7',
    teacherConfirmedReview: true,
    needsReview: false,
    gradingMode: EXAM_GRADING_MODE.TEACHER_MANUAL_LATER,
    sections: [{ id: 's1', title: 'Phần 1' }],
    passages: [{
      id: 'g1',
      sectionId: 's1',
      title: 'HEALTHY DIET from 31 to 36.',
      expectedQuestionRange: { min: 31, max: 36 },
      documents: [{ id: 'd1', bodyText: 'There are two important matters.', order: 0 }],
      contextConfirmed: true,
    }],
    questions: ['ex10-27', 'ex10-28', 'ex10-29'].map((displayNumber, i) => ({
      id: `q${i}`,
      sectionId: 's1',
      displayNumber,
      passageId: 'g1',
      groupId: 'g1',
      stemText: `Stem ${displayNumber}?`,
      points: 1,
      options: ['A', 'B', 'C', 'D'].map((id) => ({ id, label: id, text: id })),
      correctOptionId: null,
    })),
    warnings: [],
  };
  const v = validateDraftForPublish(draft);
  assert.equal(v.ok, true);
});

test('scoped range compat: legacy q99 in group 1-2 fails validation', () => {
  const group = {
    id: 'g1',
    title: 'Questions 1 to 2.',
    expectedQuestionRange: { min: 1, max: 2 },
    sectionId: 's1',
  };
  const questions = [{
    id: 'q99',
    sectionId: 's1',
    displayNumber: '99',
    passageId: 'g1',
    groupId: 'g1',
    stemText: 'Legacy stem?',
    options: [{ id: 'A', text: 'a' }, { id: 'B', text: 'b' }],
    correctOptionId: 'A',
  }];
  const errors = validateReadingGroupsAndQuestions({ passages: [group], questions });
  assert.ok(errors.some((e) => /Câu 99.*ngoài dải.*1–2/.test(publishErrorMessage(e))));
});

test('scoped range compat: mixed scoped and numeric labels keep declared range', () => {
  const group = {
    id: 'g1',
    title: 'HEALTHY DIET from 31 to 36.',
    expectedQuestionRange: { min: 31, max: 36 },
    sectionId: 's1',
  };
  const questions = [
    {
      id: 'q27',
      sectionId: 's1',
      displayNumber: 'ex10-27',
      passageId: 'g1',
      groupId: 'g1',
      stemText: 'ok?',
      options: [{ id: 'A', text: 'a' }, { id: 'B', text: 'b' }],
      correctOptionId: 'A',
    },
    {
      id: 'q42',
      sectionId: 's1',
      displayNumber: '42',
      passageId: 'g1',
      groupId: 'g1',
      stemText: 'ok2?',
      options: [{ id: 'A', text: 'a' }, { id: 'B', text: 'b' }],
      correctOptionId: 'A',
    },
  ];
  const errors = validateReadingGroupsAndQuestions({ passages: [group], questions });
  assert.ok(errors.some((e) => /ex10-27.*ngoài dải.*31–36/.test(publishErrorMessage(e))));
  assert.ok(errors.some((e) => /Câu 42.*ngoài dải.*31–36/.test(publishErrorMessage(e))));
});

test('phonetic sourceReview clears need-review filter after teacher confirmation', () => {
  const q = {
    id: 'q1',
    sectionId: 's1',
    displayNumber: 'ex2-5',
    stemText: 'stem',
    options: [{ id: 'A', text: 'a' }, { id: 'B', text: 'b' }],
    correctOptionId: null,
    sourceReview: { needsTeacherCheck: true, kind: 'phonetic-underline' },
  };
  const draftOpen = {
    teacherConfirmedReview: false,
    warnings: [
      'Câu ex2-5: phần gạch chân trong PDF không được giữ khi nhập — cần đối chiếu PDF và sửa nếu cần.',
    ],
    questions: [q],
  };
  assert.equal(draftQuestionNeedsReview(draftOpen, q), true);
  assert.equal(draftQuestionSourceReviewPending(draftOpen, q), true);
  const draftDone = { ...draftOpen, teacherConfirmedReview: true };
  assert.equal(draftQuestionNeedsReview(draftDone, q), false);
  assert.equal(draftQuestionSourceReviewPending(draftDone, q), false);
  assert.equal(q.sourceReview.needsTeacherCheck, true);
  assert.equal(
    draftImportWarningStillActive(draftDone.warnings[0], draftDone),
    false,
  );
});
