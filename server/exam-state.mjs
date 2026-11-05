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

export function findExamImportJob(state, id) {
  return state.examImports.find((j) => j.id === id) || null;
}

export function teacherOwnsExamDraft(draft, teacherAccountId) {
  return draft && draft.teacherAccountId === teacherAccountId;
}

export function teacherOwnsImportJob(job, teacherAccountId) {
  return job && job.teacherAccountId === teacherAccountId;
}
