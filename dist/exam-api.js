import { apiFetch, newOperationId } from './api-client.js';

export async function fetchExamTeacherSummary() {
  return apiFetch('/api/teacher/exams/summary');
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

export async function saveExamAnswer(attemptId, questionId, optionId, baseRevision) {
  return apiFetch(`/api/student/exams/attempts/${encodeURIComponent(attemptId)}/answers`, {
    method: 'POST',
    body: { questionId, optionId, baseRevision },
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

export function examDraftSourceUrl(draftId) {
  return `/api/teacher/exams/drafts/${encodeURIComponent(draftId)}/source`;
}

export async function fetchExamAssignmentSummary(assignmentId) {
  return apiFetch(`/api/teacher/exams/assignments/${encodeURIComponent(assignmentId)}/summary`);
}

export function pdfJsModuleUrl() {
  return '/vendor/pdfjs/pdf.mjs';
}

export function pdfJsWorkerUrl() {
  return '/vendor/pdfjs/pdf.worker.mjs';
}
