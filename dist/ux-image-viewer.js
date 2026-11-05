/**
 * Inline attachment image viewer — dedicated overlay (does not use dialog-root).
 */

import { wireDialogA11y } from './ux-forms.js';

const BODY_LOCK_CLASS = 'image-viewer-open';
const MIN_ZOOM = 25;
const MAX_ZOOM = 400;
const ZOOM_STEP = 25;

/** @type {{ backdrop: HTMLElement, dispose: () => void } | null} */
let activeViewer = null;

function defaultMkEl(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'className') node.className = v;
    else if (k.startsWith('on') && typeof v === 'function') {
      node.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (v === false || v === null || v === undefined) {
      /* skip */
    } else if (v === true) node.setAttribute(k, '');
    else node.setAttribute(k, v);
  }
  for (const child of children) {
    if (child == null) continue;
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

function releaseScrollLock() {
  document.body.classList.remove(BODY_LOCK_CLASS);
}

/**
 * Close any open attachment image viewer (navigation, auth, explicit close).
 */
export function disposeImageViewer() {
  if (!activeViewer) return;
  const { backdrop, dispose } = activeViewer;
  activeViewer = null;
  dispose?.();
  backdrop?.remove?.();
  releaseScrollLock();
}

/**
 * @param {object} opts
 * @param {string} opts.url
 * @param {string} [opts.filename]
 * @param {(tag: string, attrs?: object, ...children: unknown[]) => HTMLElement} [opts.mkEl]
 */
export function openAttachmentImageViewer({ url, filename, mkEl = defaultMkEl }) {
  disposeImageViewer();

  const focusOpener = document.activeElement;
  let disposeA11y = null;
  let naturalW = 0;
  let naturalH = 0;
  let zoomMode = 'fit';
  let zoomPct = 100;

  const backdrop = mkEl('div', {
    className: 'image-viewer-backdrop',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-labelledby': 'image-viewer-title',
  });

  const statusEl = mkEl('p', {
    className: 'image-viewer-status',
    role: 'status',
    'aria-live': 'polite',
  }, 'Đang tải ảnh…');

  const img = mkEl('img', {
    className: 'image-viewer-img',
    src: url,
    alt: filename || 'Ảnh đính kèm',
    decoding: 'async',
  });

  const stage = mkEl('div', { className: 'image-viewer-stage' }, img);

  const applyZoom = () => {
    if (!naturalW || !naturalH) return;
    if (zoomMode === 'fit') {
      img.style.width = '';
      img.style.height = '';
      img.style.maxWidth = '100%';
      img.style.maxHeight = '100%';
      img.style.transform = '';
      img.dataset.zoomMode = 'fit';
    } else {
      const factor = zoomPct / 100;
      img.style.maxWidth = 'none';
      img.style.maxHeight = 'none';
      img.style.width = `${Math.round(naturalW * factor)}px`;
      img.style.height = `${Math.round(naturalH * factor)}px`;
      img.style.transform = '';
      img.dataset.zoomMode = 'manual';
      img.dataset.zoomPct = String(zoomPct);
    }
  };

  const setZoomManual = (nextPct) => {
    zoomMode = 'manual';
    zoomPct = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, nextPct));
    applyZoom();
    statusEl.textContent = `Thu phóng ${zoomPct}%`;
  };

  const close = () => {
    disposeImageViewer();
  };

  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) close();
  });

  img.addEventListener('load', () => {
    naturalW = img.naturalWidth || img.width || 1;
    naturalH = img.naturalHeight || img.height || 1;
    statusEl.textContent = zoomMode === 'fit' ? 'Vừa màn hình' : `Thu phóng ${zoomPct}%`;
    applyZoom();
    stage.setAttribute('aria-busy', 'false');
  });

  img.addEventListener('error', () => {
    statusEl.textContent = 'Không tải được ảnh. Kiểm tra kết nối hoặc quyền truy cập.';
    statusEl.classList.add('image-viewer-status-error');
    stage.setAttribute('aria-busy', 'false');
    img.hidden = true;
  });

  stage.setAttribute('aria-busy', 'true');

  const panel = mkEl('div', { className: 'image-viewer-panel' },
    mkEl('div', { className: 'image-viewer-header' },
      mkEl('h2', { id: 'image-viewer-title', className: 'image-viewer-title' }, filename || 'Ảnh đính kèm'),
      mkEl('button', {
        type: 'button',
        className: 'btn btn-ghost btn-sm image-viewer-close',
        onClick: close,
      }, 'Đóng'),
    ),
    mkEl('div', { className: 'image-viewer-toolbar', role: 'toolbar', 'aria-label': 'Thu phóng ảnh' },
      mkEl('button', {
        type: 'button',
        className: 'btn btn-ghost btn-sm',
        'aria-label': 'Thu nhỏ',
        onClick: () => setZoomManual((zoomMode === 'fit' ? 100 : zoomPct) - ZOOM_STEP),
      }, '−'),
      mkEl('button', {
        type: 'button',
        className: 'btn btn-ghost btn-sm',
        'aria-label': 'Phóng to',
        onClick: () => setZoomManual((zoomMode === 'fit' ? 100 : zoomPct) + ZOOM_STEP),
      }, '+'),
      mkEl('button', {
        type: 'button',
        className: 'btn btn-ghost btn-sm',
        onClick: () => {
          zoomMode = 'fit';
          applyZoom();
          statusEl.textContent = 'Vừa màn hình';
        },
      }, 'Vừa màn hình'),
    ),
    stage,
    statusEl,
  );

  backdrop.appendChild(panel);
  document.body.appendChild(backdrop);
  document.body.classList.add(BODY_LOCK_CLASS);

  const dialog = panel;
  disposeA11y = wireDialogA11y({
    backdrop,
    dialog,
    titleId: 'image-viewer-title',
    onRequestClose: close,
    initialFocus: panel.querySelector('.image-viewer-close'),
    focusOpener,
  });

  activeViewer = {
    backdrop,
    dispose: () => {
      disposeA11y?.();
      disposeA11y = null;
    },
  };

  return { close };
}
