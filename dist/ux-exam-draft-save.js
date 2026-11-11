/**
 * Teacher exam draft editor: dirty generation vs in-flight PUT acks and serialized writes.
 */

export function createExamDraftSaveCoordinator() {
  let dirtyGeneration = 0;
  let saveChain = Promise.resolve();

  function bumpDirtyGeneration() {
    dirtyGeneration += 1;
    return dirtyGeneration;
  }

  function resetDirtyGeneration() {
    dirtyGeneration = 0;
  }

  function currentDirtyGeneration() {
    return dirtyGeneration;
  }

  function shouldMarkCleanAfterSave(savedAtGeneration) {
    return savedAtGeneration === dirtyGeneration;
  }

  function runSerializedWrite(fn) {
    const run = saveChain.then(fn, fn);
    saveChain = run.catch(() => {});
    return run;
  }

  return {
    bumpDirtyGeneration,
    resetDirtyGeneration,
    currentDirtyGeneration,
    shouldMarkCleanAfterSave,
    runSerializedWrite,
  };
}

/** Deep snapshot for PUT — do not mutate live draft question objects after this. */
export function snapshotExamDraftPutPayload({
  title,
  questions,
  passages,
  sections,
  teacherConfirmedReview,
  gradingMode,
  baseRevision,
}) {
  return {
    title,
    questions: JSON.parse(JSON.stringify(questions)),
    passages: JSON.parse(JSON.stringify(passages)),
    sections: JSON.parse(JSON.stringify(sections)),
    teacherConfirmedReview,
    gradingMode,
    baseRevision,
  };
}

export function applyExamDraftSaveAck(coordinator, savedAtGeneration, onClean) {
  if (!coordinator.shouldMarkCleanAfterSave(savedAtGeneration)) return false;
  onClean();
  return true;
}
