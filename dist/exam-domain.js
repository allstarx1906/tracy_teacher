/**
 * Shared exam domain: validation, grading, student projection (no secrets).
 */

export const EXAM_JOB_STATUS = {
  QUEUED: 'queued',
  EXTRACTING: 'extracting',
  PARSING: 'parsing',
  NEEDS_REVIEW: 'needs-review',
  READY: 'ready',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  INTERRUPTED: 'interrupted',
};

export const EXAM_ATTEMPT_STATUS = {
  IN_PROGRESS: 'in-progress',
  SUBMITTED: 'submitted',
  EXPIRED: 'expired',
};

/** automatic = auto-score when all keys present; teacher-manual-later = publish/read without draft keys */
export const EXAM_GRADING_MODE = {
  AUTOMATIC: 'automatic',
  TEACHER_MANUAL_LATER: 'teacher-manual-later',
};

export const EXAM_ATTEMPT_GRADING_STATUS = {
  PENDING: 'pending',
  PARTIAL: 'partial',
  COMPLETE: 'complete',
};

/** @readonly */
export const EXAM_ASSIGNMENT_PURPOSE = {
  EXAM: 'exam',
  HOMEWORK: 'homework',
};

export function normalizeExamAssignmentPurpose(value) {
  if (value === EXAM_ASSIGNMENT_PURPOSE.HOMEWORK) return EXAM_ASSIGNMENT_PURPOSE.HOMEWORK;
  return EXAM_ASSIGNMENT_PURPOSE.EXAM;
}

export function isExamHomeworkAssignment(assignment) {
  return normalizeExamAssignmentPurpose(assignment?.purpose) === EXAM_ASSIGNMENT_PURPOSE.HOMEWORK;
}

export function examAssignmentTypeBadge(assignment) {
  const mode = normalizeExamDeliveryMode(assignment);
  if (mode === EXAM_DELIVERY_MODE.PDF) {
    return isExamHomeworkAssignment(assignment) ? 'Bài tập PDF' : 'Bài thi PDF';
  }
  if (mode === EXAM_DELIVERY_MODE.COMBINED) {
    return isExamHomeworkAssignment(assignment) ? 'Bài tập kết hợp' : 'Bài thi kết hợp';
  }
  return isExamHomeworkAssignment(assignment) ? 'Bài tập trực tuyến' : 'Bài thi trực tuyến';
}

/** @readonly */
export const EXAM_QUESTION_TYPE = {
  SINGLE_CHOICE: 'single-choice',
  SHORT_ANSWER: 'short-answer',
  TRUE_FALSE_NOT_GIVEN: 'true-false-not-given',
  MATCHING: 'matching',
  WORD_BANK: 'word-bank',
  ESSAY: 'essay',
  ORAL_ASSESSMENT: 'oral-assessment',
};

const EXAM_QUESTION_TYPE_SET = new Set(Object.values(EXAM_QUESTION_TYPE));

export function normalizeExamQuestionType(question) {
  const raw = question?.questionType;
  if (raw && EXAM_QUESTION_TYPE_SET.has(raw)) return raw;
  return EXAM_QUESTION_TYPE.SINGLE_CHOICE;
}

export function isChoiceBasedQuestion(question) {
  const t = normalizeExamQuestionType(question);
  return t === EXAM_QUESTION_TYPE.SINGLE_CHOICE
    || t === EXAM_QUESTION_TYPE.TRUE_FALSE_NOT_GIVEN
    || t === EXAM_QUESTION_TYPE.MATCHING
    || t === EXAM_QUESTION_TYPE.WORD_BANK;
}

export function isManualOnlyQuestion(question) {
  const t = normalizeExamQuestionType(question);
  return t === EXAM_QUESTION_TYPE.ESSAY
    || t === EXAM_QUESTION_TYPE.ORAL_ASSESSMENT;
}

export function isStudentResponseQuestion(question) {
  return normalizeExamQuestionType(question) !== EXAM_QUESTION_TYPE.ORAL_ASSESSMENT;
}

/** Auto-scored when keys exist (choice or short text); essay/oral never. */
export function isAutoGradableQuestion(question) {
  const t = normalizeExamQuestionType(question);
  return isChoiceBasedQuestion(question) || t === EXAM_QUESTION_TYPE.SHORT_ANSWER;
}

export function questionUsesOptionsForPublish(question) {
  return isChoiceBasedQuestion(question);
}

export function normalizeShortAnswerText(value) {
  return String(value ?? '')
    .trim()
    .replace(/\s+/g, ' ');
}

export function shortAnswerTextsMatch(studentRaw, acceptedRaw, { caseSensitive = false } = {}) {
  let a = normalizeShortAnswerText(studentRaw);
  let b = normalizeShortAnswerText(acceptedRaw);
  if (!caseSensitive) {
    a = a.toLowerCase();
    b = b.toLowerCase();
  }
  return a.length > 0 && a === b;
}

function countWords(text) {
  const t = normalizeShortAnswerText(text);
  if (!t) return 0;
  return t.split(/\s+/).filter(Boolean).length;
}

export function resolveTextAnswerKey(version, questionId) {
  const map = version?.confirmedTextAnswerKey;
  if (map && Object.prototype.hasOwnProperty.call(map, questionId)) {
    const list = map[questionId];
    if (Array.isArray(list) && list.length) return list.filter((x) => String(x ?? '').trim());
  }
  const q = (version?.questions || []).find((x) => x.id === questionId);
  if (Array.isArray(q?.acceptedAnswers) && q.acceptedAnswers.length) {
    return q.acceptedAnswers.map((x) => String(x));
  }
  return null;
}

export function mergeVersionTextAnswerKeyUpdate(version, patch, { confirmOverwrite = false } = {}) {
  if (!version || !patch || typeof patch !== 'object') {
    return { ok: false, error: 'invalid-payload' };
  }
  const conflicts = [];
  const next = { ...(version.confirmedTextAnswerKey || {}) };
  for (const [questionId, rawList] of Object.entries(patch)) {
    const q = (version.questions || []).find((x) => x.id === questionId);
    if (!q) return { ok: false, error: 'invalid-question' };
    if (normalizeExamQuestionType(q) !== EXAM_QUESTION_TYPE.SHORT_ANSWER) {
      return { ok: false, error: 'invalid-question-type' };
    }
    if (!Array.isArray(rawList)) return { ok: false, error: 'invalid-answers' };
    const list = rawList.map((x) => String(x ?? '').trim()).filter(Boolean);
    if (!list.length) return { ok: false, error: 'invalid-answers' };
    const confirmedMap = version.confirmedTextAnswerKey || {};
    const hasConfirmed = Object.prototype.hasOwnProperty.call(confirmedMap, questionId);
    const existing = hasConfirmed
      ? confirmedMap[questionId].map((x) => String(x ?? '').trim()).filter(Boolean)
      : null;
    const existingJson = JSON.stringify(existing || []);
    const nextJson = JSON.stringify(list);
    if (hasConfirmed && existing?.length && existingJson !== nextJson && !confirmOverwrite) {
      conflicts.push({ questionId, existingAccepted: existing, nextAccepted: list });
      continue;
    }
    next[questionId] = list;
  }
  if (conflicts.length) return { ok: false, conflicts };
  return { ok: true, confirmedTextAnswerKey: next };
}

export function buildConfirmedTextAnswerKeyFromDraftQuestions(questions) {
  const out = {};
  for (const q of questions || []) {
    if (normalizeExamQuestionType(q) !== EXAM_QUESTION_TYPE.SHORT_ANSWER) continue;
    if (!Array.isArray(q.acceptedAnswers) || !q.acceptedAnswers.length) continue;
    const list = q.acceptedAnswers.map((x) => String(x ?? '').trim()).filter(Boolean);
    if (list.length) out[q.id] = list;
  }
  return out;
}

function draftHasAutogradableKey(draft, question) {
  if (isChoiceBasedQuestion(question)) {
    const key = resolveVersionAnswerKey(draft, question.id) || question.correctOptionId;
    return !!key;
  }
  if (normalizeExamQuestionType(question) === EXAM_QUESTION_TYPE.SHORT_ANSWER) {
    const list = resolveTextAnswerKey(draft, question.id);
    return !!(list && list.length);
  }
  return false;
}

export function formatExamChoiceOptionLabel(option) {
  if (!option) return '';
  const label = option.label != null ? String(option.label).trim() : '';
  const text = option.text != null ? String(option.text).trim() : '';
  if (label && text) {
    if (label.toLowerCase() === text.toLowerCase()) return text;
    return `${label}. ${text}`;
  }
  return text || label || String(option.id ?? '');
}

/** Teacher hub / list cards: 70 câu + 2 hoạt động (legacy questionCount unchanged). */
export function formatExamHubItemMeta(summary) {
  const numbered = summary?.numberedQuestions ?? 0;
  const activities = summary?.unnumberedActivities ?? 0;
  if (activities > 0) return `${numbered} câu + ${activities} hoạt động`;
  return `${numbered} câu`;
}

export function summarizeExamItems(versionOrDraft) {
  const questions = versionOrDraft?.questions || [];
  let numberedQuestions = 0;
  let unnumberedActivities = 0;
  let respondableItems = 0;
  let manualOnlyItems = 0;
  let autoGradableItems = 0;
  let totalPoints = 0;
  for (const q of questions) {
    const points = Number(q.points) > 0 ? Number(q.points) : 1;
    totalPoints += points;
    if (q.unnumberedActivity) unnumberedActivities += 1;
    else numberedQuestions += 1;
    if (isStudentResponseQuestion(q)) respondableItems += 1;
    if (isManualOnlyQuestion(q)) manualOnlyItems += 1;
    if (isAutoGradableQuestion(q)) autoGradableItems += 1;
  }
  return {
    numberedQuestions,
    unnumberedActivities,
    respondableItems,
    manualOnlyItems,
    autoGradableItems,
    questionCount: questions.length,
    totalPoints,
  };
}

export function projectQuestionPublicForStudent(question, passagesById) {
  const t = normalizeExamQuestionType(question);
  const out = {
    id: question.id,
    sectionId: question.sectionId,
    groupId: question.groupId,
    displayNumber: question.displayNumber,
    stemText: question.stemText,
    questionType: t,
    points: question.points,
    passageId: question.passageId,
    unnumberedActivity: !!question.unnumberedActivity,
  };
  if (question.maxWords != null) out.maxWords = Number(question.maxWords);
  if (question.minWords != null) out.minWords = Number(question.minWords);
  if (question.maxLength != null) out.maxLength = Number(question.maxLength);
  if (question.requiresAudio) out.requiresAudio = true;
  if (t === EXAM_QUESTION_TYPE.ESSAY && Array.isArray(question.essayTopics)) {
    out.essayTopics = question.essayTopics.map((row) => {
      const topic = {
        id: row.id,
        label: row.label,
      };
      const body = row.bodyText != null ? String(row.bodyText).trim() : '';
      if (body) topic.bodyText = row.bodyText;
      return topic;
    });
  }
  if (isChoiceBasedQuestion(question)) {
    out.options = (question.options || []).map((o) => ({
      id: o.id,
      label: o.label,
      text: o.text,
    }));
  }
  if (t === EXAM_QUESTION_TYPE.WORD_BANK || t === EXAM_QUESTION_TYPE.MATCHING) {
    const gid = question.passageId || question.groupId;
    const bankId = question.wordBankId || question.sourceWordBankId;
    const passage = gid ? passagesById.get(gid) : null;
    if (passage?.wordBankWords?.length) {
      out.wordBankWords = passage.wordBankWords.map((w) => ({
        id: w.id,
        text: w.text,
      }));
    } else if (Array.isArray(question.wordBankWords)) {
      out.wordBankWords = question.wordBankWords.map((w) => ({
        id: w.id,
        text: w.text,
      }));
    }
    if (passage?.wordBankInstructions) out.wordBankInstructions = passage.wordBankInstructions;
    else if (question.wordBankInstructions) out.wordBankInstructions = question.wordBankInstructions;
    if (question.sourceWordBankUseOnce || passage?.sourceWordBankUseOnce) {
      out.sourceWordBankUseOnce = true;
    }
    if (bankId) out.wordBankId = bankId;
  }
  return out;
}

function essayAnswerShape(value) {
  if (value == null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) return null;
  const text = value.text != null ? String(value.text) : '';
  const topicId = value.topicId != null ? String(value.topicId) : '';
  if (!text.trim() && !topicId) return null;
  return { text, topicId };
}

function parseEssayAnswerInput(raw) {
  if (raw == null) return { ok: true, value: null };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, code: 'bad-answer', error: 'Câu trả lời không hợp lệ.' };
  }
  if (raw.text != null && typeof raw.text !== 'string') {
    return { ok: false, code: 'bad-answer', error: 'Câu trả lời không hợp lệ.' };
  }
  if (raw.topicId != null && typeof raw.topicId !== 'string') {
    return { ok: false, code: 'bad-answer', error: 'Câu trả lời không hợp lệ.' };
  }
  const text = raw.text != null ? raw.text : '';
  const topicId = raw.topicId != null ? raw.topicId : '';
  if (!text.trim() && !topicId) return { ok: true, value: null };
  return { ok: true, value: { text, topicId } };
}

function validateAnswerBounds(question, value, { enforceEssayMinWords = false } = {}) {
  const t = normalizeExamQuestionType(question);
  if (t === EXAM_QUESTION_TYPE.SHORT_ANSWER && typeof value === 'string') {
    const maxLen = Number(question.maxLength);
    if (Number.isFinite(maxLen) && maxLen > 0 && value.length > maxLen) {
      return { ok: false, code: 'overlong', error: 'Câu trả lời quá dài.' };
    }
    const maxWords = Number(question.maxWords);
    if (Number.isFinite(maxWords) && maxWords > 0 && countWords(value) > maxWords) {
      return { ok: false, code: 'overlong', error: 'Câu trả lời vượt quá số từ cho phép.' };
    }
  }
  if (t === EXAM_QUESTION_TYPE.ESSAY) {
    const essay = essayAnswerShape(value);
    if (!essay) return { ok: true, value: null };
    const maxWords = Number(question.maxWords);
    const minWords = Number(question.minWords);
    const wc = countWords(essay.text);
    if (Number.isFinite(maxWords) && maxWords > 0 && wc > maxWords) {
      return { ok: false, code: 'overlong', error: 'Bài viết vượt quá số từ cho phép.' };
    }
    if (enforceEssayMinWords && Number.isFinite(minWords) && minWords > 0 && essay.text.trim() && wc < minWords) {
      return { ok: false, code: 'too-short', error: 'Bài viết chưa đủ số từ tối thiểu.' };
    }
    if (Array.isArray(question.essayTopics) && question.essayTopics.length && essay.topicId) {
      if (!question.essayTopics.some((row) => String(row.id) === essay.topicId)) {
        return { ok: false, code: 'bad-topic', error: 'Chủ đề bài viết không hợp lệ.' };
      }
    }
    return { ok: true, value: essay };
  }
  return { ok: true, value };
}

/**
 * Normalize one answer patch from student API body to stored attempt.answers value.
 */
export function coerceAttemptAnswerFromBody(question, body) {
  if (!question) return { ok: false, code: 'unknown-question', error: 'Câu hỏi không thuộc đề.' };
  const t = normalizeExamQuestionType(question);
  if (t === EXAM_QUESTION_TYPE.ORAL_ASSESSMENT) {
    return { ok: false, code: 'oral-forbidden', error: 'Câu hỏi này không nhận câu trả lời từ học sinh.' };
  }
  if (body?.clear === true || body?.answer === null) {
    return { ok: true, value: null };
  }
  let raw = body?.answer;
  if (raw === undefined && body?.optionId !== undefined) raw = body.optionId;
  if (raw === undefined || raw === '') {
    return { ok: true, value: null };
  }
  if (isChoiceBasedQuestion(question)) {
    const opt = String(raw);
    if (!question.options?.some((o) => o.id === opt)) {
      return { ok: false, code: 'bad-option', error: 'Lựa chọn không hợp lệ.' };
    }
    return { ok: true, value: opt };
  }
  if (t === EXAM_QUESTION_TYPE.SHORT_ANSWER) {
    if (typeof raw !== 'string') {
      return { ok: false, code: 'bad-answer', error: 'Câu trả lời không hợp lệ.' };
    }
    const text = raw.trim();
    const bounded = validateAnswerBounds(question, text);
    if (!bounded.ok) return bounded;
    return { ok: true, value: text || null };
  }
  if (t === EXAM_QUESTION_TYPE.ESSAY) {
    const parsed = parseEssayAnswerInput(raw);
    if (!parsed.ok) return parsed;
    if (!parsed.value) return { ok: true, value: null };
    const bounded = validateAnswerBounds(question, parsed.value, { enforceEssayMinWords: false });
    if (!bounded.ok) return bounded;
    return { ok: true, value: bounded.value };
  }
  return { ok: false, code: 'bad-type', error: 'Loại câu hỏi không hỗ trợ câu trả lời này.' };
}

export function validateAttemptAnswerPatch(effectiveVersion, body) {
  const qid = body?.questionId;
  if (typeof qid !== 'string' || !qid.trim()) {
    return { ok: false, code: 'bad-question-id', error: 'Thiếu mã câu hỏi.' };
  }
  const question = (effectiveVersion?.questions || []).find((q) => q.id === qid);
  return coerceAttemptAnswerFromBody(question, body);
}

function wordBankScopeKey(question, passagesById) {
  const gid = question.passageId || question.groupId;
  const passage = gid ? passagesById.get(gid) : null;
  const bankId = question.wordBankId || question.sourceWordBankId || passage?.wordBankId || gid;
  return bankId ? String(bankId) : null;
}

function questionRequiresWordBankOnce(question, passagesById) {
  if (normalizeExamQuestionType(question) !== EXAM_QUESTION_TYPE.WORD_BANK) return false;
  const gid = question.passageId || question.groupId;
  const passage = gid ? passagesById.get(gid) : null;
  return !!(question.sourceWordBankUseOnce || passage?.sourceWordBankUseOnce);
}

export function detectWordBankUseOnceViolations(effectiveVersion, answers) {
  const passages = normalizeDraftPassages(effectiveVersion?.passages || []);
  const passagesById = new Map(passages.map((p) => [p.id, p]));
  const scoped = new Map();
  for (const q of effectiveVersion?.questions || []) {
    if (!questionRequiresWordBankOnce(q, passagesById)) continue;
    const scope = wordBankScopeKey(q, passagesById);
    if (!scope) continue;
    const chosen = answers?.[q.id];
    if (chosen == null || chosen === '') continue;
    if (!scoped.has(scope)) scoped.set(scope, new Map());
    const bucket = scoped.get(scope);
    const key = String(chosen);
    if (!bucket.has(key)) bucket.set(key, []);
    bucket.get(key).push(q.displayNumber);
  }
  const violations = [];
  for (const [, bucket] of scoped) {
    for (const [wordId, nums] of bucket) {
      if (nums.length > 1) {
        violations.push({
          wordId,
          displayNumbers: nums,
          message: `Từ "${wordId}" được chọn nhiều lần (câu ${nums.join(', ')}) — mỗi từ chỉ dùng một lần.`,
        });
      }
    }
  }
  return violations;
}

export function validateAttemptAnswersForSubmit(effectiveVersion, answers) {
  const violations = detectWordBankUseOnceViolations(effectiveVersion, answers);
  if (violations.length) {
    return { ok: false, code: 'word-bank-once', error: violations[0].message, violations };
  }
  for (const q of effectiveVersion?.questions || []) {
    if (normalizeExamQuestionType(q) !== EXAM_QUESTION_TYPE.ESSAY) continue;
    const essay = essayAnswerShape(answers?.[q.id]);
    if (!essay?.text?.trim()) continue;
    if (Array.isArray(q.essayTopics) && q.essayTopics.length) {
      const topicId = String(essay.topicId || '').trim();
      if (!topicId || !q.essayTopics.some((row) => String(row.id) === topicId)) {
        return {
          ok: false,
          code: 'missing-topic',
          error: 'Hãy chọn chủ đề bài viết trước khi nộp.',
        };
      }
    }
    const minCheck = validateAnswerBounds(q, essay, { enforceEssayMinWords: true });
    if (!minCheck.ok) return minCheck;
  }
  return { ok: true };
}

export function mergeManualGradesUpdate(attempt, version, assignment, marksPatch, { gradedBy, gradedAt } = {}) {
  if (!attempt || !version) return { ok: false, error: 'missing' };
  const effective = effectiveVersionForAssignment(version, assignment);
  const questionById = new Map((effective.questions || []).map((q) => [q.id, q]));
  const next = { ...(attempt.manualGrades || {}) };
  const entries = Array.isArray(marksPatch)
    ? marksPatch
    : Object.entries(marksPatch || {}).map(([questionId, row]) => ({ questionId, ...row }));
  for (const row of entries) {
    const qid = row?.questionId;
    if (!qid || !questionById.has(qid)) return { ok: false, error: 'invalid-question' };
    const q = questionById.get(qid);
    const maxPts = Number(q.points) > 0 ? Number(q.points) : 1;
    const scoreRaw = row?.score;
    if (scoreRaw == null && row?.clear === true) {
      delete next[qid];
      continue;
    }
    const score = Number(scoreRaw);
    if (!Number.isFinite(score) || score < 0 || score > maxPts) {
      return { ok: false, error: 'invalid-score', questionId: qid, maxPoints: maxPts };
    }
    next[qid] = {
      score,
      feedback: row?.feedback != null ? String(row.feedback) : (next[qid]?.feedback || ''),
      gradedBy: gradedBy || next[qid]?.gradedBy || null,
      gradedAt: gradedAt || next[qid]?.gradedAt || null,
    };
  }
  return { ok: true, manualGrades: next };
}

export function buildTeacherGradingAttemptDetail(version, assignment, attempt) {
  const effective = effectiveVersionForAssignment(version, assignment);
  const passages = normalizeDraftPassages(effective.passages || []);
  const passagesById = new Map(passages.map((p) => [p.id, p]));
  const manualGrades = { ...(attempt?.manualGrades || {}) };
  const rows = sortExamQuestionsByOrder(effective.questions || []).map((q) => {
    const t = normalizeExamQuestionType(q);
    const answer = attempt?.answers?.[q.id];
    const mg = manualGrades[q.id] || null;
    let responsePreview = null;
    if (isChoiceBasedQuestion(q)) responsePreview = answer != null ? String(answer) : null;
    else if (t === EXAM_QUESTION_TYPE.SHORT_ANSWER) responsePreview = answer != null ? String(answer) : null;
    else if (t === EXAM_QUESTION_TYPE.ESSAY && answer && typeof answer === 'object') {
      responsePreview = { topicId: answer.topicId || null, text: answer.text || '' };
    }
    return {
      questionId: q.id,
      displayNumber: q.displayNumber,
      questionType: t,
      points: Number(q.points) > 0 ? Number(q.points) : 1,
      respondable: isStudentResponseQuestion(q),
      manualOnly: isManualOnlyQuestion(q),
      responsePreview,
      manualGrade: mg,
      public: projectQuestionPublicForStudent(q, passagesById),
    };
  });
  return {
    gradingRevision: attempt?.gradingRevision || 0,
    manualGrades,
    questions: rows,
  };
}

/** Immutable subset for assignment; legacy rows without field mean all version questions. */
export function assignmentSelectedQuestionIds(assignment, version) {
  const raw = assignment?.selectedQuestionIds;
  if (Array.isArray(raw) && raw.length > 0) return raw.slice();
  return sortExamQuestionsByOrder(version?.questions || []).map((q) => q.id);
}

export function validateExamAssignmentQuestionSelection(version, selectedQuestionIds) {
  if (selectedQuestionIds == null) return { ok: true, ids: null };
  if (!Array.isArray(selectedQuestionIds)) {
    return { ok: false, error: 'Danh sách câu hỏi không hợp lệ.' };
  }
  if (selectedQuestionIds.length === 0) {
    return { ok: false, error: 'Chọn ít nhất một câu hỏi.' };
  }
  const seen = new Set();
  for (const id of selectedQuestionIds) {
    if (typeof id !== 'string' || !id.trim()) {
      return { ok: false, error: 'Mã câu hỏi không hợp lệ.' };
    }
    if (seen.has(id)) return { ok: false, error: 'Có câu hỏi trùng lặp.' };
    seen.add(id);
  }
  const versionIds = new Set((version?.questions || []).map((q) => q.id));
  for (const id of selectedQuestionIds) {
    if (!versionIds.has(id)) return { ok: false, error: 'Có câu hỏi không thuộc đề nguồn.' };
  }
  const subset = (version.questions || []).filter((q) => seen.has(q.id));
  const ordered = sortExamQuestionsByOrder(subset).map((q) => q.id);
  return { ok: true, ids: ordered };
}

function passageIdsForQuestionSet(version, questionIds) {
  const idSet = new Set(questionIds);
  const passageIds = new Set();
  for (const q of version?.questions || []) {
    if (!idSet.has(q.id)) continue;
    const pid = q.passageId || q.groupId;
    if (pid) passageIds.add(pid);
  }
  return passageIds;
}

/**
 * Student/teacher-safe subset of a published version for one assignment (same question IDs & keys).
 */
export function effectiveVersionForAssignment(version, assignment) {
  if (!version) return version;
  const selectedIds = assignmentSelectedQuestionIds(assignment, version);
  const selectedSet = new Set(selectedIds);
  const questions = sortExamQuestionsByOrder(
    (version.questions || []).filter((q) => selectedSet.has(q.id)),
  );
  const passageIds = passageIdsForQuestionSet(version, selectedIds);
  const passages = normalizeDraftPassages(version.passages || []).filter((p) => passageIds.has(p.id));
  const sectionIds = new Set();
  for (const q of questions) {
    if (q.sectionId) sectionIds.add(q.sectionId);
  }
  for (const p of passages) {
    if (p.sectionId) sectionIds.add(p.sectionId);
  }
  const sections = (version.sections || []).filter((s) => sectionIds.has(s.id));
  return {
    ...version,
    sections,
    passages,
    questions,
  };
}

const OPTION_LABELS = ['A', 'B', 'C', 'D', 'E', 'F'];

export function draftMissingAnswerKeyCount(draft) {
  return (draft?.questions || []).filter((q) => {
    if (!isAutoGradableQuestion(q)) return false;
    return !draftHasAutogradableKey(draft, q);
  }).length;
}

export function inferDefaultGradingMode(draft) {
  if (draftMissingAnswerKeyCount(draft) > 0) {
    return EXAM_GRADING_MODE.TEACHER_MANUAL_LATER;
  }
  return EXAM_GRADING_MODE.AUTOMATIC;
}

export function normalizeExamGradingMode(entity) {
  const mode = entity?.gradingMode;
  if (mode === EXAM_GRADING_MODE.TEACHER_MANUAL_LATER || mode === EXAM_GRADING_MODE.AUTOMATIC) {
    return mode;
  }
  return inferDefaultGradingMode(entity);
}

export function allowsMissingAnswerKeysForPublish(draft) {
  return normalizeExamGradingMode(draft) === EXAM_GRADING_MODE.TEACHER_MANUAL_LATER;
}

export function resolveVersionAnswerKey(version, questionId) {
  const map = version?.confirmedAnswerKey;
  if (map && Object.prototype.hasOwnProperty.call(map, questionId)) {
    const v = map[questionId];
    if (v) return v;
  }
  const q = (version?.questions || []).find((x) => x.id === questionId);
  return q?.correctOptionId || null;
}

/** Snippets that must not appear inside Reading stems, options, or passage bodies. */
export const EXAM_PDF_BACKMATTER_SNIPPET_RES = [
  /NO TEST MATERIAL ON THIS PAGE/i,
  /General Directions\s+This test is designed/i,
  /SCRIPT FOR THE LISTENING COMPREHENSION SECTION/i,
  /Sample Form Correct Answers/i,
  /\bItem Number\s+Key\b/i,
  /Stop!\s*This is the end of the test/i,
  /TOEIC Sample Form Script\b/i,
  /\(N\)\s*Questions \d+ through \d+ refer to the following conversation/i,
  /This is the end of the Listening test/i,
];

export function scanExamContentContamination(entity) {
  const hits = [];
  const questions = entity?.questions || [];
  for (const q of questions) {
    const blob = [
      q.stemText,
      ...(q.options || []).map((o) => o.text),
    ].filter(Boolean).join(' ');
    if (!blob.trim()) continue;
    for (const re of EXAM_PDF_BACKMATTER_SNIPPET_RES) {
      if (re.test(blob)) {
        hits.push({ kind: 'question', displayNumber: q.displayNumber, questionId: q.id });
        break;
      }
    }
  }
  for (const raw of entity?.passages || []) {
    const g = normalizeReadingGroup(raw);
    const docs = g.documents?.length ? g.documents : [{ bodyText: g.bodyText }];
    for (const d of docs) {
      const body = String(d.bodyText || '');
      if (!body.trim()) continue;
      for (const re of EXAM_PDF_BACKMATTER_SNIPPET_RES) {
        if (re.test(body)) {
          hits.push({ kind: 'passage', passageId: g.id, documentId: d.id });
          break;
        }
      }
    }
  }
  return hits;
}

export function buildContaminationImportWarning(entity) {
  const hits = scanExamContentContamination(entity);
  if (!hits.length) return null;
  const nums = [...new Set(
    hits.filter((h) => h.kind === 'question' && h.displayNumber != null).map((h) => String(h.displayNumber)),
  )].slice(0, 6);
  const qPart = nums.length ? ` ${nums.join(', ')}` : '';
  return `Phát hiện nội dung đuôi PDF (script/bảng đáp án/hướng dẫn) lẫn vào câu${qPart} — nhập lại PDF với đúng phạm vi trang Reading (bỏ script/trang đáp án) hoặc tạo phiên bản mới; bản đã xuất bản không tự sửa.`;
}

export function versionHasCompleteAnswerKey(version) {
  return (version?.questions || []).every((q) => {
    if (!isAutoGradableQuestion(q)) return true;
    if (isChoiceBasedQuestion(q)) return !!resolveVersionAnswerKey(version, q.id);
    if (normalizeExamQuestionType(q) === EXAM_QUESTION_TYPE.SHORT_ANSWER) {
      const keys = resolveTextAnswerKey(version, q.id);
      return !!(keys && keys.length);
    }
    return true;
  });
}

export function mergeVersionAnswerKeyUpdate(version, patch, { confirmOverwrite = false } = {}) {
  if (!version || !patch || typeof patch !== 'object') {
    return { ok: false, error: 'invalid-payload' };
  }
  const conflicts = [];
  const next = { ...(version.confirmedAnswerKey || {}) };
  for (const [questionId, optionId] of Object.entries(patch)) {
    const q = (version.questions || []).find((x) => x.id === questionId);
    if (!q) return { ok: false, error: 'invalid-question' };
    if (!optionId || !q.options?.some((o) => o.id === optionId)) {
      return { ok: false, error: 'invalid-option' };
    }
    const existing = resolveVersionAnswerKey(version, questionId);
    if (existing && existing !== optionId && !confirmOverwrite) {
      conflicts.push({ questionId, existingOptionId: existing, nextOptionId: optionId });
      continue;
    }
    next[questionId] = optionId;
  }
  if (conflicts.length) return { ok: false, conflicts };
  return { ok: true, confirmedAnswerKey: next };
}

export function attemptGradingLabel(gradingStatus) {
  if (gradingStatus === EXAM_ATTEMPT_GRADING_STATUS.PENDING) return 'Chờ chấm';
  if (gradingStatus === EXAM_ATTEMPT_GRADING_STATUS.PARTIAL) return 'Chưa chấm';
  return null;
}

const B1_PDF_PUA_PUNCT = new Map([
  ['\uE081', '('],
  ['\uE082', ')'],
  ['\uE083', '['],
  ['\uE084', ']'],
  ['\uE088', '-'],
  ['\uE092', ':'],
]);

/** Normalize confirmed private-use punctuation glyphs from B1 source PDFs. */
export function normalizeB1PdfPrivateUseGlyphs(text) {
  let s = String(text ?? '');
  for (const [glyph, plain] of B1_PDF_PUA_PUNCT) {
    if (s.includes(glyph)) s = s.split(glyph).join(plain);
  }
  return s;
}

export function sanitizeExamHtml(text) {
  let s = normalizeB1PdfPrivateUseGlyphs(text ?? '');
  s = s.replace(/[\0-\x08\x0b\x0c\x0e-\x1f]/g, '');
  s = s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return s.trim();
}

export function newExamSectionId() {
  return `sec_${crypto.randomUUID().slice(0, 8)}`;
}

export function newExamQuestionId(sectionId, ordinal) {
  return `q_${sectionId}_${ordinal}`;
}

export function defaultOptionIds(count) {
  return OPTION_LABELS.slice(0, Math.max(2, Math.min(6, count)));
}

const QUESTIONS_RANGE_RE = /Questions?\s+(\d+)\s*[-–]\s*(\d+)/i;

export function parseExpectedQuestionRange(titleOrGroup) {
  if (!titleOrGroup) return null;
  if (titleOrGroup.expectedQuestionRange?.min != null) {
    return { ...titleOrGroup.expectedQuestionRange };
  }
  const m = String(titleOrGroup.title || titleOrGroup).match(QUESTIONS_RANGE_RE);
  if (!m) return null;
  return { min: parseInt(m[1], 10), max: parseInt(m[2], 10) };
}

const SCOPED_DISPLAY_NUMBER_RE = /^(ex\d+|sample)-(\d+)$/i;

/** Numeric ordinal for school exercise scoped labels (ex5-1, sample-27); legacy parseInt fallback. */
export function parseScopedDisplayQuestionOrdinal(displayNumber) {
  const s = String(displayNumber ?? '');
  const m = s.match(SCOPED_DISPLAY_NUMBER_RE);
  if (m) return parseInt(m[2], 10);
  const v = parseInt(s, 10);
  return Number.isFinite(v) ? v : NaN;
}

export function parseExerciseScopeFromDisplayNumber(displayNumber) {
  const m = String(displayNumber ?? '').match(SCOPED_DISPLAY_NUMBER_RE);
  return m ? m[1].toLowerCase() : null;
}

function linkedQuestionsAllowScopedRangeCompat(linked) {
  if (!linked?.length) return false;
  let scope = null;
  for (const q of linked) {
    const dn = String(q.displayNumber ?? '');
    const m = dn.match(SCOPED_DISPLAY_NUMBER_RE);
    if (!m) return false;
    const s = m[1].toLowerCase();
    if (scope === null) scope = s;
    else if (scope !== s) return false;
  }
  return true;
}

function effectiveQuestionRangeForValidation(group, questions) {
  const declared = parseExpectedQuestionRange(group);
  const linked = (questions || []).filter((q) => q.passageId === group.id || q.groupId === group.id);
  const ordinals = linked
    .map((q) => parseScopedDisplayQuestionOrdinal(q.displayNumber))
    .filter((v) => Number.isFinite(v));
  if (!ordinals.length) return declared;
  const minO = Math.min(...ordinals);
  const maxO = Math.max(...ordinals);
  const scopedCompat = linkedQuestionsAllowScopedRangeCompat(linked);
  if (!declared) {
    if (scopedCompat) return { min: minO, max: maxO };
    return declared;
  }
  const anyInDeclared = ordinals.some((v) => v >= declared.min && v <= declared.max);
  if (!anyInDeclared) {
    if (scopedCompat) return { min: minO, max: maxO };
    return declared;
  }
  return declared;
}

/** Normalize legacy passage rows to reading groups with documents (in-memory only). */
export function normalizeReadingGroup(passage) {
  if (!passage) return null;
  const sourcePages = passage.sourcePages?.length
    ? [...passage.sourcePages]
    : passage.sourcePage ? [passage.sourcePage] : [];
  let documents = Array.isArray(passage.documents) ? passage.documents.map((d) => ({ ...d })) : [];
  if (!documents.length && passage.bodyText && String(passage.bodyText).trim()) {
    documents = [{
      id: `${passage.id}_doc_0`,
      title: '',
      type: 'passage',
      bodyText: passage.bodyText,
      sourcePages: [...sourcePages],
      order: 0,
      requiresReview: !!passage.requiresReview,
    }];
  }
  const bodyText = passage.bodyText
    || documents.map((d) => d.bodyText).filter(Boolean).join('\n\n');
  return {
    ...passage,
    instructions: passage.instructions || '',
    expectedQuestionRange: passage.expectedQuestionRange || parseExpectedQuestionRange(passage),
    sourcePages,
    documents,
    bodyText,
    requiresContext: passage.requiresContext ?? false,
    contextConfirmed: !!passage.contextConfirmed,
    unsupportedTaskType: passage.unsupportedTaskType || null,
    unsupportedReason: passage.unsupportedReason || null,
  };
}

export function normalizeDraftPassages(passages) {
  return (passages || []).map((p) => normalizeReadingGroup(p)).filter(Boolean);
}

export function readingGroupAllDocsFilled(group) {
  const g = normalizeReadingGroup(group);
  const docs = g.documents || [];
  if (!docs.length) return !!String(g.bodyText || '').trim();
  return docs.every((d) => String(d.bodyText || '').trim());
}

export function readingGroupQuestionNumbers(group, questions) {
  const range = effectiveQuestionRangeForValidation(group, questions);
  const qs = questions || [];
  const linked = qs.filter((q) => q.passageId === group.id || q.groupId === group.id);
  if (!range) {
    return linked.map((q) => q.displayNumber);
  }
  const out = [];
  const seen = new Set();
  for (const q of linked) {
    const v = parseScopedDisplayQuestionOrdinal(q.displayNumber);
    if (Number.isFinite(v) && v >= range.min && v <= range.max) {
      if (!seen.has(q.displayNumber)) {
        seen.add(q.displayNumber);
        out.push(q.displayNumber);
      }
    }
  }
  for (const q of qs) {
    if (q.passageId === group.id || q.groupId === group.id) continue;
    if (parseExerciseScopeFromDisplayNumber(q.displayNumber)) continue;
    if (q.sectionId && group.sectionId && q.sectionId !== group.sectionId) continue;
    const v = parseScopedDisplayQuestionOrdinal(q.displayNumber);
    if (!Number.isFinite(v) || v < range.min || v > range.max) continue;
    if (!seen.has(q.displayNumber)) {
      seen.add(q.displayNumber);
      out.push(q.displayNumber);
    }
  }
  return out;
}

export function publishErrorMessage(error) {
  if (error == null) return '';
  if (typeof error === 'string') return error;
  if (typeof error === 'object' && error.message != null) return String(error.message);
  return String(error);
}

export function passagePublishErrorTarget(passageId, focusRole = 'body', documentId = null) {
  if (documentId) {
    return { type: 'document', kind: 'document', passageId, documentId, focusRole };
  }
  return { type: 'passage', kind: 'passage', passageId, focusRole };
}

export function readingGroupSourcePageNumbers(group) {
  const g = normalizeReadingGroup(group);
  const pages = g.sourcePages?.length ? [...g.sourcePages] : (g.sourcePage ? [g.sourcePage] : []);
  if (!pages.length && g.documents?.length) {
    for (const d of g.documents) {
      if (d.sourcePages?.length) {
        pages.push(...d.sourcePages);
        break;
      }
    }
  }
  return [...new Set(pages.filter((p) => Number.isFinite(Number(p))))].sort((a, b) => a - b);
}

export function readingGroupPublishLabel(group, questions) {
  const g = normalizeReadingGroup(group);
  const range = parseExpectedQuestionRange(g);
  const memberNums = readingGroupQuestionNumbers(g, questions);
  const label = range
    ? `Nhóm câu ${range.min}–${range.max}`
    : (memberNums.length ? `Nhóm câu ${memberNums.join(', ')}` : (g.title || 'Nhóm đọc'));
  const pages = readingGroupSourcePageNumbers(g);
  if (pages.length) return `${label} (trang ${pages.join(', ')})`;
  return label;
}

export function readingGroupMissingRequiredContext(group) {
  const g = normalizeReadingGroup(group);
  const docs = g.documents || [];
  if (g.requiresContext) {
    if (!docs.length) return !String(g.bodyText || '').trim();
    return docs.some((d) => !String(d.bodyText || '').trim());
  }
  return docs.some((d) => d.requiresReview && !String(d.bodyText || '').trim());
}

export function readingGroupNeedsContextConfirmation(group) {
  const g = normalizeReadingGroup(group);
  return !!(g.requiresContext && readingGroupAllDocsFilled(g) && !g.contextConfirmed);
}

export function draftPassagesPendingContextConfirmation(draft) {
  return (draft?.passages || []).filter((raw) => {
    const g = normalizeReadingGroup(raw);
    if (g.unsupportedTaskType || readingGroupMissingRequiredContext(g)) return false;
    return readingGroupNeedsContextConfirmation(g);
  });
}

export function questionOptionFilledCount(question) {
  return (question?.options || []).filter((o) => String(o.text || '').trim()).length;
}

export function draftQuestionStructuralPublishIssues(draft, question) {
  const issues = [];
  const q = question;
  const passages = normalizeDraftPassages(draft?.passages || []);
  const passageIds = new Set(passages.map((p) => p.id));
  const passageById = new Map(passages.map((p) => [p.id, p]));
  const gid = q.passageId || q.groupId;
  if (gid && !passageIds.has(gid)) {
    issues.push('bad-group-ref');
    return issues;
  }
  if (q.passageId && q.groupId && q.passageId !== q.groupId) issues.push('bad-group-ref');
  const group = gid ? passageById.get(gid) : null;
  if (group && q.sectionId && group.sectionId && q.sectionId !== group.sectionId) {
    issues.push('section-mismatch');
  }
  const range = group ? effectiveQuestionRangeForValidation(group, draft?.questions) : null;
  if (range) {
    const v = parseScopedDisplayQuestionOrdinal(q.displayNumber);
    if (!Number.isFinite(v) || v < range.min || v > range.max) issues.push('range');
  }
  const usesOpts = questionUsesOptionsForPublish(q);
  const opts = q.options || [];
  const uniq = new Set(opts.map((o) => o.id));
  const filled = questionOptionFilledCount(q);
  if (usesOpts) {
    if (filled < 2 || opts.length > 6) issues.push('options');
    if (uniq.size !== opts.length) issues.push('options');
  } else if (filled > 0) {
    issues.push('options');
  }
  if (!q.stemText || !String(q.stemText).trim()) issues.push('stem');
  const allowMissingKeys = allowsMissingAnswerKeysForPublish(draft);
  if (isAutoGradableQuestion(q)) {
    if (!allowMissingKeys) {
      if (isChoiceBasedQuestion(q)) {
        if (!q.correctOptionId) issues.push('key');
        else if (!opts.some((o) => o.id === q.correctOptionId)) issues.push('key');
      } else if (normalizeExamQuestionType(q) === EXAM_QUESTION_TYPE.SHORT_ANSWER) {
        const list = resolveTextAnswerKey(draft, q.id);
        if (!list?.length) issues.push('key');
      }
    } else if (isChoiceBasedQuestion(q) && q.correctOptionId && !opts.some((o) => o.id === q.correctOptionId)) {
      issues.push('key');
    }
  }
  return issues;
}

export function draftQuestionSourceReviewPending(draft, question) {
  const sr = question?.sourceReview;
  if (!sr?.needsTeacherCheck) return false;
  if (draft?.teacherConfirmedReview) return false;
  return true;
}

export function importWarningAppliesToQuestion(warning, draft, question) {
  const text = draftReviewMessage(warning);
  const m = text.match(/^Câu ([^\s:]+)/);
  if (!m || String(question.displayNumber) !== m[1]) return false;
  if (/thiếu nội dung câu hỏi/.test(text)) return !String(question.stemText || '').trim();
  if (/thiếu lựa chọn|chưa đủ 4 lựa chọn/.test(text)) {
    return questionOptionFilledCount(question) < 2;
  }
  if (/gạch chân trong PDF không được giữ/i.test(text)) {
    return draftQuestionSourceReviewPending(draft, question)
      && question?.sourceReview?.kind === 'phonetic-underline';
  }
  if (/cần (?:rà soát|kiểm tra)/i.test(text)) {
    return draftQuestionStructuralPublishIssues(draft, question).length > 0
      || draftQuestionSourceReviewPending(draft, question);
  }
  return false;
}

export function draftImportWarningStillActive(warning, draft) {
  const text = draftReviewMessage(warning);
  if (/Phát hiện nội dung đuôi PDF/.test(text)) {
    return scanExamContentContamination(draft).length > 0;
  }
  if (/trang trắng/i.test(text)) return true;
  if (/Không phát hiện câu hỏi/.test(text)) return !(draft?.questions || []).length;
  const qM = text.match(/^Câu ([^\s:]+)/);
  if (qM) {
    const matches = (draft?.questions || []).filter((q) => String(q.displayNumber) === qM[1]);
    if (!matches.length) return false;
    return matches.some((q) => importWarningAppliesToQuestion(warning, draft, q));
  }
  const passageM = text.match(/Đoạn đọc \(trang (\d+)\)/);
  if (passageM) {
    const page = Number(passageM[1]);
    for (const raw of draft?.passages || []) {
      const g = normalizeReadingGroup(raw);
      for (const d of g.documents || []) {
        if ((d.sourcePages || []).includes(page)) {
          if (!String(d.bodyText || '').trim()) return true;
          return !!d.requiresReview;
        }
      }
      const pages = readingGroupSourcePageNumbers(g);
      if (pages.includes(page) && readingGroupMissingRequiredContext(g)) return true;
    }
    return false;
  }
  return false;
}

export function draftQuestionNeedsReview(draft, question) {
  if (draftQuestionSourceReviewPending(draft, question)) return true;
  if (draftQuestionStructuralPublishIssues(draft, question).length) return true;
  for (const w of draft?.warnings || []) {
    if (!draftImportWarningStillActive(w, draft)) continue;
    if (importWarningAppliesToQuestion(w, draft, question)) return true;
  }
  return false;
}

export function draftReadingGroupNeedsReview(draft, rawGroup) {
  const g = normalizeReadingGroup(rawGroup);
  if (g.unsupportedTaskType) return true;
  if (readingGroupMissingRequiredContext(g)) return true;
  if (readingGroupNeedsContextConfirmation(g)) return true;
  const range = effectiveQuestionRangeForValidation(g, draft?.questions);
  if (range && (range.min > range.max || !Number.isFinite(range.min) || !Number.isFinite(range.max))) {
    return true;
  }
  for (const q of draft?.questions || []) {
    const linked = q.passageId === g.id || q.groupId === g.id;
    const inRange = range && (() => {
      const v = parseScopedDisplayQuestionOrdinal(q.displayNumber);
      return Number.isFinite(v) && v >= range.min && v <= range.max;
    })();
    if (linked || inRange) {
      if (draftQuestionNeedsReview(draft, q)) return true;
    }
  }
  return false;
}

export function computeDraftReviewFilterCounts(draft) {
  const passages = draft?.passages || [];
  const questions = draft?.questions || [];
  let groupsNeedReview = 0;
  let questionsNeedReview = 0;
  for (const p of passages) {
    if (draftReadingGroupNeedsReview(draft, p)) groupsNeedReview += 1;
  }
  for (const q of questions) {
    if (draftQuestionNeedsReview(draft, q)) questionsNeedReview += 1;
  }
  return {
    groupsNeedReview,
    groupsTotal: passages.length,
    questionsNeedReview,
    questionsTotal: questions.length,
  };
}

function findPassageByPublishLabel(draft, labelPrefix) {
  const want = String(labelPrefix || '').trim();
  for (const raw of draft?.passages || []) {
    if (readingGroupPublishLabel(raw, draft?.questions) === want) return normalizeReadingGroup(raw);
  }
  return null;
}

export function validateReadingGroupsAndQuestions(draft) {
  const errors = [];
  const passages = normalizeDraftPassages(draft.passages || []);
  const questions = draft.questions || [];
  const passageIds = new Set(passages.map((p) => p.id));
  const passageById = new Map(passages.map((p) => [p.id, p]));

  for (const g of passages) {
    const label = readingGroupPublishLabel(g, questions);
    if (g.unsupportedTaskType) {
      errors.push({
        message: g.unsupportedReason || `${label}: dạng bài đọc chưa được hỗ trợ — không thể xuất bản.`,
        target: passagePublishErrorTarget(g.id, 'body'),
      });
    }
    const docs = g.documents || [];
    const docIds = docs.map((d) => d.id);
    if (new Set(docIds).size !== docIds.length) {
      errors.push('Mã tài liệu trong nhóm đọc bị trùng.');
    }
    if (readingGroupMissingRequiredContext(g)) {
      const emptyDoc = docs.find((d) => !String(d.bodyText || '').trim());
      errors.push({
        message: `${label}: thiếu nội dung nhóm câu hỏi bắt buộc (hình hoặc đoạn đọc) — bổ sung trước khi xuất bản.`,
        target: passagePublishErrorTarget(g.id, 'body', emptyDoc?.id || null),
      });
    }
    if (readingGroupNeedsContextConfirmation(g)) {
      errors.push({
        message: `${label}: cần xác nhận đã kiểm tra nội dung nhóm câu hỏi.`,
        target: passagePublishErrorTarget(g.id, 'contextConfirm'),
      });
    }
    const range = parseExpectedQuestionRange(g);
    if (range && (range.min > range.max || !Number.isFinite(range.min) || !Number.isFinite(range.max))) {
      errors.push(`${label}: dải câu hỏi của nhóm đọc không hợp lệ.`);
    }
  }

  for (const q of questions) {
    const gid = q.passageId || q.groupId;
    if (gid && !passageIds.has(gid)) {
      errors.push(`Câu ${q.displayNumber}: tham chiếu nhóm đọc không tồn tại.`);
      continue;
    }
    if (q.passageId && q.groupId && q.passageId !== q.groupId) {
      errors.push(`Câu ${q.displayNumber}: tham chiếu nhóm đọc không nhất quán.`);
    }
    const group = gid ? passageById.get(gid) : null;
    if (group && q.sectionId && group.sectionId && q.sectionId !== group.sectionId) {
      errors.push(`Câu ${q.displayNumber}: không cùng phần với nhóm đọc.`);
    }
    const range = group ? effectiveQuestionRangeForValidation(group, questions) : null;
    if (range) {
      const v = parseScopedDisplayQuestionOrdinal(q.displayNumber);
      if (!Number.isFinite(v) || v < range.min || v > range.max) {
        errors.push(`Câu ${q.displayNumber}: nằm ngoài dải nhóm đọc (${range.min}–${range.max}).`);
      }
    }
  }

  const bySection = new Map();
  for (const q of questions) {
    const sec = q.sectionId || 'default';
    if (!bySection.has(sec)) bySection.set(sec, new Map());
    const nums = bySection.get(sec);
    if (nums.has(q.displayNumber)) {
      errors.push(`Trùng số câu ${q.displayNumber} trong cùng phần.`);
    } else {
      nums.set(q.displayNumber, true);
    }
  }

  return errors;
}

export function missingTextLayerPublishError(draft) {
  const pages = draft?.needsOcrPageNumbers;
  if (Array.isArray(pages) && pages.length) {
    return `Trang ${pages.join(', ')}: có nội dung hình/ảnh nhưng không trích được lớp chữ — cần nhận dạng chữ hoặc bổ sung văn bản trước khi xuất bản.`;
  }
  return 'Một hoặc nhiều trang có nội dung hình/ảnh nhưng không trích được lớp chữ — cần nhận dạng chữ hoặc bổ sung văn bản trước khi xuất bản.';
}

export function validateDraftForPublish(draft) {
  if (isPdfOnlyExamDraft(draft)) {
    return validatePdfOnlyDraftForPublish(draft);
  }
  const errors = [];
  const warnings = [...(draft.warnings || [])];
  const gradingMode = normalizeExamGradingMode(draft);
  const allowMissingKeys = gradingMode === EXAM_GRADING_MODE.TEACHER_MANUAL_LATER;
  if (!draft.title || !String(draft.title).trim()) errors.push('Thiếu tiêu đề đề thi.');
  if (draft.needsOcr) errors.push(missingTextLayerPublishError(draft));
  if (!draft.teacherConfirmedReview && draft.needsReview) {
    errors.push('Cần xác nhận đã kiểm tra trước khi xuất bản.');
  }
  errors.push(...validateReadingGroupsAndQuestions(draft));
  const questions = draft.questions || [];
  if (!questions.length) errors.push('Chưa có câu hỏi.');
  const missingKeyCount = draftMissingAnswerKeyCount(draft);
  for (const q of questions) {
    const usesOpts = questionUsesOptionsForPublish(q);
    const opts = q.options || [];
    const uniq = new Set(opts.map((o) => o.id));
    const filled = opts.filter((o) => String(o.text || '').trim()).length;
    if (usesOpts) {
      if (filled < 2 || opts.length > 6) errors.push(`Câu ${q.displayNumber}: cần 2–6 lựa chọn.`);
      if (uniq.size !== opts.length) errors.push(`Câu ${q.displayNumber}: lựa chọn trùng mã.`);
    } else if (filled > 0) {
      errors.push(`Câu ${q.displayNumber}: không dùng lựa chọn giả cho dạng này.`);
    }
    if (!q.stemText || !String(q.stemText).trim()) errors.push(`Câu ${q.displayNumber}: thiếu nội dung.`);
    if (isAutoGradableQuestion(q)) {
      if (!allowMissingKeys) {
        if (isChoiceBasedQuestion(q)) {
          if (!q.correctOptionId) errors.push(`Câu ${q.displayNumber}: thiếu đáp án đúng.`);
          else if (!opts.some((o) => o.id === q.correctOptionId)) {
            errors.push(`Câu ${q.displayNumber}: đáp án không hợp lệ.`);
          }
        } else if (normalizeExamQuestionType(q) === EXAM_QUESTION_TYPE.SHORT_ANSWER) {
          const list = resolveTextAnswerKey(draft, q.id);
          if (!list?.length) errors.push(`Câu ${q.displayNumber}: thiếu đáp án chấp nhận.`);
        }
      } else if (isChoiceBasedQuestion(q) && q.correctOptionId && !opts.some((o) => o.id === q.correctOptionId)) {
        errors.push(`Câu ${q.displayNumber}: đáp án không hợp lệ.`);
      }
    }
    const pointsErr = questionPointsPublishError(q);
    if (pointsErr) errors.push(pointsErr);
  }
  if (missingKeyCount > 0 && allowMissingKeys) {
    warnings.push(
      `Còn ${missingKeyCount} câu chưa có đáp án trong nháp — chế độ giáo viên chấm sau vẫn xuất bản được; bạn sẽ chọn đáp án đúng khi chấm bài.`,
    );
  }
  if (missingKeyCount > 0 && !allowMissingKeys) {
    errors.push('Còn câu chưa có đáp án đúng — không thể xuất bản ở chế độ chấm tự động (chọn giáo viên chấm sau hoặc điền đáp án).');
  }
  return {
    ok: errors.length === 0,
    errors,
    warnings,
    gradingMode,
    missingKeyCount,
    allowMissingKeys,
  };
}

export function draftReviewMessage(item) {
  if (item == null) return '';
  if (typeof item === 'string') return item;
  if (typeof item === 'object' && item.message != null) return String(item.message);
  return String(item);
}

/** Display-only: map legacy import/publish system phrases to current terminology (stored data unchanged). */
export function formatImportWarningDisplay(message) {
  let s = String(message ?? '');
  s = s.replace(/ — cần rà soát\./g, ' — cần kiểm tra.');
  s = s.replace(
    /Chưa có trang khóa — cần nhập khóa thủ công trước khi xuất bản\./g,
    'Chưa có trang đáp án — bổ sung đáp án thủ công hoặc chọn giáo viên chấm sau.',
  );
  s = s.replace(/Cần xác nhận đã rà soát trước khi xuất bản\./g, 'Cần xác nhận đã kiểm tra trước khi xuất bản.');
  s = s.replace(
    /thiếu nội dung ngữ cảnh bắt buộc \(hình\/đoạn đọc\)/gi,
    'thiếu nội dung nhóm câu hỏi bắt buộc (hình hoặc đoạn đọc)',
  );
  s = s.replace(
    /cần xác nhận đã rà soát ngữ cảnh nhóm đọc/gi,
    'cần xác nhận đã kiểm tra nội dung nhóm câu hỏi',
  );
  s = s.replace(/Thiếu khóa đáp án/gi, 'Thiếu đáp án đúng');
  s = s.replace(/Khóa trùng số câu/g, 'Đáp án trùng số câu');
  s = s.replace(/Khóa mơ hồ\/trùng số câu/g, 'Đáp án mơ hồ/trùng số câu');
  s = s.replace(/Khóa câu (\d+): khóa /g, 'Đáp án câu $1: đáp án ');
  s = s.replace(/^Khóa câu /gm, 'Đáp án câu ');
  return s;
}

function sectionLabelForQuestion(draft, q) {
  const sec = (draft.sections || []).find((s) => s.id === q.sectionId);
  return (sec?.title && String(sec.title).trim()) || sec?.id || 'phần';
}

function questionTargetsByDisplayNumber(draft, displayNum, focusRole) {
  const num = String(displayNum);
  const matches = (draft.questions || []).filter((q) => String(q.displayNumber) === num);
  if (!matches.length) return [];
  if (matches.length === 1) {
    return [{
      kind: 'question',
      questionId: matches[0].id,
      focusRole: focusRole || 'stem',
      label: `Câu ${num}`,
    }];
  }
  return matches.map((q) => ({
    kind: 'question',
    questionId: q.id,
    focusRole: focusRole || 'stem',
    label: `Câu ${num} (${sectionLabelForQuestion(draft, q)})`,
  }));
}

function findPassageTargetForPage(draft, pageNum) {
  const page = Number(pageNum);
  if (!Number.isFinite(page)) return null;
  for (const raw of draft.passages || []) {
    const g = normalizeReadingGroup(raw);
    if (g.documents?.length) {
      const doc = g.documents.find((d) => (d.sourcePages || []).includes(page));
      if (doc) {
        return {
          kind: 'document',
          passageId: g.id,
          documentId: doc.id,
          focusRole: 'body',
          label: `Nhóm đọc · trang ${page}`,
        };
      }
    }
    const pages = g.sourcePages?.length ? g.sourcePages : (g.sourcePage ? [g.sourcePage] : []);
    if (pages.includes(page) || g.sourcePage === page) {
      return {
        kind: 'passage',
        passageId: g.id,
        focusRole: 'body',
        label: `Nhóm đọc · trang ${page}`,
      };
    }
  }
  return null;
}

function resolveStructuredReviewTarget(target, draft, message) {
  const t = target || {};
  const type = String(t.type || t.kind || '');
  if (type === 'question' && t.questionId) {
    return {
      message,
      actionable: true,
      targets: [{
        kind: 'question',
        questionId: t.questionId,
        focusRole: t.focusRole || 'stem',
        label: t.label || `Câu ${t.displayNumber || ''}`.trim(),
      }],
    };
  }
  if (type === 'passage' && t.passageId) {
    return {
      message,
      actionable: true,
      targets: [{
        kind: 'passage',
        passageId: t.passageId,
        focusRole: t.focusRole || 'body',
        label: t.label || 'Nhóm đọc',
      }],
    };
  }
  if (type === 'document' && t.passageId && t.documentId) {
    return {
      message,
      actionable: true,
      targets: [{
        kind: 'document',
        passageId: t.passageId,
        documentId: t.documentId,
        focusRole: t.focusRole || 'body',
        label: t.label || 'Tài liệu nhóm đọc',
      }],
    };
  }
  if (t.displayNumber != null) {
    const targets = questionTargetsByDisplayNumber(draft, t.displayNumber, t.focusRole);
    return { message, actionable: targets.length > 0, targets, guidance: '' };
  }
  return { message, actionable: false, targets: [], guidance: '' };
}

export function resolveDraftReviewNavigation(warning, draft) {
  const message = draftReviewMessage(warning);
  if (typeof warning === 'object' && warning && warning.target) {
    return resolveStructuredReviewTarget(warning.target, draft, message);
  }
  return resolveDraftReviewNavigationFromText(message, draft);
}

export function resolveDraftReviewNavigationFromText(message, draft) {
  const text = String(message || '');

  if (/trang trắng/i.test(text)) {
    return { message: text, informational: true, actionable: false, targets: [], guidance: '' };
  }

  if (/Chưa có trang (?:khóa|đáp án)/i.test(text)) {
    const missing = (draft.questions || []).filter((q) => !q.correctOptionId);
    const allowLater = allowsMissingAnswerKeysForPublish(draft);
    if (allowLater) {
      return {
        message: text,
        informational: true,
        actionable: true,
        targets: [{ kind: 'gradingMode', label: 'Giáo viên chấm sau (không bắt điền đáp án)' }],
        guidance: 'Bạn có thể xuất bản ở chế độ giáo viên chấm sau — chỉ cần đọc đề; chọn đáp án đúng khi chấm bài nộp.',
      };
    }
    if (missing.length) {
      const targets = missing.slice(0, 3).map((q) => ({
        kind: 'question',
        questionId: q.id,
        focusRole: 'key',
        label: `Câu ${q.displayNumber} — chọn đáp án`,
      }));
      targets.push({ kind: 'gradingMode', label: 'Hoặc: giáo viên chấm sau' });
      const guidance = missing.length > 3
        ? `Còn ${missing.length - 3} câu thiếu đáp án — hoặc chọn giáo viên chấm sau để không bắt điền đáp án.`
        : 'Hoặc chọn giáo viên chấm sau nếu chỉ cần đọc đề.';
      return { message: text, actionable: true, targets, guidance };
    }
    return {
      message: text,
      actionable: true,
      targets: [{ kind: 'gradingMode', label: 'Giáo viên chấm sau' }],
      guidance: 'Chọn đáp án đúng tại từng câu, nhập PDF kèm trang đáp án, hoặc chuyển sang giáo viên chấm sau.',
    };
  }

  if (/Không phát hiện câu hỏi/i.test(text)) {
    return {
      message: text,
      informational: true,
      actionable: false,
      targets: [],
      guidance: 'Thêm câu thủ công hoặc kiểm tra phạm vi trang câu hỏi khi nhập PDF.',
    };
  }

  if (/Phát hiện nội dung đuôi PDF/.test(text)) {
    return {
      message: text,
      informational: true,
      actionable: true,
      targets: [{ kind: 'title', label: 'Mở trang nhập PDF (#/exams/import)' }],
      guidance: 'Nhập lại PDF: chọn đúng trang Reading (ví dụ 12–21), tách trang đáp án; không tự sửa phiên bản đã giao.',
    };
  }

  const passageM = text.match(/Đoạn đọc \(trang (\d+)\)/);
  if (passageM) {
    const hit = findPassageTargetForPage(draft, passageM[1]);
    if (hit) return { message: text, actionable: true, targets: [hit], guidance: '' };
  }

  const keyM = text.match(/(?:Khóa|Đáp án) câu (\d+)/)
    || text.match(/(?:Khóa|Đáp án) trùng số câu (\d+)/)
    || text.match(/(?:Khóa|Đáp án) mơ hồ\/trùng số câu (\d+)/);
  if (keyM) {
    const targets = questionTargetsByDisplayNumber(draft, keyM[1], 'key');
    return { message: text, actionable: targets.length > 0, targets, guidance: '' };
  }

  const qM = text.match(/^Câu (\d+)/);
  if (qM) {
    let focusRole = 'stem';
    if (/lựa chọn/i.test(text)) focusRole = 'options';
    const targets = questionTargetsByDisplayNumber(draft, qM[1], focusRole);
    return { message: text, actionable: targets.length > 0, targets, guidance: '' };
  }

  return { message: text, actionable: false, targets: [], guidance: '' };
}

export function resolvePublishErrorNavigation(error, draft) {
  const text = String(error || '');

  if (text === 'Thiếu tiêu đề đề thi.' || text === 'Thiếu tiêu đề bài thi.') {
    return {
      message: text,
      actionable: true,
      targets: [{ kind: 'title', label: 'Tiêu đề đề thi' }],
      guidance: '',
    };
  }
  if (/lớp chữ/.test(text)) {
    return { message: text, informational: true, actionable: false, targets: [], guidance: '' };
  }
  if (/Cần xác nhận đã (?:rà soát|kiểm tra) trước khi xuất bản\./.test(text)) {
    return {
      message: text,
      actionable: true,
      targets: [{ kind: 'reviewConfirm', label: 'Xác nhận đã kiểm tra' }],
      guidance: '',
    };
  }
  if (text.startsWith('Câu ')) {
    const m = text.match(/^Câu (\d+)/);
    if (m) {
      let focusRole = 'stem';
      if (/đáp án/i.test(text)) focusRole = 'key';
      if (/lựa chọn/i.test(text)) focusRole = 'options';
      const targets = questionTargetsByDisplayNumber(draft, m[1], focusRole);
      return { message: text, actionable: targets.length > 0, targets, guidance: '' };
    }
  }
  if (/Thiếu khóa đáp án|chưa có đáp án đúng/i.test(text)) {
    const missing = (draft.questions || []).filter((q) => !q.correctOptionId);
    const targets = missing.slice(0, 1).map((q) => ({
      kind: 'question',
      questionId: q.id,
      focusRole: 'key',
      label: `Câu ${q.displayNumber} — chọn đáp án`,
    }));
    targets.push({ kind: 'gradingMode', label: 'Giáo viên chấm sau (không bắt điền đáp án)' });
    return {
      message: text,
      actionable: true,
      targets,
      guidance: 'Chọn giáo viên chấm sau nếu bạn chỉ cần đọc đề và sẽ chấm đáp án sau.',
    };
  }
  const labeledContextM = text.match(/^(.+?):\s*thiếu nội dung (?:ngữ cảnh bắt buộc|nhóm câu hỏi bắt buộc)/i);
  if (labeledContextM) {
    const g = findPassageByPublishLabel(draft, labeledContextM[1]);
    if (g) {
      const emptyDoc = (g.documents || []).find((d) => !String(d.bodyText || '').trim());
      if (emptyDoc) {
        return {
          message: text,
          actionable: true,
          targets: [{
            kind: 'document',
            passageId: g.id,
            documentId: emptyDoc.id,
            focusRole: 'body',
            label: 'Bổ sung nội dung nhóm câu hỏi',
          }],
          guidance: '',
        };
      }
      return {
        message: text,
        actionable: true,
        targets: [{ kind: 'passage', passageId: g.id, focusRole: 'body', label: 'Bổ sung nội dung nhóm câu hỏi' }],
        guidance: '',
      };
    }
  }
  if (/Thiếu nội dung (?:ngữ cảnh|nhóm câu hỏi)/.test(text)) {
    for (const raw of draft.passages || []) {
      const g = normalizeReadingGroup(raw);
      if (!readingGroupMissingRequiredContext(g)) continue;
      const emptyDoc = (g.documents || []).find((d) => !String(d.bodyText || '').trim());
      if (emptyDoc) {
        return {
          message: text,
          actionable: true,
          targets: [{
            kind: 'document',
            passageId: g.id,
            documentId: emptyDoc.id,
            focusRole: 'body',
            label: 'Bổ sung nội dung nhóm câu hỏi',
          }],
          guidance: '',
        };
      }
    }
  }
  const labeledConfirmM = text.match(/^(.+?):\s*cần xác nhận đã (?:rà soát ngữ cảnh nhóm đọc|kiểm tra nội dung nhóm câu hỏi)/i);
  if (labeledConfirmM) {
    const g = findPassageByPublishLabel(draft, labeledConfirmM[1]);
    if (g && readingGroupNeedsContextConfirmation(g)) {
      return {
        message: text,
        actionable: true,
        targets: [{
          kind: 'passage',
          passageId: g.id,
          focusRole: 'contextConfirm',
          label: 'Xác nhận nội dung nhóm câu hỏi',
        }],
        guidance: '',
      };
    }
  }
  if (/xác nhận đã (?:rà soát ngữ cảnh|kiểm tra nội dung nhóm)/.test(text)) {
    for (const raw of draft.passages || []) {
      const g = normalizeReadingGroup(raw);
      if (readingGroupNeedsContextConfirmation(g)) {
        return {
          message: text,
          actionable: true,
          targets: [{
            kind: 'passage',
            passageId: g.id,
            focusRole: 'contextConfirm',
            label: 'Xác nhận nội dung nhóm câu hỏi',
          }],
          guidance: '',
        };
      }
    }
  }
  if (/chưa được hỗ trợ|chưa hỗ trợ/i.test(text)) {
    const labeledUnsupported = text.match(/^(.+?):\s*(?:dạng bài|TFNG|chưa)/i);
    if (labeledUnsupported) {
      const g = findPassageByPublishLabel(draft, labeledUnsupported[1]);
      if (g?.unsupportedTaskType) {
        return {
          message: text,
          actionable: true,
          targets: [{ kind: 'passage', passageId: g.id, focusRole: 'body', label: 'Nhóm câu hỏi cần kiểm tra' }],
          guidance: '',
        };
      }
    }
    for (const raw of draft.passages || []) {
      const g = normalizeReadingGroup(raw);
      if (g.unsupportedTaskType) {
        return {
          message: text,
          actionable: true,
          targets: [{ kind: 'passage', passageId: g.id, focusRole: 'body', label: 'Nhóm câu hỏi cần kiểm tra' }],
          guidance: '',
        };
      }
    }
  }
  if (text === 'Chưa có câu hỏi.') {
    return { message: text, informational: true, actionable: false, targets: [], guidance: '' };
  }
  return { message: text, actionable: false, targets: [], guidance: '' };
}

export function resolvePublishValidationError(error, draft) {
  if (typeof error === 'object' && error?.target) {
    return resolveStructuredReviewTarget(error.target, draft, publishErrorMessage(error));
  }
  return resolvePublishErrorNavigation(publishErrorMessage(error), draft);
}

export function computeNormalizedScore10(correctPoints, totalPoints) {
  if (!totalPoints || totalPoints <= 0) return 0;
  const raw = (correctPoints / totalPoints) * 10;
  return Math.round(raw * 100) / 100;
}

/** @returns {string|null} publish error when points field is present but not a positive number */
export function questionPointsPublishError(question) {
  const raw = question?.points;
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    return `Câu ${question.displayNumber}: điểm phải là số dương.`;
  }
  return null;
}

export function gradeAttempt(version, answers, assignment = null, manualGrades = null) {
  const scoredVersion = assignment
    ? effectiveVersionForAssignment(version, assignment)
    : version;
  const manual = manualGrades || null;
  let correct = 0;
  let total = 0;
  let earned = 0;
  let pendingCount = 0;
  let gradedCount = 0;
  const perQuestion = [];
  for (const q of scoredVersion.questions || []) {
    const points = Number(q.points) > 0 ? Number(q.points) : 1;
    const t = normalizeExamQuestionType(q);
    total += points;
    const stored = answers?.[q.id] ?? null;
    const mg = manual?.[q.id] || null;

    const baseRow = {
      questionId: q.id,
      questionType: t,
      points,
      gradingState: 'pending',
      correct: null,
      earned: null,
    };

    if (mg && Number.isFinite(Number(mg.score))) {
      const score = Number(mg.score);
      gradedCount += 1;
      const clamped = Math.max(0, Math.min(points, score));
      earned += clamped;
      if (clamped >= points) correct += 1;
      perQuestion.push({
        ...baseRow,
        manualScore: clamped,
        manualFeedback: mg.feedback || null,
        correct: clamped >= points,
        earned: clamped,
        gradingState: 'graded',
        chosenOptionId: isChoiceBasedQuestion(q) && stored != null ? String(stored) : undefined,
        responseText: t === EXAM_QUESTION_TYPE.SHORT_ANSWER && stored != null ? String(stored) : undefined,
      });
      continue;
    }

    if (isManualOnlyQuestion(q)) {
      pendingCount += 1;
      perQuestion.push({
        ...baseRow,
        chosenOptionId: undefined,
        responseText: t === EXAM_QUESTION_TYPE.ESSAY && stored && typeof stored === 'object'
          ? String(stored.text || '')
          : undefined,
      });
      continue;
    }

    if (isChoiceBasedQuestion(q)) {
      const chosen = stored != null ? String(stored) : null;
      const key = resolveVersionAnswerKey(version, q.id);
      if (!key) {
        pendingCount += 1;
        perQuestion.push({ ...baseRow, chosenOptionId: chosen });
        continue;
      }
      gradedCount += 1;
      const isCorrect = !!(chosen && chosen === key);
      if (isCorrect) {
        correct += 1;
        earned += points;
      }
      perQuestion.push({
        ...baseRow,
        chosenOptionId: chosen,
        correct: isCorrect,
        earned: isCorrect ? points : 0,
        gradingState: 'graded',
      });
      continue;
    }

    if (t === EXAM_QUESTION_TYPE.SHORT_ANSWER) {
      const text = stored != null ? String(stored) : '';
      const accepted = resolveTextAnswerKey(version, q.id);
      if (!accepted?.length) {
        pendingCount += 1;
        perQuestion.push({ ...baseRow, responseText: text || null });
        continue;
      }
      gradedCount += 1;
      const isCorrect = !!text && accepted.some((a) => shortAnswerTextsMatch(text, a));
      if (isCorrect) {
        correct += 1;
        earned += points;
      }
      perQuestion.push({
        ...baseRow,
        responseText: text || null,
        correct: isCorrect,
        earned: isCorrect ? points : 0,
        gradingState: 'graded',
      });
      continue;
    }

    pendingCount += 1;
    perQuestion.push(baseRow);
  }
  const questionCount = (scoredVersion.questions || []).length;
  let gradingStatus = EXAM_ATTEMPT_GRADING_STATUS.COMPLETE;
  if (pendingCount > 0) {
    gradingStatus = gradedCount > 0
      ? EXAM_ATTEMPT_GRADING_STATUS.PARTIAL
      : EXAM_ATTEMPT_GRADING_STATUS.PENDING;
  }
  const allGraded = pendingCount === 0;
  return {
    gradingStatus,
    correctCount: allGraded ? correct : null,
    totalCount: questionCount,
    totalPoints: total,
    earnedPoints: allGraded ? earned : null,
    score10: allGraded ? computeNormalizedScore10(earned, total) : null,
    perQuestion,
  };
}

export function applyAttemptGrading(attempt, version, assignment = null) {
  if (!attempt) return null;
  if (attempt.status !== EXAM_ATTEMPT_STATUS.SUBMITTED
    && attempt.status !== EXAM_ATTEMPT_STATUS.EXPIRED) {
    return null;
  }
  const graded = gradeAttempt(version, attempt.answers, assignment, attempt.manualGrades);
  attempt.gradingStatus = graded.gradingStatus;
  attempt.score10 = graded.score10;
  attempt.correctCount = graded.correctCount;
  attempt.totalCount = graded.totalCount;
  attempt.totalPoints = graded.totalPoints;
  attempt.earnedPoints = graded.earnedPoints;
  attempt.gradingProjection = graded.perQuestion.map((row) => ({
    questionId: row.questionId,
    questionType: row.questionType,
    correct: row.correct,
    earned: row.earned,
    gradingState: row.gradingState,
    manualScore: row.manualScore ?? null,
    manualFeedback: row.manualFeedback ?? null,
  }));
  return graded;
}

export function regradeSubmittedAttemptsForVersion(state, versionId) {
  const version = (state.examVersions || []).find((v) => v.id === versionId);
  if (!version) return 0;
  let count = 0;
  for (const attempt of state.examAttempts || []) {
    if (attempt.versionId !== versionId) continue;
    if (attempt.status !== EXAM_ATTEMPT_STATUS.SUBMITTED
      && attempt.status !== EXAM_ATTEMPT_STATUS.EXPIRED) {
      continue;
    }
    const assignment = (state.examAssignments || []).find((a) => a.id === attempt.assignmentId) || null;
    applyAttemptGrading(attempt, version, assignment);
    count += 1;
  }
  return count;
}

function studentGradingProjectionRows(attempt, version, showAnswers) {
  if (!showAnswers || !attempt?.gradingProjection) return undefined;
  const questionById = new Map((version?.questions || []).map((q) => [q.id, q]));
  return attempt.gradingProjection.map((row) => {
    const q = questionById.get(row.questionId);
    const t = q ? normalizeExamQuestionType(q) : row.questionType;
    const out = {
      questionId: row.questionId,
      questionType: t || EXAM_QUESTION_TYPE.SINGLE_CHOICE,
      correct: row.gradingState === 'pending' ? null : row.correct,
      earned: row.gradingState === 'pending' ? null : row.earned,
      gradingState: row.gradingState,
    };
    if (isChoiceBasedQuestion(q || { questionType: t }) && row.gradingState !== 'pending') {
      const key = resolveVersionAnswerKey(version, row.questionId);
      if (key) out.correctOptionId = key;
    }
    return out;
  });
}

export function projectExamVersionForStudent(version, assignment, attempt, nowIso) {
  const effective = effectiveVersionForAssignment(version, assignment);
  const homework = isExamHomeworkAssignment(assignment);
  const due = assignment.dueAt;
  const showScore = assignment.showScore !== false;
  const showAnswersPolicy = assignment.showAnswersAfter || 'after-due';
  const pastDue = due && nowIso >= due;
  const showAnswers = showAnswersPolicy === 'immediate'
    || (showAnswersPolicy === 'after-due' && pastDue)
    || (showAnswersPolicy === 'after-submit' && attempt?.status === EXAM_ATTEMPT_STATUS.SUBMITTED);

  const passagesNorm = normalizeDraftPassages(effective.passages || []);
  const passagesById = new Map(passagesNorm.map((p) => [p.id, p]));
  const deliveryMode = normalizeExamDeliveryMode(assignment);
  const questions = deliveryMode === EXAM_DELIVERY_MODE.PDF
    ? []
    : sortExamQuestionsByOrder(effective.questions || []).map((q) => (
      pickPublicQuestionFields(q, passagesById)
    ));

  const passages = normalizeDraftPassages(effective.passages || []).map((p) => ({
    id: p.id,
    title: p.title,
    instructions: p.instructions || '',
    bodyText: p.bodyText,
    sectionId: p.sectionId,
    documents: (p.documents || []).map((d) => ({
      id: d.id,
      title: d.title || '',
      type: d.type || 'passage',
      bodyText: d.bodyText || '',
      order: d.order ?? 0,
    })),
  }));

  let result = null;
  if (attempt?.status === EXAM_ATTEMPT_STATUS.SUBMITTED || attempt?.status === EXAM_ATTEMPT_STATUS.EXPIRED) {
    const gradingStatus = attempt.gradingStatus
      || (attempt.score10 != null ? EXAM_ATTEMPT_GRADING_STATUS.COMPLETE : EXAM_ATTEMPT_GRADING_STATUS.PENDING);
    const scoreReady = gradingStatus === EXAM_ATTEMPT_GRADING_STATUS.COMPLETE;
    result = {
      gradingStatus,
      gradingLabel: attemptGradingLabel(gradingStatus),
      score10: showScore && scoreReady ? attempt.score10 : null,
      correctCount: showScore && scoreReady ? attempt.correctCount : null,
      totalCount: showScore ? attempt.totalCount : null,
      showAnswers,
      answersReleased: showAnswers,
    };
    const perQ = studentGradingProjectionRows(attempt, version, showAnswers);
    if (perQ) result.perQuestion = perQ;
    const pdfFb = getPublishedPdfManualGrade(attempt);
    if (pdfFb) result.pdfFeedback = pdfFb;
  }

  return {
    versionId: version.id,
    title: version.title,
    sections: effective.sections,
    passages,
    questions,
    assignment: {
      id: assignment.id,
      openAt: assignment.openAt,
      dueAt: assignment.dueAt,
      purpose: normalizeExamAssignmentPurpose(assignment.purpose),
      timeLimitMinutes: homework ? null : assignment.timeLimitMinutes,
      attemptLimit: assignment.attemptLimit,
      showScore,
      showAnswersAfter: showAnswersPolicy,
      selectedQuestionCount: questions.length,
      deliveryMode,
      selectedPdfPageIds: assignmentSelectedPdfPageIds(assignment, version),
      requiredParts: assignmentRequiredParts(assignment),
      scoring: assignmentScoringDenominator(version, assignment),
      media: attempt?.submissionMediaSnapshot
        || assignment.mediaSnapshot
        || buildAssignmentMediaSnapshot(version),
      classroomPlaybackAllowed: !!(
        assignment.classroomPlaybackAllowed
        || version?.classroomPlaybackAllowed
        || assignment.mediaSnapshot?.classroomPlaybackAllowed
      ),
      sourcePdfAuthorized: deliveryMode !== EXAM_DELIVERY_MODE.ONLINE,
    },
    attempt: attempt ? {
      id: attempt.id,
      status: attempt.status,
      gradingStatus: attempt.gradingStatus || null,
      startedAt: attempt.startedAt,
      deadlineAt: attempt.deadlineAt,
      submittedAt: attempt.submittedAt,
      answers: attempt.answers || {},
      revision: attempt.answerRevision || 0,
      gradingRevision: attempt.gradingRevision || 0,
      partStatus: attempt.partStatus || defaultAttemptPartStatus(assignment),
      pdfAnnotationRevision: attempt.pdfAnnotationRevision || 0,
      pdfSubmitted: attempt.partStatus?.pdf === EXAM_PART_STATUS.SUBMITTED
        || attempt.status === EXAM_ATTEMPT_STATUS.SUBMITTED,
      pdfLayers: projectStudentPdfLayers(attempt, assignment),
    } : null,
    serverNow: nowIso,
    result,
    disclaimer: 'Điểm tham khảo — không phải chứng chỉ IELTS/TOEIC chính thức.',
  };
}

export function stripExamSecretsFromTeacherJob(job) {
  if (!job) return null;
  const { extractedTextPreview, ...rest } = job;
  return rest;
}

export function validateExamAssignmentInput(body, getNow, version = null) {
  const now = getNow();
  const openAt = body?.openAt;
  const dueAt = body?.dueAt;
  if (!openAt || !dueAt) return { ok: false, error: 'Cần thời gian mở và hạn nộp.' };
  if (openAt >= dueAt) return { ok: false, error: 'Thời gian mở phải trước hạn nộp.' };
  let purpose;
  if (body && Object.prototype.hasOwnProperty.call(body, 'purpose')) {
    const rawPurpose = body.purpose;
    if (
      rawPurpose !== EXAM_ASSIGNMENT_PURPOSE.EXAM
      && rawPurpose !== EXAM_ASSIGNMENT_PURPOSE.HOMEWORK
    ) {
      return { ok: false, error: 'Loại bài giao không hợp lệ.' };
    }
    purpose = rawPurpose;
  } else {
    purpose = EXAM_ASSIGNMENT_PURPOSE.EXAM;
  }
  let timeLimitMinutes = null;
  if (purpose === EXAM_ASSIGNMENT_PURPOSE.HOMEWORK) {
    const raw = body?.timeLimitMinutes;
    if (raw != null && raw !== '' && Number(raw) > 0) {
      return { ok: false, error: 'Bài tập trực tuyến không dùng giới hạn thời gian làm bài.' };
    }
    timeLimitMinutes = null;
  } else {
    const timeLimit = Number(body?.timeLimitMinutes);
    if (!Number.isFinite(timeLimit) || timeLimit <= 0) {
      return { ok: false, error: 'Thời gian làm bài phải lớn hơn 0 phút.' };
    }
    timeLimitMinutes = timeLimit;
  }
  const attemptLimit = Number(body?.attemptLimit);
  if (!Number.isFinite(attemptLimit) || attemptLimit < 1) {
    return { ok: false, error: 'Số lần làm phải ít nhất 1.' };
  }
  let selectedQuestionIds = null;
  if (version && body && Object.prototype.hasOwnProperty.call(body, 'selectedQuestionIds')) {
    const sel = validateExamAssignmentQuestionSelection(version, body.selectedQuestionIds);
    if (!sel.ok) return sel;
    selectedQuestionIds = sel.ids;
  }
  if (openAt > now && body?.forceOpen) {
    /* allowed */
  }
  if (body && Object.prototype.hasOwnProperty.call(body, 'deliveryMode')) {
    if (typeof body.deliveryMode !== 'string') {
      return { ok: false, error: 'Chế độ giao bài không hợp lệ.' };
    }
  }
  let deliveryFields = null;
  if (version) {
    const dcheck = validateExamAssignmentDelivery(version, body || {});
    if (!dcheck.ok) return dcheck;
    deliveryFields = {
      deliveryMode: dcheck.deliveryMode,
      selectedPdfPageIds: dcheck.selectedPdfPageIds || null,
      requiredParts: dcheck.requiredParts || assignmentRequiredParts({ deliveryMode: dcheck.deliveryMode }),
    };
    if (deliveryFields.deliveryMode === EXAM_DELIVERY_MODE.PDF && selectedQuestionIds) {
      return { ok: false, error: 'Bài PDF-only không chọn câu hỏi trực tuyến.' };
    }
  }
  const pdfPartPointsRaw = body?.pdfPartPoints;
  let pdfPartPoints = null;
  if (pdfPartPointsRaw != null && pdfPartPointsRaw !== '') {
    const n = Number(pdfPartPointsRaw);
    if (!Number.isFinite(n) || n <= 0) {
      return { ok: false, error: 'Điểm phần PDF phải là số dương.' };
    }
    pdfPartPoints = n;
  }
  const onlinePartPointsRaw = body?.onlinePartPoints;
  let onlinePartPoints = null;
  if (onlinePartPointsRaw != null && onlinePartPointsRaw !== '') {
    const n = Number(onlinePartPointsRaw);
    if (!Number.isFinite(n) || n <= 0) {
      return { ok: false, error: 'Điểm phần trực tuyến phải là số dương.' };
    }
    onlinePartPoints = n;
  }
  return {
    ok: true,
    purpose,
    timeLimitMinutes,
    selectedQuestionIds,
    deliveryMode: deliveryFields?.deliveryMode || EXAM_DELIVERY_MODE.ONLINE,
    selectedPdfPageIds: deliveryFields?.selectedPdfPageIds || null,
    requiredParts: deliveryFields?.requiredParts || null,
    pdfPartPoints,
    onlinePartPoints,
    classroomPlaybackAllowed: body?.classroomPlaybackAllowed === true,
  };
}

export function computeAttemptDeadline(assignment, startedAtIso) {
  const due = assignment.dueAt;
  if (isExamHomeworkAssignment(assignment)) {
    return due || startedAtIso;
  }
  const startMs = new Date(startedAtIso).getTime();
  const limitMs = (assignment.timeLimitMinutes || 60) * 60 * 1000;
  const byDuration = new Date(startMs + limitMs).toISOString();
  if (!due) return byDuration;
  return due < byDuration ? due : byDuration;
}

/**
 * Student-safe exam projection for teacher «Xem trước như học sinh» (local only; no attempt APIs).
 * @param {object} content draft or published version shape (questions may include teacher keys)
 * @param {object|null} assignmentOverrides optional assignment policy fields for preview summary
 */
export function buildTeacherPreviewExamProjection(content, assignmentOverrides = null) {
  const version = {
    id: content?.id || 'preview',
    title: content?.title || '',
    sections: content?.sections || [],
    passages: content?.passages || [],
    questions: content?.questions || [],
    audioAttachmentId: content?.audioAttachmentId || null,
    audioState: content?.audioState || null,
    mediaBindings: content?.mediaBindings || null,
    mediaRevision: content?.mediaRevision || 0,
    classroomPlaybackAllowed: !!content?.classroomPlaybackAllowed,
    sourceAttachmentId: content?.sourceAttachmentId || null,
    sourcePdfPageCount: content?.sourcePdfPageCount || null,
  };
  const nowIso = typeof assignmentOverrides?.nowIso === 'string'
    ? assignmentOverrides.nowIso
    : new Date().toISOString();
  const farDue = new Date(new Date(nowIso).getTime() + 365 * 24 * 60 * 60 * 1000).toISOString();
  const assignment = {
    id: '__preview__',
    openAt: nowIso,
    dueAt: farDue,
    purpose: EXAM_ASSIGNMENT_PURPOSE.EXAM,
    timeLimitMinutes: 60,
    attemptLimit: 1,
    showScore: false,
    showAnswersAfter: 'never',
  };
  if (assignmentOverrides && typeof assignmentOverrides === 'object') {
    if (assignmentOverrides.purpose) {
      assignment.purpose = normalizeExamAssignmentPurpose(assignmentOverrides.purpose);
    }
    if (assignmentOverrides.selectedQuestionIds) {
      assignment.selectedQuestionIds = assignmentOverrides.selectedQuestionIds;
    }
    if (Object.prototype.hasOwnProperty.call(assignmentOverrides, 'timeLimitMinutes')) {
      assignment.timeLimitMinutes = assignmentOverrides.timeLimitMinutes;
    }
    if (assignmentOverrides.showScore != null) {
      assignment.showScore = assignmentOverrides.showScore !== false;
    }
    if (assignmentOverrides.showAnswersAfter) {
      assignment.showAnswersAfter = assignmentOverrides.showAnswersAfter;
    }
    if (assignmentOverrides.dueAt) assignment.dueAt = assignmentOverrides.dueAt;
  }
  if (isExamHomeworkAssignment(assignment)) {
    assignment.timeLimitMinutes = null;
  }
  const attempt = {
    id: '__preview__',
    status: EXAM_ATTEMPT_STATUS.IN_PROGRESS,
    answers: {},
    answerRevision: 0,
  };
  return projectExamVersionForStudent(version, assignment, attempt, nowIso);
}

function remapComposeEntityId(prefix) {
  return `${prefix}_${crypto.randomUUID().slice(0, 8)}`;
}

export function nextUniqueExamDisplayNumber(questions) {
  const used = new Set((questions || []).map((q) => String(q.displayNumber)));
  let n = 1;
  while (used.has(String(n))) n += 1;
  return String(n);
}

export function sortExamQuestionsByOrder(questions) {
  const list = questions || [];
  return list
    .map((q, index) => ({ q, index }))
    .sort((a, b) => {
      const ao = a.q.order;
      const bo = b.q.order;
      const aHas = ao != null && Number.isFinite(Number(ao));
      const bHas = bo != null && Number.isFinite(Number(bo));
      if (aHas && bHas && ao !== bo) return ao - bo;
      if (!aHas && !bHas) return a.index - b.index;
      const av = aHas ? Number(ao) : Number.POSITIVE_INFINITY;
      const bv = bHas ? Number(bo) : Number.POSITIVE_INFINITY;
      if (av !== bv) return av - bv;
      return a.index - b.index;
    })
    .map(({ q }) => q);
}

export function pruneUnusedExamPassages(content) {
  if (!content) return;
  const used = new Set();
  for (const q of content.questions || []) {
    if (q.passageId) used.add(q.passageId);
    if (q.groupId) used.add(q.groupId);
  }
  content.passages = (content.passages || []).filter((raw) => {
    const g = normalizeReadingGroup(raw);
    return used.has(g.id) || (raw.groupId && used.has(raw.groupId));
  });
}

export function examDraftCreateReplayFingerprint(inputCheck, body) {
  const trimTitle = (t) => (t != null ? String(t).trim() : '');
  if (inputCheck.mode === 'blank') {
    return { mode: 'blank', title: trimTitle(body?.title) };
  }
  if (inputCheck.mode === 'multi-source') {
    return {
      mode: 'multi-source',
      sources: inputCheck.sources.map((s) => ({
        sourceVersionId: s.sourceVersionId,
        questionIds: [...s.questionIds],
      })),
      title: trimTitle(body?.title),
    };
  }
  return {
    mode: 'from-source',
    sourceVersionId: inputCheck.sourceVersionId,
    questionIds: [...inputCheck.questionIds],
    title: trimTitle(body?.title),
  };
}

/**
 * Validate POST /drafts body for composing from one published exam (legacy single source).
 */
export function validateCreateComposedDraftInput(body) {
  const blank = body?.blank === true || body?.mode === 'blank';
  if (blank) return { ok: true, mode: 'blank' };
  const sourcesRaw = body?.sources;
  if (Array.isArray(sourcesRaw) && sourcesRaw.length) {
    return validateCreateMultiSourceComposedDraftInput(body);
  }
  const sourceVersionId = body?.sourceVersionId ? String(body.sourceVersionId) : '';
  if (!sourceVersionId) return { ok: false, error: 'Thiếu nguồn đề hoặc chọn bắt đầu trống.' };
  const questionIds = body?.questionIds;
  if (!Array.isArray(questionIds) || !questionIds.length) {
    return { ok: false, error: 'Chọn ít nhất một câu từ nguồn hoặc bắt đầu trống.' };
  }
  const seen = new Set();
  for (const id of questionIds) {
    const s = String(id);
    if (!s) return { ok: false, error: 'Câu hỏi không hợp lệ.' };
    if (seen.has(s)) return { ok: false, error: 'Trùng câu hỏi trong lựa chọn.' };
    seen.add(s);
  }
  return { ok: true, mode: 'from-source', sourceVersionId, questionIds: questionIds.map(String) };
}

/**
 * Validate POST /drafts body with body.sources: [{ sourceVersionId, questionIds }].
 * At least two distinct sources required (use single-source fields for one exam).
 */
export function validateCreateMultiSourceComposedDraftInput(body) {
  const sourcesRaw = body?.sources;
  if (!Array.isArray(sourcesRaw) || sourcesRaw.length < 2) {
    return { ok: false, error: 'Chọn ít nhất hai đề nguồn hoặc dùng một nguồn / bắt đầu trống.' };
  }
  const versionSeen = new Set();
  const sources = [];
  for (const row of sourcesRaw) {
    const sourceVersionId = row?.sourceVersionId ? String(row.sourceVersionId) : '';
    const questionIds = row?.questionIds;
    if (!sourceVersionId) return { ok: false, error: 'Thiếu mã đề nguồn.' };
    if (!Array.isArray(questionIds) || !questionIds.length) {
      return { ok: false, error: 'Mỗi đề nguồn cần ít nhất một câu được chọn.' };
    }
    if (versionSeen.has(sourceVersionId)) {
      return { ok: false, error: 'Trùng đề nguồn trong danh sách — gom câu vào một mục.' };
    }
    versionSeen.add(sourceVersionId);
    const seenQ = new Set();
    const ids = [];
    for (const id of questionIds) {
      const s = String(id);
      if (!s) return { ok: false, error: 'Câu hỏi không hợp lệ.' };
      if (seenQ.has(s)) return { ok: false, error: 'Trùng câu hỏi trong cùng một đề nguồn.' };
      seenQ.add(s);
      ids.push(s);
    }
    sources.push({ sourceVersionId, questionIds: ids });
  }
  return { ok: true, mode: 'multi-source', sources };
}

export function validateAppendComposedQuestionsInput(body) {
  const sourceVersionId = body?.sourceVersionId ? String(body.sourceVersionId) : '';
  if (!sourceVersionId) return { ok: false, error: 'Thiếu đề nguồn.' };
  const questionIds = body?.questionIds;
  if (!Array.isArray(questionIds) || !questionIds.length) {
    return { ok: false, error: 'Chọn ít nhất một câu để thêm.' };
  }
  const seen = new Set();
  for (const id of questionIds) {
    const s = String(id);
    if (!s) return { ok: false, error: 'Câu hỏi không hợp lệ.' };
    if (seen.has(s)) return { ok: false, error: 'Trùng câu hỏi trong lựa chọn.' };
    seen.add(s);
  }
  return { ok: true, sourceVersionId, questionIds: questionIds.map(String) };
}

export function validateComposeQuestionIdsForVersion(version, questionIds) {
  const known = new Set((version?.questions || []).map((q) => q.id));
  for (const id of questionIds) {
    if (!known.has(id)) return { ok: false, error: 'Câu hỏi không thuộc nguồn đề.' };
  }
  return { ok: true };
}

/**
 * Remap one published version’s selected questions into an isolated draft slice (sections, passages, questions).
 * Caller merges slices; does not mutate `version`.
 */
export function composePublishedVersionQuestionSlice(version, selectedQuestionIds) {
  if (!version) throw new Error('missing-version');
  const ids = selectedQuestionIds || [];
  const idCheck = validateComposeQuestionIdsForVersion(version, ids);
  if (!idCheck.ok) throw new Error('invalid-question-ids');

  const byId = new Map((version.questions || []).map((q) => [q.id, q]));
  const orderedSource = ids.map((id) => byId.get(id));

  const sectionIdMap = new Map();
  for (const q of orderedSource) {
    if (q.sectionId && !sectionIdMap.has(q.sectionId)) {
      sectionIdMap.set(q.sectionId, newExamSectionId());
    }
  }
  if (!sectionIdMap.size) {
    const fallback = newExamSectionId();
    sectionIdMap.set(fallback, fallback);
  }

  const sections = (version.sections || [])
    .filter((s) => sectionIdMap.has(s.id))
    .map((s) => ({ ...JSON.parse(JSON.stringify(s)), id: sectionIdMap.get(s.id) }));
  if (!sections.length) {
    const only = [...sectionIdMap.values()][0];
    sections.push({ id: only, title: 'Phần 1', order: 1 });
  }

  const passageIdMap = new Map();
  for (const q of orderedSource) {
    const gid = q.passageId || q.groupId;
    if (gid && !passageIdMap.has(gid)) passageIdMap.set(gid, remapComposeEntityId('grp'));
  }

  const defaultSectionId = [...sectionIdMap.values()][0];
  const sourceGroupSectionMap = new Map();
  for (const q of orderedSource) {
    const srcG = q.passageId || q.groupId;
    if (!srcG) continue;
    const remappedSec = (q.sectionId && sectionIdMap.get(q.sectionId)) || defaultSectionId;
    if (!sourceGroupSectionMap.has(srcG)) sourceGroupSectionMap.set(srcG, remappedSec);
  }

  const passages = [];
  for (const raw of version.passages || []) {
    const g = normalizeReadingGroup(raw);
    if (!passageIdMap.has(g.id)) continue;
    const newGid = passageIdMap.get(g.id);
    const copy = JSON.parse(JSON.stringify(raw));
    copy.id = newGid;
    if (copy.groupId != null) copy.groupId = newGid;
    copy.sourceVersionId = version.id;
    copy.sourceGroupId = g.id;
    const legacySec = copy.sectionId && sectionIdMap.has(copy.sectionId)
      ? sectionIdMap.get(copy.sectionId)
      : null;
    copy.sectionId = sourceGroupSectionMap.get(g.id) || legacySec || defaultSectionId;
    if (Array.isArray(copy.documents)) {
      copy.documents = copy.documents.map((d) => ({
        ...d,
        id: remapComposeEntityId('doc'),
      }));
    }
    passages.push(copy);
  }

  const questions = orderedSource.map((q, idx) => {
    const secId = sectionIdMap.get(q.sectionId) || [...sectionIdMap.values()][0];
    const nq = JSON.parse(JSON.stringify(q));
    nq.id = newExamQuestionId(secId, idx + 1);
    nq.sectionId = secId;
    nq.order = idx + 1;
    nq.originalDisplayNumber = q.displayNumber;
    nq.sourceVersionId = version.id;
    nq.sourceQuestionId = q.id;
    const srcG = q.passageId || q.groupId;
    if (srcG && passageIdMap.has(srcG)) {
      const newG = passageIdMap.get(srcG);
      nq.passageId = newG;
      nq.groupId = newG;
      nq.sourceGroupId = srcG;
    }
    const key = resolveVersionAnswerKey(version, q.id);
    if (key) nq.correctOptionId = key;
    return nq;
  });

  return {
    sourceVersionId: version.id,
    sourceVersionTitle: version.title || 'Đề nguồn',
    sourceAttachmentId: version.sourceAttachmentId || null,
    sections,
    passages,
    questions,
    gradingMode: normalizeExamGradingMode(version),
  };
}

export function composeExamDraftSourceBindingsFromSlices(slices) {
  const map = {};
  for (const sl of slices || []) {
    const vid = sl.sourceVersionId;
    if (!vid || map[vid]) continue;
    map[vid] = {
      sourceVersionId: vid,
      sourceTitle: String(sl.sourceVersionTitle || 'Đề nguồn').slice(0, 200),
      sourceAttachmentId: sl.sourceAttachmentId || null,
    };
  }
  return map;
}

/**
 * Count selected composer rows per published exam (by sourceVersionId on questions).
 */
export function countComposerSelectionsBySource(questions) {
  const map = new Map();
  for (const q of questions || []) {
    const vid = q.sourceVersionId;
    if (!vid) continue;
    map.set(vid, (map.get(vid) || 0) + 1);
  }
  return map;
}

export function formatComposerSelectionSummaryVi(selectionBySource, bindings) {
  const parts = [];
  for (const [vid, n] of selectionBySource) {
    const title = bindings?.[vid]?.sourceTitle || vid.slice(0, 8);
    parts.push(`${title}: ${n} câu`);
  }
  const total = [...selectionBySource.values()].reduce((a, b) => a + b, 0);
  if (!parts.length) return 'Chưa chọn câu.';
  return `${parts.join(' · ')} — tổng ${total} câu`;
}

/**
 * Merge multiple isolated slices in order into one draft content payload (sections/passages concatenated;
 * questions renumbered with stable relative order).
 */
export function mergeComposedDraftSlices(slices, { title, renumberGlobally = true } = {}) {
  if (!Array.isArray(slices) || !slices.length) throw new Error('missing-slices');
  const allSections = [];
  const allPassages = [];
  const allQuestions = [];
  for (const sl of slices) {
    for (const s of sl.sections || []) allSections.push(JSON.parse(JSON.stringify(s)));
    for (const p of sl.passages || []) allPassages.push(JSON.parse(JSON.stringify(p)));
    for (const q of sl.questions || []) {
      const cq = JSON.parse(JSON.stringify(q));
      allQuestions.push(cq);
    }
  }
  const first = slices[0];
  const gm = slices.every((s) => s.gradingMode === first.gradingMode) ? first.gradingMode : EXAM_GRADING_MODE.AUTOMATIC;

  // Global sequence before sort/renumber: each source slice uses local orders (1..n) that would
  // interleave when sorting by order alone (A1,B1,A2,B2). Assign monotonic order in slice order.
  let seq = 0;
  for (const q of allQuestions) {
    seq += 1;
    q.order = seq;
  }

  const out = {
    title: (title && String(title).trim()) || `${slices.length} đề nguồn (bản soạn)`,
    sections: allSections,
    passages: allPassages,
    questions: allQuestions,
    warnings: [],
    needsOcr: false,
    needsOcrPageNumbers: [],
    needsReview: false,
    teacherConfirmedReview: false,
    manuallyEdited: false,
    gradingMode: gm,
    sourceAttachmentId: first.sourceAttachmentId || null,
    composedFromVersionId: slices.length === 1 ? first.sourceVersionId : null,
    composedSourceExamBindings: composeExamDraftSourceBindingsFromSlices(slices),
  };
  if (renumberGlobally) renumberComposedDraftQuestionsInPlace(out);
  return out;
}

function renumberComposedDraftQuestionsInPlace(content) {
  const secs = content.sections || [];
  const secById = new Map(secs.map((s) => [s.id, s]));
  const qs = content.questions || [];
  const sorted = sortExamQuestionsByOrder(qs);

  for (let i = 0; i < sorted.length; i++) {
    const q = sorted[i];
    const secId = q.sectionId && secById.has(q.sectionId) ? q.sectionId : secs[0]?.id;
    if (!secId) continue;
    const nextId = newExamQuestionId(secId, i + 1);
    q.id = nextId;
    q.sectionId = secId;
    q.displayNumber = String(i + 1);
    q.order = i + 1;
  }

  for (const raw of content.passages || []) {
    const g = normalizeReadingGroup(raw);
    const memberNums = readingGroupQuestionNumbers(g, qs).map((n) => parseInt(String(n).replace(/\D/g, ''), 10))
      .filter((n) => Number.isFinite(n));
    if (!memberNums.length) continue;
    const newRange = { min: Math.min(...memberNums), max: Math.max(...memberNums) };
    raw.expectedQuestionRange = newRange;
    if (raw.title && QUESTIONS_RANGE_RE.test(String(raw.title))) {
      raw.title = String(raw.title).replace(QUESTIONS_RANGE_RE, `Questions ${newRange.min}–${newRange.max}`);
    }
  }
}

/**
 * Append questions from a published `version` to existing `draft` content (server-side).
 * Passages for the same source group are reused once; duplicate source questions are skipped.
 */
export function appendComposedSliceToDraftContent(draft, version, selectedQuestionIds) {
  if (!draft || !version) throw new Error('missing-draft-or-version');
  const slice = composePublishedVersionQuestionSlice(version, selectedQuestionIds);

  const existingKeys = new Set();
  for (const q of draft.questions || []) {
    if (q.sourceVersionId && q.sourceQuestionId) {
      existingKeys.add(`${q.sourceVersionId}|${q.sourceQuestionId}`);
    }
  }

  const bindings = draft.composedSourceExamBindings && typeof draft.composedSourceExamBindings === 'object'
    ? { ...draft.composedSourceExamBindings }
    : {};
  if (!bindings[version.id]) {
    bindings[version.id] = {
      sourceVersionId: version.id,
      sourceTitle: String(version.title || 'Đề nguồn').slice(0, 200),
      sourceAttachmentId: version.sourceAttachmentId || null,
    };
  }

  const appendQuestionsFiltered = slice.questions.filter((q) => {
    const k = `${version.id}|${q.sourceQuestionId}`;
    if (existingKeys.has(k)) return false;
    existingKeys.add(k);
    return true;
  });
  if (!appendQuestionsFiltered.length) {
    return { addedCount: 0, skippedDuplicateSourceQuestions: slice.questions.length };
  }

  const secIdMap = new Map();
  for (const s of draft.sections || []) secIdMap.set(s.id, s.id);
  for (const s of slice.sections) {
    if (!secIdMap.has(s.id)) secIdMap.set(s.id, newExamSectionId());
  }
  for (const s of slice.sections) {
    const mapped = secIdMap.get(s.id);
    if (mapped === s.id && (draft.sections || []).some((x) => x.id === s.id)) continue;
    draft.sections = draft.sections || [];
    draft.sections.push({
      ...JSON.parse(JSON.stringify(s)),
      id: mapped,
    });
  }

  const mergedBindingIds = new Map();
  for (const vid of Object.keys(bindings)) {
    const row = bindings[vid];
    const aid = row.sourceAttachmentId;
    if (aid) mergedBindingIds.set(aid, vid);
  }

  const passageMergeMap = new Map();
  const grpMergeMap = new Map();

  for (const raw of slice.passages) {
    const g = normalizeReadingGroup(raw);
    const srcG = g.sourceGroupId != null ? g.sourceGroupId : g.id;
    const candAid = version.sourceAttachmentId || null;
    let useExisting = null;
    if (candAid && mergedBindingIds.has(candAid)) {
      const boundVid = mergedBindingIds.get(candAid);
      useExisting = (draft.passages || []).find((p) => {
        const pg = normalizeReadingGroup(p);
        const pSrc = pg.sourceGroupId != null ? pg.sourceGroupId : pg.id;
        return p.sourceVersionId === boundVid && pSrc === srcG;
      });
    }
    if (!useExisting) {
      useExisting = (draft.passages || []).find((p) => {
        const pg = normalizeReadingGroup(p);
        const pSrc = pg.sourceGroupId != null ? pg.sourceGroupId : pg.id;
        return p.sourceVersionId === version.id && pSrc === srcG;
      });
    }
    if (useExisting) {
      passageMergeMap.set(g.id, normalizeReadingGroup(useExisting).id);
      grpMergeMap.set(g.id, normalizeReadingGroup(useExisting).id);
      continue;
    }
    const newGid = remapComposeEntityId('grp');
    grpMergeMap.set(g.id, newGid);
    passageMergeMap.set(g.id, newGid);
    const copy = JSON.parse(JSON.stringify(raw));
    copy.id = newGid;
    if (copy.groupId != null) copy.groupId = newGid;
    copy.sourceVersionId = version.id;
    const pgNorm = normalizeReadingGroup(g);
    copy.sourceGroupId = pgNorm.sourceGroupId != null ? pgNorm.sourceGroupId : srcG;
    const targetSec = slice.questions.find(
      (q) => (q.passageId === srcG || q.groupId === srcG) && q.sectionId,
    )?.sectionId;
    const mappedSec = targetSec ? secIdMap.get(targetSec) : null;
    copy.sectionId = mappedSec || (draft.sections || [])[0]?.id;
    if (Array.isArray(copy.documents)) {
      copy.documents = copy.documents.map((d) => ({
        ...d,
        id: remapComposeEntityId('doc'),
      }));
    }
    draft.passages = draft.passages || [];
    draft.passages.push(copy);
  }

  const maxOrder = Math.max(0, ...(draft.questions || []).map((q) => Number(q.order) || 0));
  let ord = maxOrder;
  const addedForMedia = [];

  for (const q of appendQuestionsFiltered) {
    ord += 1;
    const nq = JSON.parse(JSON.stringify(q));
    const fromSec = nq.sectionId;
    nq.sectionId = secIdMap.get(fromSec) || (draft.sections || [])[0]?.id;
    nq.order = ord;
    const srcPass = nq.passageId || nq.groupId;
    if (srcPass && grpMergeMap.has(srcPass)) {
      const newG = grpMergeMap.get(srcPass);
      nq.passageId = newG;
      nq.groupId = newG;
    }
    nq.sourceVersionId = version.id;
    nq.sourceQuestionId = nq.sourceQuestionId || q.sourceQuestionId || q.id;
    const srcGForMedia = q.passageId || q.groupId;
    if (srcGForMedia) nq.sourceGroupId = srcGForMedia;
    draft.questions = draft.questions || [];
    draft.questions.push(nq);
    addedForMedia.push(nq);
  }

  draft.composedSourceExamBindings = bindings;
  if (draft.composedFromVersionId && draft.composedFromVersionId !== version.id) {
    draft.composedFromVersionId = null;
  } else if (!draft.composedFromVersionId) {
    draft.composedFromVersionId = version.id;
  }

  if (!draft.sourceAttachmentId && version.sourceAttachmentId) {
    draft.sourceAttachmentId = version.sourceAttachmentId;
  }

  renumberComposedDraftQuestionsInPlace(draft);
  inheritComposeMediaFromSource(draft, version, addedForMedia);

  return {
    addedCount: appendQuestionsFiltered.length,
    skippedDuplicateSourceQuestions: slice.questions.length - appendQuestionsFiltered.length,
  };
}

export function composeBlankExamDraftContent(title) {
  const secId = newExamSectionId();
  return {
    title: (title && String(title).trim()) || 'Đề mới',
    sections: [{ id: secId, title: 'Phần 1', order: 1 }],
    passages: [],
    questions: [],
    warnings: [],
    needsOcr: false,
    needsOcrPageNumbers: [],
    needsReview: false,
    teacherConfirmedReview: false,
    manuallyEdited: false,
    gradingMode: EXAM_GRADING_MODE.AUTOMATIC,
    sourceAttachmentId: null,
    composedFromVersionId: null,
    mediaRevision: 0,
    audioState: EXAM_AUDIO_STATE.PENDING,
    mediaBindings: { paper: null, groups: {}, questions: {} },
  };
}

/** Deep-copy subset from a published version into new draft content (does not mutate source). */
export function composeExamDraftFromPublishedVersion(version, { selectedQuestionIds, title } = {}) {
  const slice = composePublishedVersionQuestionSlice(version, selectedQuestionIds);
  return {
    title: (title && String(title).trim())
      || `${version.title || 'Đề'} (bản soạn)`,
    sections: slice.sections,
    passages: slice.passages,
    questions: slice.questions,
    warnings: [],
    needsOcr: false,
    needsOcrPageNumbers: [],
    needsReview: false,
    teacherConfirmedReview: false,
    manuallyEdited: false,
    gradingMode: slice.gradingMode,
    sourceAttachmentId: slice.sourceAttachmentId || null,
    composedFromVersionId: version.id,
    composedSourceExamBindings: composeExamDraftSourceBindingsFromSlices([slice]),
  };
}

export function isExamComposeSupportedQuestion(question) {
  return normalizeExamQuestionType(question) !== EXAM_QUESTION_TYPE.ORAL_ASSESSMENT;
}

function tokenizeExamMetadataFilterList(raw) {
  const parts = Array.isArray(raw)
    ? raw.map((s) => String(s).trim())
    : String(raw ?? '').split(/[,;]+/).map((s) => String(s).trim());
  return parts.filter((s) => s.length > 0);
}

export function parseExamMetadataFilters(input) {
  const skillsRaw = input?.skills ?? input?.get?.('skills');
  const typesRaw = input?.types ?? input?.get?.('types');
  const skillTokens = tokenizeExamMetadataFilterList(skillsRaw);
  const skills = skillTokens
    .map((s) => (EXAM_SKILL_SET.has(s) ? s : normalizeExamSkill(s)))
    .filter((s) => EXAM_SKILL_SET.has(s));
  const types = tokenizeExamMetadataFilterList(typesRaw);
  return { skills, types };
}

export function computeExamMetadataFilterCounts(questions) {
  const list = questions || [];
  const skillCounts = {};
  const typeCounts = {};
  let unclassified = 0;
  for (const q of list) {
    const skill = normalizeExamSkill(q.skill) || inferExamSkillFromQuestion(q);
    if (!q.skill && skill === EXAM_SKILL.UNCLASSIFIED) unclassified += 1;
    skillCounts[skill] = (skillCounts[skill] || 0) + 1;
    const t = normalizeExamQuestionType(q);
    typeCounts[t] = (typeCounts[t] || 0) + 1;
  }
  return { skillCounts, typeCounts, unclassified, total: list.length };
}

export function versionQualifiesMetadataFilter(version, filters = {}) {
  const matching = filterExamQuestionsByMetadata(version?.questions || [], filters);
  return matching.length > 0;
}

export function captureComposeUndoSnapshot(draft) {
  return {
    questions: JSON.parse(JSON.stringify(draft.questions || [])),
    passages: JSON.parse(JSON.stringify(draft.passages || [])),
    sections: JSON.parse(JSON.stringify(draft.sections || [])),
    composedSourceExamBindings: draft.composedSourceExamBindings
      ? JSON.parse(JSON.stringify(draft.composedSourceExamBindings))
      : null,
    composedFromVersionId: draft.composedFromVersionId || null,
    sourceAttachmentId: draft.sourceAttachmentId || null,
    mediaBindings: draft.mediaBindings ? JSON.parse(JSON.stringify(draft.mediaBindings)) : null,
  };
}

export function restoreComposeUndoSnapshot(draft, snapshot) {
  if (!snapshot) return;
  draft.questions = JSON.parse(JSON.stringify(snapshot.questions || []));
  draft.passages = JSON.parse(JSON.stringify(snapshot.passages || []));
  draft.sections = JSON.parse(JSON.stringify(snapshot.sections || []));
  draft.composedSourceExamBindings = snapshot.composedSourceExamBindings
    ? JSON.parse(JSON.stringify(snapshot.composedSourceExamBindings))
    : null;
  draft.composedFromVersionId = snapshot.composedFromVersionId || null;
  draft.sourceAttachmentId = snapshot.sourceAttachmentId || null;
  draft.mediaBindings = snapshot.mediaBindings ? JSON.parse(JSON.stringify(snapshot.mediaBindings)) : null;
}

function resolveComposeSourceMediaBindings(version) {
  const raw = version?.mediaBindings && typeof version.mediaBindings === 'object'
    ? JSON.parse(JSON.stringify(version.mediaBindings))
    : { paper: null, groups: {}, questions: {} };
  if (!raw.groups) raw.groups = {};
  if (!raw.questions) raw.questions = {};
  const paperAtt = pickExamMediaBindingAttachmentId(raw.paper) || version?.audioAttachmentId || null;
  if (paperAtt) {
    raw.paper = {
      ...(raw.paper && typeof raw.paper === 'object' ? raw.paper : {}),
      audioAttachmentId: raw.paper?.audioAttachmentId || paperAtt,
      frozenAudioAttachmentId: raw.paper?.frozenAudioAttachmentId || paperAtt,
      sourceVersionId: version.id,
    };
  }
  const hasAny = paperAtt
    || Object.keys(raw.groups).length
    || Object.keys(raw.questions).length;
  return hasAny ? raw : null;
}

export function inheritComposeMediaFromSource(draft, version, addedQuestions) {
  if (!version || !addedQuestions?.length) return;
  const src = resolveComposeSourceMediaBindings(version);
  if (!src) return;
  const bindings = draft.mediaBindings && typeof draft.mediaBindings === 'object'
    ? JSON.parse(JSON.stringify(draft.mediaBindings))
    : { paper: null, groups: {}, questions: {} };
  if (!bindings.groups) bindings.groups = {};
  if (!bindings.questions) bindings.questions = {};
  if (src.paper?.audioAttachmentId && !bindings.paper?.audioAttachmentId) {
    bindings.paper = {
      audioAttachmentId: src.paper.audioAttachmentId,
      frozenAudioAttachmentId: src.paper.frozenAudioAttachmentId || src.paper.audioAttachmentId,
      sourceVersionId: version.id,
    };
    if (!draft.audioAttachmentId) draft.audioAttachmentId = src.paper.audioAttachmentId;
    if (!draft.audioState || draft.audioState === EXAM_AUDIO_STATE.PENDING) {
      draft.audioState = version.audioState || EXAM_AUDIO_STATE.AVAILABLE;
    }
  }
  const srcGroups = src.groups || {};
  for (const q of addedQuestions) {
    const srcG = q.sourceGroupId || null;
    const newG = q.passageId || q.groupId || null;
    const audioFromGroup = (srcG && pickExamMediaBindingAttachmentId(srcGroups[srcG])) || null;
    const srcQKey = q.sourceQuestionId || q.id;
    const audioFromQ = (srcQKey && pickExamMediaBindingAttachmentId(src.questions?.[srcQKey])) || null;
    const paperAtt = pickExamMediaBindingAttachmentId(src.paper);
    const att = audioFromGroup || audioFromQ || paperAtt;
    if (!att) continue;
    if (newG && !bindings.groups[newG]) {
      bindings.groups[newG] = {
        audioAttachmentId: att,
        frozenAudioAttachmentId: att,
        sourceVersionId: version.id,
        sourceGroupId: srcG,
      };
    }
    if (q.id && !bindings.questions[q.id]) {
      bindings.questions[q.id] = {
        audioAttachmentId: att,
        frozenAudioAttachmentId: att,
        sourceVersionId: version.id,
        sourceQuestionId: q.sourceQuestionId,
      };
    }
  }
  draft.mediaBindings = bindings;
}

export function validateDraftMediaPatch(draft, body, { hasPublishedVersion = false } = {}) {
  return validateVersionAudioPatch(draft, body, { hasAssignedAttempts: hasPublishedVersion });
}

export function buildComposeSourcePickerProjection(version, filters = {}) {
  if (!version) return null;
  const groupsById = new Map();
  for (const raw of version.passages || []) {
    const g = normalizeReadingGroup(raw);
    const range = parseExpectedQuestionRange(g);
    const memberIds = (version.questions || [])
      .filter((q) => q.passageId === g.id || q.groupId === g.id)
      .map((q) => q.id);
    const snippet = (g.bodyText || g.documents?.[0]?.bodyText || '').slice(0, 120);
    const mb = version.mediaBindings?.groups?.[g.id];
    groupsById.set(g.id, {
      id: g.id,
      label: range ? `Nhóm câu ${range.min}–${range.max}` : (g.title || 'Nhóm đọc'),
      questionIds: memberIds,
      contextSnippet: snippet,
      audioAttachmentId: mb?.audioAttachmentId || null,
    });
  }
  const allQuestions = (version.questions || []).map((q) => {
    const gid = q.passageId || q.groupId;
    const grp = gid ? groupsById.get(gid) : null;
    return {
      id: q.id,
      displayNumber: q.displayNumber,
      stemSnippet: String(q.stemText || '').slice(0, 120),
      passageId: gid || null,
      groupLabel: grp?.label || null,
      skill: q.skill || inferExamSkillFromQuestion(q),
      questionType: normalizeExamQuestionType(q),
      composeSupported: isExamComposeSupportedQuestion(q),
    };
  });
  const questions = filterExamQuestionsByMetadata(allQuestions, filters);
  const allowedGroupIds = new Set(questions.map((q) => q.passageId).filter(Boolean));
  const groups = [...groupsById.values()].filter((g) => allowedGroupIds.has(g.id));
  const filterCounts = computeExamMetadataFilterCounts(version.questions || []);
  return {
    versionId: version.id,
    title: version.title,
    questionCount: questions.length,
    hasSourcePdf: !!version.sourceAttachmentId,
    audioState: version.audioState || EXAM_AUDIO_STATE.PENDING,
    questions,
    groups,
    filterCounts,
    totalQuestionCount: allQuestions.length,
  };
}

/** @readonly */
export const EXAM_DELIVERY_MODE = {
  ONLINE: 'online',
  PDF: 'pdf',
  COMBINED: 'combined',
};

/** @readonly */
export const EXAM_ASSIGNMENT_PART = {
  ONLINE: 'online',
  PDF: 'pdf',
};

/** @readonly */
export const EXAM_PART_STATUS = {
  NOT_STARTED: 'not-started',
  IN_PROGRESS: 'in-progress',
  SUBMITTED: 'submitted',
};

/** @readonly */
export const EXAM_AUDIO_STATE = {
  PENDING: 'pending',
  AVAILABLE: 'available',
  REMOVED: 'removed',
};

/** @readonly */
export const EXAM_SKILL = {
  LISTENING: 'listening',
  READING: 'reading',
  WRITING: 'writing',
  SPEAKING: 'speaking',
  UNCLASSIFIED: 'unclassified',
};

const EXAM_SKILL_SET = new Set(Object.values(EXAM_SKILL));
const EXAM_DELIVERY_MODE_SET = new Set(Object.values(EXAM_DELIVERY_MODE));

export const EXAM_QUESTION_PUBLIC_ALLOWLIST = new Set([
  'id', 'sectionId', 'groupId', 'displayNumber', 'stemText', 'questionType', 'points',
  'passageId', 'unnumberedActivity', 'maxWords', 'minWords', 'maxLength', 'requiresAudio',
  'essayTopics', 'options', 'wordBankWords', 'wordBankInstructions', 'sourceWordBankUseOnce',
  'wordBankId', 'skill', 'bodyText', 'media',
]);

export const EXAM_PASSAGE_PUBLIC_ALLOWLIST = new Set([
  'id', 'title', 'instructions', 'bodyText', 'sectionId', 'documents', 'skill', 'media',
]);

export const EXAM_PDF_ANNOTATION_MAX_BYTES = 512 * 1024;
export const EXAM_PDF_ANNOTATION_MAX_STROKES_PER_PAGE = 4000;
export const EXAM_PDF_ANNOTATION_MAX_TEXT_ITEMS_PER_PAGE = 200;

export function normalizeExamDeliveryMode(value) {
  const raw = value?.deliveryMode != null ? value.deliveryMode : value;
  if (raw === EXAM_DELIVERY_MODE.PDF) return EXAM_DELIVERY_MODE.PDF;
  if (raw === EXAM_DELIVERY_MODE.COMBINED) return EXAM_DELIVERY_MODE.COMBINED;
  return EXAM_DELIVERY_MODE.ONLINE;
}

export function normalizeExamSkill(raw) {
  if (raw && EXAM_SKILL_SET.has(raw)) return raw;
  return EXAM_SKILL.UNCLASSIFIED;
}

export function inferExamSkillFromQuestion(question) {
  if (question?.skill && EXAM_SKILL_SET.has(question.skill)) {
    return question.skill;
  }
  const t = normalizeExamQuestionType(question);
  if (question?.requiresAudio) return EXAM_SKILL.LISTENING;
  if (t === EXAM_QUESTION_TYPE.ESSAY) return EXAM_SKILL.WRITING;
  if (t === EXAM_QUESTION_TYPE.ORAL_ASSESSMENT) return EXAM_SKILL.SPEAKING;
  const instr = String(question?.sectionInstructionSkill || question?.stemText || '').toLowerCase();
  if (/\blisten(ing)?\b/.test(instr)) return EXAM_SKILL.LISTENING;
  if (/\bread(ing)?\b/.test(instr)) return EXAM_SKILL.READING;
  if (/\bwrit(e|ing)\b/.test(instr)) return EXAM_SKILL.WRITING;
  if (/\bspeak(ing)?\b/.test(instr)) return EXAM_SKILL.SPEAKING;
  return EXAM_SKILL.UNCLASSIFIED;
}

export function isPdfOnlyExamDraft(draft) {
  return draft?.explicitPdfOnly === true || draft?.pdfOnly === true;
}

/** Stable bank identity across versions/drafts (legacy rows fall back to own id). */
export function resolveBankExamId(entity) {
  if (!entity) return null;
  if (entity.bankExamId) return String(entity.bankExamId);
  if (entity.id) return String(entity.id);
  return null;
}

export function validateCreatePdfOnlyDraftInput(body) {
  const sourceAttachmentId = body?.sourceAttachmentId ? String(body.sourceAttachmentId) : '';
  if (!sourceAttachmentId) return { ok: false, error: 'Cần tệp PDF nguồn.' };
  const title = body?.title != null ? String(body.title).trim() : '';
  return { ok: true, sourceAttachmentId, title: title || 'Đề PDF' };
}

export function buildPdfOnlyDraftContent({
  title,
  sourceAttachmentId,
  sourcePdfPageCount,
  needsOcr = false,
  needsOcrPageNumbers = [],
}) {
  return {
    title: title || 'Đề PDF',
    sections: [],
    passages: [],
    questions: [],
    warnings: needsOcr ? ['PDF quét — có thể chuyển trực tuyến sau (cần nhận dạng chữ).'] : [],
    needsOcr: !!needsOcr,
    needsOcrPageNumbers: needsOcrPageNumbers || [],
    needsReview: false,
    teacherConfirmedReview: true,
    manuallyEdited: false,
    gradingMode: EXAM_GRADING_MODE.TEACHER_MANUAL_LATER,
    sourceAttachmentId,
    sourcePdfPageCount: sourcePdfPageCount || null,
    explicitPdfOnly: true,
    composedFromVersionId: null,
  };
}

export function composeReviseDraftFromPublishedVersion(version) {
  const qs = version?.questions || [];
  return {
    title: version?.title || 'Đề thi',
    sections: JSON.parse(JSON.stringify(version?.sections || [])),
    passages: JSON.parse(JSON.stringify(version?.passages || [])),
    questions: JSON.parse(JSON.stringify(qs)),
    warnings: [],
    needsOcr: false,
    needsOcrPageNumbers: [],
    needsReview: false,
    teacherConfirmedReview: false,
    manuallyEdited: false,
    gradingMode: normalizeExamGradingMode(version),
    sourceAttachmentId: version?.sourceAttachmentId || null,
    sourcePdfPageCount: version?.sourcePdfPageCount || null,
    explicitPdfOnly: !!(version?.explicitPdfOnly || version?.pdfOnly),
    bankExamId: resolveBankExamId(version),
    composedFromVersionId: version?.id || null,
    publishedFromVersionId: version?.id || null,
  };
}

export function groupTeacherExamBanks(state, teacherAccountId) {
  const banks = new Map();
  const touch = (bid, patch) => {
    const prev = banks.get(bid) || {
      bankExamId: bid,
      title: 'Đề thi',
      hasPdf: false,
      hasOnline: false,
      versionCount: 0,
      draftCount: 0,
      latestPublishedAt: null,
      activeVersionId: null,
      needsReview: false,
      needsOcr: false,
    };
    banks.set(bid, { ...prev, ...patch, bankExamId: bid });
  };
  for (const v of (state.examVersions || []).filter((x) => x.teacherAccountId === teacherAccountId)) {
    const bid = resolveBankExamId(v);
    const prev = banks.get(bid);
    const publishedAt = v.publishedAt || null;
    const newer = !prev?.latestPublishedAt || (publishedAt && publishedAt >= prev.latestPublishedAt);
    touch(bid, {
      title: v.title || prev?.title,
      hasPdf: (prev?.hasPdf) || !!v.sourceAttachmentId,
      hasOnline: (prev?.hasOnline) || (v.questions || []).length > 0,
      versionCount: (prev?.versionCount || 0) + 1,
      latestPublishedAt: newer ? publishedAt : prev?.latestPublishedAt,
      activeVersionId: newer ? v.id : prev?.activeVersionId,
    });
  }
  for (const d of (state.examDrafts || []).filter((x) => x.teacherAccountId === teacherAccountId)) {
    const bid = resolveBankExamId(d);
    const prev = banks.get(bid);
    touch(bid, {
      title: d.title || prev?.title,
      hasPdf: (prev?.hasPdf) || !!d.sourceAttachmentId,
      hasOnline: (prev?.hasOnline) || (d.questions || []).length > 0,
      draftCount: (prev?.draftCount || 0) + 1,
      needsReview: (prev?.needsReview) || !!d.needsReview,
      needsOcr: (prev?.needsOcr) || !!d.needsOcr,
    });
  }
  return [...banks.values()].sort(
    (a, b) => String(b.latestPublishedAt || '').localeCompare(String(a.latestPublishedAt || '')),
  );
}

export function buildTeacherBankDetailProjection(state, bankExamId, teacherAccountId) {
  const bid = String(bankExamId || '');
  const versions = (state.examVersions || []).filter(
    (v) => v.teacherAccountId === teacherAccountId && resolveBankExamId(v) === bid,
  );
  const drafts = (state.examDrafts || []).filter(
    (d) => d.teacherAccountId === teacherAccountId && resolveBankExamId(d) === bid,
  );
  const latestVersion = versions.slice()
    .sort((a, b) => String(b.publishedAt || '').localeCompare(String(a.publishedAt || '')))[0] || null;
  const title = latestVersion?.title || drafts[0]?.title || 'Đề thi';
  return {
    bankExamId: bid,
    title,
    activeVersionId: latestVersion?.id || null,
    versions: versions.map((v) => ({
      id: v.id,
      title: v.title,
      publishedAt: v.publishedAt,
      pdfOnly: !!(v.explicitPdfOnly || v.pdfOnly),
      hasPdf: !!v.sourceAttachmentId,
      hasOnline: (v.questions || []).length > 0,
      sourcePdfPageCount: v.sourcePdfPageCount || null,
      questionCount: (v.questions || []).length,
      itemSummary: formatExamHubItemMeta(summarizeExamItems(v)),
    })),
    drafts: drafts.map((d) => ({
      id: d.id,
      title: d.title,
      updatedAt: d.updatedAt,
      explicitPdfOnly: !!d.explicitPdfOnly,
      needsOcr: d.needsOcr,
      needsReview: d.needsReview,
      hasPdf: !!d.sourceAttachmentId,
      hasOnline: (d.questions || []).length > 0,
      sourcePdfPageCount: d.sourcePdfPageCount || null,
      questionCount: (d.questions || []).length,
      itemSummary: formatExamHubItemMeta(summarizeExamItems(d)),
    })),
    capabilities: {
      hasPdf: versions.some((v) => v.sourceAttachmentId) || drafts.some((d) => d.sourceAttachmentId),
      hasOnline: versions.some((v) => (v.questions || []).length) || drafts.some((d) => (d.questions || []).length),
      readyOnline: versions.some((v) => (v.questions || []).length > 0),
    },
  };
}

export function versionHasAssignableOnlineQuestions(version) {
  return (version?.questions || []).length > 0;
}

export function versionHasSourcePdf(version) {
  return !!version?.sourceAttachmentId;
}

export function validatePdfOnlyDraftForPublish(draft) {
  const errors = [];
  const warnings = [...(draft.warnings || [])];
  if (!draft.title || !String(draft.title).trim()) errors.push('Thiếu tiêu đề đề thi.');
  if (!draft.sourceAttachmentId) errors.push('Cần tệp PDF nguồn.');
  if ((draft.questions || []).length > 0) {
    errors.push('Đề PDF-only không được chứa câu hỏi trực tuyến giả.');
  }
  if (!draft.teacherConfirmedReview && draft.needsReview) {
    errors.push('Cần xác nhận đã kiểm tra trước khi xuất bản.');
  }
  return {
    ok: errors.length === 0,
    errors,
    warnings,
    gradingMode: EXAM_GRADING_MODE.TEACHER_MANUAL_LATER,
    missingKeyCount: 0,
    allowMissingKeys: true,
    pdfOnly: true,
  };
}

export function normalizeSelectedPdfPageIds(raw, { maxPage = null } = {}) {
  if (raw == null) return { ok: true, ids: null };
  if (!Array.isArray(raw)) return { ok: false, error: 'Danh sách trang PDF không hợp lệ.' };
  if (!raw.length) return { ok: false, error: 'Chọn ít nhất một trang PDF.' };
  const seen = new Set();
  const ids = [];
  for (const p of raw) {
    const n = Number(p);
    if (!Number.isInteger(n) || n < 1) {
      return { ok: false, error: 'Số trang PDF không hợp lệ.' };
    }
    if (maxPage != null && n > maxPage) {
      return { ok: false, error: 'Trang PDF vượt quá phạm vi đề nguồn.' };
    }
    if (seen.has(n)) return { ok: false, error: 'Trang PDF bị trùng.' };
    seen.add(n);
    ids.push(n);
  }
  ids.sort((a, b) => a - b);
  return { ok: true, ids };
}

export function assignmentSelectedPdfPageIds(assignment, version) {
  const raw = assignment?.selectedPdfPageIds;
  if (Array.isArray(raw) && raw.length) return raw.slice();
  const max = Number(version?.sourcePdfPageCount);
  if (Number.isInteger(max) && max > 0) {
    return Array.from({ length: max }, (_, i) => i + 1);
  }
  return null;
}

export function assignmentRequiredParts(assignment) {
  const mode = normalizeExamDeliveryMode(assignment);
  if (mode === EXAM_DELIVERY_MODE.PDF) {
    return { online: false, pdf: true };
  }
  if (mode === EXAM_DELIVERY_MODE.COMBINED) {
    const raw = assignment?.requiredParts;
    return {
      online: raw?.online !== false,
      pdf: raw?.pdf !== false,
    };
  }
  return { online: true, pdf: false };
}

export function validateExamAssignmentDelivery(version, body) {
  const mode = normalizeExamDeliveryMode(body);
  const hasOnline = versionHasAssignableOnlineQuestions(version);
  const hasPdf = versionHasSourcePdf(version);
  if (mode === EXAM_DELIVERY_MODE.ONLINE) {
    if (!hasOnline) {
      return { ok: false, error: 'Đề này không có phần trực tuyến — chọn PDF hoặc kết hợp.' };
    }
    if (isPdfOnlyExamDraft(version) || (version.questions || []).length === 0) {
      return { ok: false, error: 'Không thể giao PDF-only ở chế độ trực tuyến.' };
    }
    return { ok: true, deliveryMode: mode, requiredParts: assignmentRequiredParts({ deliveryMode: mode }) };
  }
  if (mode === EXAM_DELIVERY_MODE.PDF) {
    if (!hasPdf) return { ok: false, error: 'Đề không có PDF nguồn.' };
    if (hasOnline && (version.questions || []).length > 0) {
      /* pdf delivery may still reference version with questions — student only sees pdf */
    }
    let pages;
    if (body?.selectedPdfPageIds == null) {
      const max = Number(version?.sourcePdfPageCount);
      if (Number.isInteger(max) && max > 0) {
        pages = { ok: true, ids: Array.from({ length: max }, (_, i) => i + 1) };
      } else {
        return { ok: false, error: 'Chọn ít nhất một trang PDF.' };
      }
    } else {
      pages = normalizeSelectedPdfPageIds(body.selectedPdfPageIds, {
        maxPage: version?.sourcePdfPageCount || null,
      });
    }
    if (!pages.ok) return pages;
    return {
      ok: true,
      deliveryMode: mode,
      selectedPdfPageIds: pages.ids,
      requiredParts: { online: false, pdf: true },
    };
  }
  if (mode === EXAM_DELIVERY_MODE.COMBINED) {
    if (!hasOnline) return { ok: false, error: 'Đề kết hợp cần phần trực tuyến.' };
    if (!hasPdf) return { ok: false, error: 'Đề kết hợp cần PDF nguồn.' };
    let pages;
    if (body?.selectedPdfPageIds == null) {
      const max = Number(version?.sourcePdfPageCount);
      if (Number.isInteger(max) && max > 0) {
        pages = { ok: true, ids: Array.from({ length: max }, (_, i) => i + 1) };
      } else {
        return { ok: false, error: 'Chọn ít nhất một trang PDF.' };
      }
    } else {
      pages = normalizeSelectedPdfPageIds(body.selectedPdfPageIds, {
        maxPage: version?.sourcePdfPageCount || null,
      });
    }
    if (!pages.ok) return pages;
    const requiredParts = {
      online: body?.requiredParts?.online !== false,
      pdf: body?.requiredParts?.pdf !== false,
    };
    if (!requiredParts.online && !requiredParts.pdf) {
      return { ok: false, error: 'Cần ít nhất một phần bắt buộc.' };
    }
    return {
      ok: true,
      deliveryMode: mode,
      selectedPdfPageIds: pages.ids,
      requiredParts,
    };
  }
  return { ok: false, error: 'Chế độ giao bài không hợp lệ.' };
}

export function pickExamMediaBindingAttachmentId(binding) {
  if (!binding || typeof binding !== 'object') return null;
  return binding.frozenAudioAttachmentId || binding.audioAttachmentId || null;
}

export function pickExamMediaAttachmentFromSnapshot(snap, { groupId = null } = {}) {
  if (!snap || typeof snap !== 'object') return null;
  if (groupId && snap.mediaBindings?.groups?.[groupId]) {
    const gid = pickExamMediaBindingAttachmentId(snap.mediaBindings.groups[groupId]);
    if (gid) return gid;
  }
  if (snap.mediaBindings?.paper) {
    const paper = pickExamMediaBindingAttachmentId(snap.mediaBindings.paper);
    if (paper) return paper;
  }
  if (snap.mediaBindings?.questions && typeof snap.mediaBindings.questions === 'object') {
    for (const qBind of Object.values(snap.mediaBindings.questions)) {
      const qid = pickExamMediaBindingAttachmentId(qBind);
      if (qid) return qid;
    }
  }
  return snap.audioAttachmentId || null;
}

function freezeBindingAttachmentIds(binding) {
  if (!binding || typeof binding !== 'object') return binding;
  const id = pickExamMediaBindingAttachmentId(binding);
  if (!id) return binding;
  const out = { ...binding };
  if (!out.audioAttachmentId) out.audioAttachmentId = id;
  if (!out.frozenAudioAttachmentId) out.frozenAudioAttachmentId = id;
  return out;
}

export function freezeMediaSnapshotBindings(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return snapshot;
  const snap = JSON.parse(JSON.stringify(snapshot));
  const mb = snap.mediaBindings && typeof snap.mediaBindings === 'object'
    ? { ...snap.mediaBindings, groups: { ...(snap.mediaBindings.groups || {}) }, questions: { ...(snap.mediaBindings.questions || {}) } }
    : { paper: null, groups: {}, questions: {} };
  if (mb.paper) mb.paper = freezeBindingAttachmentIds(mb.paper);
  for (const k of Object.keys(mb.groups || {})) {
    mb.groups[k] = freezeBindingAttachmentIds(mb.groups[k]);
  }
  for (const k of Object.keys(mb.questions || {})) {
    mb.questions[k] = freezeBindingAttachmentIds(mb.questions[k]);
  }
  snap.mediaBindings = mb;
  const paperId = pickExamMediaBindingAttachmentId(mb.paper);
  if (!snap.audioAttachmentId && paperId) snap.audioAttachmentId = paperId;
  if (snap.audioAttachmentId && !mb.paper?.audioAttachmentId) {
    mb.paper = freezeBindingAttachmentIds({
      ...(mb.paper || {}),
      audioAttachmentId: snap.audioAttachmentId,
      frozenAudioAttachmentId: snap.audioAttachmentId,
    });
    snap.mediaBindings = mb;
  }
  if (snap.audioAttachmentId && (snap.audioState === EXAM_AUDIO_STATE.PENDING || !snap.audioState)) {
    snap.audioState = EXAM_AUDIO_STATE.AVAILABLE;
  }
  return snap;
}

export function buildAssignmentMediaSnapshot(version) {
  const mediaBindings = version?.mediaBindings && typeof version.mediaBindings === 'object'
    ? JSON.parse(JSON.stringify(version.mediaBindings))
    : null;
  let audioAttachmentId = version?.audioAttachmentId || null;
  const paperId = pickExamMediaBindingAttachmentId(mediaBindings?.paper);
  if (!audioAttachmentId && paperId) audioAttachmentId = paperId;
  let audioState = version?.audioState || EXAM_AUDIO_STATE.PENDING;
  if (audioAttachmentId && (audioState === EXAM_AUDIO_STATE.PENDING || !audioState)) {
    audioState = EXAM_AUDIO_STATE.AVAILABLE;
  }
  return freezeMediaSnapshotBindings({
    audioAttachmentId,
    audioState,
    mediaRevision: version?.mediaRevision || 0,
    classroomPlaybackAllowed: !!version?.classroomPlaybackAllowed,
    mediaBindings,
  });
}

export function pickPublicQuestionFields(question, passagesById) {
  const full = projectQuestionPublicForStudent(question, passagesById);
  const out = {};
  for (const key of EXAM_QUESTION_PUBLIC_ALLOWLIST) {
    if (full[key] !== undefined) out[key] = full[key];
  }
  if (out.skill == null) out.skill = inferExamSkillFromQuestion(question);
  return out;
}

/**
 * Bank filter: OR within skills, OR within types; AND across dimensions when both present.
 */
export function filterExamQuestionsByMetadata(questions, filters = {}) {
  const list = questions || [];
  const skillSet = new Set((filters.skills || []).map(normalizeExamSkill).filter(Boolean));
  const typeSet = new Set((filters.types || []).map((t) => String(t)));
  const wantSkills = skillSet.size > 0;
  const wantTypes = typeSet.size > 0;
  if (!wantSkills && !wantTypes) return list;
  return list.filter((q) => {
    const skillOk = !wantSkills || skillSet.has(inferExamSkillFromQuestion(q));
    const typeOk = !wantTypes || typeSet.has(normalizeExamQuestionType(q));
    return skillOk && typeOk;
  });
}

export function filterExamBankSources(sources, filters = {}) {
  const skillSet = new Set((filters.skills || []).map(normalizeExamSkill));
  const typeSet = new Set((filters.types || []).map((t) => String(t)));
  const wantSkills = skillSet.size > 0;
  const wantTypes = typeSet.size > 0;
  if (!wantSkills && !wantTypes) return sources || [];
  return (sources || []).filter((src) => {
    const qs = src.questions || [];
    const matching = qs.filter((q) => {
      const skillOk = !wantSkills || skillSet.has(inferExamSkillFromQuestion(q));
      const typeOk = !wantTypes || typeSet.has(normalizeExamQuestionType(q));
      return skillOk && typeOk;
    });
    return matching.length > 0;
  }).map((src) => ({
    ...src,
    questions: filterExamQuestionsByMetadata(src.questions, filters),
  }));
}

export function defaultAttemptPartStatus(assignment) {
  const req = assignmentRequiredParts(assignment);
  return {
    online: req.online ? EXAM_PART_STATUS.NOT_STARTED : null,
    pdf: req.pdf ? EXAM_PART_STATUS.NOT_STARTED : null,
  };
}

export function normalizePdfPageKey(page) {
  const n = Number(page);
  if (!Number.isInteger(n) || n < 1) return null;
  return String(n);
}

function validatePdfAnnotationPayload(body, pageKey) {
  const strokes = Array.isArray(body?.strokes) ? body.strokes : [];
  const texts = Array.isArray(body?.texts) ? body.texts : [];
  if (strokes.length > EXAM_PDF_ANNOTATION_MAX_STROKES_PER_PAGE) {
    return { ok: false, code: 'payload-too-large', error: 'Quá nhiều nét vẽ.' };
  }
  if (texts.length > EXAM_PDF_ANNOTATION_MAX_TEXT_ITEMS_PER_PAGE) {
    return { ok: false, code: 'payload-too-large', error: 'Quá nhiều chú thích.' };
  }
  const payloadBytes = Buffer.byteLength(JSON.stringify({ strokes, texts }), 'utf8');
  if (payloadBytes > EXAM_PDF_ANNOTATION_MAX_BYTES) {
    return { ok: false, code: 'payload-too-large', error: 'Dữ liệu chú thích quá lớn.' };
  }
  const viewport = body?.viewport;
  if (!viewport || typeof viewport !== 'object') {
    return { ok: false, code: 'bad-viewport', error: 'Thiếu metadata khung trang.' };
  }
  return {
    ok: true,
    pageKey,
    strokes,
    texts,
    viewport: {
      width: Number(viewport.width) || 0,
      height: Number(viewport.height) || 0,
      pageWidth: Number(viewport.pageWidth) || 0,
      pageHeight: Number(viewport.pageHeight) || 0,
    },
  };
}

export function validatePdfAnnotationSaveBody(body, assignment, allowedPageIds) {
  const pageKey = normalizePdfPageKey(body?.page);
  if (!pageKey) return { ok: false, code: 'bad-page', error: 'Trang PDF không hợp lệ.' };
  const allowed = new Set((allowedPageIds || []).map((p) => String(p)));
  if (!allowed.has(pageKey)) return { ok: false, code: 'page-out-of-scope', error: 'Trang không thuộc phần được giao.' };
  const layer = body?.layer === 'teacher' ? 'teacher' : 'student';
  if (layer === 'teacher') return { ok: false, code: 'forbidden-layer', error: 'Học sinh không ghi lớp giáo viên.' };
  return validatePdfAnnotationPayload(body, pageKey);
}

export function validatePdfTeacherAnnotationSaveBody(body, assignment, allowedPageIds) {
  const pageKey = normalizePdfPageKey(body?.page);
  if (!pageKey) return { ok: false, code: 'bad-page', error: 'Trang PDF không hợp lệ.' };
  const allowed = new Set((allowedPageIds || []).map((p) => String(p)));
  if (!allowed.has(pageKey)) return { ok: false, code: 'page-out-of-scope', error: 'Trang không thuộc phần được giao.' };
  if (body?.layer === 'student') return { ok: false, code: 'forbidden-layer', error: 'Giáo viên không ghi đè lớp học sinh.' };
  return validatePdfAnnotationPayload(body, pageKey);
}

export function mergePdfTeacherPageAnnotation(attempt, pageKey, patch, nowIso) {
  if (!attempt.teacherPdfAnnotations || typeof attempt.teacherPdfAnnotations !== 'object') {
    attempt.teacherPdfAnnotations = {};
  }
  attempt.teacherPdfAnnotations[pageKey] = {
    strokes: patch.strokes,
    texts: patch.texts,
    viewport: patch.viewport,
    updatedAt: nowIso,
  };
  attempt.teacherPdfAnnotationRevision = (attempt.teacherPdfAnnotationRevision || 0) + 1;
  return attempt.teacherPdfAnnotationRevision;
}

export function frozenPdfStudentPagesForTeacher(attempt) {
  const snap = attempt?.pdfSubmittedSnapshot ?? attempt?.pdfAnnotations ?? {};
  return JSON.parse(JSON.stringify(snap));
}

export function buildTeacherPdfGradingProjection(attempt, assignment, version) {
  const pages = assignmentSelectedPdfPageIds(assignment, version) || [];
  return {
    selectedPdfPageIds: pages.slice(),
    studentFrozenPages: frozenPdfStudentPagesForTeacher(attempt),
    teacherPages: JSON.parse(JSON.stringify(attempt?.teacherPdfAnnotations || {})),
    teacherPdfAnnotationRevision: attempt?.teacherPdfAnnotationRevision || 0,
    pdfGradeRevision: attempt?.pdfGradeRevision || 0,
    pdfManualGrade: attempt?.pdfManualGrade ? { ...(attempt.pdfManualGrade) } : null,
    pdfFeedbackPublished: attempt?.pdfFeedbackPublished === true,
  };
}

export function projectStudentPdfLayers(attempt, assignment) {
  const mode = normalizeExamDeliveryMode(assignment);
  if (mode === EXAM_DELIVERY_MODE.ONLINE) return null;
  const pdfFrozen = attempt?.partStatus?.pdf === EXAM_PART_STATUS.SUBMITTED
    || attempt?.status === EXAM_ATTEMPT_STATUS.SUBMITTED;
  const editable = !pdfFrozen && attempt?.status === EXAM_ATTEMPT_STATUS.IN_PROGRESS;
  const studentSource = pdfFrozen
    ? (attempt?.pdfSubmittedSnapshot || attempt?.pdfAnnotations || {})
    : (attempt?.pdfAnnotations || {});
  const out = {
    editable,
    studentPages: JSON.parse(JSON.stringify(studentSource)),
    revision: attempt?.pdfAnnotationRevision || 0,
    teacherPages: {},
    pdfFeedback: null,
  };
  if (pdfFrozen && attempt?.pdfFeedbackPublished === true) {
    out.teacherPages = JSON.parse(JSON.stringify(attempt?.teacherPdfAnnotations || {}));
    out.pdfFeedback = getPublishedPdfManualGrade(attempt);
  }
  return out;
}

export function getPublishedPdfManualGrade(attempt) {
  const mg = attempt?.pdfManualGrade;
  if (!mg || attempt?.pdfFeedbackPublished !== true) return null;
  return {
    score: mg.score,
    maxPoints: mg.maxPoints,
    feedback: mg.feedback || null,
    published: true,
  };
}

export function mergePdfStudentPageAnnotation(attempt, pageKey, patch, nowIso) {
  if (!attempt.pdfAnnotations || typeof attempt.pdfAnnotations !== 'object') {
    attempt.pdfAnnotations = {};
  }
  const prev = attempt.pdfAnnotations[pageKey] || {};
  attempt.pdfAnnotations[pageKey] = {
    strokes: patch.strokes,
    texts: patch.texts,
    viewport: patch.viewport,
    updatedAt: nowIso,
  };
  attempt.pdfAnnotationRevision = (attempt.pdfAnnotationRevision || 0) + 1;
  const parts = attempt.partStatus || defaultAttemptPartStatus({ deliveryMode: EXAM_DELIVERY_MODE.PDF });
  if (parts.pdf === EXAM_PART_STATUS.NOT_STARTED) {
    attempt.partStatus = { ...parts, pdf: EXAM_PART_STATUS.IN_PROGRESS };
  }
  return attempt.pdfAnnotationRevision;
}

export function freezePdfStudentAnnotations(attempt) {
  attempt.pdfSubmittedSnapshot = JSON.parse(JSON.stringify(attempt.pdfAnnotations || {}));
}

export function validateVersionAudioPatch(version, body, { hasAssignedAttempts = false } = {}) {
  const action = body?.action;
  if (action !== 'attach' && action !== 'replace' && action !== 'remove') {
    return { ok: false, error: 'Thao tác âm thanh không hợp lệ.' };
  }
  if (action === 'remove' || action === 'replace') {
    if (hasAssignedAttempts && !body?.acknowledgeMediaChange) {
      return { ok: false, error: 'Cần xác nhận thay đổi âm thanh cho bài đã giao.', code: 'ack-required' };
    }
  }
  if (action === 'remove') {
    return { ok: true, action, audioAttachmentId: null, audioState: EXAM_AUDIO_STATE.REMOVED };
  }
  const attId = body?.audioAttachmentId ? String(body.audioAttachmentId) : '';
  if (!attId) return { ok: false, error: 'Thiếu tệp âm thanh.' };
  const baseRev = Number(body?.baseMediaRevision);
  if (!Number.isFinite(baseRev) || baseRev < 0) {
    return { ok: false, error: 'Thiếu phiên bản media.' };
  }
  if ((version?.mediaRevision || 0) !== baseRev) {
    return { ok: false, error: 'Media đã thay đổi — tải lại.', code: 'stale-media' };
  }
  return {
    ok: true,
    action,
    audioAttachmentId: attId,
    audioState: EXAM_AUDIO_STATE.AVAILABLE,
    mediaRevision: baseRev + 1,
    classroomPlaybackAllowed: body?.classroomPlaybackAllowed === true,
  };
}

export function requiredPartsSubmitted(assignment, attempt) {
  const req = assignmentRequiredParts(assignment);
  const st = attempt?.partStatus || {};
  if (req.online && st.online !== EXAM_PART_STATUS.SUBMITTED) return false;
  if (req.pdf && st.pdf !== EXAM_PART_STATUS.SUBMITTED) return false;
  return true;
}

export function validateAttemptPartSubmit(assignment, attempt, part) {
  const mode = normalizeExamDeliveryMode(assignment);
  const req = assignmentRequiredParts(assignment);
  if (part === EXAM_ASSIGNMENT_PART.ONLINE) {
    if (mode === EXAM_DELIVERY_MODE.PDF) {
      return { ok: false, error: 'Bài PDF-only không có phần trực tuyến.' };
    }
    if (!req.online) return { ok: false, error: 'Phần trực tuyến không bắt buộc.' };
    return { ok: true, part };
  }
  if (part === EXAM_ASSIGNMENT_PART.PDF) {
    if (!req.pdf) return { ok: false, error: 'Phần PDF không bắt buộc.' };
    return { ok: true, part };
  }
  return { ok: false, error: 'Phần nộp không hợp lệ.' };
}

export function markAttemptPartSubmitted(attempt, part, nowIso) {
  const parts = { ...(attempt.partStatus || {}) };
  if (part === EXAM_ASSIGNMENT_PART.ONLINE) parts.online = EXAM_PART_STATUS.SUBMITTED;
  if (part === EXAM_ASSIGNMENT_PART.PDF) {
    parts.pdf = EXAM_PART_STATUS.SUBMITTED;
    freezePdfStudentAnnotations(attempt);
  }
  attempt.partStatus = parts;
  attempt.updatedAt = nowIso;
}

export function scaleOnlineEarnedToPartWeight(onlineGrade, assignment, version) {
  const denom = assignmentScoringDenominator(version, assignment);
  const rawTotal = Number(onlineGrade?.totalPoints) || 0;
  const rawEarned = onlineGrade?.earnedPoints;
  if (rawEarned == null) return null;
  if (rawTotal <= 0 || denom.onlinePoints <= 0) return rawEarned;
  if (Math.abs(rawTotal - denom.onlinePoints) < 1e-6) return rawEarned;
  return (rawEarned / rawTotal) * denom.onlinePoints;
}

export function freezeAttemptSubmissionSnapshots(attempt, assignment, version) {
  attempt.submissionMediaSnapshot = buildAssignmentMediaSnapshot(version);
  if (attempt.pdfSubmittedSnapshot == null) {
    freezePdfStudentAnnotations(attempt);
  }
  attempt.frozenSourcePdfAttachmentId = assignment?.sourcePdfAttachmentId || version?.sourceAttachmentId || null;
  attempt.frozenSelectedPdfPageIds = assignment?.selectedPdfPageIds
    ? assignment.selectedPdfPageIds.slice()
    : null;
}

export function assignmentScoringDenominator(version, assignment) {
  const mode = normalizeExamDeliveryMode(assignment);
  const effective = effectiveVersionForAssignment(version, assignment);
  let onlinePoints = 0;
  for (const q of effective.questions || []) {
    onlinePoints += Number(q.points) > 0 ? Number(q.points) : 1;
  }
  const onlineOverride = Number(assignment?.onlinePartPoints);
  if (Number.isFinite(onlineOverride) && onlineOverride > 0) {
    onlinePoints = onlineOverride;
  }
  const pdfPoints = Number(assignment?.pdfPartPoints) > 0 ? Number(assignment.pdfPartPoints) : 0;
  if (mode === EXAM_DELIVERY_MODE.PDF) {
    return { onlinePoints: 0, pdfPoints: pdfPoints || 10, totalPoints: pdfPoints || 10 };
  }
  if (mode === EXAM_DELIVERY_MODE.COMBINED) {
    const pp = pdfPoints || 10;
    return { onlinePoints, pdfPoints: pp, totalPoints: onlinePoints + pp };
  }
  return { onlinePoints, pdfPoints: 0, totalPoints: onlinePoints };
}

export function mergePdfManualGradeUpdate(attempt, assignment, version, body) {
  const denom = assignmentScoringDenominator(version, assignment);
  const max = denom.pdfPoints || denom.totalPoints;
  const scoreRaw = body?.score;
  if (scoreRaw == null || scoreRaw === '') {
    return { ok: false, error: 'Thiếu điểm PDF.' };
  }
  const score = Number(scoreRaw);
  if (!Number.isFinite(score) || score < 0 || score > max) {
    return { ok: false, error: 'Điểm PDF không hợp lệ.' };
  }
  const feedback = body?.feedback != null ? String(body.feedback).slice(0, 4000) : null;
  attempt.pdfManualGrade = {
    score,
    maxPoints: max,
    feedback,
  };
  if (body?.publishFeedback === true) {
    attempt.pdfFeedbackPublished = true;
  } else if (body?.publishFeedback === false) {
    attempt.pdfFeedbackPublished = false;
  }
  return { ok: true, pdfManualGrade: attempt.pdfManualGrade, pdfFeedbackPublished: attempt.pdfFeedbackPublished === true };
}

export function computeFinalAttemptScore(attempt, version, assignment) {
  const mode = normalizeExamDeliveryMode(assignment);
  if (mode === EXAM_DELIVERY_MODE.PDF) {
    const mg = attempt.pdfManualGrade;
    if (!mg) {
      return {
        gradingStatus: EXAM_ATTEMPT_GRADING_STATUS.PENDING,
        score10: null,
        earnedPoints: null,
        totalPoints: mg?.maxPoints || assignmentScoringDenominator(version, assignment).totalPoints,
      };
    }
    const total = mg.maxPoints || assignmentScoringDenominator(version, assignment).totalPoints;
    const earned = mg.score;
    return {
      gradingStatus: EXAM_ATTEMPT_GRADING_STATUS.COMPLETE,
      score10: computeNormalizedScore10(earned, total),
      earnedPoints: earned,
      totalPoints: total,
      correctCount: null,
      totalCount: null,
    };
  }
  const onlineGrade = gradeAttempt(version, attempt.answers, assignment, attempt.manualGrades);
  if (mode === EXAM_DELIVERY_MODE.COMBINED) {
    const denom = assignmentScoringDenominator(version, assignment);
    const pdfMg = attempt.pdfManualGrade;
    const pdfEarned = pdfMg ? Number(pdfMg.score) : null;
    const onlineEarned = scaleOnlineEarnedToPartWeight(onlineGrade, assignment, version);
    const total = denom.totalPoints;
    let gradingStatus = onlineGrade.gradingStatus;
    if (!pdfMg) gradingStatus = EXAM_ATTEMPT_GRADING_STATUS.PARTIAL;
    else if (gradingStatus === EXAM_ATTEMPT_GRADING_STATUS.COMPLETE) {
      /* keep */
    } else if (onlineEarned != null) gradingStatus = EXAM_ATTEMPT_GRADING_STATUS.PARTIAL;
    const earned = (onlineEarned ?? 0) + (pdfEarned ?? 0);
    const scoreReady = gradingStatus === EXAM_ATTEMPT_GRADING_STATUS.COMPLETE
      && pdfMg != null
      && onlineGrade.gradingStatus === EXAM_ATTEMPT_GRADING_STATUS.COMPLETE;
    return {
      gradingStatus,
      score10: scoreReady ? computeNormalizedScore10(earned, total) : null,
      earnedPoints: scoreReady ? earned : null,
      totalPoints: total,
      correctCount: onlineGrade.correctCount,
      totalCount: onlineGrade.totalCount,
    };
  }
  return {
    gradingStatus: onlineGrade.gradingStatus,
    score10: onlineGrade.score10,
    earnedPoints: onlineGrade.earnedPoints,
    totalPoints: onlineGrade.totalPoints,
    correctCount: onlineGrade.correctCount,
    totalCount: onlineGrade.totalCount,
  };
}

/** Stage B/C: stable API contract (payload shapes only). */
export function buildUnifiedExamStageApiContract() {
  return {
    deliveryModes: Object.values(EXAM_DELIVERY_MODE),
    assignmentCreateFields: [
      'versionId', 'classId', 'title', 'openAt', 'dueAt', 'attemptLimit', 'purpose',
      'deliveryMode', 'selectedQuestionIds', 'selectedPdfPageIds', 'requiredParts',
      'pdfPartPoints', 'onlinePartPoints', 'classroomPlaybackAllowed',
    ],
    studentPartSubmit: { method: 'POST', path: '/api/student/exams/attempts/:attemptId/submit-part', body: { part: 'online|pdf' } },
    studentPdfAnnotations: {
      method: 'POST',
      path: '/api/student/exams/attempts/:attemptId/pdf-annotations',
      body: { page: 'number', strokes: '[]', texts: '[]', viewport: '{}', baseRevision: 'number' },
    },
    studentFinalSubmit: { method: 'POST', path: '/api/student/exams/attempts/:attemptId/submit', body: {} },
    teacherPdfManualGrade: {
      method: 'PUT',
      path: '/api/teacher/exams/attempts/:attemptId/pdf-manual-grade',
      body: { score: 'number', feedback: 'string?', baseRevision: 'number', publishFeedback: 'boolean?' },
    },
    teacherPdfAnnotations: {
      method: 'POST',
      path: '/api/teacher/exams/attempts/:attemptId/pdf-annotations',
      body: { page: 'number', strokes: '[]', texts: '[]', viewport: '{}', baseRevision: 'number' },
    },
    teacherVersionMedia: {
      method: 'PUT',
      path: '/api/teacher/exams/versions/:versionId/media',
      body: {
        action: 'attach|replace|remove',
        audioAttachmentId: 'string?',
        baseMediaRevision: 'number',
        acknowledgeMediaChange: 'boolean?',
        classroomPlaybackAllowed: 'boolean?',
      },
    },
    studentSourcePdf: { method: 'GET', path: '/api/student/exams/assignments/:assignmentId/source-pdf' },
    teacherVersionSourcePdf: { method: 'GET', path: '/api/teacher/exams/versions/:versionId/source-pdf' },
    studentExamAudio: { method: 'GET', path: '/api/student/exams/assignments/:assignmentId/audio' },
    teacherPdfOnlyDraft: {
      method: 'POST',
      path: '/api/teacher/exams/pdf-only-drafts',
      body: { sourceAttachmentId: 'string', title: 'string?' },
    },
    teacherBankDetail: { method: 'GET', path: '/api/teacher/exams/banks/:bankExamId' },
    teacherVersionRevise: { method: 'POST', path: '/api/teacher/exams/versions/:versionId/revise' },
    teacherDraftMedia: {
      method: 'PUT',
      path: '/api/teacher/exams/drafts/:draftId/media',
      body: {
        action: 'attach|replace|remove',
        audioAttachmentId: 'string?',
        baseMediaRevision: 'number',
        groupId: 'string?',
        acknowledgeMediaChange: 'boolean?',
      },
    },
    teacherComposeUndo: {
      method: 'POST',
      path: '/api/teacher/exams/drafts/:draftId/compose-undo',
      body: { baseRevision: 'number' },
    },
    teacherEditableDrafts: { method: 'GET', path: '/api/teacher/exams/editable-drafts?q=search' },
  };
}

export function parseExamRoute(parts) {
  if (parts[0] !== 'exams') return null;
  if (parts.length === 1) return { view: 'exams-hub' };
  if (parts[1] === 'import') return { view: 'exams-import' };
  if (parts[1] === 'compose') return { view: 'exams-compose' };
  if (parts[1] === 'source' && parts[2]) return { view: 'exams-source', versionId: parts[2] };
  if (parts[1] === 'bank' && parts[2]) return { view: 'exams-bank', bankExamId: parts[2] };
  if (parts[1] === 'draft' && parts[2]) return { view: 'exams-draft', draftId: parts[2] };
  if (parts[1] === 'assign' && parts[2]) return { view: 'exams-assign', versionId: parts[2] };
  if (parts[1] === 'grade' && parts[2]) return { view: 'exams-grade', assignmentId: parts[2] };
  if (parts[1] === 'take' && parts[2]) return { view: 'exams-take', assignmentId: parts[2] };
  if (parts[1] === 'result' && parts[2]) return { view: 'exams-result', assignmentId: parts[2] };
  return { view: 'exams-hub' };
}

export const EXAM_NAV_ITEM = {
  id: 'exams',
  label: 'Kho đề',
  studentLabel: 'Bài trực tuyến',
  hash: '#/exams',
  teacher: true,
  student: true,
};
