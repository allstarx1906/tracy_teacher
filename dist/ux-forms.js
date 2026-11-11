/**
 * Form UX: mutation guards, dirty navigation, accessible dialog wiring.
 */

const mutationGuards = new Map();

export function newClientOperationId() {
  return crypto.randomUUID();
}

/**
 * Prevent double-submit for the same logical key (e.g. 'login').
 * @param {string} key
 * @param {() => Promise<void>} fn
 */
export async function runMutationGuard(key, fn) {
  if (mutationGuards.get(key)) return { skipped: true };
  mutationGuards.set(key, true);
  try {
    await fn();
    return { skipped: false, ok: true };
  } finally {
    mutationGuards.delete(key);
  }
}

/**
 * @param {HTMLButtonElement} btn
 * @param {string} busyLabel
 * @param {() => Promise<void>} fn
 */
export async function withBusyButton(btn, busyLabel, fn) {
  if (!btn || btn.disabled) return { skipped: true };
  const prev = btn.textContent;
  btn.disabled = true;
  btn.setAttribute('aria-busy', 'true');
  if (busyLabel) btn.textContent = busyLabel;
  try {
    await fn();
    return { skipped: false };
  } finally {
    btn.disabled = false;
    btn.removeAttribute('aria-busy');
    btn.textContent = prev;
  }
}

/**
 * @param {ParentNode} root
 * @param {string} invalidSelector
 */
export function focusFirstInvalid(root, invalidSelector = '.field-invalid input, .field-invalid select, .field-invalid textarea') {
  const first = root.querySelector(invalidSelector);
  if (first && typeof first.focus === 'function') {
    first.focus();
    return true;
  }
  return false;
}

export function setFieldInvalid(fieldWrap, message) {
  if (!fieldWrap) return;
  fieldWrap.classList.toggle('field-invalid', !!message);
  let hint = fieldWrap.querySelector('.field-inline-error');
  if (message) {
    if (!hint) {
      hint = document.createElement('div');
      hint.className = 'field-inline-error';
      hint.setAttribute('role', 'alert');
      fieldWrap.appendChild(hint);
    }
    hint.textContent = message;
  } else if (hint) {
    hint.remove();
  }
}

export function confirmDiscard(message = 'Bạn có thay đổi chưa lưu. Bỏ thay đổi?') {
  return window.confirm(message);
}

/**
 * @param {Array<{ value?: string, checked?: boolean, type?: string }>} fields
 * @param {() => boolean} [extra]
 */
export function snapshotFormDirty(fields, extra) {
  const baseline = fields.map((f) => (f.type === 'checkbox' ? !!f.checked : String(f.value ?? '')));
  const probe = () => {
    if (typeof extra === 'function' && extra()) return true;
    return fields.some((f, i) => {
      const cur = f.type === 'checkbox' ? !!f.checked : String(f.value ?? '');
      return cur !== baseline[i];
    });
  };
  probe.markClean = () => {
    for (let i = 0; i < fields.length; i += 1) {
      const f = fields[i];
      baseline[i] = f.type === 'checkbox' ? !!f.checked : String(f.value ?? '');
    }
    syncBeforeUnload();
  };
  probe.syncBaseline = probe.markClean;
  return probe;
}

function stableSnapshotEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Capture form values at persist attempt; global retry must not clean/close if the user edited since.
 * @param {() => unknown} readValues
 * @returns {() => boolean}
 */
export function captureAcknowledgedFormSnapshot(readValues) {
  const acknowledged = readValues();
  return () => stableSnapshotEqual(acknowledged, readValues());
}

/** @type {(() => boolean)|null} */
let globalDirtyProbe = null;
/** @type {boolean} */
let beforeUnloadArmed = false;
/** @type {(() => void)|null} */
let dirtyTransitionCleanup = null;

/**
 * @param {(() => boolean)|null} fn
 * @param {{ fields?: Array<{ addEventListener: Function, removeEventListener: Function }>, onQueueTransition?: (handler: () => void) => (() => void)|void }} [watch]
 */
export function getDirtyProbe() {
  return globalDirtyProbe;
}

export function registerDirtyProbe(fn, watch = null) {
  dirtyTransitionCleanup?.();
  dirtyTransitionCleanup = null;
  globalDirtyProbe = typeof fn === 'function' ? fn : null;
  if (globalDirtyProbe && watch?.fields?.length) {
    const onTransition = () => syncBeforeUnload();
    for (const field of watch.fields) {
      field.addEventListener('input', onTransition);
      field.addEventListener('change', onTransition);
    }
    const extraCleanup = watch.onQueueTransition?.(onTransition);
    dirtyTransitionCleanup = () => {
      for (const field of watch.fields) {
        field.removeEventListener('input', onTransition);
        field.removeEventListener('change', onTransition);
      }
      extraCleanup?.();
    };
  }
  syncBeforeUnload();
}

/** Re-evaluate tab-close guard after programmatic clean/dirty transitions. */
export function bumpDirtyNavigationGuard() {
  syncBeforeUnload();
}

export function isGloballyDirty() {
  try {
    return !!globalDirtyProbe?.();
  } catch {
    return false;
  }
}

function syncBeforeUnload() {
  const shouldListen = globalDirtyProbe != null;
  if (shouldListen === beforeUnloadArmed) return;
  beforeUnloadArmed = shouldListen;
  if (shouldListen) {
    window.addEventListener('beforeunload', beforeUnloadHandler);
  } else {
    window.removeEventListener('beforeunload', beforeUnloadHandler);
  }
}

function beforeUnloadHandler(e) {
  if (!isGloballyDirty()) return;
  e.preventDefault();
  e.returnValue = '';
}

function canReceiveFocus(el) {
  if (!el || typeof el.focus !== 'function') return false;
  if (el.isConnected === false) return false;
  if (el.disabled) return false;
  if (el.getAttribute?.('tabindex') === '-1') return false;
  if (el.offsetParent === null && el !== document.body) {
    const role = el.getAttribute?.('role');
    if (role !== 'dialog' && !el.closest?.('[role="dialog"]')) return false;
  }
  return true;
}

/** Stable focus target when dialog opener is gone (e.g. route re-render). */
export function pickDialogFocusFallback() {
  const headerCreate = document.getElementById('header-create');
  if (canReceiveFocus(headerCreate)) return headerCreate;
  const appRoot = document.getElementById('app-root');
  if (appRoot) {
    const list = [...appRoot.querySelectorAll(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    )].filter((el) => canReceiveFocus(el));
    if (list.length) return list[0];
  }
  return null;
}

/**
 * Restore keyboard focus after closing a dialog.
 * @param {Element|null|undefined} opener
 */
export function restoreDialogFocus(opener) {
  if (canReceiveFocus(opener)) {
    opener.focus();
    return opener;
  }
  const fallback = pickDialogFocusFallback();
  if (canReceiveFocus(fallback)) {
    fallback.focus();
    return fallback;
  }
  return null;
}

export function wireDialogA11y({
  backdrop,
  dialog,
  titleId,
  onRequestClose,
  isDirty,
  initialFocus,
  focusOpener,
}) {
  const opener = focusOpener ?? document.activeElement;

  const focusables = () => [...dialog.querySelectorAll(
    'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
  )].filter((el) => !el.disabled && el.offsetParent !== null);

  const trap = (e) => {
    if (e.key !== 'Tab') return;
    const list = focusables();
    if (!list.length) return;
    const first = list[0];
    const last = list[list.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const onKey = (e) => {
    if (e.key === 'Escape') {
      onRequestClose();
    }
    trap(e);
  };

  document.addEventListener('keydown', onKey);
  const toFocus = initialFocus || focusables()[0] || dialog.querySelector(`#${titleId}`);
  toFocus?.focus?.();

  return () => {
    document.removeEventListener('keydown', onKey);
    restoreDialogFocus(opener);
  };
}

/**
 * Freeze mutable controls (and optional fieldset via inert) while async save runs.
 * Restores prior disabled state on release; cancel/actions stay outside fieldsetRoot.
 *
 * @param {object} opts
 * @param {HTMLElement} [opts.fieldsetRoot]
 * @param {Array<{ disabled?: boolean }>} opts.controls
 * @param {Array<(blocked: boolean) => void>} [opts.onSync]
 */
export function createFormPendingLock(opts) {
  let pending = false;
  /** @type {WeakMap<object, boolean>} */
  const priorDisabled = new WeakMap();

  function sync() {
    const block = pending;
    for (const control of opts.controls || []) {
      if (!control) continue;
      if (block) {
        if (!priorDisabled.has(control)) priorDisabled.set(control, !!control.disabled);
        control.disabled = true;
      } else if (priorDisabled.has(control)) {
        control.disabled = priorDisabled.get(control);
        priorDisabled.delete(control);
      }
    }
    if (opts.fieldsetRoot) {
      opts.fieldsetRoot.inert = block;
      opts.fieldsetRoot.toggleAttribute('aria-busy', block);
    }
    for (const fn of opts.onSync || []) {
      fn(block);
    }
  }

  return {
    isPending: () => pending,
    canMutate: () => !pending,
    acquire() {
      if (pending) return false;
      pending = true;
      sync();
      return true;
    },
    release() {
      if (!pending) return;
      pending = false;
      sync();
    },
    sync,
    /**
     * @template T
     * @param {() => Promise<T>} fn
     * @returns {Promise<{ skipped: true } | { skipped: false, result: T }>}
     */
    async run(fn) {
      if (!this.acquire()) return { skipped: true };
      try {
        const result = await fn();
        return { skipped: false, result };
      } finally {
        this.release();
      }
    },
  };
}

/**
 * After a successful create/save inside formLock.run(), release pending lock before
 * skip-dirty close so onBeforeClose guards do not block closeAfterSave().
 *
 * @param {object} ctx
 * @param {() => boolean} ctx.isDialogActive
 * @param {() => boolean} [ctx.isDialogHostLive] dialog generation / route host still owns this modal
 * @param {ReturnType<typeof createFormPendingLock>} ctx.formLock
 * @param {() => void} ctx.onAcknowledged
 * @param {() => boolean} ctx.closeAfterSave
 * @param {() => boolean} [ctx.formMatchesAcknowledgedSnapshot]
 * @param {() => void} [ctx.onFormChangedSinceAcknowledged]
 * @returns {boolean} whether the dialog host was closed on this success path
 */
export function closePendingFormDialogAfterSuccessfulSave(ctx) {
  const {
    isDialogActive,
    isDialogHostLive,
    formLock,
    onAcknowledged,
    closeAfterSave,
    formMatchesAcknowledgedSnapshot,
    onFormChangedSinceAcknowledged,
  } = ctx;
  if (!isDialogActive()) return false;
  if (typeof isDialogHostLive === 'function' && !isDialogHostLive()) return false;
  if (
    typeof formMatchesAcknowledgedSnapshot === 'function'
    && !formMatchesAcknowledgedSnapshot()
  ) {
    onFormChangedSinceAcknowledged?.();
    return false;
  }
  onAcknowledged();
  formLock.release();
  return closeAfterSave() === true;
}

export function attachPasswordToggle(input, mkBtn) {
  const wrap = document.createElement('div');
  wrap.className = 'password-field';
  input.type = 'password';
  const toggle = mkBtn('button', {
    type: 'button',
    className: 'btn btn-ghost btn-sm password-toggle',
    'aria-label': 'Hiện mật khẩu',
    onClick: () => {
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      toggle.textContent = show ? 'Ẩn' : 'Hiện';
      toggle.setAttribute('aria-label', show ? 'Ẩn mật khẩu' : 'Hiện mật khẩu');
    },
  }, 'Hiện');
  wrap.append(input, toggle);
  return wrap;
}
