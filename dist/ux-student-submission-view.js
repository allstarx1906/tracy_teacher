/**
 * Student assignment photo edit view: per-entry generation + assignment id (not app-root).
 */

/**
 * @param {number} capturedViewGeneration
 * @param {{ assignmentId: string, viewGeneration: number } | null | undefined} liveView
 * @param {HTMLElement | null | undefined} viewHostEl container for this edit surface
 */
export function isStudentSubmissionViewHostLive(capturedViewGeneration, liveView, viewHostEl) {
  if (!liveView || liveView.viewGeneration !== capturedViewGeneration) return false;
  if (viewHostEl && viewHostEl.isConnected === false) return false;
  return true;
}

/**
 * Guard async student submission UI after await (navigate away, re-enter same assignment, auth drift).
 * @param {{
 *   assignmentId: string,
 *   viewGeneration: number,
 *   epoch: number,
 *   principal: string,
 * }} captured scope captured at save/submit/upload entry (sync)
 * @param {{
 *   liveView: { assignmentId: string, viewGeneration: number } | null | undefined,
 *   isStaleEpoch: (epoch: number) => boolean,
 *   getAuthPrincipal: () => string,
 *   viewHostEl?: HTMLElement | null,
 * }} live
 */
export function shouldApplyStudentSubmissionUiWork(captured, live) {
  if (!captured) return false;
  const lv = live.liveView;
  if (!lv || lv.viewGeneration !== captured.viewGeneration) return false;
  if (lv.assignmentId !== captured.assignmentId) return false;
  if (live.isStaleEpoch(captured.epoch)) return false;
  if (live.getAuthPrincipal() !== captured.principal) return false;
  if (live.viewHostEl && live.viewHostEl.isConnected === false) return false;
  return true;
}

/**
 * @param {{
 *   assignmentId: string,
 *   viewGeneration: number,
 *   epoch: number,
 *   principal: string,
 *   getRequestEpoch: () => number,
 *   getAuthPrincipal: () => string,
 * }} deps
 */
export function captureStudentSubmissionUiScope(deps) {
  return Object.freeze({
    assignmentId: deps.assignmentId,
    viewGeneration: deps.viewGeneration,
    epoch: deps.getRequestEpoch(),
    principal: deps.getAuthPrincipal(),
  });
}
