/**
 * Shared busy guard for explicit grading mutating persists (draft / publish / revision).
 * Autosave drafts queue behind in-flight draft work and pause while explicit actions run.
 */

/**
 * @param {() => boolean} isBusy
 * @param {(...args: unknown[]) => unknown} handler
 */
export function guardGradingNotBusy(isBusy, handler) {
  return (...args) => {
    if (isBusy()) return;
    return handler(...args);
  };
}

/**
 * @param {object} deps
 * @param {(busy: boolean) => void} [deps.onBusyChange]
 */
export function createGradingMutatingCoordinator(deps = {}) {
  let disposed = false;
  let actionBusy = false;
  /** @type {Promise<void> | null} */
  let inFlightDraft = null;
  /** @type {(() => Promise<void>) | null} */
  let deferredAutosaveFn = null;

  function isBusy() {
    return actionBusy;
  }

  function isDisposed() {
    return disposed;
  }

  function setBusy(next) {
    if (disposed) return;
    actionBusy = next;
    deps.onBusyChange?.(next);
  }

  async function waitPendingDraft() {
    if (!inFlightDraft) return;
    try {
      await inFlightDraft;
    } catch {
      /* persist layer owns error UI */
    }
  }

  function flushDeferredAutosave() {
    if (disposed || actionBusy || !deferredAutosaveFn) return;
    const fn = deferredAutosaveFn;
    deferredAutosaveFn = null;
    queueAutosaveDraft(fn);
  }

  function clearDeferredAutosave() {
    deferredAutosaveFn = null;
  }

  /**
   * @template T
   * @param {() => Promise<T>} fn
   * @returns {Promise<{ skipped: true, disposed?: boolean } | { skipped: false, result: T }>}
   */
  async function runExplicitAction(fn) {
    if (disposed || actionBusy) return { skipped: true };
    setBusy(true);
    try {
      await waitPendingDraft();
      if (disposed) return { skipped: true, disposed: true };
      const result = await fn();
      if (disposed) return { skipped: true, disposed: true };
      return { skipped: false, result };
    } finally {
      if (!disposed) setBusy(false);
      flushDeferredAutosave();
    }
  }

  /**
   * Fire-and-forget autosave; coalesced while an explicit action holds the lock.
   * @param {() => Promise<void>} fn
   */
  function queueAutosaveDraft(fn) {
    if (disposed) return;
    if (actionBusy) {
      deferredAutosaveFn = fn;
      return;
    }

    const run = (async () => {
      if (inFlightDraft) {
        try {
          await inFlightDraft;
        } catch {
          /* ignore */
        }
      }
      if (disposed || actionBusy) {
        if (!disposed && actionBusy) deferredAutosaveFn = fn;
        return;
      }
      await fn();
    })();

    inFlightDraft = run;
    run.finally(() => {
      if (inFlightDraft === run) inFlightDraft = null;
    });
  }

  function dispose() {
    disposed = true;
    deferredAutosaveFn = null;
  }

  return {
    isBusy,
    isDisposed,
    runExplicitAction,
    queueAutosaveDraft,
    waitPendingDraft,
    clearDeferredAutosave,
    dispose,
  };
}

/**
 * After publish/revision explicit action completes and busy lock is released, navigation is safe.
 * @param {{ skipped?: boolean, result?: { didPublish?: boolean } }} ran
 * @param {{ isBusy: () => boolean, isEditorLive: () => boolean }} deps
 */
export function shouldNavigateAfterGradingPublish(ran, deps) {
  if (!ran || ran.skipped) return false;
  if (!ran.result?.didPublish) return false;
  if (deps.isBusy()) return false;
  if (!deps.isEditorLive()) return false;
  return true;
}

/**
 * @param {HTMLElement} btn
 * @param {string} idleLabel
 * @param {boolean} busy
 */
export function syncGradingMutatingButton(btn, idleLabel, busy) {
  if (!btn) return;
  btn.disabled = busy;
  if (busy) {
    btn.setAttribute('aria-busy', 'true');
    btn.textContent = 'Đang lưu…';
  } else {
    btn.removeAttribute('aria-busy');
    btn.textContent = idleLabel;
  }
}
