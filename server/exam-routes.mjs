import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { studentCanAccessAssignmentClass } from '../dist/ba-domain.js';
import {
  EXAM_ATTEMPT_STATUS,
  EXAM_JOB_STATUS,
  validateDraftForPublish,
  publishErrorMessage,
  validateExamAssignmentInput,
  computeAttemptDeadline,
  applyAttemptGrading,
  regradeSubmittedAttemptsForVersion,
  mergeVersionAnswerKeyUpdate,
  mergeVersionTextAnswerKeyUpdate,
  buildConfirmedTextAnswerKeyFromDraftQuestions,
  validateAttemptAnswerPatch,
  validateAttemptAnswersForSubmit,
  mergeManualGradesUpdate,
  buildTeacherGradingAttemptDetail,
  buildTeacherPdfGradingProjection,
  normalizeExamGradingMode,
  EXAM_GRADING_MODE,
  attemptGradingLabel,
  projectExamVersionForStudent,
  buildTeacherPreviewExamProjection,
  effectiveVersionForAssignment,
  normalizeExamAssignmentPurpose,
  examAssignmentTypeBadge,
  isExamHomeworkAssignment,
  validateCreateComposedDraftInput,
  validateComposeQuestionIdsForVersion,
  composeBlankExamDraftContent,
  composeExamDraftFromPublishedVersion,
  composePublishedVersionQuestionSlice,
  summarizeExamItems,
  formatExamHubItemMeta,
  mergeComposedDraftSlices,
  validateAppendComposedQuestionsInput,
  appendComposedSliceToDraftContent,
  examDraftCreateReplayFingerprint,
  buildComposeSourcePickerProjection,
  parseExamMetadataFilters,
  versionQualifiesMetadataFilter,
  captureComposeUndoSnapshot,
  restoreComposeUndoSnapshot,
  validateDraftMediaPatch,
  computeExamMetadataFilterCounts,
  filterExamQuestionsByMetadata,
  EXAM_DELIVERY_MODE,
  normalizeExamDeliveryMode,
  freezeAttemptSubmissionSnapshots,
  EXAM_AUDIO_STATE,
  validateCreatePdfOnlyDraftInput,
  buildPdfOnlyDraftContent,
  composeReviseDraftFromPublishedVersion,
  buildTeacherBankDetailProjection,
  groupTeacherExamBanks,
  resolveBankExamId,
} from '../dist/exam-domain.js';
import {
  findExamAssignment,
  findExamDraft,
  findExamImportJob,
  findExamVersion,
  resolveAttemptExamContext,
  resolveAttemptVersion,
  teacherOwnsExamAttempt,
  teacherOwnsExamDraft,
  teacherOwnsImportJob,
} from './exam-state.mjs';
import {
  createImportJobRecord,
  examContentDigest,
  findExistingImportByDigest,
  scheduleExamImportProcessing,
} from './exam-worker.mjs';
import {
  EXAM_EXTRACT_PARSER_VERSION,
  getPdfPageCount,
  resolveImportQuestionPages,
  parsePhysicalPageRangeInput,
} from './exam-extract.mjs';
import {
  tryHandleUnifiedExamApi,
  initUnifiedAttemptOnStart,
  applyUnifiedAssignmentFields,
  maybeFinalizeUnifiedSubmit,
} from './exam-unified-routes.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PDFJS_VENDOR = {
  pdf: path.join(__dirname, '..', 'node_modules', 'pdfjs-dist', 'legacy', 'build', 'pdf.mjs'),
  worker: path.join(__dirname, '..', 'node_modules', 'pdfjs-dist', 'legacy', 'build', 'pdf.worker.mjs'),
};

export const PDFLIB_VENDOR = {
  esm: path.join(__dirname, '..', 'node_modules', 'pdf-lib', 'dist', 'pdf-lib.esm.min.js'),
  umd: path.join(__dirname, '..', 'node_modules', 'pdf-lib', 'dist', 'pdf-lib.min.js'),
};

function requireTeacher(auth, error, res) {
  if (!auth) {
    error(res, 401, 'Chưa đăng nhập.');
    return false;
  }
  if (auth.role !== 'teacher') {
    error(res, 403, 'Chỉ giáo viên được phép.');
    return false;
  }
  return true;
}

function requireStudent(auth, error, res) {
  if (!auth || auth.role !== 'student') {
    error(res, 403, 'Chỉ học sinh được phép.');
    return false;
  }
  return true;
}

function splitOperationId(body) {
  if (!body || typeof body !== 'object') return { operationId: null, payload: body };
  const operationId = typeof body.operationId === 'string' ? body.operationId : null;
  const payload = { ...body };
  delete payload.operationId;
  return { operationId, payload };
}

function teacherExamDraftProjection(draft) {
  if (!draft) return null;
  return {
    id: draft.id,
    title: draft.title,
    sections: draft.sections,
    passages: draft.passages,
    questions: draft.questions,
    warnings: draft.warnings,
    needsOcr: draft.needsOcr,
    needsOcrPageNumbers: draft.needsOcrPageNumbers || [],
    needsReview: draft.needsReview,
    teacherConfirmedReview: draft.teacherConfirmedReview,
    manuallyEdited: draft.manuallyEdited,
    sourceAttachmentId: draft.sourceAttachmentId,
    importJobId: draft.importJobId,
    gradingMode: normalizeExamGradingMode(draft),
    revision: draft.revision || 0,
    updatedAt: draft.updatedAt,
    composedFromVersionId: draft.composedFromVersionId || null,
    composedSourceExamBindings: draft.composedSourceExamBindings && typeof draft.composedSourceExamBindings === 'object'
      ? draft.composedSourceExamBindings
      : null,
    bankExamId: draft.bankExamId || null,
    explicitPdfOnly: !!draft.explicitPdfOnly,
    sourcePdfPageCount: draft.sourcePdfPageCount || null,
    publishedFromVersionId: draft.publishedFromVersionId || null,
    audioAttachmentId: draft.audioAttachmentId || null,
    audioState: draft.audioState || null,
    mediaRevision: draft.mediaRevision || 0,
    mediaBindings: draft.mediaBindings || null,
  };
}

function teacherExamListSnapshot(state, teacherAccountId) {
  return {
    banks: groupTeacherExamBanks(state, teacherAccountId),
    imports: (state.examImports || [])
      .filter((j) => j.teacherAccountId === teacherAccountId)
      .map((j) => ({
        id: j.id,
        status: j.status,
        progress: j.progress,
        draftId: j.draftId,
        needsOcr: j.needsOcr,
        error: j.error,
        updatedAt: j.updatedAt,
      })),
    drafts: (state.examDrafts || [])
      .filter((d) => d.teacherAccountId === teacherAccountId)
      .map((d) => {
        const itemSummary = summarizeExamItems(d);
        return {
          id: d.id,
          title: d.title,
          needsOcr: d.needsOcr,
          needsReview: d.needsReview,
          questionCount: itemSummary.questionCount,
          numberedQuestions: itemSummary.numberedQuestions,
          unnumberedActivities: itemSummary.unnumberedActivities,
          itemSummary: formatExamHubItemMeta(itemSummary),
          updatedAt: d.updatedAt,
        };
      }),
    versions: (state.examVersions || [])
      .filter((v) => v.teacherAccountId === teacherAccountId)
      .map((v) => {
        const itemSummary = summarizeExamItems(v);
        return {
          id: v.id,
          bankExamId: resolveBankExamId(v),
          title: v.title,
          publishedAt: v.publishedAt,
          sourceAttachmentId: v.sourceAttachmentId || null,
          sourcePdfPageCount: v.sourcePdfPageCount || null,
          pdfOnly: !!(v.pdfOnly || !(v.questions || []).length),
          questionCount: itemSummary.questionCount,
          numberedQuestions: itemSummary.numberedQuestions,
          unnumberedActivities: itemSummary.unnumberedActivities,
          itemSummary: formatExamHubItemMeta(itemSummary),
        };
      }),
    assignments: (state.examAssignments || [])
      .filter((a) => a.teacherAccountId === teacherAccountId)
      .map((a) => ({
        id: a.id,
        versionId: a.versionId,
        classId: a.classId,
        openAt: a.openAt,
        dueAt: a.dueAt,
        title: a.title,
        purpose: normalizeExamAssignmentPurpose(a.purpose),
        timeLimitMinutes: a.timeLimitMinutes ?? null,
        selectedQuestionIds: Array.isArray(a.selectedQuestionIds) ? a.selectedQuestionIds : undefined,
        deliveryMode: a.deliveryMode || EXAM_DELIVERY_MODE.ONLINE,
        pdfPartPoints: a.pdfPartPoints ?? null,
        onlinePartPoints: a.onlinePartPoints ?? null,
      })),
  };
}

function buildExamSubmitClientResponse(assignment, attempt, { reused = false } = {}) {
  const showScore = assignment.showScore !== false;
  const payload = { ok: true };
  if (reused) payload.reused = true;
  if (attempt.gradingStatus) payload.gradingStatus = attempt.gradingStatus;
  const label = attemptGradingLabel(attempt.gradingStatus);
  if (label) payload.gradingLabel = label;
  if (showScore && attempt.score10 != null) {
    payload.score10 = attempt.score10;
    payload.correctCount = attempt.correctCount;
    payload.totalCount = attempt.totalCount;
  }
  return payload;
}

function teacherExamAttemptSummaryRow(attempt) {
  const label = attemptGradingLabel(attempt.gradingStatus);
  return {
    attemptId: attempt.id,
    studentId: attempt.studentId,
    status: attempt.status,
    gradingStatus: attempt.gradingStatus || null,
    gradingLabel: label,
    score10: attempt.score10,
    correctCount: attempt.correctCount,
    totalCount: attempt.totalCount,
    submittedAt: attempt.submittedAt,
  };
}

function studentExamAssignmentStatus(state, assignment, studentId, now) {
  const attempts = (state.examAttempts || []).filter(
    (at) => at.assignmentId === assignment.id && at.studentId === studentId,
  );
  const active = attempts.find((a) => a.status === EXAM_ATTEMPT_STATUS.IN_PROGRESS);
  if (active) return 'in-progress';
  const submitted = attempts
    .filter((a) => a.status === EXAM_ATTEMPT_STATUS.SUBMITTED || a.status === EXAM_ATTEMPT_STATUS.EXPIRED)
    .sort((a, b) => (b.submittedAt || b.startedAt || '').localeCompare(a.submittedAt || a.startedAt || ''))[0];
  if (submitted) return 'submitted';
  if (assignment.dueAt && now >= assignment.dueAt) return 'past-due';
  if (assignment.openAt && now < assignment.openAt) return 'not-open';
  return 'not-started';
}

function studentExamAssignments(state, student, getNow) {
  const now = getNow();
  return (state.examAssignments || []).filter((a) => {
    const st = student;
    if (!st) return false;
    return studentCanAccessAssignmentClass(st, a.classId, state.memberships || [], now);
  }).map((a) => ({
    id: a.id,
    title: a.title,
    openAt: a.openAt,
    dueAt: a.dueAt,
    versionId: a.versionId,
    attemptLimit: a.attemptLimit,
    purpose: normalizeExamAssignmentPurpose(a.purpose),
    typeLabel: examAssignmentTypeBadge(a),
    deliveryMode: normalizeExamDeliveryMode(a),
    status: studentExamAssignmentStatus(state, a, student?.id, now),
  }));
}

function countStudentAttempts(state, assignmentId, studentId) {
  return (state.examAttempts || []).filter(
    (at) => at.assignmentId === assignmentId && at.studentId === studentId && at.status !== EXAM_ATTEMPT_STATUS.IN_PROGRESS,
  ).length;
}

function activeAttempt(state, assignmentId, studentId) {
  return (state.examAttempts || []).find(
    (at) => at.assignmentId === assignmentId
      && at.studentId === studentId
      && at.status === EXAM_ATTEMPT_STATUS.IN_PROGRESS,
  ) || null;
}

export function tryServePdfJsVendor(pathname, req, res, error) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  if (pathname === '/vendor/pdfjs/pdf.mjs') {
    return sendVendorFile(PDFJS_VENDOR.pdf, 'text/javascript; charset=utf-8', req, res, error);
  }
  if (pathname === '/vendor/pdfjs/pdf.worker.mjs') {
    return sendVendorFile(PDFJS_VENDOR.worker, 'text/javascript; charset=utf-8', req, res, error);
  }
  if (pathname === '/vendor/pdf-lib/pdf-lib.esm.min.js') {
    return sendVendorFile(PDFLIB_VENDOR.esm, 'text/javascript; charset=utf-8', req, res, error);
  }
  if (pathname === '/vendor/pdf-lib/pdf-lib.min.js') {
    return sendVendorFile(PDFLIB_VENDOR.umd, 'text/javascript; charset=utf-8', req, res, error);
  }
  return false;
}

function sendVendorFile(filePath, mime, req, res, error) {
  if (!fs.existsSync(filePath)) {
    error(res, 404, 'Không tìm thấy thư viện PDF.');
    return true;
  }
  const data = fs.readFileSync(filePath);
  res.writeHead(200, {
    'Content-Type': mime,
    'Cache-Control': 'public, max-age=3600',
  });
  if (req.method === 'HEAD') res.end();
  else res.end(data);
  return true;
}

/**
 * @returns {Promise<boolean>}
 */
export async function tryHandleExamApi(ctx) {
  const {
    req, res, pathname, auth, store, hostHeader, cookies,
    readJsonBody, error, json, runWithReplay, assertMutationHeaders,
    loadLiveAuth, withCommitAuth, getNow, state,
  } = ctx;

  if (pathname === '/api/student/exams/server-now' && req.method === 'GET') {
    if (!auth) { error(res, 401, 'Chưa đăng nhập.'); return true; }
    json(res, 200, { ok: true, now: getNow() });
    return true;
  }

  if (pathname.startsWith('/api/teacher/exams')) {
    if (!requireTeacher(auth, error, res)) return true;
    if (await tryHandleUnifiedExamApi(ctx)) return true;
    return handleTeacherExamApi(ctx);
  }

  if (pathname.startsWith('/api/student/exams')) {
    if (!requireStudent(auth, error, res)) return true;
    if (await tryHandleUnifiedExamApi(ctx)) return true;
    return handleStudentExamApi(ctx);
  }

  return false;
}

async function handleTeacherExamApi(ctx) {
  const {
    req, res, pathname, auth, store,
    readJsonBody, error, json, runWithReplay, assertMutationHeaders,
    withCommitAuth, getNow,
  } = ctx;

  if (pathname === '/api/teacher/exams/summary' && req.method === 'GET') {
    const state = await store.read();
    const q = new URL(req.url || '/', 'http://localhost').searchParams;
    const filters = parseExamMetadataFilters(q);
    const snap = teacherExamListSnapshot(state, auth.account.id);
    const wantFilter = (filters.skills?.length || 0) > 0 || (filters.types?.length || 0) > 0;
    if (wantFilter) {
      const versionsFull = (state.examVersions || []).filter((v) => v.teacherAccountId === auth.account.id);
      const qualifiedVersionIds = new Set(
        versionsFull.filter((v) => versionQualifiesMetadataFilter(v, filters)).map((v) => v.id),
      );
      snap.versions = (snap.versions || []).filter((v) => qualifiedVersionIds.has(v.id));
      snap.banks = (snap.banks || []).filter((b) => {
        const bankVersions = versionsFull.filter(
          (v) => resolveBankExamId(v) === b.bankExamId && qualifiedVersionIds.has(v.id),
        );
        return bankVersions.length > 0;
      });
      let matchingQuestions = 0;
      let unclassifiedCount = 0;
      for (const vid of qualifiedVersionIds) {
        const v = findExamVersion(state, vid);
        if (!v) continue;
        matchingQuestions += filterExamQuestionsByMetadata(v.questions || [], filters).length;
        unclassifiedCount += computeExamMetadataFilterCounts(v.questions || []).unclassified;
      }
      snap.filterQualification = {
        applied: filters,
        matchingVersionCount: qualifiedVersionIds.size,
        matchingQuestionCount: matchingQuestions,
        unclassifiedCount,
      };
    }
    json(res, 200, { ok: true, ...snap });
    return true;
  }

  if (pathname === '/api/teacher/exams/editable-drafts' && req.method === 'GET') {
    const state = await store.read();
    const q = new URL(req.url || '/', 'http://localhost').searchParams;
    const needle = String(q.get('q') || '').trim().toLowerCase();
    const rows = (state.examDrafts || [])
      .filter((d) => d.teacherAccountId === auth.account.id && !d.publishedVersionId)
      .filter((d) => !needle || String(d.title || '').toLowerCase().includes(needle))
      .map((d) => ({
        id: d.id,
        title: d.title,
        bankExamId: d.bankExamId || null,
        questionCount: (d.questions || []).length,
        revision: d.revision || 0,
        updatedAt: d.updatedAt,
      }))
      .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
    json(res, 200, { ok: true, drafts: rows });
    return true;
  }

  const bankDetailMatch = pathname.match(/^\/api\/teacher\/exams\/banks\/([^/]+)$/);
  if (bankDetailMatch && req.method === 'GET') {
    const state = await store.read();
    const bank = buildTeacherBankDetailProjection(state, bankDetailMatch[1], auth.account.id);
    if (!bank.versions.length && !bank.drafts.length) {
      error(res, 404, 'Không tìm thấy.');
      return true;
    }
    json(res, 200, { ok: true, bank });
    return true;
  }

  if (pathname === '/api/teacher/exams/pdf-only-drafts' && req.method === 'POST') {
    if (!assertMutationHeaders(req, ctx.hostHeader, ctx.cookies.bn_csrf, req.headers['x-bn-csrf'])) {
      error(res, 403, 'Yêu cầu không hợp lệ.');
      return true;
    }
    const bodyRaw = await readJsonBody(req);
    const { operationId, payload: body } = splitOperationId(bodyRaw);
    const inputCheck = validateCreatePdfOnlyDraftInput(body);
    if (!inputCheck.ok) {
      error(res, 400, inputCheck.error);
      return true;
    }
    const buf = await store.readAttachment(inputCheck.sourceAttachmentId);
    if (!buf) {
      error(res, 400, 'Tệp không tồn tại.');
      return true;
    }
    const meta = (await store.read()).attachmentMeta?.[inputCheck.sourceAttachmentId];
    if (!meta || meta.ownerAccountId !== auth.account.id) {
      error(res, 403, 'Không có quyền với tệp này.');
      return true;
    }
    let numPages;
    try {
      numPages = await getPdfPageCount(buf);
    } catch (_) {
      error(res, 400, 'PDF không hợp lệ hoặc quá dài.');
      return true;
    }
    const needsOcr = !!body?.needsOcr;
    const replayOut = await runWithReplay(store, auth, 'exam.pdfOnlyDraft.create', operationId, {
      sourceAttachmentId: inputCheck.sourceAttachmentId,
    }, (s) => {
      const draftId = randomUUID();
      const content = buildPdfOnlyDraftContent({
        title: inputCheck.title,
        sourceAttachmentId: inputCheck.sourceAttachmentId,
        sourcePdfPageCount: numPages,
        needsOcr,
        needsOcrPageNumbers: Array.isArray(body?.needsOcrPageNumbers) ? body.needsOcrPageNumbers : [],
      });
      const draft = {
        id: draftId,
        teacherAccountId: auth.account.id,
        bankExamId: draftId,
        importJobId: null,
        revision: 0,
        updatedAt: getNow(),
        ...content,
      };
      const attMeta = s.attachmentMeta?.[inputCheck.sourceAttachmentId];
      if (attMeta) attMeta.examSource = true;
      s.examDrafts.push(draft);
      return {
        client: { ok: true, draftId, draft: teacherExamDraftProjection(draft), bankExamId: draft.bankExamId },
        stored: { ok: true, draftId, bankExamId: draft.bankExamId },
      };
    });
    if (!replayOut.ok) {
      error(res, replayOut.status, replayOut.error);
      return true;
    }
    json(res, 200, replayOut.result);
    return true;
  }

  const reviseMatch = pathname.match(/^\/api\/teacher\/exams\/versions\/([^/]+)\/revise$/);
  if (reviseMatch && req.method === 'POST') {
    if (!assertMutationHeaders(req, ctx.hostHeader, ctx.cookies.bn_csrf, req.headers['x-bn-csrf'])) {
      error(res, 403, 'Yêu cầu không hợp lệ.');
      return true;
    }
    const bodyRaw = await readJsonBody(req);
    const { operationId } = splitOperationId(bodyRaw);
    const pre = await store.read();
    const versionPre = findExamVersion(pre, reviseMatch[1]);
    if (!versionPre || versionPre.teacherAccountId !== auth.account.id) {
      error(res, 404, 'Không tìm thấy phiên bản đề.');
      return true;
    }
    const replayOut = await runWithReplay(store, auth, 'exam.version.revise', operationId, {
      versionId: reviseMatch[1],
    }, (s) => {
      const version = findExamVersion(s, reviseMatch[1]);
      if (!version || version.teacherAccountId !== auth.account.id) throw new Error('missing');
      const draftId = randomUUID();
      const draft = {
        id: draftId,
        teacherAccountId: auth.account.id,
        bankExamId: resolveBankExamId(version),
        importJobId: null,
        revision: 0,
        updatedAt: getNow(),
        ...composeReviseDraftFromPublishedVersion(version),
      };
      s.examDrafts.push(draft);
      return {
        client: { ok: true, draftId, bankExamId: draft.bankExamId, draft: teacherExamDraftProjection(draft) },
        stored: { ok: true, draftId, bankExamId: draft.bankExamId },
      };
    });
    if (!replayOut.ok) {
      error(res, replayOut.status, replayOut.error);
      return true;
    }
    json(res, 200, replayOut.result);
    return true;
  }

  if (pathname === '/api/teacher/exams/imports' && req.method === 'POST') {
    if (!assertMutationHeaders(req, ctx.hostHeader, ctx.cookies.bn_csrf, req.headers['x-bn-csrf'])) {
      error(res, 403, 'Yêu cầu không hợp lệ.');
      return true;
    }
    const bodyRaw = await readJsonBody(req);
    const { payload: body } = splitOperationId(bodyRaw);
    const attachmentId = body?.sourceAttachmentId;
    if (!attachmentId) { error(res, 400, 'Thiếu tệp PDF.'); return true; }
    const buf = await store.readAttachment(attachmentId);
    if (!buf) { error(res, 400, 'Tệp không tồn tại.'); return true; }
    const meta = (await store.read()).attachmentMeta?.[attachmentId];
    if (!meta || meta.ownerAccountId !== auth.account.id) {
      error(res, 403, 'Không có quyền với tệp này.');
      return true;
    }
    const keyPagesRaw = Array.isArray(body?.keyPages) ? body.keyPages : null;
    const keyPageRange = body?.keyPageRange;
    let keyPages = [];
    let numPages;
    try {
      numPages = await getPdfPageCount(buf);
    } catch (_) {
      error(res, 400, 'PDF không hợp lệ hoặc quá dài.');
      return true;
    }
    if (keyPagesRaw?.length) {
      keyPages = keyPagesRaw.map(Number);
    } else if (keyPageRange != null && String(keyPageRange).trim()) {
      try {
        keyPages = parsePhysicalPageRangeInput(keyPageRange, numPages);
      } catch (_) {
        error(res, 400, 'Trang đáp án không hợp lệ.');
        return true;
      }
    }
    let questionPages;
    try {
      questionPages = resolveImportQuestionPages({
        numPages,
        questionPages: Array.isArray(body?.questionPages) && body.questionPages.length
          ? body.questionPages
          : null,
        questionPageRange: body?.questionPageRange,
        allPages: Array.isArray(body?.allPages) && body.allPages.length ? body.allPages : null,
        keyPages,
      });
    } catch (e) {
      const msg = String(e?.message || '');
      if (msg === 'page-overlap') {
        error(res, 400, 'Trang câu hỏi và trang đáp án không được trùng nhau.');
        return true;
      }
      if (msg === 'no-question-pages') {
        error(res, 400, 'Chưa chọn trang câu hỏi (hoặc mọi trang đều là trang đáp án).');
        return true;
      }
      error(res, 400, 'Phạm vi trang không hợp lệ.');
      return true;
    }
    const allPages = questionPages;
    const digest = examContentDigest(buf, {
      questionPages,
      keyPages,
      parserVersion: EXAM_EXTRACT_PARSER_VERSION,
    });
    const makeCopy = !!body?.makeCopy;
    const existing = !makeCopy
      ? findExistingImportByDigest(await store.read(), auth.account.id, digest, allPages, keyPages)
      : null;
    if (existing?.draftId) {
      json(res, 200, { ok: true, jobId: existing.id, draftId: existing.draftId, reused: true });
      return true;
    }
    let jobId;
    await store.mutate(withCommitAuth(auth, (s) => {
      const metaLive = s.attachmentMeta?.[attachmentId];
      if (!metaLive || metaLive.ownerAccountId !== auth.account.id) throw new Error('forbidden');
      metaLive.examSource = true;
      const job = createImportJobRecord({
        teacherAccountId: auth.account.id,
        sourceAttachmentId: attachmentId,
        contentDigest: digest,
        questionPages: allPages,
        keyPages,
        allPages,
        titleHint: body?.title || null,
        getNow,
      });
      s.examImports.push(job);
      jobId = job.id;
    }));
    scheduleExamImportProcessing(store, jobId, getNow);
    json(res, 200, { ok: true, jobId, reused: false });
    return true;
  }

  const importMatch = pathname.match(/^\/api\/teacher\/exams\/imports\/([^/]+)$/);
  if (importMatch && req.method === 'GET') {
    const state = await store.read();
    const job = findExamImportJob(state, importMatch[1]);
    if (!teacherOwnsImportJob(job, auth.account.id)) {
      error(res, 404, 'Không tìm thấy.');
      return true;
    }
    json(res, 200, { ok: true, job });
    return true;
  }

  if (importMatch && req.method === 'POST' && pathname.endsWith('/cancel')) {
    /* handled below */
  }

  const cancelMatch = pathname.match(/^\/api\/teacher\/exams\/imports\/([^/]+)\/cancel$/);
  if (cancelMatch && req.method === 'POST') {
    if (!assertMutationHeaders(req, ctx.hostHeader, ctx.cookies.bn_csrf, req.headers['x-bn-csrf'])) {
      error(res, 403, 'Yêu cầu không hợp lệ.');
      return true;
    }
    await store.mutate(withCommitAuth(auth, (s) => {
      const job = findExamImportJob(s, cancelMatch[1]);
      if (!teacherOwnsImportJob(job, auth.account.id)) throw new Error('missing');
      job.status = EXAM_JOB_STATUS.CANCELLED;
      job.updatedAt = getNow();
    }));
    json(res, 200, { ok: true });
    return true;
  }

  const composeSourceMatch = pathname.match(/^\/api\/teacher\/exams\/versions\/([^/]+)\/compose-source$/);
  if (composeSourceMatch && req.method === 'GET') {
    const state = await store.read();
    const version = findExamVersion(state, composeSourceMatch[1]);
    if (!version || version.teacherAccountId !== auth.account.id) {
      error(res, 404, 'Không tìm thấy.');
      return true;
    }
    const q = new URL(req.url || '/', 'http://localhost').searchParams;
    const filters = parseExamMetadataFilters(q);
    json(res, 200, {
      ok: true,
      source: buildComposeSourcePickerProjection(version, filters),
      filterQualification: {
        applied: filters,
        matchingQuestionCount: buildComposeSourcePickerProjection(version, filters).questionCount,
        totalQuestionCount: (version.questions || []).length,
      },
    });
    return true;
  }

  if (pathname === '/api/teacher/exams/drafts' && req.method === 'POST') {
    if (!assertMutationHeaders(req, ctx.hostHeader, ctx.cookies.bn_csrf, req.headers['x-bn-csrf'])) {
      error(res, 403, 'Yêu cầu không hợp lệ.');
      return true;
    }
    const bodyRaw = await readJsonBody(req);
    const { operationId, payload: body } = splitOperationId(bodyRaw);
    const inputCheck = validateCreateComposedDraftInput(body);
    if (!inputCheck.ok) {
      error(res, 400, inputCheck.error);
      return true;
    }
    if (inputCheck.mode === 'from-source') {
      const pre = await store.read();
      const versionPre = findExamVersion(pre, inputCheck.sourceVersionId);
      if (!versionPre || versionPre.teacherAccountId !== auth.account.id) {
        error(res, 404, 'Không tìm thấy nguồn đề.');
        return true;
      }
      const qCheck = validateComposeQuestionIdsForVersion(versionPre, inputCheck.questionIds);
      if (!qCheck.ok) {
        error(res, 400, qCheck.error);
        return true;
      }
    }
    if (inputCheck.mode === 'multi-source') {
      const pre = await store.read();
      for (const row of inputCheck.sources) {
        const v = findExamVersion(pre, row.sourceVersionId);
        if (!v || v.teacherAccountId !== auth.account.id) {
          error(res, 404, 'Không tìm thấy một trong các đề nguồn.');
          return true;
        }
        const qc = validateComposeQuestionIdsForVersion(v, row.questionIds);
        if (!qc.ok) {
          error(res, 400, qc.error);
          return true;
        }
      }
    }
    const replayOut = await runWithReplay(store, auth, 'exam.draft.create', operationId, examDraftCreateReplayFingerprint(inputCheck, body), (s) => {
      let content;
      if (inputCheck.mode === 'blank') {
        content = composeBlankExamDraftContent(body?.title);
      } else if (inputCheck.mode === 'multi-source') {
        const slices = [];
        for (const row of inputCheck.sources) {
          const version = findExamVersion(s, row.sourceVersionId);
          if (!version || version.teacherAccountId !== auth.account.id) throw new Error('missing');
          slices.push(composePublishedVersionQuestionSlice(version, row.questionIds));
        }
        content = mergeComposedDraftSlices(slices, { title: body?.title });
      } else {
        const version = findExamVersion(s, inputCheck.sourceVersionId);
        if (!version || version.teacherAccountId !== auth.account.id) throw new Error('missing');
        content = composeExamDraftFromPublishedVersion(version, {
          selectedQuestionIds: inputCheck.questionIds,
          title: body?.title,
        });
      }
      const draftId = randomUUID();
      let bankExamId = draftId;
      if (inputCheck.mode === 'from-source') {
        const src = findExamVersion(s, inputCheck.sourceVersionId);
        if (src) bankExamId = resolveBankExamId(src);
      } else if (inputCheck.mode === 'multi-source') {
        bankExamId = randomUUID();
      }
      const draft = {
        id: draftId,
        teacherAccountId: auth.account.id,
        bankExamId,
        ...content,
        importJobId: null,
        revision: 0,
        updatedAt: getNow(),
      };
      s.examDrafts.push(draft);
      return {
        client: { ok: true, draftId, draft: teacherExamDraftProjection(draft) },
        stored: { ok: true, draftId },
      };
    });
    if (!replayOut.ok) {
      error(res, replayOut.status, replayOut.error);
      return true;
    }
    json(res, 200, replayOut.result);
    return true;
  }

  const composeAppendMatch = pathname.match(/^\/api\/teacher\/exams\/drafts\/([^/]+)\/compose-append$/);
  if (composeAppendMatch && req.method === 'POST') {
    if (!assertMutationHeaders(req, ctx.hostHeader, ctx.cookies.bn_csrf, req.headers['x-bn-csrf'])) {
      error(res, 403, 'Yêu cầu không hợp lệ.');
      return true;
    }
    const bodyRaw = await readJsonBody(req);
    const { operationId, payload: body } = splitOperationId(bodyRaw);
    const inputCheck = validateAppendComposedQuestionsInput(body);
    if (!inputCheck.ok) {
      error(res, 400, inputCheck.error);
      return true;
    }
    const pre = await store.read();
    const versionPre = findExamVersion(pre, inputCheck.sourceVersionId);
    if (!versionPre || versionPre.teacherAccountId !== auth.account.id) {
      error(res, 404, 'Không tìm thấy đề nguồn.');
      return true;
    }
    const qCheck = validateComposeQuestionIdsForVersion(versionPre, inputCheck.questionIds);
    if (!qCheck.ok) {
      error(res, 400, qCheck.error);
      return true;
    }
    const replayOut = await runWithReplay(
      store,
      auth,
      'exam.draft.composeAppend',
      operationId,
      { draftId: composeAppendMatch[1], sourceVersionId: inputCheck.sourceVersionId, questionIds: [...inputCheck.questionIds] },
      (s) => {
        const draft = findExamDraft(s, composeAppendMatch[1]);
        if (!teacherOwnsExamDraft(draft, auth.account.id)) throw new Error('missing');
        const version = findExamVersion(s, inputCheck.sourceVersionId);
        if (!version || version.teacherAccountId !== auth.account.id) throw new Error('missing');
        const undoSnapshot = captureComposeUndoSnapshot(draft);
        const stats = appendComposedSliceToDraftContent(draft, version, inputCheck.questionIds);
        draft.manuallyEdited = true;
        draft.revision = (draft.revision || 0) + 1;
        draft.updatedAt = getNow();
        if (stats.addedCount > 0) {
          draft.pendingComposeUndo = {
            expectedRevision: draft.revision,
            addedCount: stats.addedCount,
            skippedDuplicateSourceQuestions: stats.skippedDuplicateSourceQuestions,
            snapshot: undoSnapshot,
          };
        } else {
          draft.pendingComposeUndo = null;
        }
        return {
          client: {
            ok: true,
            draft: teacherExamDraftProjection(draft),
            revision: draft.revision,
            addedCount: stats.addedCount,
            skippedDuplicateSourceQuestions: stats.skippedDuplicateSourceQuestions,
            undoAvailable: !!(draft.pendingComposeUndo && stats.addedCount > 0),
          },
          stored: { ok: true, revision: draft.revision },
        };
      },
    );
    if (!replayOut.ok) {
      error(res, replayOut.status, replayOut.error);
      return true;
    }
    json(res, 200, replayOut.result);
    return true;
  }

  const composeUndoMatch = pathname.match(/^\/api\/teacher\/exams\/drafts\/([^/]+)\/compose-undo$/);
  if (composeUndoMatch && req.method === 'POST') {
    if (!assertMutationHeaders(req, ctx.hostHeader, ctx.cookies.bn_csrf, req.headers['x-bn-csrf'])) {
      error(res, 403, 'Yêu cầu không hợp lệ.');
      return true;
    }
    const bodyRaw = await readJsonBody(req);
    const { operationId, payload: body } = splitOperationId(bodyRaw);
    const baseRevision = Number(body?.baseRevision);
    if (!Number.isFinite(baseRevision)) {
      error(res, 400, 'Thiếu revision.');
      return true;
    }
    const replayOut = await runWithReplay(
      store,
      auth,
      'exam.draft.composeUndo',
      operationId,
      { draftId: composeUndoMatch[1], baseRevision },
      (s) => {
        const draft = findExamDraft(s, composeUndoMatch[1]);
        if (!teacherOwnsExamDraft(draft, auth.account.id)) throw new Error('missing');
        const pending = draft.pendingComposeUndo;
        if (!pending?.snapshot) throw new Error('no-undo');
        if (draft.revision !== pending.expectedRevision || baseRevision !== pending.expectedRevision) {
          throw new Error('stale-undo');
        }
        restoreComposeUndoSnapshot(draft, pending.snapshot);
        draft.pendingComposeUndo = null;
        draft.revision = (draft.revision || 0) + 1;
        draft.updatedAt = getNow();
        return {
          client: {
            ok: true,
            draft: teacherExamDraftProjection(draft),
            revision: draft.revision,
          },
          stored: { ok: true, revision: draft.revision },
        };
      },
    );
    if (!replayOut.ok) {
      if (String(replayOut.error || '').includes('stale-undo') || String(replayOut.error || '').includes('no-undo')) {
        error(res, 409, 'Không thể hoàn tác — bản nháp đã chỉnh sửa sau lần thêm câu.');
        return true;
      }
      error(res, replayOut.status, replayOut.error);
      return true;
    }
    json(res, 200, replayOut.result);
    return true;
  }

  const draftMatch = pathname.match(/^\/api\/teacher\/exams\/drafts\/([^/]+)$/);
  const sourceMatch = pathname.match(/^\/api\/teacher\/exams\/drafts\/([^/]+)\/source$/);
  if (sourceMatch && req.method === 'GET') {
    const state = await store.read();
    const draft = findExamDraft(state, sourceMatch[1]);
    if (!teacherOwnsExamDraft(draft, auth.account.id)) {
      error(res, 404, 'Không tìm thấy.');
      return true;
    }
    const q = new URL(req.url || '/', 'http://localhost').searchParams;
    const boundVid = q.get('sourceVersionId');
    if (boundVid && draft.composedSourceExamBindings?.[boundVid]?.sourceAttachmentId) {
      const attId = draft.composedSourceExamBindings[boundVid].sourceAttachmentId;
      const pdfBufBound = await store.readAttachment(attId);
      if (!pdfBufBound) {
        error(res, 404, 'Không tìm thấy PDF gốc.');
        return true;
      }
      res.writeHead(200, {
        'Content-Type': 'application/pdf',
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(pdfBufBound);
      return true;
    }
    const pdfBuf = await store.readAttachment(draft.sourceAttachmentId);
    if (!pdfBuf) {
      error(res, 404, 'Không tìm thấy PDF gốc.');
      return true;
    }
    res.writeHead(200, {
      'Content-Type': 'application/pdf',
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    if (req.method === 'HEAD') res.end();
    else res.end(pdfBuf);
    return true;
  }

  if (draftMatch && req.method === 'GET') {
    const state = await store.read();
    const draft = findExamDraft(state, draftMatch[1]);
    if (!teacherOwnsExamDraft(draft, auth.account.id)) {
      error(res, 404, 'Không tìm thấy.');
      return true;
    }
    json(res, 200, { ok: true, draft: teacherExamDraftProjection(draft) });
    return true;
  }

  if (draftMatch && req.method === 'PUT') {
    if (!assertMutationHeaders(req, ctx.hostHeader, ctx.cookies.bn_csrf, req.headers['x-bn-csrf'])) {
      error(res, 403, 'Yêu cầu không hợp lệ.');
      return true;
    }
    const bodyRaw = await readJsonBody(req);
    const { operationId, payload: body } = splitOperationId(bodyRaw);
    const pre = await store.read();
    const preDraft = findExamDraft(pre, draftMatch[1]);
    if (!teacherOwnsExamDraft(preDraft, auth.account.id)) {
      error(res, 404, 'Không tìm thấy.');
      return true;
    }
    let validatedPageCount = null;
    if (body?.sourceAttachmentId) {
      const attId = String(body.sourceAttachmentId);
      const meta = pre.attachmentMeta?.[attId];
      if (!meta || meta.ownerAccountId !== auth.account.id) {
        error(res, 403, 'Không có quyền với tệp này.');
        return true;
      }
      const buf = await store.readAttachment(attId);
      if (!buf) {
        error(res, 400, 'Tệp không tồn tại.');
        return true;
      }
      try {
        validatedPageCount = await getPdfPageCount(buf);
      } catch (_) {
        error(res, 400, 'PDF không hợp lệ hoặc quá dài.');
        return true;
      }
    }
    let conflictRevision = false;
    const replayOut = await runWithReplay(store, auth, 'exam.draft.put', operationId, {
      draftId: draftMatch[1],
      revision: body?.baseRevision,
    }, (s) => {
      const draft = findExamDraft(s, draftMatch[1]);
      if (!teacherOwnsExamDraft(draft, auth.account.id)) throw new Error('missing');
      if (body?.baseRevision != null && draft.revision != null && body.baseRevision !== draft.revision) {
        conflictRevision = true;
        return { client: null, stored: null };
      }
      if (body?.title != null) draft.title = String(body.title).slice(0, 200);
      if (body?.questions) draft.questions = body.questions;
      if (body?.passages) draft.passages = body.passages;
      if (body?.sections) draft.sections = body.sections;
      if (body?.sourceAttachmentId) {
        draft.sourceAttachmentId = String(body.sourceAttachmentId);
        if (validatedPageCount != null) draft.sourcePdfPageCount = validatedPageCount;
      } else if (body?.sourcePdfPageCount != null) {
        draft.sourcePdfPageCount = Number(body.sourcePdfPageCount);
      }
      if (body?.teacherConfirmedReview != null) {
        draft.teacherConfirmedReview = !!body.teacherConfirmedReview;
      }
      if (body?.gradingMode != null) {
        const gm = String(body.gradingMode);
        if (gm === EXAM_GRADING_MODE.AUTOMATIC || gm === EXAM_GRADING_MODE.TEACHER_MANUAL_LATER) {
          draft.gradingMode = gm;
        }
      }
      draft.manuallyEdited = true;
      draft.revision = (draft.revision || 0) + 1;
      draft.updatedAt = getNow();
      return {
        client: { ok: true, draft: teacherExamDraftProjection(draft), revision: draft.revision },
        stored: { ok: true, revision: draft.revision },
      };
    });
    if (conflictRevision) {
      error(res, 409, 'Bản nháp đã thay đổi — tải lại trang.');
      return true;
    }
    if (!replayOut.ok) {
      error(res, replayOut.status, replayOut.error);
      return true;
    }
    json(res, 200, replayOut.result);
    return true;
  }

  const publishMatch = pathname.match(/^\/api\/teacher\/exams\/drafts\/([^/]+)\/publish$/);
  if (publishMatch && req.method === 'POST') {
    if (!assertMutationHeaders(req, ctx.hostHeader, ctx.cookies.bn_csrf, req.headers['x-bn-csrf'])) {
      error(res, 403, 'Yêu cầu không hợp lệ.');
      return true;
    }
    const pre = await store.read();
    const preDraft = findExamDraft(pre, publishMatch[1]);
    if (!teacherOwnsExamDraft(preDraft, auth.account.id)) {
      error(res, 404, 'Không tìm thấy.');
      return true;
    }
    const vcheck = validateDraftForPublish(preDraft);
    if (!vcheck.ok) {
      error(res, 400, publishErrorMessage(vcheck.errors[0]));
      return true;
    }
    const bodyRaw = await readJsonBody(req);
    const { operationId } = splitOperationId(bodyRaw);
    const replayOut = await runWithReplay(store, auth, 'exam.draft.publish', operationId, {
      draftId: publishMatch[1],
    }, (s) => {
      const draft = findExamDraft(s, publishMatch[1]);
      if (!teacherOwnsExamDraft(draft, auth.account.id)) throw new Error('missing');
      const versionId = randomUUID();
      const version = {
        id: versionId,
        draftId: draft.id,
        bankExamId: draft.bankExamId || draft.id,
        teacherAccountId: auth.account.id,
        title: draft.title,
        sections: JSON.parse(JSON.stringify(draft.sections || [])),
        passages: JSON.parse(JSON.stringify(draft.passages || [])),
        questions: JSON.parse(JSON.stringify(draft.questions || [])),
        sourceAttachmentId: draft.sourceAttachmentId,
        publishedAt: getNow(),
        gradingMode: normalizeExamGradingMode(draft),
        confirmedAnswerKey: {},
        confirmedTextAnswerKey: buildConfirmedTextAnswerKeyFromDraftQuestions(draft.questions || []),
        answerKeyRevision: 1,
        textAnswerKeyRevision: 1,
        revision: 1,
        pdfOnly: !!(draft.explicitPdfOnly || draft.pdfOnly),
        explicitPdfOnly: !!draft.explicitPdfOnly,
        sourcePdfPageCount: draft.sourcePdfPageCount || null,
        audioState: draft.audioAttachmentId
          ? (draft.audioState === EXAM_AUDIO_STATE.REMOVED ? EXAM_AUDIO_STATE.PENDING : (draft.audioState || EXAM_AUDIO_STATE.AVAILABLE))
          : (draft.audioState || EXAM_AUDIO_STATE.PENDING),
        mediaRevision: draft.mediaRevision || 0,
        audioAttachmentId: draft.audioAttachmentId || null,
        mediaBindings: draft.mediaBindings ? JSON.parse(JSON.stringify(draft.mediaBindings)) : null,
        classroomPlaybackAllowed: !!draft.classroomPlaybackAllowed,
      };
      s.examVersions.push(version);
      draft.publishedVersionId = versionId;
      draft.updatedAt = getNow();
      return {
        client: { ok: true, versionId },
        stored: { ok: true, versionId },
      };
    });
    if (!replayOut.ok) { error(res, replayOut.status, replayOut.error); return true; }
    json(res, 200, replayOut.result);
    return true;
  }

  if (pathname === '/api/teacher/exams/assignments' && req.method === 'POST') {
    if (!assertMutationHeaders(req, ctx.hostHeader, ctx.cookies.bn_csrf, req.headers['x-bn-csrf'])) {
      error(res, 403, 'Yêu cầu không hợp lệ.');
      return true;
    }
    const bodyRaw = await readJsonBody(req);
    const { operationId, payload: body } = splitOperationId(bodyRaw);
    const pre = await store.read();
    const versionPre = findExamVersion(pre, body?.versionId);
    if (!versionPre || versionPre.teacherAccountId !== auth.account.id) {
      error(res, 404, 'Không tìm thấy phiên bản đề.');
      return true;
    }
    const v = validateExamAssignmentInput(body, getNow, versionPre);
    if (!v.ok) { error(res, 400, v.error); return true; }
    const replayOut = await runWithReplay(store, auth, 'exam.assignment.create', operationId, body, (s) => {
      const version = findExamVersion(s, body.versionId);
      if (!version || version.teacherAccountId !== auth.account.id) throw new Error('missing-version');
      const cls = s.classes.find((c) => c.id === body.classId);
      if (!cls) throw new Error('missing-class');
      const id = randomUUID();
      const row = {
        id,
        teacherAccountId: auth.account.id,
        versionId: version.id,
        classId: body.classId,
        title: body.title || version.title,
        openAt: body.openAt,
        dueAt: body.dueAt,
        purpose: v.purpose,
        timeLimitMinutes: v.timeLimitMinutes,
        attemptLimit: Number(body.attemptLimit),
        showScore: body.showScore !== false,
        showAnswersAfter: body.showAnswersAfter || 'after-due',
        createdAt: getNow(),
      };
      if (v.selectedQuestionIds) row.selectedQuestionIds = v.selectedQuestionIds;
      applyUnifiedAssignmentFields(row, version, v);
      s.examAssignments.push(row);
      return {
        client: { ok: true, assignmentId: id },
        stored: { ok: true, assignmentId: id },
      };
    });
    if (!replayOut.ok) { error(res, replayOut.status, replayOut.error); return true; }
    json(res, 200, replayOut.result);
    return true;
  }

  const assignSummary = pathname.match(/^\/api\/teacher\/exams\/assignments\/([^/]+)\/summary$/);
  if (assignSummary && req.method === 'GET') {
    const state = await store.read();
    const assignment = findExamAssignment(state, assignSummary[1]);
    if (!assignment || assignment.teacherAccountId !== auth.account.id) {
      error(res, 404, 'Không tìm thấy.');
      return true;
    }
    const attempts = (state.examAttempts || []).filter((a) => a.assignmentId === assignment.id);
    const summary = attempts.map((a) => teacherExamAttemptSummaryRow(a));
    json(res, 200, { ok: true, assignment, summary, attemptCount: attempts.length });
    return true;
  }

  const assignGradingMatch = pathname.match(/^\/api\/teacher\/exams\/assignments\/([^/]+)\/grading$/);
  if (assignGradingMatch && req.method === 'GET') {
    const state = await store.read();
    const assignment = findExamAssignment(state, assignGradingMatch[1]);
    if (!assignment || assignment.teacherAccountId !== auth.account.id) {
      error(res, 404, 'Không tìm thấy.');
      return true;
    }
    const version = findExamVersion(state, assignment.versionId);
    if (!version || version.teacherAccountId !== auth.account.id) {
      error(res, 404, 'Không tìm thấy phiên bản.');
      return true;
    }
    const effective = effectiveVersionForAssignment(version, assignment);
    const attempts = (state.examAttempts || [])
      .filter((a) => a.assignmentId === assignment.id && a.status === EXAM_ATTEMPT_STATUS.SUBMITTED);
    const attemptId = new URL(`http://x${req.url || ''}`).searchParams.get('attemptId');
    const focusAttempt = attemptId
      ? attempts.find((a) => a.id === attemptId) || null
      : attempts[0] || null;
    json(res, 200, {
      ok: true,
      assignment: {
        id: assignment.id,
        title: assignment.title,
        versionId: version.id,
        purpose: normalizeExamAssignmentPurpose(assignment.purpose),
      },
      version: {
        id: version.id,
        title: version.title,
        gradingMode: normalizeExamGradingMode(version),
        answerKeyRevision: version.answerKeyRevision || 1,
        confirmedAnswerKey: { ...(version.confirmedAnswerKey || {}) },
        confirmedTextAnswerKey: { ...(version.confirmedTextAnswerKey || {}) },
        answerKeyRevision: version.answerKeyRevision || 1,
        textAnswerKeyRevision: version.textAnswerKeyRevision || 1,
        sections: effective.sections,
        passages: effective.passages,
        questions: effective.questions,
      },
      attempts: attempts.map((a) => teacherExamAttemptSummaryRow(a)),
      focusAttempt: focusAttempt ? {
        id: focusAttempt.id,
        studentId: focusAttempt.studentId,
        answers: { ...(focusAttempt.answers || {}) },
        gradingStatus: focusAttempt.gradingStatus || null,
        gradingRevision: focusAttempt.gradingRevision || 0,
        manualGrades: { ...(focusAttempt.manualGrades || {}) },
        detail: buildTeacherGradingAttemptDetail(version, assignment, focusAttempt),
        pdfGrading: buildTeacherPdfGradingProjection(focusAttempt, assignment, version),
      } : null,
    });
    return true;
  }

  const attemptManualGradesMatch = pathname.match(/^\/api\/teacher\/exams\/attempts\/([^/]+)\/manual-grades$/);
  if (attemptManualGradesMatch && req.method === 'PUT') {
    if (!assertMutationHeaders(req, ctx.hostHeader, ctx.cookies.bn_csrf, req.headers['x-bn-csrf'])) {
      error(res, 403, 'Yêu cầu không hợp lệ.');
      return true;
    }
    const bodyRaw = await readJsonBody(req);
    const { operationId, payload: body } = splitOperationId(bodyRaw);
    const baseRevRaw = body?.baseRevision;
    if (!Number.isInteger(baseRevRaw) || baseRevRaw < 0) {
      error(res, 400, 'Thiếu hoặc sai phiên bản chấm điểm.');
      return true;
    }
    let conflictRevision = false;
    let mergeFail = null;
    let notFound = false;
    let notSubmitted = false;
    let forbidden = false;
    let replayOut;
    try {
      replayOut = await runWithReplay(store, auth, 'exam.attempt.manual-grades', operationId, {
        attemptId: attemptManualGradesMatch[1],
        baseRevision: baseRevRaw,
        marks: body?.marks ?? body?.manualGrades ?? null,
      }, (s) => {
      const attempt = (s.examAttempts || []).find((a) => a.id === attemptManualGradesMatch[1]);
      if (!attempt) {
        notFound = true;
        return { client: null, stored: null };
      }
      if (!teacherOwnsExamAttempt(s, attempt, auth.account.id)) {
        if (findExamAssignment(s, attempt.assignmentId)) forbidden = true;
        else notFound = true;
        return { client: null, stored: null };
      }
      if (attempt.status !== EXAM_ATTEMPT_STATUS.SUBMITTED
        && attempt.status !== EXAM_ATTEMPT_STATUS.EXPIRED) {
        notSubmitted = true;
        return { client: null, stored: null };
      }
      const { assignment, version } = resolveAttemptExamContext(s, attempt);
      if (!assignment || !version) {
        notFound = true;
        return { client: null, stored: null };
      }
      if (!attempt.versionId && assignment.versionId) attempt.versionId = assignment.versionId;
      const liveRev = attempt.gradingRevision || 0;
      if (baseRevRaw !== liveRev) {
        conflictRevision = true;
        return { client: null, stored: null };
      }
      const marks = body?.marks ?? body?.manualGrades;
      const merged = mergeManualGradesUpdate(attempt, version, assignment, marks, {
        gradedBy: auth.account.id,
        gradedAt: getNow(),
      });
      if (!merged.ok) {
        mergeFail = merged;
        return { client: null, stored: null };
      }
      const prevJson = JSON.stringify(attempt.manualGrades || {});
      const nextJson = JSON.stringify(merged.manualGrades || {});
      if (prevJson === nextJson) {
        return {
          client: {
            ok: true,
            gradingRevision: liveRev,
            idempotent: true,
            gradingStatus: attempt.gradingStatus || null,
          },
          stored: { ok: true },
        };
      }
      attempt.manualGrades = merged.manualGrades;
      attempt.gradingRevision = liveRev + 1;
      applyAttemptGrading(attempt, version, assignment);
      return {
        client: {
          ok: true,
          gradingRevision: attempt.gradingRevision,
          gradingStatus: attempt.gradingStatus,
          score10: attempt.score10,
          idempotent: false,
        },
        stored: { ok: true },
      };
    });
    } catch (e) {
      if (e?.message === 'session-revoked') {
        error(res, 401, 'Phiên đăng nhập không còn hợp lệ.');
        return true;
      }
      throw e;
    }
    if (notFound) {
      error(res, 404, 'Không tìm thấy.');
      return true;
    }
    if (forbidden) {
      error(res, 403, 'Không có quyền.');
      return true;
    }
    if (notSubmitted) {
      error(res, 400, 'Chỉ chấm được bài đã nộp.');
      return true;
    }
    if (conflictRevision) {
      error(res, 409, 'Điểm chấm đã thay đổi — tải lại trang.');
      return true;
    }
    if (mergeFail) {
      if (mergeFail.error === 'invalid-score') {
        error(res, 400, `Điểm không hợp lệ (0–${mergeFail.maxPoints}).`);
        return true;
      }
      error(res, 400, 'Không lưu được điểm chấm tay.');
      return true;
    }
    if (!replayOut.ok) { error(res, replayOut.status, replayOut.error); return true; }
    json(res, 200, replayOut.result);
    return true;
  }

  const versionKeyMatch = pathname.match(/^\/api\/teacher\/exams\/versions\/([^/]+)\/answer-key$/);
  const versionPreviewMatch = pathname.match(/^\/api\/teacher\/exams\/versions\/([^/]+)\/student-preview$/);
  if (versionPreviewMatch && req.method === 'GET') {
    const state = await store.read();
    const version = findExamVersion(state, versionPreviewMatch[1]);
    if (!version || version.teacherAccountId !== auth.account.id) {
      error(res, 404, 'Không tìm thấy.');
      return true;
    }
    const exam = buildTeacherPreviewExamProjection(version);
    json(res, 200, {
      ok: true,
      exam,
      version: {
        id: version.id,
        bankExamId: resolveBankExamId(version),
        sourceAttachmentId: version.sourceAttachmentId || null,
        sourcePdfPageCount: version.sourcePdfPageCount || null,
        pdfOnly: !!(version.pdfOnly || !(version.questions || []).length),
        classroomPlaybackAllowed: !!version.classroomPlaybackAllowed,
        audioState: version.audioState || null,
      },
    });
    return true;
  }

  if (versionKeyMatch && req.method === 'PUT') {
    if (!assertMutationHeaders(req, ctx.hostHeader, ctx.cookies.bn_csrf, req.headers['x-bn-csrf'])) {
      error(res, 403, 'Yêu cầu không hợp lệ.');
      return true;
    }
    const bodyRaw = await readJsonBody(req);
    const { operationId, payload: body } = splitOperationId(bodyRaw);
    const baseRevRaw = body?.baseRevision;
    if (!Number.isInteger(baseRevRaw) || baseRevRaw < 1) {
      error(res, 400, 'Thiếu hoặc sai phiên bản đáp án.');
      return true;
    }
    let conflictRevision = false;
    let mergeFail = null;
    const replayOut = await runWithReplay(store, auth, 'exam.version.answer-key', operationId, {
      versionId: versionKeyMatch[1],
      baseRevision: baseRevRaw,
      keys: body?.keys ?? null,
      confirmOverwrite: !!body?.confirmOverwrite,
    }, (s) => {
      const version = findExamVersion(s, versionKeyMatch[1]);
      if (!version || version.teacherAccountId !== auth.account.id) throw new Error('missing');
      const liveRev = version.answerKeyRevision || 1;
      if (baseRevRaw !== liveRev) {
        conflictRevision = true;
        return { client: null, stored: null };
      }
      const merged = mergeVersionAnswerKeyUpdate(version, body?.keys, {
        confirmOverwrite: !!body?.confirmOverwrite,
      });
      if (!merged.ok) {
        mergeFail = merged;
        return { client: null, stored: null };
      }
      const prevJson = JSON.stringify(version.confirmedAnswerKey || {});
      const nextJson = JSON.stringify(merged.confirmedAnswerKey || {});
      if (prevJson === nextJson) {
        return {
          client: {
            ok: true,
            answerKeyRevision: liveRev,
            regradedCount: 0,
            idempotent: true,
          },
          stored: { ok: true },
        };
      }
      version.confirmedAnswerKey = merged.confirmedAnswerKey;
      version.answerKeyRevision = liveRev + 1;
      const regradedCount = regradeSubmittedAttemptsForVersion(s, version.id);
      return {
        client: {
          ok: true,
          answerKeyRevision: version.answerKeyRevision,
          regradedCount,
        },
        stored: { ok: true },
      };
    });
    if (conflictRevision) {
      error(res, 409, 'Đáp án đã thay đổi — tải lại trang.');
      return true;
    }
    if (mergeFail?.conflicts?.length) {
      json(res, 409, {
        ok: false,
        error: 'Đáp án đúng đã có — cần xác nhận ghi đè.',
        conflicts: mergeFail.conflicts,
      });
      return true;
    }
    if (mergeFail) {
      error(res, 400, 'Không lưu được đáp án.');
      return true;
    }
    if (!replayOut.ok) { error(res, replayOut.status, replayOut.error); return true; }
    json(res, 200, replayOut.result);
    return true;
  }

  const versionTextKeyMatch = pathname.match(/^\/api\/teacher\/exams\/versions\/([^/]+)\/text-answer-key$/);
  if (versionTextKeyMatch && req.method === 'PUT') {
    if (!assertMutationHeaders(req, ctx.hostHeader, ctx.cookies.bn_csrf, req.headers['x-bn-csrf'])) {
      error(res, 403, 'Yêu cầu không hợp lệ.');
      return true;
    }
    const bodyRaw = await readJsonBody(req);
    const { operationId, payload: body } = splitOperationId(bodyRaw);
    const baseRevRaw = body?.baseRevision;
    if (!Number.isInteger(baseRevRaw) || baseRevRaw < 1) {
      error(res, 400, 'Thiếu hoặc sai phiên bản đáp án.');
      return true;
    }
    let conflictRevision = false;
    let mergeFail = null;
    const replayOut = await runWithReplay(store, auth, 'exam.version.text-answer-key', operationId, {
      versionId: versionTextKeyMatch[1],
      baseRevision: baseRevRaw,
      keys: body?.keys ?? null,
      confirmOverwrite: !!body?.confirmOverwrite,
    }, (s) => {
      const version = findExamVersion(s, versionTextKeyMatch[1]);
      if (!version || version.teacherAccountId !== auth.account.id) throw new Error('missing');
      const liveRev = version.textAnswerKeyRevision || 1;
      if (baseRevRaw !== liveRev) {
        conflictRevision = true;
        return { client: null, stored: null };
      }
      const merged = mergeVersionTextAnswerKeyUpdate(version, body?.keys, {
        confirmOverwrite: !!body?.confirmOverwrite,
      });
      if (!merged.ok) {
        mergeFail = merged;
        return { client: null, stored: null };
      }
      const prevJson = JSON.stringify(version.confirmedTextAnswerKey || {});
      const nextJson = JSON.stringify(merged.confirmedTextAnswerKey || {});
      if (prevJson === nextJson) {
        return {
          client: {
            ok: true,
            textAnswerKeyRevision: liveRev,
            regradedCount: 0,
            idempotent: true,
          },
          stored: { ok: true },
        };
      }
      version.confirmedTextAnswerKey = merged.confirmedTextAnswerKey;
      version.textAnswerKeyRevision = liveRev + 1;
      const regradedCount = regradeSubmittedAttemptsForVersion(s, version.id);
      return {
        client: {
          ok: true,
          textAnswerKeyRevision: version.textAnswerKeyRevision,
          regradedCount,
        },
        stored: { ok: true },
      };
    });
    if (conflictRevision) {
      error(res, 409, 'Đáp án đã thay đổi — tải lại trang.');
      return true;
    }
    if (mergeFail?.conflicts?.length) {
      json(res, 409, {
        ok: false,
        error: 'Đáp án đã có — cần xác nhận ghi đè.',
        conflicts: mergeFail.conflicts,
      });
      return true;
    }
    if (mergeFail) {
      error(res, 400, 'Không lưu được đáp án.');
      return true;
    }
    if (!replayOut.ok) { error(res, replayOut.status, replayOut.error); return true; }
    json(res, 200, replayOut.result);
    return true;
  }

  return false;
}

async function handleStudentExamApi(ctx) {
  const {
    req, res, pathname, auth, store,
    readJsonBody, error, json, runWithReplay, assertMutationHeaders,
    withCommitAuth, getNow,
  } = ctx;
  const studentId = auth.studentId;
  const student = (await store.read()).students.find((s) => s.id === studentId);

  if (pathname === '/api/student/exams/assignments' && req.method === 'GET') {
    const state = await store.read();
    json(res, 200, {
      ok: true,
      assignments: studentExamAssignments(state, student, getNow),
    });
    return true;
  }

  const detailMatch = pathname.match(/^\/api\/student\/exams\/assignments\/([^/]+)$/);
  if (detailMatch && req.method === 'GET') {
    const state = await store.read();
    const assignment = findExamAssignment(state, detailMatch[1]);
    if (!assignment || !studentCanAccessAssignmentClass(student, assignment.classId, state.memberships || [], getNow())) {
      error(res, 403, 'Không có quyền.');
      return true;
    }
    const version = findExamVersion(state, assignment.versionId);
    if (!version) { error(res, 404, 'Không tìm thấy.'); return true; }
    const attempt = activeAttempt(state, assignment.id, studentId)
      || (state.examAttempts || []).filter((a) => a.assignmentId === assignment.id && a.studentId === studentId)
        .sort((a, b) => (b.startedAt || '').localeCompare(a.startedAt || ''))[0];
    const projection = projectExamVersionForStudent(version, assignment, attempt, getNow());
    json(res, 200, { ok: true, exam: projection });
    return true;
  }

  if (pathname === '/api/student/exams/attempts/start' && req.method === 'POST') {
    if (!assertMutationHeaders(req, ctx.hostHeader, ctx.cookies.bn_csrf, req.headers['x-bn-csrf'])) {
      error(res, 403, 'Yêu cầu không hợp lệ.');
      return true;
    }
    const bodyRaw = await readJsonBody(req);
    const { operationId, payload: body } = splitOperationId(bodyRaw);
    const pre = await store.read();
    const assignmentPre = findExamAssignment(pre, body?.assignmentId);
    const stPre = pre.students.find((x) => x.id === studentId);
    const nowPre = getNow();
    if (!assignmentPre || !stPre) {
      error(res, 400, 'Bài thi không tồn tại.');
      return true;
    }
    if (!studentCanAccessAssignmentClass(stPre, assignmentPre.classId, pre.memberships || [], nowPre)) {
      error(res, 403, 'Không có quyền.');
      return true;
    }
    if (nowPre < assignmentPre.openAt) { error(res, 403, 'Bài thi chưa mở.'); return true; }
    if (nowPre >= assignmentPre.dueAt) { error(res, 403, 'Đã quá hạn nộp.'); return true; }
    const activePre = activeAttempt(pre, assignmentPre.id, studentId);
    if (!activePre && countStudentAttempts(pre, assignmentPre.id, studentId) >= assignmentPre.attemptLimit) {
      error(res, 403, 'Đã hết lượt làm bài.');
      return true;
    }
    let replayOut;
    try {
      replayOut = await runWithReplay(store, auth, 'exam.attempt.start', operationId, body, (s) => {
      const assignment = findExamAssignment(s, body?.assignmentId);
      const st = s.students.find((x) => x.id === studentId);
      if (!assignment || !st) throw new Error('missing');
      if (!studentCanAccessAssignmentClass(st, assignment.classId, s.memberships || [], getNow())) {
        throw new Error('forbidden');
      }
      const now = getNow();
      if (now < assignment.openAt) throw new Error('not-open');
      if (now >= assignment.dueAt) throw new Error('past-due');
      const active = activeAttempt(s, assignment.id, studentId);
      if (active) {
        return {
          client: { ok: true, attemptId: active.id, reused: true },
          stored: { ok: true, attemptId: active.id },
        };
      }
      const submittedCount = countStudentAttempts(s, assignment.id, studentId);
      if (submittedCount >= assignment.attemptLimit) throw new Error('attempt-limit');
      const startedAt = now;
      const attempt = {
        id: randomUUID(),
        assignmentId: assignment.id,
        versionId: assignment.versionId,
        studentId,
        status: EXAM_ATTEMPT_STATUS.IN_PROGRESS,
        startedAt,
        deadlineAt: computeAttemptDeadline(assignment, startedAt),
        answers: {},
        answerRevision: 0,
        submittedAt: null,
      };
      initUnifiedAttemptOnStart(attempt, assignment);
      s.examAttempts.push(attempt);
      return {
        client: { ok: true, attemptId: attempt.id, deadlineAt: attempt.deadlineAt },
        stored: { ok: true, attemptId: attempt.id },
      };
    });
    } catch (e) {
      if (e?.message === 'session-revoked') { error(res, 401, 'Phiên đăng nhập không còn hợp lệ.'); return true; }
      error(res, 403, 'Không thể bắt đầu bài thi.');
      return true;
    }
    if (!replayOut.ok) {
      error(res, replayOut.status, replayOut.error);
      return true;
    }
    json(res, 200, replayOut.result);
    return true;
  }

  const answerMatch = pathname.match(/^\/api\/student\/exams\/attempts\/([^/]+)\/answers$/);
  if (answerMatch && req.method === 'POST') {
    if (!assertMutationHeaders(req, ctx.hostHeader, ctx.cookies.bn_csrf, req.headers['x-bn-csrf'])) {
      error(res, 403, 'Yêu cầu không hợp lệ.');
      return true;
    }
    const bodyRaw = await readJsonBody(req);
    const { payload: body } = splitOperationId(bodyRaw);
    try {
      await store.mutate(withCommitAuth(auth, (s) => {
        const attempt = s.examAttempts.find((a) => a.id === answerMatch[1]);
        if (!attempt || attempt.studentId !== studentId) throw new Error('missing');
        if (attempt.status !== EXAM_ATTEMPT_STATUS.IN_PROGRESS) throw new Error('not-active');
        const now = getNow();
        const assignment = findExamAssignment(s, attempt.assignmentId);
        if (!assignment) throw new Error('missing');
        if (!isExamHomeworkAssignment(assignment) && now >= attempt.deadlineAt) throw new Error('expired');
        if (now >= assignment.dueAt) throw new Error('expired');
        const version = resolveAttemptVersion(s, attempt);
        if (!version) throw new Error('missing');
        const effective = effectiveVersionForAssignment(version, assignment);
        const baseRev = body?.baseRevision;
        if (baseRev != null && baseRev !== attempt.answerRevision) throw new Error('conflict-revision');
        const patch = validateAttemptAnswerPatch(effective, body);
        if (!patch.ok) {
          const code = patch.code || 'bad-answer';
          if (code === 'overlong' || code === 'too-short' || code === 'bad-answer') throw new Error(code);
          if (code === 'oral-forbidden') throw new Error('oral-forbidden');
          throw new Error(code);
        }
        const qid = body?.questionId;
        const nextAnswers = { ...(attempt.answers || {}) };
        if (patch.value == null) delete nextAnswers[qid];
        else nextAnswers[qid] = patch.value;
        attempt.answers = nextAnswers;
        attempt.answerRevision = (attempt.answerRevision || 0) + 1;
        attempt.updatedAt = now;
      }));
    } catch (e) {
      if (e?.message === 'conflict-revision') { error(res, 409, 'Phiên bản câu trả lời đã thay đổi — tải lại.'); return true; }
      if (e?.message === 'expired') { error(res, 403, 'Đã hết thời gian làm bài.'); return true; }
      if (e?.message === 'overlong') { error(res, 400, 'Câu trả lời vượt giới hạn.'); return true; }
      if (e?.message === 'too-short') { error(res, 400, 'Bài viết chưa đủ số từ tối thiểu.'); return true; }
      if (e?.message === 'bad-answer') { error(res, 400, 'Câu trả lời không hợp lệ.'); return true; }
      if (e?.message === 'oral-forbidden') { error(res, 400, 'Câu hỏi này không nhận câu trả lời từ học sinh.'); return true; }
      if (e?.message === 'unknown-question' || e?.message === 'bad-question-id') {
        error(res, 400, 'Câu hỏi không thuộc đề.');
        return true;
      }
      if (e?.message === 'session-revoked') { error(res, 401, 'Phiên đăng nhập không còn hợp lệ.'); return true; }
      error(res, 400, 'Không lưu được câu trả lời.');
      return true;
    }
    const state = await store.read();
    const attempt = state.examAttempts.find((a) => a.id === answerMatch[1]);
    json(res, 200, { ok: true, revision: attempt?.answerRevision || 0 });
    return true;
  }

  const submitMatch = pathname.match(/^\/api\/student\/exams\/attempts\/([^/]+)\/submit$/);
  if (submitMatch && req.method === 'POST') {
    if (!assertMutationHeaders(req, ctx.hostHeader, ctx.cookies.bn_csrf, req.headers['x-bn-csrf'])) {
      error(res, 403, 'Yêu cầu không hợp lệ.');
      return true;
    }
    const bodyRaw = await readJsonBody(req);
    const { operationId } = splitOperationId(bodyRaw);
    let submitFailMessage = null;
    const replayOut = await runWithReplay(store, auth, 'exam.attempt.submit', operationId, {
      attemptId: submitMatch[1],
    }, (s) => {
      const attempt = s.examAttempts.find((a) => a.id === submitMatch[1]);
      if (!attempt || attempt.studentId !== studentId) throw new Error('missing');
      if (attempt.status === EXAM_ATTEMPT_STATUS.SUBMITTED) {
        const assignment = findExamAssignment(s, attempt.assignmentId);
        return {
          client: buildExamSubmitClientResponse(assignment || {}, attempt, { reused: true }),
          stored: { ok: true },
        };
      }
      const assignment = findExamAssignment(s, attempt.assignmentId);
      const version = resolveAttemptVersion(s, attempt);
      if (!version || !assignment) throw new Error('missing');
      if (!attempt.versionId && assignment.versionId) attempt.versionId = assignment.versionId;
      const mode = normalizeExamDeliveryMode(assignment);
      if (mode !== EXAM_DELIVERY_MODE.ONLINE) {
        const unifiedFail = maybeFinalizeUnifiedSubmit(s, attempt, assignment, version, getNow);
        if (unifiedFail) {
          submitFailMessage = unifiedFail;
          return { client: null, stored: null };
        }
      } else {
        const effective = effectiveVersionForAssignment(version, assignment);
        const submitCheck = validateAttemptAnswersForSubmit(effective, attempt.answers || {});
        if (!submitCheck.ok) {
          submitFailMessage = submitCheck.error || 'Không thể nộp — kiểm tra lại câu trả lời.';
          return { client: null, stored: null };
        }
        attempt.status = EXAM_ATTEMPT_STATUS.SUBMITTED;
        attempt.submittedAt = getNow();
        if (attempt.gradingRevision == null) attempt.gradingRevision = 0;
        freezeAttemptSubmissionSnapshots(attempt, assignment, version);
        applyAttemptGrading(attempt, version, assignment);
      }
      return {
        client: buildExamSubmitClientResponse(assignment || {}, attempt),
        stored: { ok: true },
      };
    });
    if (submitFailMessage) {
      error(res, 400, submitFailMessage);
      return true;
    }
    if (!replayOut.ok) {
      error(res, replayOut.status, replayOut.error);
      return true;
    }
    json(res, 200, replayOut.result);
    return true;
  }

  return false;
}

export function examTeacherDataExtension(state, teacherAccountId) {
  const snap = teacherExamListSnapshot(state, teacherAccountId);
  return {
    examImports: snap.imports,
    examDrafts: snap.drafts,
    examVersions: snap.versions,
    examAssignments: snap.assignments,
  };
}

export function examStudentDataExtension(state, student, getNow) {
  return { examAssignments: studentExamAssignments(state, student, getNow) };
}
