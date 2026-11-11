import { encodeContentDisposition } from './attachments.mjs';
import { validateExamAudioBuffer } from './exam-audio.mjs';
import {
  studentMayStreamExamAudio,
  resolveAuthorizedExamSourcePdfAttachmentId,
} from './exam-unified-access.mjs';
import {
  findExamAssignment,
  findExamVersion,
  resolveAttemptVersion,
  teacherOwnsExamAttempt,
  resolveAttemptExamContext,
} from './exam-state.mjs';
import {
  EXAM_ATTEMPT_STATUS,
  EXAM_ASSIGNMENT_PART,
  EXAM_DELIVERY_MODE,
  EXAM_PART_STATUS,
  applyAttemptGrading,
  assignmentSelectedPdfPageIds,
  buildAssignmentMediaSnapshot,
  computeFinalAttemptScore,
  defaultAttemptPartStatus,
  freezeAttemptSubmissionSnapshots,
  markAttemptPartSubmitted,
  mergePdfManualGradeUpdate,
  mergePdfStudentPageAnnotation,
  mergePdfTeacherPageAnnotation,
  validatePdfTeacherAnnotationSaveBody,
  normalizeExamDeliveryMode,
  requiredPartsSubmitted,
  validateAttemptAnswersForSubmit,
  validateAttemptPartSubmit,
  validatePdfAnnotationSaveBody,
  validateVersionAudioPatch,
  validateDraftMediaPatch,
  effectiveVersionForAssignment,
  isExamHomeworkAssignment,
} from '../dist/exam-domain.js';
import { findExamDraft, teacherOwnsExamDraft } from './exam-state.mjs';
import { studentCanAccessAssignmentClass } from '../dist/ba-domain.js';

function splitOperationId(body) {
  if (!body || typeof body !== 'object') return { operationId: null, payload: body };
  const operationId = typeof body.operationId === 'string' ? body.operationId : null;
  const payload = { ...body };
  delete payload.operationId;
  return { operationId, payload };
}

function versionHasAssignedAttempts(state, versionId) {
  const assignmentIds = new Set(
    (state.examAssignments || []).filter((a) => a.versionId === versionId).map((a) => a.id),
  );
  if (!assignmentIds.size) return false;
  return (state.examAttempts || []).some((a) => assignmentIds.has(a.assignmentId));
}

export async function tryHandleUnifiedExamApi(ctx) {
  const {
    req, res, pathname, auth, store,
    readJsonBody, error, json, runWithReplay, assertMutationHeaders,
    withCommitAuth, getNow,
  } = ctx;

  const draftMediaMatch = pathname.match(/^\/api\/teacher\/exams\/drafts\/([^/]+)\/media$/);
  if (draftMediaMatch && req.method === 'PUT') {
    if (auth?.role !== 'teacher') {
      error(res, 403, 'Chỉ giáo viên được phép.');
      return true;
    }
    if (!assertMutationHeaders(req, ctx.hostHeader, ctx.cookies.bn_csrf, req.headers['x-bn-csrf'])) {
      error(res, 403, 'Yêu cầu không hợp lệ.');
      return true;
    }
    const bodyRaw = await readJsonBody(req);
    const { operationId, payload: body } = splitOperationId(bodyRaw);
    const pre = await store.read();
    const draftPre = findExamDraft(pre, draftMediaMatch[1]);
    if (!teacherOwnsExamDraft(draftPre, auth.account.id)) {
      error(res, 404, 'Không tìm thấy.');
      return true;
    }
    const hasPublished = !!draftPre.publishedVersionId;
    const patch = validateDraftMediaPatch(draftPre, body, { hasPublishedVersion: hasPublished });
    if (!patch.ok) {
      const code = patch.code === 'stale-media' ? 409 : 400;
      error(res, code, patch.error);
      return true;
    }
    if (patch.audioAttachmentId) {
      const meta = pre.attachmentMeta?.[patch.audioAttachmentId];
      if (!meta || meta.ownerAccountId !== auth.account.id) {
        error(res, 400, 'Tệp âm thanh không hợp lệ.');
        return true;
      }
      const buf = await store.readAttachment(patch.audioAttachmentId);
      if (!buf) {
        error(res, 400, 'Không đọc được tệp âm thanh.');
        return true;
      }
      const v = validateExamAudioBuffer(buf, meta.filename, meta.mime);
      if (!v.ok) {
        error(res, 400, v.error);
        return true;
      }
    }
    const groupId = body?.groupId ? String(body.groupId) : null;
    const replayOut = await runWithReplay(store, auth, 'exam.draft.media', operationId, body, (s) => {
      const draft = findExamDraft(s, draftMediaMatch[1]);
      if (!teacherOwnsExamDraft(draft, auth.account.id)) throw new Error('missing');
      draft.audioAttachmentId = patch.audioAttachmentId;
      draft.audioState = patch.audioState;
      draft.mediaRevision = patch.mediaRevision;
      if (!draft.mediaBindings || typeof draft.mediaBindings !== 'object') {
        draft.mediaBindings = { paper: null, groups: {}, questions: {} };
      }
      const bindTarget = groupId && draft.passages?.some((p) => p.id === groupId)
        ? 'group'
        : 'paper';
      if (bindTarget === 'group') {
        if (!draft.mediaBindings.groups) draft.mediaBindings.groups = {};
        if (patch.audioState === 'removed' || !patch.audioAttachmentId) {
          delete draft.mediaBindings.groups[groupId];
        } else {
          draft.mediaBindings.groups[groupId] = {
            audioAttachmentId: patch.audioAttachmentId,
            frozenAudioAttachmentId: patch.audioAttachmentId,
          };
        }
      } else if (patch.audioState === 'removed' || !patch.audioAttachmentId) {
        draft.mediaBindings.paper = null;
        draft.audioAttachmentId = null;
      } else {
        draft.mediaBindings.paper = {
          audioAttachmentId: patch.audioAttachmentId,
          frozenAudioAttachmentId: patch.audioAttachmentId,
        };
        draft.audioAttachmentId = patch.audioAttachmentId;
      }
      draft.updatedAt = getNow();
      return {
        client: {
          ok: true,
          mediaRevision: draft.mediaRevision,
          audioState: draft.audioState,
          audioAttachmentId: draft.audioAttachmentId,
          mediaBindings: draft.mediaBindings,
        },
        stored: { ok: true },
      };
    });
    if (!replayOut.ok) {
      error(res, replayOut.status, replayOut.error);
      return true;
    }
    json(res, 200, replayOut.result);
    return true;
  }

  const versionMediaMatch = pathname.match(/^\/api\/teacher\/exams\/versions\/([^/]+)\/media$/);
  if (versionMediaMatch && req.method === 'PUT') {
    if (auth?.role !== 'teacher') {
      error(res, 403, 'Chỉ giáo viên được phép.');
      return true;
    }
    if (!assertMutationHeaders(req, ctx.hostHeader, ctx.cookies.bn_csrf, req.headers['x-bn-csrf'])) {
      error(res, 403, 'Yêu cầu không hợp lệ.');
      return true;
    }
    const bodyRaw = await readJsonBody(req);
    const { operationId, payload: body } = splitOperationId(bodyRaw);
    const pre = await store.read();
    const versionPre = findExamVersion(pre, versionMediaMatch[1]);
    if (!versionPre || versionPre.teacherAccountId !== auth.account.id) {
      error(res, 404, 'Không tìm thấy.');
      return true;
    }
    const assigned = versionHasAssignedAttempts(pre, versionPre.id);
    const patch = validateVersionAudioPatch(versionPre, body, { hasAssignedAttempts: assigned });
    if (!patch.ok) {
      const code = patch.code === 'stale-media' ? 409 : 400;
      error(res, code, patch.error);
      return true;
    }
    if (patch.audioAttachmentId) {
      const meta = pre.attachmentMeta?.[patch.audioAttachmentId];
      if (!meta || meta.ownerAccountId !== auth.account.id) {
        error(res, 400, 'Tệp âm thanh không hợp lệ.');
        return true;
      }
      const buf = await store.readAttachment(patch.audioAttachmentId);
      if (!buf) {
        error(res, 400, 'Không đọc được tệp âm thanh.');
        return true;
      }
      const v = validateExamAudioBuffer(buf, meta.filename, meta.mime);
      if (!v.ok) {
        error(res, 400, v.error);
        return true;
      }
    }
    const replayOut = await runWithReplay(store, auth, 'exam.version.media', operationId, body, (s) => {
      const version = findExamVersion(s, versionMediaMatch[1]);
      if (!version || version.teacherAccountId !== auth.account.id) throw new Error('missing');
      version.audioAttachmentId = patch.audioAttachmentId;
      version.audioState = patch.audioState;
      version.mediaRevision = patch.mediaRevision;
      if (!version.mediaBindings || typeof version.mediaBindings !== 'object') {
        version.mediaBindings = { paper: null, groups: {}, questions: {} };
      }
      if (patch.audioState === 'removed' || !patch.audioAttachmentId) {
        version.mediaBindings.paper = null;
      } else {
        version.mediaBindings.paper = {
          audioAttachmentId: patch.audioAttachmentId,
          frozenAudioAttachmentId: patch.audioAttachmentId,
        };
      }
      if (patch.classroomPlaybackAllowed != null) {
        version.classroomPlaybackAllowed = patch.classroomPlaybackAllowed;
      }
      const liveSnap = buildAssignmentMediaSnapshot(version);
      for (const row of s.examAssignments || []) {
        if (row.versionId !== version.id) continue;
        const hasFrozenSubmit = (s.examAttempts || []).some(
          (a) => a.assignmentId === row.id
            && (a.status === EXAM_ATTEMPT_STATUS.SUBMITTED || a.status === EXAM_ATTEMPT_STATUS.EXPIRED),
        );
        if (!hasFrozenSubmit) {
          row.mediaSnapshot = JSON.parse(JSON.stringify(liveSnap));
        }
      }
      return {
        client: {
          ok: true,
          mediaRevision: version.mediaRevision,
          audioState: version.audioState,
          audioAttachmentId: version.audioAttachmentId,
        },
        stored: { ok: true },
      };
    });
    if (!replayOut.ok) {
      error(res, replayOut.status, replayOut.error);
      return true;
    }
    json(res, 200, replayOut.result);
    return true;
  }

  const teacherPdfAnnotMatch = pathname.match(/^\/api\/teacher\/exams\/attempts\/([^/]+)\/pdf-annotations$/);
  if (teacherPdfAnnotMatch && req.method === 'POST') {
    if (auth?.role !== 'teacher') {
      error(res, 403, 'Chỉ giáo viên được phép.');
      return true;
    }
    if (!assertMutationHeaders(req, ctx.hostHeader, ctx.cookies.bn_csrf, req.headers['x-bn-csrf'])) {
      error(res, 403, 'Yêu cầu không hợp lệ.');
      return true;
    }
    const bodyRaw = await readJsonBody(req);
    const { operationId, payload: body } = splitOperationId(bodyRaw);
    const baseRev = body?.baseRevision;
    if (!Number.isInteger(baseRev) || baseRev < 0) {
      error(res, 400, 'Thiếu phiên bản chú thích giáo viên.');
      return true;
    }
    let conflict = false;
    let validationCode = null;
    let notSubmitted = false;
    const replayOut = await runWithReplay(store, auth, 'exam.attempt.teacher-pdf-annot', operationId, body, (s) => {
      const attempt = (s.examAttempts || []).find((a) => a.id === teacherPdfAnnotMatch[1]);
      if (!attempt || !teacherOwnsExamAttempt(s, attempt, auth.account.id)) throw new Error('missing');
      if (attempt.status !== EXAM_ATTEMPT_STATUS.SUBMITTED
        && attempt.status !== EXAM_ATTEMPT_STATUS.EXPIRED) {
        notSubmitted = true;
        return { client: null, stored: null };
      }
      if (baseRev !== (attempt.teacherPdfAnnotationRevision || 0)) {
        conflict = true;
        return { client: null, stored: null };
      }
      const { assignment, version } = resolveAttemptExamContext(s, attempt);
      if (!assignment || !version) throw new Error('missing');
      const pages = assignmentSelectedPdfPageIds(assignment, version);
      const validated = validatePdfTeacherAnnotationSaveBody(body, assignment, pages || []);
      if (!validated.ok) {
        validationCode = validated.code || 'bad-annotation';
        return { client: null, stored: null };
      }
      const now = getNow();
      const revision = mergePdfTeacherPageAnnotation(attempt, validated.pageKey, validated, now);
      attempt.updatedAt = now;
      return { client: { ok: true, revision }, stored: { ok: true } };
    });
    if (conflict) {
      error(res, 409, 'Phiên bản chú thích đã thay đổi — tải lại.');
      return true;
    }
    if (validationCode === 'page-out-of-scope') {
      error(res, 400, 'Trang không thuộc phần được giao.');
      return true;
    }
    if (validationCode === 'payload-too-large') {
      error(res, 400, 'Dữ liệu chú thích quá lớn.');
      return true;
    }
    if (validationCode) {
      error(res, 400, 'Không lưu được chú thích PDF.');
      return true;
    }
    if (notSubmitted) {
      error(res, 400, 'Chỉ chấm bài đã nộp.');
      return true;
    }
    if (!replayOut.ok) {
      error(res, replayOut.status, replayOut.error);
      return true;
    }
    json(res, 200, replayOut.result);
    return true;
  }

  const pdfGradeMatch = pathname.match(/^\/api\/teacher\/exams\/attempts\/([^/]+)\/pdf-manual-grade$/);
  if (pdfGradeMatch && req.method === 'PUT') {
    if (auth?.role !== 'teacher') {
      error(res, 403, 'Chỉ giáo viên được phép.');
      return true;
    }
    if (!assertMutationHeaders(req, ctx.hostHeader, ctx.cookies.bn_csrf, req.headers['x-bn-csrf'])) {
      error(res, 403, 'Yêu cầu không hợp lệ.');
      return true;
    }
    const bodyRaw = await readJsonBody(req);
    const { operationId, payload: body } = splitOperationId(bodyRaw);
    const baseRev = body?.baseRevision;
    if (!Number.isInteger(baseRev) || baseRev < 0) {
      error(res, 400, 'Thiếu phiên bản chấm PDF.');
      return true;
    }
    let conflict = false;
    let mergeFail = null;
    const replayOut = await runWithReplay(store, auth, 'exam.attempt.pdf-grade', operationId, body, (s) => {
      const attempt = (s.examAttempts || []).find((a) => a.id === pdfGradeMatch[1]);
      if (!attempt || !teacherOwnsExamAttempt(s, attempt, auth.account.id)) throw new Error('missing');
      if (attempt.pdfGradeRevision != null && baseRev !== attempt.pdfGradeRevision) {
        conflict = true;
        return { client: null, stored: null };
      }
      const { assignment, version } = resolveAttemptExamContext(s, attempt);
      if (!assignment || !version) throw new Error('missing');
      const merged = mergePdfManualGradeUpdate(attempt, assignment, version, body);
      if (!merged.ok) {
        mergeFail = merged;
        return { client: null, stored: null };
      }
      attempt.pdfGradeRevision = (attempt.pdfGradeRevision || 0) + 1;
      if (attempt.status === EXAM_ATTEMPT_STATUS.SUBMITTED) {
        const fin = computeFinalAttemptScore(attempt, version, assignment);
        attempt.gradingStatus = fin.gradingStatus;
        attempt.score10 = fin.score10;
        attempt.earnedPoints = fin.earnedPoints;
        attempt.totalPoints = fin.totalPoints;
        attempt.correctCount = fin.correctCount;
        attempt.totalCount = fin.totalCount;
      }
      return {
        client: {
          ok: true,
          pdfGradeRevision: attempt.pdfGradeRevision,
          gradingStatus: attempt.gradingStatus || null,
          score10: attempt.score10 ?? null,
        },
        stored: { ok: true },
      };
    });
    if (conflict) {
      error(res, 409, 'Phiên bản chấm PDF đã thay đổi — tải lại.');
      return true;
    }
    if (mergeFail) {
      error(res, 400, mergeFail.error);
      return true;
    }
    if (!replayOut.ok) {
      error(res, replayOut.status, replayOut.error);
      return true;
    }
    json(res, 200, replayOut.result);
    return true;
  }

  const pdfAnnotMatch = pathname.match(/^\/api\/student\/exams\/attempts\/([^/]+)\/pdf-annotations$/);
  if (pdfAnnotMatch && req.method === 'POST') {
    if (auth?.role !== 'student') {
      error(res, 403, 'Chỉ học sinh được phép.');
      return true;
    }
    if (!assertMutationHeaders(req, ctx.hostHeader, ctx.cookies.bn_csrf, req.headers['x-bn-csrf'])) {
      error(res, 403, 'Yêu cầu không hợp lệ.');
      return true;
    }
    const studentId = auth.studentId;
    const bodyRaw = await readJsonBody(req);
    const { payload: body } = splitOperationId(bodyRaw);
    try {
      let revision = 0;
      await store.mutate(withCommitAuth(auth, (s) => {
        const attempt = (s.examAttempts || []).find((a) => a.id === pdfAnnotMatch[1]);
        if (!attempt || attempt.studentId !== studentId) throw new Error('missing');
        if (attempt.status !== EXAM_ATTEMPT_STATUS.IN_PROGRESS) throw new Error('not-active');
        if (attempt.partStatus?.pdf === EXAM_PART_STATUS.SUBMITTED) throw new Error('frozen');
        const assignment = findExamAssignment(s, attempt.assignmentId);
        if (!assignment) throw new Error('missing');
        const mode = normalizeExamDeliveryMode(assignment);
        if (mode === EXAM_DELIVERY_MODE.ONLINE) throw new Error('no-pdf-part');
        const now = getNow();
        if (!isExamHomeworkAssignment(assignment) && now >= attempt.deadlineAt) throw new Error('expired');
        if (now >= assignment.dueAt) throw new Error('expired');
        const baseRev = body?.baseRevision;
        if (baseRev != null && baseRev !== (attempt.pdfAnnotationRevision || 0)) throw new Error('conflict-revision');
        const pages = assignmentSelectedPdfPageIds(assignment, findExamVersion(s, assignment.versionId));
        const validated = validatePdfAnnotationSaveBody(body, assignment, pages || []);
        if (!validated.ok) throw new Error(validated.code || 'bad-annotation');
        if (body?.deliveryMode || body?.selectedPdfPageIds || body?.partStatus) throw new Error('spoof');
        revision = mergePdfStudentPageAnnotation(attempt, validated.pageKey, validated, now);
        attempt.updatedAt = now;
      }));
      json(res, 200, { ok: true, revision });
    } catch (e) {
      if (e?.message === 'conflict-revision') {
        error(res, 409, 'Phiên bản chú thích đã thay đổi — tải lại.');
        return true;
      }
      if (e?.message === 'frozen') {
        error(res, 403, 'Đã nộp phần PDF — không sửa được.');
        return true;
      }
      if (e?.message === 'expired') {
        error(res, 403, 'Đã hết thời gian làm bài.');
        return true;
      }
      if (e?.message === 'page-out-of-scope') {
        error(res, 400, 'Trang không thuộc phần được giao.');
        return true;
      }
      if (e?.message === 'payload-too-large') {
        error(res, 400, 'Dữ liệu chú thích quá lớn.');
        return true;
      }
      if (e?.message === 'no-pdf-part') {
        error(res, 400, 'Bài này không có phần PDF.');
        return true;
      }
      if (e?.message === 'spoof') {
        error(res, 400, 'Yêu cầu không hợp lệ.');
        return true;
      }
      error(res, 400, 'Không lưu được chú thích PDF.');
      return true;
    }
    return true;
  }

  const partSubmitMatch = pathname.match(/^\/api\/student\/exams\/attempts\/([^/]+)\/submit-part$/);
  if (partSubmitMatch && req.method === 'POST') {
    if (auth?.role !== 'student') {
      error(res, 403, 'Chỉ học sinh được phép.');
      return true;
    }
    if (!assertMutationHeaders(req, ctx.hostHeader, ctx.cookies.bn_csrf, req.headers['x-bn-csrf'])) {
      error(res, 403, 'Yêu cầu không hợp lệ.');
      return true;
    }
    const studentId = auth.studentId;
    const bodyRaw = await readJsonBody(req);
    const { operationId, payload: body } = splitOperationId(bodyRaw);
    if (body?.deliveryMode || body?.selectedPdfPageIds) {
      error(res, 400, 'Yêu cầu không hợp lệ.');
      return true;
    }
  const part = body?.part;
  let failMsg = null;
  const replayOut = await runWithReplay(store, auth, 'exam.attempt.submit-part', operationId, body, (s) => {
      const attempt = (s.examAttempts || []).find((a) => a.id === partSubmitMatch[1]);
      if (!attempt || attempt.studentId !== studentId) throw new Error('missing');
      if (attempt.status !== EXAM_ATTEMPT_STATUS.IN_PROGRESS) throw new Error('not-active');
      const assignment = findExamAssignment(s, attempt.assignmentId);
      const version = resolveAttemptVersion(s, attempt);
      if (!assignment || !version) throw new Error('missing');
      const pcheck = validateAttemptPartSubmit(assignment, attempt, part);
      if (!pcheck.ok) {
        failMsg = pcheck.error;
        return { client: null, stored: null };
      }
      const now = getNow();
      if (part === EXAM_ASSIGNMENT_PART.ONLINE) {
        const effective = effectiveVersionForAssignment(version, assignment);
        const submitCheck = validateAttemptAnswersForSubmit(effective, attempt.answers || {});
        if (!submitCheck.ok) {
          failMsg = submitCheck.error || 'Không thể nộp phần trực tuyến.';
          return { client: null, stored: null };
        }
      }
      markAttemptPartSubmitted(attempt, part, now);
      return {
        client: {
          ok: true,
          part,
          partStatus: attempt.partStatus,
          readyForFinalSubmit: requiredPartsSubmitted(assignment, attempt),
        },
        stored: { ok: true },
      };
    });
    if (failMsg) {
      error(res, 400, failMsg);
      return true;
    }
    if (!replayOut.ok) {
      error(res, replayOut.status, replayOut.error);
      return true;
    }
    json(res, 200, replayOut.result);
    return true;
  }

  const teacherVersionSourcePdfMatch = pathname.match(/^\/api\/teacher\/exams\/versions\/([^/]+)\/source-pdf$/);
  if (teacherVersionSourcePdfMatch && (req.method === 'GET' || req.method === 'HEAD')) {
    if (auth?.role !== 'teacher') {
      error(res, 403, 'Chỉ giáo viên được phép.');
      return true;
    }
    const state = await store.read();
    const version = findExamVersion(state, teacherVersionSourcePdfMatch[1]);
    if (!version || version.teacherAccountId !== auth.account.id) {
      error(res, 404, 'Không tìm thấy.');
      return true;
    }
    const attId = version.sourceAttachmentId;
    if (!attId) {
      error(res, 404, 'Không có PDF nguồn cho đề này.');
      return true;
    }
    const buf = await store.readAttachment(attId);
    if (!buf) {
      error(res, 404, 'Không tìm thấy PDF.');
      return true;
    }
    const meta = state.attachmentMeta?.[attId];
    res.writeHead(200, {
      'Content-Type': 'application/pdf',
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': encodeContentDisposition(meta?.filename || 'exam.pdf', true),
    });
    if (req.method === 'HEAD') res.end();
    else res.end(buf);
    return true;
  }

  const teacherSourcePdfMatch = pathname.match(/^\/api\/teacher\/exams\/assignments\/([^/]+)\/source-pdf$/);
  if (teacherSourcePdfMatch && (req.method === 'GET' || req.method === 'HEAD')) {
    if (auth?.role !== 'teacher') {
      error(res, 403, 'Chỉ giáo viên được phép.');
      return true;
    }
    const state = await store.read();
    const assignment = findExamAssignment(state, teacherSourcePdfMatch[1]);
    if (!assignment || assignment.teacherAccountId !== auth.account.id) {
      error(res, 404, 'Không tìm thấy.');
      return true;
    }
    const mode = normalizeExamDeliveryMode(assignment);
    if (mode === EXAM_DELIVERY_MODE.ONLINE) {
      error(res, 404, 'Không có PDF cho bài này.');
      return true;
    }
    const version = findExamVersion(state, assignment.versionId);
    const attId = resolveAuthorizedExamSourcePdfAttachmentId(state, assignment, version);
    if (!attId) {
      error(res, 404, 'Không tìm thấy PDF.');
      return true;
    }
    const buf = await store.readAttachment(attId);
    if (!buf) {
      error(res, 404, 'Không tìm thấy PDF.');
      return true;
    }
    const meta = state.attachmentMeta?.[attId];
    res.writeHead(200, {
      'Content-Type': 'application/pdf',
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': encodeContentDisposition(meta?.filename || 'exam.pdf', true),
    });
    if (req.method === 'HEAD') res.end();
    else res.end(buf);
    return true;
  }

  const sourcePdfMatch = pathname.match(/^\/api\/student\/exams\/assignments\/([^/]+)\/source-pdf$/);
  if (sourcePdfMatch && (req.method === 'GET' || req.method === 'HEAD')) {
    if (auth?.role !== 'student') {
      error(res, 403, 'Chỉ học sinh được phép.');
      return true;
    }
    const state = await store.read();
    const student = state.students.find((s) => s.id === auth.studentId);
    const assignment = findExamAssignment(state, sourcePdfMatch[1]);
    if (!assignment || !studentCanAccessAssignmentClass(student, assignment.classId, state.memberships || [], getNow())) {
      error(res, 403, 'Không có quyền.');
      return true;
    }
    const mode = normalizeExamDeliveryMode(assignment);
    if (mode === EXAM_DELIVERY_MODE.ONLINE) {
      error(res, 404, 'Không có PDF cho bài này.');
      return true;
    }
    const version = findExamVersion(state, assignment.versionId);
    const attId = resolveAuthorizedExamSourcePdfAttachmentId(state, assignment, version);
    if (!attId) {
      error(res, 404, 'Không tìm thấy PDF.');
      return true;
    }
    const buf = await store.readAttachment(attId);
    if (!buf) {
      error(res, 404, 'Không tìm thấy PDF.');
      return true;
    }
    const meta = state.attachmentMeta?.[attId];
    res.writeHead(200, {
      'Content-Type': 'application/pdf',
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': encodeContentDisposition(meta?.filename || 'exam.pdf', true),
    });
    if (req.method === 'HEAD') res.end();
    else res.end(buf);
    return true;
  }

  const audioMatch = pathname.match(/^\/api\/student\/exams\/assignments\/([^/]+)\/audio$/);
  if (audioMatch && (req.method === 'GET' || req.method === 'HEAD')) {
    if (auth?.role !== 'student') {
      error(res, 403, 'Chỉ học sinh được phép.');
      return true;
    }
    const state = await store.read();
    const authStudent = { ...auth, student: state.students.find((s) => s.id === auth.studentId) };
    const q = new URL(req.url || '/', 'http://localhost').searchParams;
    const groupId = q.get('groupId') ? String(q.get('groupId')) : null;
    const gate = studentMayStreamExamAudio(state, authStudent, audioMatch[1], getNow, { groupId });
    if (!gate.ok) {
      error(res, gate.error === 'forbidden' ? 403 : 404, 'Không có quyền nghe âm thanh.');
      return true;
    }
    if (gate.classroomPlayback && !gate.attachmentId) {
      json(res, 200, { ok: true, classroomPlayback: true });
      return true;
    }
    const buf = await store.readAttachment(gate.attachmentId);
    if (!buf) {
      error(res, 404, 'Không tìm thấy âm thanh.');
      return true;
    }
    const meta = state.attachmentMeta?.[gate.attachmentId];
    const mime = meta?.mime || 'audio/mpeg';
    const range = req.headers.range;
    const total = buf.length;
    if (range && /^bytes=\d*-\d*$/.test(range)) {
      const m = range.match(/bytes=(\d*)-(\d*)/);
      let start = m[1] ? parseInt(m[1], 10) : 0;
      let end = m[2] ? parseInt(m[2], 10) : total - 1;
      if (Number.isNaN(start)) start = 0;
      if (Number.isNaN(end) || end >= total) end = total - 1;
      if (start > end || start >= total) {
        res.writeHead(416, { 'Content-Range': `bytes */${total}` });
        res.end();
        return true;
      }
      const chunk = buf.slice(start, end + 1);
      res.writeHead(206, {
        'Content-Type': mime,
        'Content-Range': `bytes ${start}-${end}/${total}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunk.length,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      if (req.method === 'HEAD') res.end();
      else res.end(chunk);
      return true;
    }
    res.writeHead(200, {
      'Content-Type': mime,
      'Content-Length': total,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    if (req.method === 'HEAD') res.end();
    else res.end(buf);
    return true;
  }

  return false;
}

export function initUnifiedAttemptOnStart(attempt, assignment) {
  attempt.partStatus = defaultAttemptPartStatus(assignment);
  attempt.pdfAnnotations = {};
  attempt.pdfAnnotationRevision = 0;
  attempt.pdfGradeRevision = 0;
  attempt.teacherPdfAnnotations = {};
  attempt.teacherPdfAnnotationRevision = 0;
  attempt.pdfFeedbackPublished = false;
}

export function applyUnifiedAssignmentFields(row, version, v) {
  row.deliveryMode = v.deliveryMode || EXAM_DELIVERY_MODE.ONLINE;
  if (v.selectedPdfPageIds) row.selectedPdfPageIds = v.selectedPdfPageIds;
  if (v.requiredParts) row.requiredParts = v.requiredParts;
  if (v.pdfPartPoints != null) row.pdfPartPoints = v.pdfPartPoints;
  if (v.onlinePartPoints != null) row.onlinePartPoints = v.onlinePartPoints;
  row.sourcePdfAttachmentId = version.sourceAttachmentId || null;
  row.mediaSnapshot = buildAssignmentMediaSnapshot(version);
  if (v.classroomPlaybackAllowed) {
    row.classroomPlaybackAllowed = true;
    row.mediaSnapshot.classroomPlaybackAllowed = true;
  }
}

export function maybeFinalizeUnifiedSubmit(s, attempt, assignment, version, getNow) {
  const mode = normalizeExamDeliveryMode(assignment);
  if (mode === EXAM_DELIVERY_MODE.ONLINE) return null;
  if (!requiredPartsSubmitted(assignment, attempt)) {
    return 'Chưa nộp đủ phần bắt buộc — nộp từng phần trước.';
  }
  freezeAttemptSubmissionSnapshots(attempt, assignment, version);
  const fin = computeFinalAttemptScore(attempt, version, assignment);
  if (mode !== EXAM_DELIVERY_MODE.PDF) {
    applyAttemptGrading(attempt, version, assignment);
    attempt.gradingStatus = fin.gradingStatus;
    attempt.score10 = fin.score10;
    attempt.earnedPoints = fin.earnedPoints;
    attempt.totalPoints = fin.totalPoints;
    attempt.correctCount = fin.correctCount;
    attempt.totalCount = fin.totalCount;
  } else {
    attempt.gradingStatus = fin.gradingStatus;
    attempt.score10 = fin.score10;
    attempt.earnedPoints = fin.earnedPoints;
    attempt.totalPoints = fin.totalPoints;
  }
  attempt.status = EXAM_ATTEMPT_STATUS.SUBMITTED;
  attempt.submittedAt = getNow();
  return null;
}
