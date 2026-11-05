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

const OPTION_LABELS = ['A', 'B', 'C', 'D', 'E', 'F'];

export function sanitizeExamHtml(text) {
  let s = String(text ?? '');
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

export function validateDraftForPublish(draft) {
  const errors = [];
  const warnings = draft.warnings || [];
  if (!draft.title || !String(draft.title).trim()) errors.push('Thiếu tiêu đề bài thi.');
  if (draft.needsOcr) errors.push('PDF cần OCR — không thể xuất bản ở giai đoạn 1.');
  if (!draft.teacherConfirmedReview && draft.needsReview) {
    errors.push('Cần xác nhận đã rà soát trước khi xuất bản.');
  }
  const questions = draft.questions || [];
  if (!questions.length) errors.push('Chưa có câu hỏi.');
  for (const q of questions) {
    const opts = q.options || [];
    const uniq = new Set(opts.map((o) => o.id));
    if (opts.length < 2 || opts.length > 6) errors.push(`Câu ${q.displayNumber}: cần 2–6 lựa chọn.`);
    if (uniq.size !== opts.length) errors.push(`Câu ${q.displayNumber}: lựa chọn trùng mã.`);
    if (!q.stemText || !String(q.stemText).trim()) errors.push(`Câu ${q.displayNumber}: thiếu nội dung.`);
    if (!q.correctOptionId) errors.push(`Câu ${q.displayNumber}: thiếu đáp án đúng.`);
    else if (!opts.some((o) => o.id === q.correctOptionId)) {
      errors.push(`Câu ${q.displayNumber}: đáp án không hợp lệ.`);
    }
  }
  const missingKey = questions.some((q) => !q.correctOptionId);
  if (missingKey) errors.push('Thiếu khóa đáp án — không thể xuất bản.');
  return { ok: errors.length === 0, errors, warnings };
}

export function computeNormalizedScore10(correctPoints, totalPoints) {
  if (!totalPoints || totalPoints <= 0) return 0;
  const raw = (correctPoints / totalPoints) * 10;
  return Math.round(raw * 100) / 100;
}

export function gradeAttempt(version, answers) {
  let correct = 0;
  let total = 0;
  let earned = 0;
  const perQuestion = [];
  for (const q of version.questions || []) {
    const points = Number(q.points) > 0 ? Number(q.points) : 1;
    total += points;
    const chosen = answers?.[q.id] ?? null;
    const isCorrect = chosen && chosen === q.correctOptionId;
    if (isCorrect) {
      correct += 1;
      earned += points;
    }
    perQuestion.push({
      questionId: q.id,
      chosenOptionId: chosen,
      correct: !!isCorrect,
      points,
      earned: isCorrect ? points : 0,
    });
  }
  return {
    correctCount: correct,
    totalCount: (version.questions || []).length,
    totalPoints: total,
    earnedPoints: earned,
    score10: computeNormalizedScore10(earned, total),
    perQuestion,
  };
}

export function projectExamVersionForStudent(version, assignment, attempt, nowIso) {
  const due = assignment.dueAt;
  const showScore = assignment.showScore !== false;
  const showAnswersPolicy = assignment.showAnswersAfter || 'after-due';
  const pastDue = due && nowIso >= due;
  const showAnswers = showAnswersPolicy === 'immediate'
    || (showAnswersPolicy === 'after-due' && pastDue)
    || (showAnswersPolicy === 'after-submit' && attempt?.status === EXAM_ATTEMPT_STATUS.SUBMITTED);

  const questions = (version.questions || []).map((q) => ({
    id: q.id,
    sectionId: q.sectionId,
    groupId: q.groupId,
    displayNumber: q.displayNumber,
    stemText: q.stemText,
    options: (q.options || []).map((o) => ({
      id: o.id,
      label: o.label,
      text: o.text,
    })),
    points: q.points,
    passageId: q.passageId,
  }));

  const passages = (version.passages || []).map((p) => ({
    id: p.id,
    title: p.title,
    bodyText: p.bodyText,
    sectionId: p.sectionId,
  }));

  let result = null;
  if (attempt?.status === EXAM_ATTEMPT_STATUS.SUBMITTED || attempt?.status === EXAM_ATTEMPT_STATUS.EXPIRED) {
    result = {
      score10: showScore ? attempt.score10 : null,
      correctCount: showScore ? attempt.correctCount : null,
      totalCount: showScore ? attempt.totalCount : null,
      showAnswers,
      answersReleased: showAnswers,
    };
    if (showAnswers && attempt.gradingProjection) {
      result.perQuestion = attempt.gradingProjection;
    }
  }

  return {
    versionId: version.id,
    title: version.title,
    sections: version.sections,
    passages,
    questions,
    assignment: {
      id: assignment.id,
      openAt: assignment.openAt,
      dueAt: assignment.dueAt,
      timeLimitMinutes: assignment.timeLimitMinutes,
      attemptLimit: assignment.attemptLimit,
      showScore,
      showAnswersAfter: showAnswersPolicy,
    },
    attempt: attempt ? {
      id: attempt.id,
      status: attempt.status,
      startedAt: attempt.startedAt,
      deadlineAt: attempt.deadlineAt,
      submittedAt: attempt.submittedAt,
      answers: attempt.answers || {},
      revision: attempt.answerRevision || 0,
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

export function validateExamAssignmentInput(body, getNow) {
  const now = getNow();
  const openAt = body?.openAt;
  const dueAt = body?.dueAt;
  if (!openAt || !dueAt) return { ok: false, error: 'Cần thời gian mở và hạn nộp.' };
  if (openAt >= dueAt) return { ok: false, error: 'Thời gian mở phải trước hạn nộp.' };
  const timeLimit = Number(body?.timeLimitMinutes);
  if (!Number.isFinite(timeLimit) || timeLimit <= 0) {
    return { ok: false, error: 'Thời gian làm bài phải lớn hơn 0 phút.' };
  }
  const attemptLimit = Number(body?.attemptLimit);
  if (!Number.isFinite(attemptLimit) || attemptLimit < 1) {
    return { ok: false, error: 'Số lần làm phải ít nhất 1.' };
  }
  if (openAt > now && body?.forceOpen) {
    /* allowed */
  }
  return { ok: true };
}

export function computeAttemptDeadline(assignment, startedAtIso) {
  const startMs = new Date(startedAtIso).getTime();
  const limitMs = (assignment.timeLimitMinutes || 60) * 60 * 1000;
  const byDuration = new Date(startMs + limitMs).toISOString();
  const due = assignment.dueAt;
  if (!due) return byDuration;
  return due < byDuration ? due : byDuration;
}

export function parseExamRoute(parts) {
  if (parts[0] !== 'exams') return null;
  if (parts.length === 1) return { view: 'exams-hub' };
  if (parts[1] === 'import') return { view: 'exams-import' };
  if (parts[1] === 'draft' && parts[2]) return { view: 'exams-draft', draftId: parts[2] };
  if (parts[1] === 'assign' && parts[2]) return { view: 'exams-assign', versionId: parts[2] };
  if (parts[1] === 'take' && parts[2]) return { view: 'exams-take', assignmentId: parts[2] };
  if (parts[1] === 'result' && parts[2]) return { view: 'exams-result', assignmentId: parts[2] };
  return { view: 'exams-hub' };
}

export const EXAM_NAV_ITEM = {
  id: 'exams',
  label: 'Bài thi online',
  hash: '#/exams',
  teacher: true,
  student: true,
};
