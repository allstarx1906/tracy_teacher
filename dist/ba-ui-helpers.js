import {
  loadAppData,
  getRequestEpoch,
  captureAuthPrincipal,
  isInitiatingAuthStale,
} from './api-client.js';
import {
  newClientOperationId,
  runMutationGuard,
  withBusyButton,
  snapshotFormDirty,
  registerDirtyProbe,
} from './ux-forms.js';
import { getActiveBaViewScope } from './ba-ui-scoped.js';

export async function safeReloadAppData(ctx, guards = null) {
  const epoch = guards?.epoch ?? getRequestEpoch();
  const principal = guards?.principal ?? captureAuthPrincipal();
  const viewGen = guards?.viewGen;
  const data = await loadAppData();
  if (isInitiatingAuthStale(epoch, principal)) return false;
  const scope = getActiveBaViewScope();
  if (viewGen != null && scope && scope.generation !== viewGen) return false;
  ctx.state.data = data;
  return true;
}

/**
 * @param {HTMLElement} btn
 * @param {string} guardKey
 * @param {string} busyLabel
 * @param {() => Promise<void>} fn
 */
export async function runBaMutation(btn, guardKey, busyLabel, fn) {
  if (busyKeys.has(guardKey)) return { skipped: true };
  busyKeys.add(guardKey);
  try {
    return await withBusyButton(btn, busyLabel, async () => {
      const out = await runMutationGuard(guardKey, fn);
      return out;
    });
  } finally {
    busyKeys.delete(guardKey);
  }
}

const busyKeys = new Set();

export function registerBaFormDirty(fields) {
  const dirty = snapshotFormDirty(fields);
  const scope = getActiveBaViewScope();
  if (scope) {
    scope.probes.push(dirty);
    for (const f of fields) {
      if (f?.addEventListener) scope.fields.push(f);
    }
    const combined = () => scope.probes.some((p) => {
      try { return p(); } catch { return false; }
    });
    combined.markClean = () => {
      for (const p of scope.probes) p.markClean?.();
    };
    registerDirtyProbe(combined, { fields: scope.fields });
  } else {
    registerDirtyProbe(dirty, { fields });
  }
  return dirty;
}

export function stableOperationPayload(formValues) {
  return JSON.stringify(formValues);
}

export function newBaOperationId() {
  return newClientOperationId();
}
