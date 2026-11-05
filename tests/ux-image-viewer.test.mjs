import test from 'node:test';
import assert from 'node:assert/strict';
import {
  openAttachmentImageViewer,
  disposeImageViewer,
} from '../dist/ux-image-viewer.js';

function installFakeDom() {
  const bodyChildren = [];
  const body = {
    classList: {
      _c: new Set(),
      add(name) { this._c.add(name); },
      remove(name) { this._c.delete(name); },
      contains(name) { return this._c.has(name); },
    },
    appendChild(node) {
      bodyChildren.push(node);
      node.parentNode = body;
      return node;
    },
    removeChild(node) {
      const i = bodyChildren.indexOf(node);
      if (i >= 0) bodyChildren.splice(i, 1);
      if (node.parentNode === body) node.parentNode = null;
      return node;
    },
  };

  function makeEl(tag, attrs = {}, ...children) {
    const listeners = {};
    const node = {
      tagName: String(tag).toUpperCase(),
      attributes: {},
      className: '',
      style: {},
      childNodes: [],
      parentNode: null,
      hidden: false,
      dataset: {},
      setAttribute(k, v) {
        this.attributes[k] = String(v);
        if (k === 'class') this.className = v;
      },
      getAttribute(k) {
        return this.attributes[k] ?? null;
      },
      appendChild(child) {
        if (child?.parentNode && child.parentNode !== this) {
          child.parentNode.removeChild(child);
        }
        this.childNodes.push(child);
        child.parentNode = this;
        return child;
      },
      removeChild(child) {
        const idx = this.childNodes.indexOf(child);
        if (idx >= 0) this.childNodes.splice(idx, 1);
        if (child?.parentNode === this) child.parentNode = null;
        return child;
      },
      remove() {
        if (this.parentNode) this.parentNode.removeChild(this);
      },
      addEventListener(type, fn) {
        (listeners[type] ||= []).push(fn);
      },
      removeEventListener(type, fn) {
        if (!listeners[type]) return;
        listeners[type] = listeners[type].filter((h) => h !== fn);
      },
      dispatchEvent(event) {
        for (const fn of listeners[event?.type] || []) fn(event);
        return true;
      },
      querySelector(sel) {
        const walk = (n) => {
          if (n.matches?.(sel)) return n;
          for (const c of n.childNodes || []) {
            const hit = walk(c);
            if (hit) return hit;
          }
          return null;
        };
        return walk(this);
      },
      querySelectorAll(sel) {
        const out = [];
        const walk = (n) => {
          if (n.matches?.(sel)) out.push(n);
          for (const c of n.childNodes || []) walk(c);
        };
        walk(this);
        return out;
      },
      matches(sel) {
        if (sel.startsWith('.')) {
          const cls = sel.slice(1);
          return String(this.className || '').split(/\s+/).includes(cls);
        }
        if (sel.startsWith('#')) return this.attributes.id === sel.slice(1);
        return this.tagName === sel.toUpperCase();
      },
      focus() {},
      click() {
        this.dispatchEvent({ type: 'click', target: this });
      },
    };
    Object.defineProperty(node, 'textContent', {
      configurable: true,
      get() {
        return node.childNodes
          .map((c) => (typeof c === 'string' ? c : c.textContent || ''))
          .join('');
      },
      set(value) {
        node.childNodes = [{ nodeType: 3, textContent: String(value), getAttribute: () => null }];
      },
    });
    if (attrs.className) node.className = attrs.className;
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'className') continue;
      if (k.startsWith('on') && typeof v === 'function') {
        node.addEventListener(k.slice(2).toLowerCase(), v);
      } else if (v != null && v !== false) {
        node.setAttribute(k, v === true ? '' : v);
      }
    }
    for (const child of children) {
      if (child == null) continue;
      if (typeof child === 'string') {
        const text = { nodeType: 3, textContent: child, getAttribute: () => null };
        node.appendChild(text);
      } else {
        node.appendChild(child);
      }
    }
    if (tag === 'img') {
      Object.defineProperty(node, 'naturalWidth', { value: 800, configurable: true });
      Object.defineProperty(node, 'naturalHeight', { value: 600, configurable: true });
      queueMicrotask(() => {
        for (const fn of listeners.load || []) fn({ type: 'load', target: node });
      });
    }
    return node;
  }

  const docListeners = {};
  globalThis.document = {
    body,
    activeElement: { focus() {} },
    createElement(tag) {
      return makeEl(tag);
    },
    addEventListener(type, fn) {
      (docListeners[type] ||= []).push(fn);
    },
    removeEventListener(type, fn) {
      if (!docListeners[type]) return;
      docListeners[type] = docListeners[type].filter((h) => h !== fn);
    },
    _docListeners: docListeners,
    _bodyChildren: bodyChildren,
  };
  return { makeEl, body, docListeners, bodyChildren };
}

test('openAttachmentImageViewer uses button overlay not new tab link', () => {
  const { makeEl, body, bodyChildren } = installFakeDom();
  openAttachmentImageViewer({
    url: '/api/attachments/test-id',
    filename: 'homework.png',
    mkEl: makeEl,
  });
  assert.equal(body.classList.contains('image-viewer-open'), true);
  const backdrop = bodyChildren.find((n) => n.className?.includes('image-viewer-backdrop'));
  assert.ok(backdrop);
  assert.equal(backdrop.getAttribute('target'), null);
  assert.equal(backdrop.querySelector('a'), null);
  const closeBtn = backdrop.querySelector('.image-viewer-close');
  assert.ok(closeBtn);
  assert.equal(closeBtn.tagName, 'BUTTON');
  disposeImageViewer();
  assert.equal(body.classList.contains('image-viewer-open'), false);
  assert.equal(bodyChildren.length, 0);
});

test('image viewer zoom controls adjust manual scale', async () => {
  const { makeEl, bodyChildren } = installFakeDom();
  openAttachmentImageViewer({
    url: '/api/attachments/z',
    filename: 'z.png',
    mkEl: makeEl,
  });
  await new Promise((r) => queueMicrotask(r));
  const backdrop = bodyChildren[0];
  const zoomIn = [...backdrop.querySelectorAll('button')].find((b) => b.textContent === '+');
  assert.ok(zoomIn);
  zoomIn.click();
  const img = backdrop.querySelector('.image-viewer-img');
  assert.equal(img.dataset.zoomMode, 'manual');
  assert.equal(img.dataset.zoomPct, '125');
  disposeImageViewer();
});

test('image viewer closes on Escape via wireDialogA11y', () => {
  const { makeEl, body, bodyChildren, docListeners } = installFakeDom();
  openAttachmentImageViewer({ url: '/x', mkEl: makeEl });
  assert.equal(bodyChildren.length, 1);
  const keyHandler = docListeners.keydown?.[0];
  assert.ok(keyHandler);
  keyHandler({ key: 'Escape' });
  assert.equal(bodyChildren.length, 0);
  assert.equal(body.classList.contains('image-viewer-open'), false);
});

test('disposeImageViewer clears overlay on navigation hook', () => {
  const { makeEl, body, bodyChildren } = installFakeDom();
  openAttachmentImageViewer({ url: '/x', mkEl: makeEl });
  assert.equal(bodyChildren.length, 1);
  disposeImageViewer();
  assert.equal(bodyChildren.length, 0);
  assert.equal(body.classList.contains('image-viewer-open'), false);
});
