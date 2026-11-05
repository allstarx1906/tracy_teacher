/**
 * Modal host lifecycle for route navigation: authorized dispose must not re-prompt discard.
 */

/** @type {{ disposeA11y: (() => void)|null, onAfterClose: (() => void)|null, cancelOwnedWork: (() => void)|null } | null} */
let boundHost = null;

let authorizedDisposeGeneration = 0;

export function getAuthorizedDialogDisposeGeneration() {
  return authorizedDisposeGeneration;
}

/**
 * @param {{ disposeA11y?: () => void, onAfterClose?: () => void, cancelOwnedWork?: () => void }} bindings
 */
export function bindModalRouteHost(bindings) {
  boundHost = {
    disposeA11y: bindings.disposeA11y ?? null,
    onAfterClose: bindings.onAfterClose ?? null,
    cancelOwnedWork: bindings.cancelOwnedWork ?? null,
  };
  return boundHost;
}

export function clearModalRouteHost(bindings) {
  if (boundHost === bindings) boundHost = null;
}

/**
 * Close and tear down the current modal host after navigation was already authorized
 * (user confirmed discard or route was clean). Must not invoke confirmDiscard again.
 *
 * @param {{ clearRoot: () => void, unregisterDirtyProbe: () => void, bumpDialogGeneration?: () => void }} ctx
 */
export function disposeAuthorizedDialogHost(ctx) {
  authorizedDisposeGeneration += 1;
  ctx.bumpDialogGeneration?.();
  const host = boundHost;
  boundHost = null;
  host?.cancelOwnedWork?.();
  host?.disposeA11y?.();
  ctx.clearRoot();
  host?.onAfterClose?.();
  ctx.unregisterDirtyProbe();
}

/**
 * Simulate stale async dialog callback after authorized dispose + newer dialog opened.
 * @param {number} callbackGeneration captured when dialog opened
 * @param {number} currentGeneration live generation after dispose/open
 */
export function isDialogGenerationLive(callbackGeneration, currentGeneration) {
  return callbackGeneration === currentGeneration;
}
