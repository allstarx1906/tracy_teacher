/**
 * Immutable initiating identity for student photo upload jobs (epoch + principal + view).
 */

/**
 * Capture synchronously at file-selection time — before compression/hash/network.
 * @param {object} deps
 * @param {() => number} deps.getRequestEpoch
 * @param {() => string} deps.getAuthPrincipal
 * @param {string} deps.assignmentId
 * @param {number} deps.viewGeneration
 * @param {() => boolean} deps.isViewLive per-assignment edit host, not persistent app-root
 */
export function captureStudentPhotoInitiatingContext(deps) {
  const epoch = deps.getRequestEpoch();
  const principal = deps.getAuthPrincipal();
  const assignmentId = deps.assignmentId;
  const viewGeneration = deps.viewGeneration;
  const isViewLive = deps.isViewLive;
  return Object.freeze({ epoch, principal, assignmentId, viewGeneration, isViewLive });
}

/**
 * @param {ReturnType<typeof captureStudentPhotoInitiatingContext>|null|undefined} ctx
 * @param {{
 *   isStaleEpoch: (epoch: number) => boolean,
 *   getAuthPrincipal: () => string,
 *   liveView: { assignmentId: string, viewGeneration: number } | null | undefined,
 * }} deps
 */
export function isStudentPhotoInitiatingContextStale(ctx, deps) {
  if (!ctx) return true;
  if (deps.isStaleEpoch(ctx.epoch)) return true;
  if (deps.getAuthPrincipal() !== ctx.principal) return true;
  const lv = deps.liveView;
  if (!lv || lv.viewGeneration !== ctx.viewGeneration) return true;
  if (lv.assignmentId !== ctx.assignmentId) return true;
  if (typeof ctx.isViewLive === 'function' && !ctx.isViewLive()) return true;
  return false;
}

export function staleStudentPhotoAuthError() {
  const err = new Error('stale-session');
  err.staleAuth = true;
  return err;
}
