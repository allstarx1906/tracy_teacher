/**
 * Student photo draft UI: shared busy for uploads + save/submit snapshot ops.
 */

export function isStudentPhotoMutationBlocked(
  draftActionBusy,
  pendingUploadCount,
  baselineFingerprintPrepPending = false,
) {
  return !!draftActionBusy || pendingUploadCount > 0 || !!baselineFingerprintPrepPending;
}

/**
 * @param {boolean} blocked
 * @param {() => void} fn
 * @returns {boolean} whether mutation ran
 */
export function guardStudentPhotoMutation(blocked, fn) {
  if (blocked) return false;
  fn();
  return true;
}

/**
 * @param {string[]} pages live draft page ids (mutated in place when allowed)
 * @param {() => Promise<void>} waitUploads
 * @param {(snapshot: string[]) => Promise<boolean>} persistSnapshot
 */
export async function runStudentPhotoDraftPersist(pages, waitUploads, persistSnapshot) {
  await waitUploads();
  const snapshot = [...pages];
  const ok = await persistSnapshot(snapshot);
  return { ok, snapshot };
}
