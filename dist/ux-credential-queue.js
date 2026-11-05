/**
 * In-memory FIFO queue for one-time credential dialogs (reset/create/recovery).
 * Never replaces unrelated modals; secrets stay in RAM only for this auth session.
 */

/** @type {import('./ux-notify.js').openCredentialsDialog extends (...args: infer A) => unknown ? A : never} */
let deps = null;

/** @type {Array<{ id: number, accountKey: string, accountSeq: number, requestEpoch: number, accountsViewGeneration: number|null, spec: { title: string, lines: string[], copyValue?: string }, invalidated: boolean }>} */
let fifo = [];

let nextEntryId = 1;
/** @type {Map<string, number>} */
const accountSequence = new Map();
let presenting = false;
let pendingNoticeGeneration = 0;
/** @type {ReturnType<typeof setTimeout>|null} */
let drainTimer = null;

export const CREDENTIAL_DIALOG_KIND = 'credential';

export function configureCredentialQueue(host) {
  deps = host;
}

export function clearCredentialQueueSecrets() {
  fifo = [];
  accountSequence.clear();
  presenting = false;
  pendingNoticeGeneration += 1;
  if (drainTimer != null) {
    clearTimeout(drainTimer);
    drainTimer = null;
  }
  deps?.hidePendingNotice?.();
}

/**
 * @param {{ accountKey?: string, requestEpoch: number, accountsViewGeneration?: number|null, title: string, lines: string[], copyValue?: string }} entry
 */
export function showCredentialDialog(entry) {
  if (!deps) throw new Error('credential queue not configured');
  const accountKey = entry.accountKey || entry.title;
  const accountSeq = (accountSequence.get(accountKey) || 0) + 1;
  accountSequence.set(accountKey, accountSeq);
  for (const item of fifo) {
    if (item.accountKey === accountKey && !item.invalidated) {
      item.invalidated = true;
    }
  }
  fifo.push({
    id: nextEntryId++,
    accountKey,
    accountSeq,
    requestEpoch: entry.requestEpoch,
    accountsViewGeneration: entry.accountsViewGeneration ?? null,
    spec: {
      title: entry.title,
      lines: [...entry.lines],
      copyValue: entry.copyValue,
    },
    invalidated: false,
  });
  scheduleDrain();
  updatePendingNotice();
}

export function refreshCredentialQueuePresentation() {
  updatePendingNotice();
  if (deps?.isAccountsViewActive?.()) {
    tryPresentNextCredential();
  }
}

export function onCredentialRouteNavigation() {
  presenting = false;
  refreshCredentialQueuePresentation();
}

export function notifyCredentialDialogClosed() {
  presenting = false;
  scheduleDrain();
}

export function hasForeignModalBlockingCredentials() {
  if (!deps?.getDialogRootFirstChild) return false;
  const backdrop = deps.getDialogRootFirstChild();
  if (!backdrop) return false;
  return backdrop.dataset?.dialogKind !== CREDENTIAL_DIALOG_KIND;
}

function scheduleDrain() {
  if (drainTimer != null) return;
  drainTimer = setTimeout(() => {
    drainTimer = null;
    tryPresentNextCredential();
  }, 0);
}

function updatePendingNotice() {
  const pending = fifo.filter((i) => !i.invalidated && isEntryStillValid(i));
  if (pending.length === 0) {
    pendingNoticeGeneration += 1;
    deps?.hidePendingNotice?.();
    return;
  }
  const gen = ++pendingNoticeGeneration;
  const count = pending.length;
  const label = count === 1
    ? 'Có mật khẩu tạm chờ xem.'
    : `Có ${count} mật khẩu tạm chờ xem.`;
  deps?.showPendingNotice?.({
    message: label,
    generation: gen,
    onOpen: () => {
      if (gen !== pendingNoticeGeneration) return;
      tryPresentNextCredential({ userInitiated: true });
    },
  });
}

function isEntryStillValid(item) {
  if (item.invalidated) return false;
  if (deps.isStaleEpoch(item.requestEpoch)) return false;
  return true;
}

function dropInvalidHead() {
  while (fifo.length > 0) {
    const head = fifo[0];
    if (!head.invalidated && isEntryStillValid(head)) return head;
    fifo.shift();
  }
  return null;
}

/**
 * @param {{ userInitiated?: boolean }} [opts]
 */
export function tryPresentNextCredential(opts = {}) {
  if (!deps || presenting) return false;
  if (hasForeignModalBlockingCredentials()) return false;
  if (!opts.userInitiated && !deps.isAccountsViewActive?.()) {
    updatePendingNotice();
    return false;
  }
  if (opts.userInitiated && !deps.isAccountsViewActive?.()) {
    deps.toastInfo?.('Mở trang Tài khoản học sinh để xem mật khẩu tạm.');
    return false;
  }
  const item = dropInvalidHead();
  if (!item) {
    updatePendingNotice();
    return false;
  }
  if (hasForeignModalBlockingCredentials()) {
    updatePendingNotice();
    return false;
  }
  presenting = true;
  const spec = {
    title: item.spec.title,
    lines: [...item.spec.lines],
    copyValue: item.spec.copyValue,
  };
  fifo.shift();
  updatePendingNotice();
  deps.openCredentialsDialog(spec, (title, body, actions, options = {}) => {
    return deps.openDialog(title, body, actions, {
      ...options,
      dialogKind: CREDENTIAL_DIALOG_KIND,
      onAfterClose: () => {
        spec.copyValue = undefined;
        item.spec.copyValue = undefined;
        notifyCredentialDialogClosed();
        options.onAfterClose?.();
      },
    });
  }, deps.mkEl);
  return true;
}

/**
 * Stale async handlers must call before presenting credentials directly.
 * @param {{ requestEpoch: number, accountKey: string, accountSeq: number }} ctx
 */
export function shouldApplyCredentialCallback(ctx) {
  if (!deps || deps.isStaleEpoch(ctx.requestEpoch)) return false;
  const live = accountSequence.get(ctx.accountKey) || 0;
  if (ctx.accountSeq < live) return false;
  return true;
}

export function getCredentialQueueDepthForTests() {
  return fifo.filter((i) => !i.invalidated && isEntryStillValid(i)).length;
}

export function peekCredentialQueueAccountKeysForTests() {
  return fifo.filter((i) => !i.invalidated).map((i) => i.accountKey);
}
