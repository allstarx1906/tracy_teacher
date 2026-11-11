export function normalizeExamState(state) {
  if (!Array.isArray(state.examImports)) state.examImports = [];
  if (!Array.isArray(state.examDrafts)) state.examDrafts = [];
  if (!Array.isArray(state.examVersions)) state.examVersions = [];
  if (!Array.isArray(state.examAssignments)) state.examAssignments = [];
  if (!Array.isArray(state.examAttempts)) state.examAttempts = [];
  return state;
}

export function findExamDraft(state, id) {
  return state.examDrafts.find((d) => d.id === id) || null;
}

export function findExamVersion(state, id) {
  return state.examVersions.find((v) => v.id === id) || null;
}

export function findExamAssignment(state, id) {
  return state.examAssignments.find((a) => a.id === id) || null;
}

/** Resolve published version for an attempt; falls back to assignment.versionId when attempt omits versionId. */
export function resolveAttemptVersion(state, attempt) {
  if (!attempt) return null;
  const assignment = findExamAssignment(state, attempt.assignmentId);
  const versionId = attempt.versionId || assignment?.versionId;
  if (!versionId) return null;
  return findExamVersion(state, versionId);
}

export function resolveAttemptExamContext(state, attempt) {
  if (!attempt) return { assignment: null, version: null };
  const assignment = findExamAssignment(state, attempt.assignmentId);
  const version = resolveAttemptVersion(state, attempt);
  return { assignment, version };
}

export function teacherOwnsExamAttempt(state, attempt, teacherAccountId) {
  const { assignment, version } = resolveAttemptExamContext(state, attempt);
  if (!assignment || assignment.teacherAccountId !== teacherAccountId) return false;
  if (!version) return false;
  if (version.teacherAccountId && version.teacherAccountId !== teacherAccountId) return false;
  return true;
}

export function findExamImportJob(state, id) {
  return state.examImports.find((j) => j.id === id) || null;
}

export function teacherOwnsExamDraft(draft, teacherAccountId) {
  return draft && draft.teacherAccountId === teacherAccountId;
}

export function teacherOwnsImportJob(job, teacherAccountId) {
  return job && job.teacherAccountId === teacherAccountId;
}
