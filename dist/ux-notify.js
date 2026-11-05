/**
 * Accessible toast + persistent error banner (Vietnamese UX).
 */

const MAX_STACK = 4;
const AUTO_DISMISS_MS = 4200;

/** @type {HTMLElement|null} */
let stackEl = null;
/** @type {HTMLElement|null} */
let bannerEl = null;
/** @type {(() => void)|null} */
let bannerRetry = null;
/** @type {number} */
let bannerGeneration = 0;
/** @type {ReturnType<typeof setTimeout>|null} */
let bannerDismissTimer = null;

/** @type {HTMLElement|null} */
let credentialNoticeEl = null;
/** @type {number} */
let credentialNoticeGeneration = 0;

function clearBannerDismissTimer() {
  if (bannerDismissTimer != null) {
    clearTimeout(bannerDismissTimer);
    bannerDismissTimer = null;
  }
}

function ensureStack() {
  if (stackEl && stackEl.isConnected) return stackEl;
  stackEl = document.getElementById('toast-stack');
  if (!stackEl) {
    stackEl = document.createElement('div');
    stackEl.id = 'toast-stack';
    stackEl.className = 'toast-stack';
    stackEl.setAttribute('aria-live', 'polite');
    stackEl.setAttribute('aria-relevant', 'additions');
    document.body.appendChild(stackEl);
  }
  return stackEl;
}

function ensureBanner() {
  if (bannerEl && bannerEl.isConnected) return bannerEl;
  bannerEl = document.getElementById('ux-error-banner');
  if (!bannerEl) {
    bannerEl = document.createElement('div');
    bannerEl.id = 'ux-error-banner';
    bannerEl.className = 'ux-error-banner';
    bannerEl.hidden = true;
    bannerEl.setAttribute('role', 'alert');
    document.body.appendChild(bannerEl);
  }
  return bannerEl;
}

function removeToast(node) {
  node?.remove();
}

export function clearToasts() {
  const stack = document.getElementById('toast-stack');
  if (stack) stack.replaceChildren();
}

export function hideErrorBanner() {
  clearBannerDismissTimer();
  const b = ensureBanner();
  b.hidden = true;
  b.replaceChildren();
  bannerRetry = null;
}

function ensureCredentialNotice() {
  if (credentialNoticeEl && credentialNoticeEl.isConnected) return credentialNoticeEl;
  credentialNoticeEl = document.getElementById('ux-credential-notice');
  if (!credentialNoticeEl) {
    credentialNoticeEl = document.createElement('div');
    credentialNoticeEl.id = 'ux-credential-notice';
    credentialNoticeEl.className = 'ux-credential-notice';
    credentialNoticeEl.hidden = true;
    credentialNoticeEl.setAttribute('role', 'status');
    document.body.appendChild(credentialNoticeEl);
  }
  return credentialNoticeEl;
}

/**
 * Persistent notice for queued one-time credentials (separate from save error banner).
 * @param {string} message
 * @param {{ generation?: number, onOpen?: () => void }} [opts]
 */
export function showCredentialPendingNotice(message, opts = {}) {
  const noticeId = opts.generation ?? ++credentialNoticeGeneration;
  credentialNoticeGeneration = noticeId;
  const el = ensureCredentialNotice();
  el.hidden = false;
  el.replaceChildren();
  const msg = document.createElement('span');
  msg.className = 'ux-credential-notice-text';
  msg.textContent = message;
  el.appendChild(msg);
  if (typeof opts.onOpen === 'function') {
    const openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.className = 'btn btn-secondary btn-sm';
    openBtn.textContent = 'Xem mật khẩu tạm';
    openBtn.addEventListener('click', () => {
      if (noticeId !== credentialNoticeGeneration) return;
      opts.onOpen?.();
    });
    el.appendChild(openBtn);
  }
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'toast-close';
  closeBtn.setAttribute('aria-label', 'Đóng');
  closeBtn.textContent = '×';
  closeBtn.addEventListener('click', () => {
    if (noticeId !== credentialNoticeGeneration) return;
    hideCredentialPendingNotice();
  });
  el.appendChild(closeBtn);
}

export function hideCredentialPendingNotice() {
  credentialNoticeGeneration += 1;
  const el = document.getElementById('ux-credential-notice');
  if (el) {
    el.hidden = true;
    el.replaceChildren();
  }
}

/** @returns {boolean} */
export function isCredentialPendingNoticeVisibleForTests() {
  const el = document.getElementById('ux-credential-notice');
  return Boolean(el && !el.hidden);
}

/** @returns {boolean} */
export function isErrorBannerVisibleForTests() {
  const el = document.getElementById('ux-error-banner');
  return Boolean(el && !el.hidden);
}

/**
 * Success toast — only call after server confirmed success.
 * @param {string} message
 */
export function toastSuccess(message) {
  const stack = ensureStack();
  while (stack.children.length >= MAX_STACK) {
    stack.firstElementChild?.remove();
  }
  const toast = document.createElement('div');
  toast.className = 'toast toast-success';
  toast.setAttribute('role', 'status');
  const text = document.createElement('span');
  text.className = 'toast-text';
  text.textContent = message;
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'toast-close';
  closeBtn.setAttribute('aria-label', 'Đóng thông báo');
  closeBtn.textContent = '×';
  closeBtn.addEventListener('click', () => removeToast(toast));
  toast.append(text, closeBtn);
  stack.appendChild(toast);
  window.setTimeout(() => removeToast(toast), AUTO_DISMISS_MS);
}

/**
 * @param {string} message
 * @param {{ retry?: () => void, persistent?: boolean, retryLabel?: string }} [opts]
 */
export function showErrorBanner(message, opts = {}) {
  clearBannerDismissTimer();
  const bannerId = ++bannerGeneration;
  const b = ensureBanner();
  b.hidden = false;
  b.replaceChildren();
  const msg = document.createElement('span');
  msg.className = 'ux-error-banner-text';
  msg.textContent = message;
  b.appendChild(msg);
  bannerRetry = typeof opts.retry === 'function' ? opts.retry : null;
  if (bannerRetry) {
    const retryBtn = document.createElement('button');
    retryBtn.type = 'button';
    retryBtn.className = 'btn btn-secondary btn-sm';
    retryBtn.textContent = opts.retryLabel || 'Thử lại';
    retryBtn.addEventListener('click', () => {
      if (bannerId !== bannerGeneration) return;
      const fn = bannerRetry;
      if (fn) fn();
    });
    b.appendChild(retryBtn);
  }
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'toast-close';
  closeBtn.setAttribute('aria-label', 'Đóng');
  closeBtn.textContent = '×';
  closeBtn.addEventListener('click', () => {
    if (bannerId !== bannerGeneration) return;
    hideErrorBanner();
  });
  b.appendChild(closeBtn);
  if (!opts.persistent && !bannerRetry) {
    bannerDismissTimer = window.setTimeout(() => {
      bannerDismissTimer = null;
      if (bannerId !== bannerGeneration) return;
      hideErrorBanner();
    }, 12000);
  }
}

export function clearAllNotifications() {
  clearToasts();
  hideErrorBanner();
  hideCredentialPendingNotice();
}

/**
 * Modal dialog for one-time credentials (not a toast).
 * @param {{ title: string, lines: string[], copyValue?: string }} spec
 * @param {(openDialog: Function) => { close: () => void }} openDialogHost
 */
export function openCredentialsDialog(spec, openDialogHost, mkEl) {
  const body = [];
  for (const line of spec.lines) {
    body.push(mkEl('p', {}, line));
  }
  let copyFeedback = mkEl('span', { className: 'form-hint', 'aria-live': 'polite' });
  if (spec.copyValue) {
    const row = mkEl('div', { className: 'credential-copy-row' },
      mkEl('code', { className: 'credential-block' }, spec.copyValue),
      mkEl('button', {
        type: 'button',
        className: 'btn btn-secondary btn-sm',
        onClick: async () => {
          try {
            await navigator.clipboard.writeText(spec.copyValue);
            copyFeedback.textContent = 'Đã sao chép.';
          } catch {
            copyFeedback.textContent = 'Không sao chép được — hãy chọn và copy thủ công.';
          }
        },
      }, 'Sao chép'),
      copyFeedback,
    );
    body.push(row);
  }
  const { close } = openDialogHost(
    spec.title,
    body,
    [mkEl('button', { type: 'button', className: 'btn btn-primary', onClick: () => close() }, 'Đã ghi lại')],
    { focusPrimary: true },
  );
  return { close };
}
