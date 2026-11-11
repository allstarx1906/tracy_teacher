import { studentCanAccessAssignmentClass } from '../dist/ba-domain.js';
import {
  EXAM_ATTEMPT_STATUS,
  EXAM_AUDIO_STATE,
  normalizeExamDeliveryMode,
  pickExamMediaAttachmentFromSnapshot,
  pickExamMediaBindingAttachmentId,
  buildAssignmentMediaSnapshot,
} from '../dist/exam-domain.js';
import { findExamAssignment, findExamVersion, resolveAttemptExamContext } from './exam-state.mjs';
import { isExamAudioMime } from './exam-audio.mjs';

function assignmentUsesAttachment(state, assignment, attachmentId) {
  if (assignment.sourcePdfAttachmentId === attachmentId) return true;
  const snap = assignment.mediaSnapshot;
  if (snap?.audioAttachmentId === attachmentId) return true;
  if (pickExamMediaAttachmentFromSnapshot(snap) === attachmentId) return true;
  const mb = snap?.mediaBindings;
  if (mb?.paper && pickExamMediaBindingAttachmentId(mb.paper) === attachmentId) return true;
  if (mb?.groups) {
    for (const g of Object.values(mb.groups)) {
      if (pickExamMediaBindingAttachmentId(g) === attachmentId) return true;
    }
  }
  const version = findExamVersion(state, assignment.versionId);
  if (version?.sourceAttachmentId === attachmentId) return true;
  if (version?.audioAttachmentId === attachmentId) return true;
  if (pickExamMediaAttachmentFromSnapshot(buildAssignmentMediaSnapshot(version)) === attachmentId) return true;
  return false;
}

function studentAttemptsForAssignment(state, assignmentId, studentId) {
  return (state.examAttempts || []).filter(
    (a) => a.assignmentId === assignmentId && a.studentId === studentId,
  );
}

function versionReferencesAttachment(version, attachmentId) {
  if (!version) return false;
  if (version.sourceAttachmentId === attachmentId || version.audioAttachmentId === attachmentId) return true;
  const mb = version.mediaBindings;
  if (!mb || typeof mb !== 'object') return false;
  if (pickExamMediaBindingAttachmentId(mb.paper) === attachmentId) return true;
  if (mb.groups) {
    for (const g of Object.values(mb.groups)) {
      if (pickExamMediaBindingAttachmentId(g) === attachmentId) return true;
    }
  }
  if (mb.questions) {
    for (const q of Object.values(mb.questions)) {
      if (pickExamMediaBindingAttachmentId(q) === attachmentId) return true;
    }
  }
  return false;
}

export function teacherOwnsExamAttachment(state, teacherAccountId, attachmentId) {
  const meta = state.attachmentMeta?.[attachmentId];
  if (!meta || meta.ownerAccountId !== teacherAccountId) return false;
  for (const v of state.examVersions || []) {
    if (v.teacherAccountId !== teacherAccountId) continue;
    if (versionReferencesAttachment(v, attachmentId)) return true;
  }
  for (const d of state.examDrafts || []) {
    if (d.teacherAccountId !== teacherAccountId) continue;
    if (versionReferencesAttachment(d, attachmentId)) return true;
  }
  return meta.ownerAccountId === teacherAccountId;
}

export function canStudentAccessExamAttachment(state, student, attachmentId, getNow) {
  if (!student || !attachmentId) return false;
  const now = getNow();
  for (const assignment of state.examAssignments || []) {
    if (!studentCanAccessAssignmentClass(student, assignment.classId, state.memberships || [], now)) {
      continue;
    }
    if (!assignmentUsesAttachment(state, assignment, attachmentId)) continue;
    const attempts = studentAttemptsForAssignment(state, assignment.id, student.id);
    if (!attempts.length) continue;
    const open = assignment.openAt && now < assignment.openAt;
    const pastDue = assignment.dueAt && now >= assignment.dueAt;
    const hasActive = attempts.some((a) => a.status === EXAM_ATTEMPT_STATUS.IN_PROGRESS);
    const hasSubmitted = attempts.some(
      (a) => a.status === EXAM_ATTEMPT_STATUS.SUBMITTED || a.status === EXAM_ATTEMPT_STATUS.EXPIRED,
    );
    if (open && !hasActive && !hasSubmitted) continue;
    if (pastDue && !hasActive && !hasSubmitted) continue;
    return true;
  }
  return false;
}

export function canAccessExamAttachment(state, auth, attachmentId, getNow) {
  if (!attachmentId) return false;
  if (auth.role === 'teacher') {
    return teacherOwnsExamAttachment(state, auth.account.id, attachmentId);
  }
  const student = auth.student || state.students.find((s) => s.id === auth.studentId);
  if (!student) return false;
  const meta = state.attachmentMeta?.[attachmentId];
  if (!meta) return false;
  if (!isExamAudioMime(meta.mime) && meta.mime !== 'application/pdf') return false;
  return canStudentAccessExamAttachment(state, student, attachmentId, getNow);
}

export function resolveAuthorizedExamSourcePdfAttachmentId(state, assignment, version) {
  if (assignment?.sourcePdfAttachmentId) return assignment.sourcePdfAttachmentId;
  return version?.sourceAttachmentId || null;
}

export function resolveStudentExamAudioAttachmentId(state, assignment, attempt, version, { groupId = null } = {}) {
  const submitted = attempt?.status === EXAM_ATTEMPT_STATUS.SUBMITTED
    || attempt?.status === EXAM_ATTEMPT_STATUS.EXPIRED;
  if (submitted) {
    const snap = attempt?.submissionMediaSnapshot || assignment?.mediaSnapshot;
    return pickExamMediaAttachmentFromSnapshot(snap, { groupId });
  }
  const fromAssignment = pickExamMediaAttachmentFromSnapshot(assignment?.mediaSnapshot, { groupId });
  if (fromAssignment) return fromAssignment;
  const fromLiveVersion = pickExamMediaAttachmentFromSnapshot(buildAssignmentMediaSnapshot(version), { groupId });
  if (fromLiveVersion) return fromLiveVersion;
  if (version?.audioAttachmentId && version?.audioState !== EXAM_AUDIO_STATE.REMOVED) {
    return version.audioAttachmentId;
  }
  return null;
}

export function studentMayStreamExamAudio(state, auth, assignmentId, getNow, { groupId = null } = {}) {
  const assignment = findExamAssignment(state, assignmentId);
  if (!assignment) return { ok: false, error: 'missing-assignment' };
  const student = auth.student || state.students.find((s) => s.id === auth.studentId);
  if (!student) return { ok: false, error: 'missing-student' };
  if (!studentCanAccessAssignmentClass(student, assignment.classId, state.memberships || [], getNow())) {
    return { ok: false, error: 'forbidden' };
  }
  const version = findExamVersion(state, assignment.versionId);
  const attempts = studentAttemptsForAssignment(state, assignment.id, student.id);
  const attempt = attempts.find((a) => a.status === EXAM_ATTEMPT_STATUS.IN_PROGRESS)
    || attempts.sort((a, b) => (b.startedAt || '').localeCompare(a.startedAt || ''))[0];
  const attId = resolveStudentExamAudioAttachmentId(state, assignment, attempt, version, { groupId });
  if (attId) return { ok: true, attachmentId: attId };
  const mode = normalizeExamDeliveryMode(assignment);
  if (
    assignment.classroomPlaybackAllowed
    || version?.classroomPlaybackAllowed
    || assignment.mediaSnapshot?.classroomPlaybackAllowed
  ) {
    return { ok: true, attachmentId: null, classroomPlayback: true, deliveryMode: mode };
  }
  return { ok: false, error: 'audio-unavailable' };
}
