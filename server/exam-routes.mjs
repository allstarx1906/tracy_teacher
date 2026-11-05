import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { studentCanAccessAssignmentClass } from '../dist/ba-domain.js';
import {
  EXAM_ATTEMPT_STATUS,
  EXAM_JOB_STATUS,
  validateDraftForPublish,
  validateExamAssignmentInput,
  computeAttemptDeadline,
  gradeAttempt,
  projectExamVersionForStudent,
} from '../dist/exam-domain.js';
import {
  findExamAssignment,
  findExamDraft,
  findExamImportJob,
  findExamVersion,
  teacherOwnsExamDraft,
  teacherOwnsImportJob,
} from './exam-state.mjs';
import {
  createImportJobRecord,
  examContentDigest,
  findExistingImportByDigest,
  scheduleExamImportProcessing,
} from './exam-worker.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PDFJS_VENDOR = {
  pdf: path.join(__dirname, '..', 'node_modules', 'pdfjs-dist', 'legacy', 'build', 'pdf.mjs'),
  worker: path.join(__dirname, '..', 'node_modules', 'pdfjs-dist', 'legacy', 'build', 'pdf.worker.mjs'),
};

function requireTeacher(auth, error, res) {
  if (!auth || auth.role !== 'teacher') {
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
    needsReview: draft.needsReview,
    teacherConfirmedReview: draft.teacherConfirmedReview,
    manuallyEdited: draft.manuallyEdited,
    sourceAttachmentId: draft.sourceAttachmentId,
    importJobId: draft.importJobId,
    updatedAt: draft.updatedAt,
  };
}

function teacherExamListSnapshot(state, teacherAccountId) {
  return {
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
      .map((d) => ({
        id: d.id,
        title: d.title,
        needsOcr: d.needsOcr,
        needsReview: d.needsReview,
        questionCount: (d.questions || []).length,
        updatedAt: d.updatedAt,
      })),
    versions: (state.examVersions || [])
      .filter((v) => v.teacherAccountId === teacherAccountId)
      .map((v) => ({
        id: v.id,
        title: v.title,
        publishedAt: v.publishedAt,
        questionCount: (v.questions || []).length,
      })),
    assignments: (state.examAssignments || [])
      .filter((a) => a.teacherAccountId === teacherAccountId)
      .map((a) => ({
        id: a.id,
        versionId: a.versionId,
        classId: a.classId,
        openAt: a.openAt,
        dueAt: a.dueAt,
        title: a.title,
      })),
  };
}

function buildExamSubmitClientResponse(assignment, attempt, { reused = false } = {}) {
  const showScore = assignment.showScore !== false;
  const payload = { ok: true };
  if (reused) payload.reused = true;
  if (showScore) {
    payload.score10 = attempt.score10;
    payload.correctCount = attempt.correctCount;
    payload.totalCount = attempt.totalCount;
  }
  return payload;
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
    return handleTeacherExamApi(ctx);
  }

  if (pathname.startsWith('/api/student/exams')) {
    if (!requireStudent(auth, error, res)) return true;
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
    json(res, 200, { ok: true, ...teacherExamListSnapshot(state, auth.account.id) });
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
    const questionPages = Array.isArray(body?.questionPages) && body.questionPages.length
      ? body.questionPages.map(Number)
      : null;
    const keyPages = Array.isArray(body?.keyPages) ? body.keyPages.map(Number) : [];
    const allPages = questionPages || body?.allPages || [1];
    const digest = examContentDigest(buf, { questionPages: allPages, keyPages });
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

  const draftMatch = pathname.match(/^\/api\/teacher\/exams\/drafts\/([^/]+)$/);
  const sourceMatch = pathname.match(/^\/api\/teacher\/exams\/drafts\/([^/]+)\/source$/);
  if (sourceMatch && req.method === 'GET') {
    const state = await store.read();
    const draft = findExamDraft(state, sourceMatch[1]);
    if (!teacherOwnsExamDraft(draft, auth.account.id)) {
      error(res, 404, 'Không tìm thấy.');
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
      if (body?.teacherConfirmedReview != null) {
        draft.teacherConfirmedReview = !!body.teacherConfirmedReview;
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
      error(res, 400, vcheck.errors[0]);
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
        teacherAccountId: auth.account.id,
        title: draft.title,
        sections: JSON.parse(JSON.stringify(draft.sections || [])),
        passages: JSON.parse(JSON.stringify(draft.passages || [])),
        questions: JSON.parse(JSON.stringify(draft.questions || [])),
        sourceAttachmentId: draft.sourceAttachmentId,
        publishedAt: getNow(),
        revision: 1,
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
    const v = validateExamAssignmentInput(body, getNow);
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
        timeLimitMinutes: Number(body.timeLimitMinutes),
        attemptLimit: Number(body.attemptLimit),
        showScore: body.showScore !== false,
        showAnswersAfter: body.showAnswersAfter || 'after-due',
        createdAt: getNow(),
      };
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
    const summary = attempts.map((a) => ({
      studentId: a.studentId,
      status: a.status,
      score10: a.score10,
      correctCount: a.correctCount,
      totalCount: a.totalCount,
      submittedAt: a.submittedAt,
    }));
    json(res, 200, { ok: true, assignment, summary, attemptCount: attempts.length });
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
        if (now >= attempt.deadlineAt) throw new Error('expired');
        const assignment = findExamAssignment(s, attempt.assignmentId);
        if (!assignment || now >= assignment.dueAt) throw new Error('expired');
        const version = findExamVersion(s, attempt.versionId);
        const qid = body?.questionId;
        const opt = body?.optionId;
        const baseRev = body?.baseRevision;
        if (baseRev != null && baseRev !== attempt.answerRevision) throw new Error('conflict-revision');
        const question = version?.questions?.find((q) => q.id === qid);
        if (!question || !question.options.some((o) => o.id === opt)) throw new Error('bad-option');
        attempt.answers = { ...(attempt.answers || {}), [qid]: opt };
        attempt.answerRevision = (attempt.answerRevision || 0) + 1;
        attempt.updatedAt = now;
      }));
    } catch (e) {
      if (e?.message === 'conflict-revision') { error(res, 409, 'Phiên bản câu trả lời đã thay đổi — tải lại.'); return true; }
      if (e?.message === 'expired') { error(res, 403, 'Đã hết thời gian làm bài.'); return true; }
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
      const version = findExamVersion(s, attempt.versionId);
      const graded = gradeAttempt(version, attempt.answers);
      attempt.status = EXAM_ATTEMPT_STATUS.SUBMITTED;
      attempt.submittedAt = getNow();
      attempt.score10 = graded.score10;
      attempt.correctCount = graded.correctCount;
      attempt.totalCount = graded.totalCount;
      attempt.gradingProjection = graded.perQuestion.map((row) => ({
        questionId: row.questionId,
        correct: row.correct,
        earned: row.earned,
      }));
      return {
        client: buildExamSubmitClientResponse(assignment || {}, attempt),
        stored: { ok: true },
      };
    });
    if (!replayOut.ok) { error(res, replayOut.status, replayOut.error); return true; }
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
