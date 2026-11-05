/**
 * BA view-scoped forms: aggregated dirty probes, auth/view guards, stable operation IDs.
 */
import {
  getRequestEpoch,
  captureAuthPrincipal,
  isInitiatingAuthStale,
  loadAppData,
} from './api-client.js';
import {
  registerDirtyProbe,
  snapshotFormDirty,
  captureAcknowledgedFormSnapshot,
  runMutationGuard,
  newClientOperationId,
} from './ux-forms.js';

/** @type {{ generation: number, probes: Array<() => boolean>, fields: object[], dispose: () => void } | null} */
let activeViewScope = null;
let viewGenerationCounter = 0;

/** @type {Map<string, { operationId: string, payloadJson: string }>} */
const pendingOperations = new Map();

/** @type {Map<string, { epoch: number, principal: object, payloadJson: string }>} */
const pendingReloadAfterAck = new Map();

export function getActiveBaViewScope() {
  return activeViewScope;
}

export function disposeActiveBaViewScope() {
  activeViewScope?.dispose();
}

export function beginBaViewScope() {
  activeViewScope?.dispose();
  viewGenerationCounter += 1;
  const probes = [];
  const watchFields = [];
  const scope = {
    generation: viewGenerationCounter,
    probes,
    fields: watchFields,
    dispose() {
      if (activeViewScope !== scope) return;
      registerDirtyProbe(null);
      activeViewScope = null;
    },
  };
  activeViewScope = scope;
  syncScopeDirtyProbe(scope);
  return scope;
}

function syncScopeDirtyProbe(scope) {
  const combined = () => scope.probes.some((p) => {
    try { return p(); } catch { return false; }
  });
  combined.markClean = () => {
    for (const p of scope.probes) p.markClean?.();
  };
  registerDirtyProbe(combined, { fields: scope.fields });
}

export function registerBaViewDirty(scope, fields, extra) {
  if (!scope) return () => false;
  const probe = snapshotFormDirty(fields, extra);
  scope.probes.push(probe);
  for (const f of fields) {
    if (f?.addEventListener) scope.fields.push(f);
  }
  syncScopeDirtyProbe(scope);
  return probe;
}

export function isBaViewStale(scope, epoch, principal) {
  if (!scope || activeViewScope !== scope) return true;
  if (isInitiatingAuthStale(epoch, principal)) return true;
  return false;
}

export async function reloadBaViewData(ctx, scope, epoch, principal) {
  if (isBaViewStale(scope, epoch, principal)) return false;
  let data;
  try {
    data = await loadAppData();
  } catch {
    return false;
  }
  if (isBaViewStale(scope, epoch, principal)) return false;
  ctx.state.data = data;
  return true;
}

export function resolveBaOperationId(guardKey, payload) {
  const json = JSON.stringify(payload);
  const prev = pendingOperations.get(guardKey);
  if (prev && prev.payloadJson === json) return prev.operationId;
  const operationId = newClientOperationId();
  pendingOperations.set(guardKey, { operationId, payloadJson: json });
  return operationId;
}

export function ackBaOperation(guardKey) {
  pendingOperations.delete(guardKey);
}

function scopeHasOtherDirty(scope, exceptProbe) {
  if (!scope?.probes?.length) return false;
  return scope.probes.some((p) => {
    if (p === exceptProbe) return false;
    try { return p(); } catch { return false; }
  });
}

function captureControlState(fields, buttons, btn) {
  const fieldStates = (fields || []).map((f) => (f ? !!f.disabled : true));
  const buttonStates = (buttons || []).map((b) => (b ? !!b.disabled : true));
  const btnWasDisabled = btn ? !!btn.disabled : true;
  return { fieldStates, buttonStates, btnWasDisabled };
}

function lockControls(fields, buttons, btn, state, busyLabel) {
  for (let i = 0; i < (fields || []).length; i += 1) {
    const f = fields[i];
    if (!f || state.fieldStates[i]) continue;
    f.disabled = true;
    f.setAttribute?.('aria-disabled', 'true');
  }
  for (let i = 0; i < (buttons || []).length; i += 1) {
    const b = buttons[i];
    if (!b || state.buttonStates[i]) continue;
    b.dataset.baLocked = '1';
    b.disabled = true;
  }
  if (btn && !state.btnWasDisabled) {
    btn.disabled = true;
    btn.setAttribute('aria-busy', 'true');
    if (busyLabel) btn.textContent = busyLabel;
  }
}

function unlockControls(fields, buttons, btn, state, prevLabel) {
  for (let i = 0; i < (fields || []).length; i += 1) {
    const f = fields[i];
    if (!f || state.fieldStates[i]) continue;
    f.disabled = false;
    f.removeAttribute?.('aria-disabled');
  }
  for (let i = 0; i < (buttons || []).length; i += 1) {
    const b = buttons[i];
    if (!b || !b.dataset?.baLocked) continue;
    delete b.dataset.baLocked;
    if (!state.buttonStates[i]) b.disabled = false;
  }
  if (btn && !state.btnWasDisabled) {
    btn.disabled = false;
    btn.removeAttribute('aria-busy');
    if (prevLabel != null) btn.textContent = prevLabel;
  }
}

async function finishAfterWriteAck(ctx, scope, opts, epoch, principal, ackMatchFn, payloadJson) {
  let reloaded = false;
  try {
    reloaded = await reloadBaViewData(ctx, scope, epoch, principal);
  } catch {
    reloaded = false;
  }

  if (!reloaded) {
    if (isBaViewStale(scope, epoch, principal)) {
      return { ok: false, stale: true };
    }
    pendingReloadAfterAck.set(opts.guardKey, { epoch, principal, payloadJson });
    ctx.toastErr?.('Đã lưu nhưng không tải lại được dữ liệu — thử lưu lại để tải dữ liệu.');
    return { ok: false, reloadFailed: true };
  }

  pendingReloadAfterAck.delete(opts.guardKey);

  const matchesSnapshot = ackMatchFn();
  const otherDirty = scopeHasOtherDirty(scope, opts.dirtyProbe);
  const safeToReset = matchesSnapshot && !otherDirty;

  if (matchesSnapshot) {
    opts.dirtyProbe?.markClean?.();
  }

  const msg = safeToReset
    ? opts.successMessage
    : (opts.pendingChangesMessage
      || `${opts.successMessage} (còn thay đổi chưa lưu trên màn hình)`);
  ctx.toastOk?.(msg);

  const callbackResult = { matchesSnapshot, safeToReset };
  if (opts.onSuccess) {
    opts.onSuccess(callbackResult);
  } else if (safeToReset && !opts.skipFullRender) {
    ctx.renderApp?.();
  }

  return { ok: true, ...callbackResult };
}

async function withSubmitControlsLocked(opts, controlState, prevLabel, fn) {
  lockControls(opts.fields, opts.buttons, opts.btn, controlState, opts.busyLabel);
  try {
    return await fn();
  } finally {
    unlockControls(opts.fields, opts.buttons, opts.btn, controlState, prevLabel);
  }
}

/**
 * @param {object} ctx
 * @param {ReturnType<typeof beginBaViewScope>} scope
 * @param {{
 *   guardKey: string,
 *   btn?: HTMLElement,
 *   busyLabel?: string,
 *   fields?: HTMLElement[],
 *   buttons?: HTMLElement[],
 *   readPayload: () => object,
 *   write: (payload: object, operationId: string) => Promise<void>,
 *   dirtyProbe?: { markClean?: () => void },
 *   matchesAck?: () => boolean,
 *   successMessage: string,
 *   pendingChangesMessage?: string,
 *   onSuccess?: (result: { matchesSnapshot: boolean, safeToReset: boolean }) => void,
 *   skipFullRender?: boolean,
 * }} opts
 */
export async function runBaScopedSubmit(ctx, scope, opts) {
  const epoch = getRequestEpoch();
  const principal = captureAuthPrincipal();
  const payload = opts.readPayload();
  const payloadJson = JSON.stringify(payload);
  const ackMatchFn = opts.matchesAck || captureAcknowledgedFormSnapshot(opts.readPayload);

  const btn = opts.btn;
  if (btn?.disabled) return { skipped: true };

  const controlState = captureControlState(opts.fields, opts.buttons, btn);
  const prevLabel = btn?.textContent;

  const pendingReload = pendingReloadAfterAck.get(opts.guardKey);
  if (pendingReload) {
    if (pendingReload.payloadJson !== payloadJson) {
      pendingReloadAfterAck.delete(opts.guardKey);
    } else {
      /** @type {{ ok?: boolean, stale?: boolean, reloadFailed?: boolean, matchesSnapshot?: boolean, safeToReset?: boolean, skipped?: boolean }} */
      let result = { ok: false };
      const guard = await runMutationGuard(opts.guardKey, async () => {
        result = await withSubmitControlsLocked(opts, controlState, prevLabel, async () => finishAfterWriteAck(
          ctx,
          scope,
          opts,
          pendingReload.epoch,
          pendingReload.principal,
          ackMatchFn,
          payloadJson,
        ));
      });
      if (guard.skipped) return { skipped: true };
      return result;
    }
  }

  const operationId = resolveBaOperationId(opts.guardKey, payload);
  const body = { ...payload, operationId };

  /** @type {{ ok?: boolean, stale?: boolean, reloadFailed?: boolean, matchesSnapshot?: boolean, safeToReset?: boolean, error?: unknown, skipped?: boolean }} */
  let result = { ok: false };
  const guard = await runMutationGuard(opts.guardKey, async () => {
    result = await withSubmitControlsLocked(opts, controlState, prevLabel, async () => {
      try {
        await opts.write(body, operationId);
      } catch (e) {
        if (!isBaViewStale(scope, epoch, principal)) {
          ctx.toastErr?.(e.message || 'Lỗi lưu.');
        }
        return { ok: false, error: e };
      }
      if (isBaViewStale(scope, epoch, principal)) {
        return { ok: false, stale: true };
      }
      ackBaOperation(opts.guardKey);
      return finishAfterWriteAck(ctx, scope, opts, epoch, principal, ackMatchFn, payloadJson);
    });
  });
  if (guard.skipped) return { skipped: true };
  return result;
}
