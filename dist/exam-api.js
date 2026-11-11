import { apiFetch, newOperationId } from './api-client.js';

export async function fetchExamTeacherSummary(filters = null) {
  const params = new URLSearchParams();
  if (filters?.skills?.length) params.set('skills', filters.skills.join(','));
  if (filters?.types?.length) params.set('types', filters.types.join(','));
  const qs = params.toString();
  return apiFetch(qs ? `/api/teacher/exams/summary?${qs}` : '/api/teacher/exams/summary');
}

export async function fetchEditableExamDrafts(query = '') {
  const qs = query ? `?q=${encodeURIComponent(query)}` : '';
  return apiFetch(`/api/teacher/exams/editable-drafts${qs}`);
}

export async function undoComposeAppend(draftId, baseRevision, operationId) {
  return apiFetch(`/api/teacher/exams/drafts/${encodeURIComponent(draftId)}/compose-undo`, {
    method: 'POST',
    body: { baseRevision, operationId: operationId || newOperationId() },
  });
}

export async function saveExamDraftMedia(draftId, payload, operationId) {
  return apiFetch(`/api/teacher/exams/drafts/${encodeURIComponent(draftId)}/media`, {
    method: 'PUT',
    body: { ...payload, operationId: operationId || newOperationId() },
  });
}

export async function startExamImport(payload, operationId) {
  return apiFetch('/api/teacher/exams/imports', {
    method: 'POST',
    body: { ...payload, operationId: operationId || newOperationId() },
  });
}

export async function fetchExamImportJob(jobId) {
  return apiFetch(`/api/teacher/exams/imports/${encodeURIComponent(jobId)}`);
}

export async function fetchExamDraft(draftId) {
  return apiFetch(`/api/teacher/exams/drafts/${encodeURIComponent(draftId)}`);
}

export async function createExamDraft(payload, operationId) {
  return apiFetch('/api/teacher/exams/drafts', {
    method: 'POST',
    body: { ...payload, operationId: operationId || newOperationId() },
  });
}

export async function createPdfOnlyExamDraft(payload, operationId) {
  return apiFetch('/api/teacher/exams/pdf-only-drafts', {
    method: 'POST',
    body: { ...payload, operationId: operationId || newOperationId() },
  });
}

export async function fetchExamBankDetail(bankExamId) {
  return apiFetch(`/api/teacher/exams/banks/${encodeURIComponent(bankExamId)}`);
}

export async function reviseExamVersion(versionId, operationId) {
  return apiFetch(`/api/teacher/exams/versions/${encodeURIComponent(versionId)}/revise`, {
    method: 'POST',
    body: { operationId: operationId || newOperationId() },
  });
}

export async function appendComposedQuestionsToDraft(draftId, payload, operationId) {
  return apiFetch(`/api/teacher/exams/drafts/${encodeURIComponent(draftId)}/compose-append`, {
    method: 'POST',
    body: { ...payload, operationId: operationId || newOperationId() },
  });
}

export async function fetchExamComposeSource(versionId, filters = null) {
  const params = new URLSearchParams();
  if (filters?.skills?.length) params.set('skills', filters.skills.join(','));
  if (filters?.types?.length) params.set('types', filters.types.join(','));
  const qs = params.toString();
  const base = `/api/teacher/exams/versions/${encodeURIComponent(versionId)}/compose-source`;
  return apiFetch(qs ? `${base}?${qs}` : base);
}

export async function saveExamDraft(draftId, payload, operationId) {
  return apiFetch(`/api/teacher/exams/drafts/${encodeURIComponent(draftId)}`, {
    method: 'PUT',
    body: { ...payload, operationId: operationId || newOperationId() },
  });
}

export async function publishExamDraft(draftId, operationId) {
  return apiFetch(`/api/teacher/exams/drafts/${encodeURIComponent(draftId)}/publish`, {
    method: 'POST',
    body: { operationId: operationId || newOperationId() },
  });
}

export async function createExamAssignment(payload, operationId) {
  return apiFetch('/api/teacher/exams/assignments', {
    method: 'POST',
    body: { ...payload, operationId: operationId || newOperationId() },
  });
}

export async function fetchStudentExamAssignments() {
  return apiFetch('/api/student/exams/assignments');
}

export async function fetchStudentExamDetail(assignmentId) {
  return apiFetch(`/api/student/exams/assignments/${encodeURIComponent(assignmentId)}`);
}

export async function startExamAttempt(assignmentId, operationId) {
  return apiFetch('/api/student/exams/attempts/start', {
    method: 'POST',
    body: { assignmentId, operationId: operationId || newOperationId() },
  });
}

export async function saveExamAttemptAnswer(attemptId, payload) {
  return apiFetch(`/api/student/exams/attempts/${encodeURIComponent(attemptId)}/answers`, {
    method: 'POST',
    body: payload,
  });
}

/** @deprecated prefer saveExamAttemptAnswer for typed payloads */
export async function saveExamAnswer(attemptId, questionId, optionId, baseRevision) {
  return saveExamAttemptAnswer(attemptId, { questionId, optionId, baseRevision });
}

export async function saveExamAttemptManualGrades(attemptId, payload, operationId) {
  return apiFetch(`/api/teacher/exams/attempts/${encodeURIComponent(attemptId)}/manual-grades`, {
    method: 'PUT',
    body: { ...payload, operationId: operationId || newOperationId() },
  });
}

export async function saveExamVersionTextAnswerKey(versionId, payload, operationId) {
  return apiFetch(`/api/teacher/exams/versions/${encodeURIComponent(versionId)}/text-answer-key`, {
    method: 'PUT',
    body: { ...payload, operationId: operationId || newOperationId() },
  });
}

export async function submitExamAttempt(attemptId, operationId) {
  return apiFetch(`/api/student/exams/attempts/${encodeURIComponent(attemptId)}/submit`, {
    method: 'POST',
    body: { operationId: operationId || newOperationId() },
  });
}

export async function fetchExamServerNow() {
  return apiFetch('/api/student/exams/server-now');
}

export function examDraftSourceUrl(draftId, { sourceVersionId } = {}) {
  const base = `/api/teacher/exams/drafts/${encodeURIComponent(draftId)}/source`;
  if (sourceVersionId) return `${base}?sourceVersionId=${encodeURIComponent(sourceVersionId)}`;
  return base;
}

export async function fetchExamAssignmentSummary(assignmentId) {
  return apiFetch(`/api/teacher/exams/assignments/${encodeURIComponent(assignmentId)}/summary`);
}

export async function fetchExamAssignmentGrading(assignmentId, attemptId) {
  const q = attemptId ? `?attemptId=${encodeURIComponent(attemptId)}` : '';
  return apiFetch(`/api/teacher/exams/assignments/${encodeURIComponent(assignmentId)}/grading${q}`);
}

export async function fetchTeacherExamVersionStudentPreview(versionId) {
  return apiFetch(`/api/teacher/exams/versions/${encodeURIComponent(versionId)}/student-preview`);
}

export async function saveExamVersionAnswerKey(versionId, payload, operationId) {
  return apiFetch(`/api/teacher/exams/versions/${encodeURIComponent(versionId)}/answer-key`, {
    method: 'PUT',
    body: { ...payload, operationId: operationId || newOperationId() },
  });
}

export function pdfJsModuleUrl() {
  return '/vendor/pdfjs/pdf.mjs';
}

export function pdfJsWorkerUrl() {
  return '/vendor/pdfjs/pdf.worker.mjs';
}

export function pdfLibEsmUrl() {
  return '/vendor/pdf-lib/pdf-lib.esm.min.js';
}

export function studentExamSourcePdfUrl(assignmentId) {
  return `/api/student/exams/assignments/${encodeURIComponent(assignmentId)}/source-pdf`;
}

export function studentExamAudioUrl(assignmentId, groupId = null) {
  const base = `/api/student/exams/assignments/${encodeURIComponent(assignmentId)}/audio`;
  if (groupId) return `${base}?groupId=${encodeURIComponent(groupId)}`;
  return base;
}

export function teacherAttachmentPreviewUrl(attachmentId) {
  return `/api/teacher/attachments/${encodeURIComponent(attachmentId)}`;
}

export function teacherExamSourcePdfUrl(assignmentId) {
  return `/api/teacher/exams/assignments/${encodeURIComponent(assignmentId)}/source-pdf`;
}

export function teacherExamVersionSourcePdfUrl(versionId) {
  return `/api/teacher/exams/versions/${encodeURIComponent(versionId)}/source-pdf`;
}

export async function saveStudentPdfAnnotations(attemptId, body) {
  return apiFetch(`/api/student/exams/attempts/${encodeURIComponent(attemptId)}/pdf-annotations`, {
    method: 'POST',
    body,
  });
}

export async function saveTeacherPdfAnnotations(attemptId, body) {
  return apiFetch(`/api/teacher/exams/attempts/${encodeURIComponent(attemptId)}/pdf-annotations`, {
    method: 'POST',
    body,
  });
}

export async function submitExamAttemptPart(attemptId, part, operationId) {
  return apiFetch(`/api/student/exams/attempts/${encodeURIComponent(attemptId)}/submit-part`, {
    method: 'POST',
    body: { part, operationId: operationId || newOperationId() },
  });
}

export async function saveTeacherPdfManualGrade(attemptId, payload, operationId) {
  return apiFetch(`/api/teacher/exams/attempts/${encodeURIComponent(attemptId)}/pdf-manual-grade`, {
    method: 'PUT',
    body: { ...payload, operationId: operationId || newOperationId() },
  });
}
