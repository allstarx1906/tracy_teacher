import assert from 'node:assert/strict';
import { localDateTimeToUtcIso } from '../dist/ba-domain.js';
import { registerDirtyProbe } from '../dist/ux-forms.js';

/**
 * Minimal DOM field/event target for Node tests (input/change listeners + remove).
 * Prefer {@link createMinimalDomElement} via {@link installBaDomEnvironment} for tree nodes.
 */
export function createDomEventTargetStub(extra = {}) {
  const listeners = {};
  const { textContent: _ignoredText, childNodes: _ignoredChildren, ...rest } = extra;
  const target = {
    value: '',
    checked: false,
    type: '',
    disabled: false,
    readOnly: false,
    childNodes: [],
    attributes: {},
    style: {},
    dataset: {},
    ...rest,
    addEventListener(type, fn) {
      (listeners[type] ||= []).push(fn);
    },
    removeEventListener(type, fn) {
      if (!listeners[type]) return;
      listeners[type] = listeners[type].filter((h) => h !== fn);
    },
    dispatchEvent(event) {
      const type = event?.type;
      for (const fn of listeners[type] || []) fn(event);
      return true;
    },
    focus() {},
    blur() {},
  };
  return target;
}

export function aggregateDomTextContent(node) {
  if (!node) return '';
  if (node.nodeType === 3) return String(node.textContent ?? '');
  let out = '';
  for (const c of node.childNodes || []) out += aggregateDomTextContent(c);
  return out;
}

function syncFirstChild(el) {
  el.firstChild = el.childNodes[0] ?? null;
}

/** @param {object} node @param {string} selector */
function nodeAttributeValue(node, attr) {
  if (attr === 'type' && node.type != null && node.type !== '') return String(node.type);
  if (typeof node.getAttribute === 'function') {
    const fromGet = node.getAttribute(attr);
    if (fromGet != null) return String(fromGet);
  }
  if (node.attributes && attr in node.attributes) return String(node.attributes[attr]);
  return null;
}

function nodeMatchesSelector(node, selector) {
  if (!node || node.nodeType !== 1) return false;
  const s = String(selector).trim();
  if (s.startsWith('#')) {
    const id = s.slice(1);
    const nodeId = node.id != null && node.id !== '' ? String(node.id) : nodeAttributeValue(node, 'id');
    return nodeId === id;
  }
  if (s.startsWith('.')) {
    const cls = s.slice(1).split('.')[0];
    return domClassIncludes(node, cls);
  }
  const attrOnlyVal = s.match(/^\[([^\]=]+)=(["']?)([^\]"']*)\2\]$/);
  if (attrOnlyVal) {
    return nodeAttributeValue(node, attrOnlyVal[1]) === attrOnlyVal[3];
  }
  const attrOnly = s.match(/^\[([^\]=]+)\]$/);
  if (attrOnly) {
    return nodeAttributeValue(node, attrOnly[1]) != null;
  }
  const taggedAttrVal = s.match(/^([a-z*]+|\*)\[([^\]=]+)=(["']?)([^\]"']*)\3\]$/i);
  if (taggedAttrVal) {
    const tag = taggedAttrVal[1];
    const attr = taggedAttrVal[2];
    const val = taggedAttrVal[4];
    if (tag !== '*' && node.tagName !== tag.toUpperCase()) return false;
    return nodeAttributeValue(node, attr) === val;
  }
  const taggedAttr = s.match(/^([a-z*]+|\*)\[([^\]=]+)\]$/i);
  if (taggedAttr) {
    const tag = taggedAttr[1];
    const attr = taggedAttr[2];
    if (tag !== '*' && node.tagName !== tag.toUpperCase()) return false;
    return nodeAttributeValue(node, attr) != null;
  }
  if (/^[a-z*]+$/i.test(s)) {
    if (s === '*') return true;
    const nodeTag = node.tagName;
    if (node.namespaceURI === 'http://www.w3.org/2000/svg') {
      return String(nodeTag).toLowerCase() === s.toLowerCase();
    }
    return nodeTag === s.toUpperCase();
  }
  return false;
}

/** @param {object} node @param {string} attr */
export function domNodeAttributeValue(node, attr) {
  return nodeAttributeValue(node, attr);
}

/** @param {object} root @param {string} attr @param {string} value */
export function findDomNodeByAttr(root, attr, value) {
  const want = String(value);
  return findDomNodes(root, (n) => domNodeAttributeValue(n, attr) === want)[0] ?? null;
}

/** @param {object} root @param {string} ancestorAttr @param {string} ancestorValue @param {(n: object) => boolean} predicate */
export function findDomNodeWithinAttr(root, ancestorAttr, ancestorValue, predicate) {
  const host = findDomNodeByAttr(root, ancestorAttr, ancestorValue);
  if (!host) return null;
  return findDomNodes(host, predicate)[0] ?? null;
}

/** @param {object} root @param {string} selector @param {object[]} acc */
function collectQuerySelectorAll(root, selector, acc) {
  const s = String(selector).trim();
  // Comma-separated top-level groups must split BEFORE descendant (space) combinator handling,
  // so e.g. `input, textarea, .foo bar` is two groups — not "input," as ancestor of "textarea,...".
  if (s.includes(',')) {
    const seen = new Set();
    for (const part of s.split(',')) {
      const one = part.trim();
      if (!one) continue;
      const inner = [];
      collectQuerySelectorAll(root, one, inner);
      for (const n of inner) {
        if (!seen.has(n)) {
          seen.add(n);
          acc.push(n);
        }
      }
    }
    return;
  }
  const spaceAt = s.indexOf(' ');
  if (spaceAt > 0) {
    const ancestorSel = s.slice(0, spaceAt).trim();
    const descSel = s.slice(spaceAt + 1).trim();
    collectDescendantSelectorMatches(root, ancestorSel, descSel, acc);
    return;
  }
  for (const ch of root.childNodes || []) {
    if (ch.nodeType !== 1) continue;
    if (nodeMatchesSelector(ch, selector)) acc.push(ch);
    collectQuerySelectorAll(ch, selector, acc);
  }
}

/** @param {object} root @param {string} ancestorSel @param {string} descSel @param {object[]} acc */
function collectDescendantSelectorMatches(root, ancestorSel, descSel, acc) {
  for (const ch of root.childNodes || []) {
    if (ch.nodeType !== 1) continue;
    if (nodeMatchesSelector(ch, ancestorSel)) {
      (function walk(n) {
        for (const c of n.childNodes || []) {
          if (c.nodeType !== 1) continue;
          if (nodeMatchesSelector(c, descSel)) acc.push(c);
          walk(c);
        }
      })(ch);
    }
    collectDescendantSelectorMatches(ch, ancestorSel, descSel, acc);
  }
}

function domAppendChild(parent, child) {
  if (!parent || !child) return child;
  if (child.parentNode && child.parentNode !== parent) {
    domRemoveChild(child.parentNode, child);
  }
  parent.childNodes.push(child);
  child.parentNode = parent;
  syncFirstChild(parent);
  return child;
}

function domRemoveChild(parent, child) {
  const idx = parent.childNodes.indexOf(child);
  if (idx >= 0) parent.childNodes.splice(idx, 1);
  if (child.parentNode === parent) child.parentNode = null;
  syncFirstChild(parent);
  return child;
}

function domInsertBefore(parent, newChild, refChild) {
  if (!parent || !newChild) return newChild;
  if (refChild != null && refChild.parentNode !== parent) {
    throw new TypeError('insertBefore: reference node is not a child of this node');
  }
  if (newChild.parentNode && newChild.parentNode !== parent) {
    domRemoveChild(newChild.parentNode, newChild);
  }
  if (refChild == null) {
    return domAppendChild(parent, newChild);
  }
  if (newChild === refChild) return newChild;
  let refIndex = parent.childNodes.indexOf(refChild);
  if (refIndex < 0) {
    throw new TypeError('insertBefore: reference node is not a child of this node');
  }
  const curIndex = newChild.parentNode === parent ? parent.childNodes.indexOf(newChild) : -1;
  if (curIndex >= 0) {
    parent.childNodes.splice(curIndex, 1);
    if (curIndex < refIndex) refIndex -= 1;
  }
  parent.childNodes.splice(refIndex, 0, newChild);
  newChild.parentNode = parent;
  syncFirstChild(parent);
  return newChild;
}

function wireTextContent(el) {
  Object.defineProperty(el, 'textContent', {
    configurable: true,
    enumerable: true,
    get() {
      return aggregateDomTextContent(el);
    },
    set(value) {
      el.childNodes.length = 0;
      syncFirstChild(el);
      if (value == null || value === '') return;
      domAppendChild(el, { nodeType: 3, textContent: String(value), parentNode: null });
    },
  });
}

function wireClassName(el) {
  const classTokens = new Set();
  const classString = () => [...classTokens].join(' ');
  const syncClassAttributes = () => {
    const cls = classString();
    if (cls) {
      el.attributes.class = cls;
      el.attributes.className = cls;
    } else {
      delete el.attributes.class;
      delete el.attributes.className;
    }
  };
  const ingest = (value) => {
    classTokens.clear();
    for (const t of String(value || '').split(/\s+/)) {
      if (t) classTokens.add(t);
    }
    syncClassAttributes();
  };
  if (el.className != null && el.className !== '') ingest(el.className);
  else if (el.attributes?.class != null) ingest(el.attributes.class);
  else if (el.attributes?.className != null) ingest(el.attributes.className);

  Object.defineProperty(el, 'className', {
    configurable: true,
    enumerable: true,
    get() {
      return classString();
    },
    set(value) {
      ingest(value);
    },
  });
  el.classList = {
    add(...tokens) {
      for (const t of tokens) if (t) classTokens.add(t);
      syncClassAttributes();
    },
    remove(...tokens) {
      for (const t of tokens) classTokens.delete(t);
      syncClassAttributes();
    },
    toggle(token) {
      if (classTokens.has(token)) classTokens.delete(token);
      else classTokens.add(token);
      syncClassAttributes();
    },
    contains(token) {
      if (token == null || token === '') return false;
      return classTokens.has(String(token));
    },
  };

  const baseSetAttribute = el.setAttribute.bind(el);
  el.setAttribute = (name, value) => {
    baseSetAttribute(name, value);
    if (name === 'class') ingest(value);
  };
  const baseRemoveAttribute = el.removeAttribute?.bind(el);
  if (baseRemoveAttribute) {
    el.removeAttribute = (name) => {
      baseRemoveAttribute(name);
      if (name === 'class' || name === 'className') {
        classTokens.clear();
        syncClassAttributes();
      }
    };
  }
}

function wireInputValue(el) {
  let current = el.attributes.value ?? '';
  Object.defineProperty(el, 'value', {
    configurable: true,
    enumerable: true,
    get() {
      return current;
    },
    set(v) {
      current = v == null ? '' : String(v);
    },
  });
  const baseSetAttribute = el.setAttribute.bind(el);
  el.setAttribute = (name, value) => {
    baseSetAttribute(name, value);
    if (name === 'value') current = value == null ? '' : String(value);
    if (name === 'type') el.type = String(value);
  };
}

function wireSelectValue(el) {
  let current = '';
  Object.defineProperty(el, 'value', {
    configurable: true,
    enumerable: true,
    get() {
      const opts = el.childNodes.filter((n) => n.tagName === 'OPTION');
      if (opts.some((o) => (o.attributes.value ?? o.value) === current)) return current;
      const first = opts[0];
      return first ? (first.attributes.value ?? first.value ?? '') : current;
    },
    set(v) {
      current = v == null ? '' : String(v);
    },
  });
  Object.defineProperty(el, 'selectedOptions', {
    configurable: true,
    get() {
      const val = el.value;
      return el.childNodes.filter(
        (n) => n.tagName === 'OPTION' && (n.attributes.value ?? n.value) === val,
      );
    },
  });
}

/**
 * @param {string} tag
 * @param {{ namespaceURI?: string | null } & Record<string, unknown>} [extra]
 */
export function createMinimalDomElement(tag, extra = {}) {
  const ns = extra.namespaceURI ?? null;
  const rawTag = String(tag);
  const tagName = ns === 'http://www.w3.org/2000/svg'
    ? rawTag
    : rawTag.toUpperCase();
  const { isConnected: _dropConnected, namespaceURI: _nsDrop, ...restExtra } = extra;
  const el = createDomEventTargetStub({
    tagName,
    nodeType: 1,
    parentNode: null,
    firstChild: null,
    _forceConnected: false,
    namespaceURI: ns,
    ...restExtra,
  });

  wireTextContent(el);

  Object.defineProperty(el, 'isConnected', {
    configurable: true,
    enumerable: true,
    get() {
      if (el._forceConnected) return true;
      return el.parentNode != null;
    },
  });

  el.appendChild = (ch) => domAppendChild(el, ch);
  el.insertBefore = (newChild, refChild) => domInsertBefore(el, newChild, refChild);
  el.removeChild = (ch) => domRemoveChild(el, ch);
  el.replaceChildren = (...nodes) => {
    el.childNodes.length = 0;
    syncFirstChild(el);
    for (const n of nodes) {
      if (n != null) domAppendChild(el, n);
    }
  };
  el.remove = () => {
    if (el.parentNode) domRemoveChild(el.parentNode, el);
  };
  el._scrollIntoViewCalls = [];
  el.scrollIntoView = (arg) => {
    el._scrollIntoViewCalls.push(arg);
  };
  el.querySelectorAll = (selector) => {
    const acc = [];
    collectQuerySelectorAll(el, selector, acc);
    return acc;
  };
  el.querySelector = (selector) => el.querySelectorAll(selector)[0] ?? null;
  el.hasAttribute = (name) => name in el.attributes || el.getAttribute(name) != null;

  el.setAttribute = (name, value) => {
    el.attributes[name] = value == null ? '' : String(value);
    if (name === 'type') el.type = String(value);
    if (name === 'value' && (tagName === 'INPUT' || tagName === 'TEXTAREA')) {
      el.value = String(value);
    }
    if (name === 'id') el.id = String(value);
    if (name === 'src' && (tagName === 'AUDIO' || tagName === 'VIDEO' || tagName === 'IMG' || tagName === 'SOURCE')) {
      el.src = String(value);
    }
  };
  if (tagName === 'AUDIO' || tagName === 'VIDEO' || tagName === 'IMG' || tagName === 'SOURCE') {
    Object.defineProperty(el, 'src', {
      configurable: true,
      enumerable: true,
      get() {
        return el.attributes.src ?? el.getAttribute('src') ?? '';
      },
      set(v) {
        if (v == null || v === '') {
          delete el.attributes.src;
        } else {
          el.attributes.src = String(v);
        }
      },
    });
  }
  el.getAttribute = (name) => (name in el.attributes ? el.attributes[name] : null);
  el.removeAttribute = (name) => {
    delete el.attributes[name];
    if (name === 'aria-disabled') return;
    if (name === 'aria-busy') return;
  };

  if (tagName === 'INPUT' || tagName === 'TEXTAREA') wireInputValue(el);
  if (tagName === 'SELECT') wireSelectValue(el);
  if (tagName === 'OPTION') {
    wireInputValue(el);
    Object.defineProperty(el, 'value', {
      configurable: true,
      enumerable: true,
      get() {
        return el.attributes.value ?? el.getAttribute('value') ?? aggregateDomTextContent(el);
      },
      set(v) {
        el.attributes.value = v == null ? '' : String(v);
      },
    });
  }

  wireHiddenIdl(el);
  wireClassName(el);

  if (tagName === 'A') {
    el.click = function click() {
      el.dispatchEvent({ type: 'click', bubbles: true, cancelable: true, target: el });
    };
  }

  if (tagName === 'CANVAS') {
    el.getContext = () => ({
      clearRect() {},
      fillRect() {},
      strokeRect() {},
      drawImage() {},
      save() {},
      restore() {},
      translate() {},
      scale() {},
      transform() {},
      setTransform() {},
      beginPath() {},
      closePath() {},
      moveTo() {},
      lineTo() {},
      rect() {},
      clip() {},
      fill() {},
      stroke() {},
      measureText() {
        return { width: 0 };
      },
      fillText() {},
      strokeText() {},
      createImageData() {
        return { data: new Uint8ClampedArray(4), width: 1, height: 1 };
      },
      getImageData() {
        return { data: new Uint8ClampedArray(4), width: 1, height: 1 };
      },
      putImageData() {},
      canvas: el,
    });
  }

  return el;
}

/** UTC+7 local noon on `dateKey` (YYYY-MM-DD) as UTC ISO — matches BA wall-clock helpers. */
export function fixedUtc7NoonIso(dateKey) {
  return localDateTimeToUtcIso(dateKey, '12:00');
}

function wireHiddenIdl(el) {
  const baseRemoveAttribute = el.removeAttribute.bind(el);
  const baseSetAttribute = el.setAttribute.bind(el);
  Object.defineProperty(el, 'hidden', {
    configurable: true,
    enumerable: true,
    get() {
      return Object.hasOwn(el.attributes, 'hidden');
    },
    set(v) {
      if (v && v !== false && v !== 'false') {
        if (!Object.hasOwn(el.attributes, 'hidden')) el.attributes.hidden = '';
      } else {
        delete el.attributes.hidden;
      }
    },
  });
  el.setAttribute = (name, value) => {
    baseSetAttribute(name, value);
    if (name === 'hidden') el.hidden = true;
  };
  el.removeAttribute = (name) => {
    baseRemoveAttribute(name);
    if (name === 'hidden') el.hidden = false;
  };
}

/** Mirrors HTML `hidden` IDL (boolean), not only presence via hasAttribute quirks. */
export function domElementIsHidden(node) {
  if (!node) return true;
  if (typeof node.hidden === 'boolean') return node.hidden;
  return node.hasAttribute?.('hidden') ?? false;
}

/**
 * @param {{ cookie?: string }} [options]
 */
export function createMinimalDocument(options = {}) {
  const nodes = new Map();
  let idSeq = 0;
  const body = createMinimalDomElement('body');
  body._forceConnected = true;
  body.querySelector = (selector) => body.querySelectorAll(selector)[0] ?? null;

  const documentStub = {
    cookie: options.cookie ?? '',
    body,
    querySelector(selector) {
      return body.querySelector(selector);
    },
    getElementById(id) {
      if (id === 'app-root') {
        if (!nodes.has(id)) {
          const root = createMinimalDomElement('div', { id: 'app-root' });
          root._forceConnected = true;
          nodes.set(id, root);
        }
        return nodes.get(id);
      }
      return nodes.get(id) ?? null;
    },
    createElement(tag) {
      const el = createMinimalDomElement(tag);
      el.id = el.attributes.id || `n-${idSeq += 1}`;
      return el;
    },
    createElementNS(namespaceURI, qualifiedName) {
      const el = createMinimalDomElement(qualifiedName, { namespaceURI: namespaceURI ?? null });
      el.id = el.attributes.id || `n-${idSeq += 1}`;
      return el;
    },
    createTextNode(text) {
      return {
        nodeType: 3,
        textContent: String(text),
        parentNode: null,
      };
    },
  };

  return documentStub;
}

/**
 * Installs minimal `document` + optional `window` for BA UI tests.
 * Restores globals, dirty probe, and document/window on all exit paths.
 *
 * @param {import('node:test').TestContext} t
 * @param {{ confirm?: (message?: string) => boolean, cookie?: string }} [options]
 */
export function installBaDomEnvironment(t, options = {}) {
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  const originalBlob = globalThis.Blob;
  const originalCreateObjectURL = globalThis.URL?.createObjectURL;
  const originalRevokeObjectURL = globalThis.URL?.revokeObjectURL;
  const handlers = new Map();

  const windowStub = {
    addEventListener(type, fn) {
      handlers.set(type, fn);
    },
    removeEventListener(type, fn) {
      if (handlers.get(type) === fn) handlers.delete(type);
    },
  };
  if (Object.prototype.hasOwnProperty.call(options, 'confirm')) {
    windowStub.confirm = options.confirm;
  }
  globalThis.window = windowStub;
  globalThis.document = createMinimalDocument({ cookie: options.cookie });
  if (typeof globalThis.Blob !== 'function') {
    globalThis.Blob = class Blob {
      constructor(parts = [], opts = {}) {
        this.type = opts.type || '';
        const chunks = parts.map((p) => (p instanceof Uint8Array ? p : Buffer.from(p)));
        this._data = chunks.length ? Buffer.concat(chunks) : Buffer.alloc(0);
      }
    };
  }
  if (globalThis.URL) {
    globalThis.URL.createObjectURL = globalThis.URL.createObjectURL || (() => 'blob:exam-test');
    globalThis.URL.revokeObjectURL = globalThis.URL.revokeObjectURL || (() => {});
  }

  t.after(() => {
    registerDirtyProbe(null);
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
    if (originalBlob === undefined) delete globalThis.Blob;
    else globalThis.Blob = originalBlob;
    if (globalThis.URL) {
      if (originalCreateObjectURL) globalThis.URL.createObjectURL = originalCreateObjectURL;
      if (originalRevokeObjectURL) globalThis.URL.revokeObjectURL = originalRevokeObjectURL;
    }
  });

  return {
    root: globalThis.document.getElementById('app-root'),
    handlers,
  };
}

/**
 * Minimal `window` with add/removeEventListener for ux-forms beforeunload wiring in Node tests.
 * Clears any active dirty probe before restoring globalThis.window.
 *
 * @param {import('node:test').TestContext} t
 * @param {{ confirm?: (message?: string) => boolean }} [options]
 *   Optional `window.confirm` implementation. Omit to leave confirm unset (no implicit accept).
 * @returns {Map<string, Function>} beforeunload and other handler map (last fn per type)
 */
export function installBrowserWindowFixture(t, options = {}) {
  const originalWindow = globalThis.window;
  const handlers = new Map();
  const windowStub = {
    addEventListener(type, fn) {
      handlers.set(type, fn);
    },
    removeEventListener(type, fn) {
      if (handlers.get(type) === fn) handlers.delete(type);
    },
  };
  if (Object.prototype.hasOwnProperty.call(options, 'confirm')) {
    windowStub.confirm = options.confirm;
  }
  globalThis.window = windowStub;
  t.after(() => {
    registerDirtyProbe(null);
    globalThis.window = originalWindow;
  });
  return handlers;
}

/**
 * Node 24+ exposes `globalThis.navigator` as a getter-only property; tests must not assign to it.
 * Installs a configurable stub without clipboard API; restores the original descriptor on teardown.
 * Register after {@link installBaDomEnvironment} so navigator is restored before document/window.
 *
 * @param {import('node:test').TestContext} t
 */
export function installNavigatorWithoutClipboardFixture(t) {
  const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    enumerable: originalDescriptor?.enumerable ?? true,
    writable: true,
    value: { clipboard: undefined },
  });
  t.after(() => {
    if (originalDescriptor) {
      Object.defineProperty(globalThis, 'navigator', originalDescriptor);
    } else {
      delete globalThis.navigator;
    }
  });
}

/** Class string from minimal DOM nodes (attributes.class / getAttribute('class')). */
export function domElementClassName(node) {
  if (!node) return '';
  if (typeof node.getAttribute === 'function') {
    const fromGet = node.getAttribute('class');
    if (fromGet != null) return String(fromGet);
  }
  if (node.attributes && node.attributes.className != null) return String(node.attributes.className);
  if (node.attributes && node.attributes.class != null) return String(node.attributes.class);
  return node.className != null ? String(node.className) : '';
}

/**
 * Poll until predicate(root) is truthy or timeoutMs elapses.
 * @param {object} root
 * @param {(root: object) => boolean} predicate
 * @param {{ intervalMs?: number, timeoutMs?: number }} [opts]
 */
export async function waitForDomCondition(root, predicate, opts = {}) {
  const intervalMs = opts.intervalMs ?? 10;
  const timeoutMs = opts.timeoutMs ?? 5000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate(root)) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return predicate(root);
}

export function domClassIncludes(node, token) {
  return domElementClassName(node).split(/\s+/).filter(Boolean).includes(token);
}

export function findReportsStatusNode(root) {
  const byTest = findDomNodes(root, (n) => n.getAttribute?.('data-test') === 'status')[0];
  if (byTest) return byTest;
  return findDomNodes(root, (n) => domClassIncludes(n, 'ba-reports-status'))[0];
}

function reportsLoadFailureReason(root) {
  const status = findReportsStatusNode(root);
  const text = status ? aggregateDomTextContent(status).trim() : '';
  if (text.includes('Đã tải')) return null;
  if (text.includes('Đang tải')) return null;
  if (text) return text;
  const retry = findDomNodes(root, (n) => domClassIncludes(n, 'ba-reports-retry'))[0];
  if (retry && !domElementIsHidden(retry)) return 'load failed (retry visible)';
  return 'timed out waiting for report load';
}

/**
 * Poll until reports status shows success (`Đã tải`) or fail with the live status / error text.
 * @param {object} root
 * @param {{ intervalMs?: number, timeoutMs?: number }} [opts]
 */
export async function waitForReportsLoad(root, opts = {}) {
  const ok = await waitForDomCondition(root, (r) => {
    const status = findReportsStatusNode(r);
    const text = status ? aggregateDomTextContent(status) : '';
    return text.includes('Đã tải');
  }, opts);
  if (!ok) {
    assert.fail(reportsLoadFailureReason(root));
  }
}

/**
 * Freeze `Date` for BA UI default month filters; does not mock timers/setTimeout.
 * @param {import('node:test').TestContext} t
 * @param {string} dateKey YYYY-MM-DD in UTC+7
 * @returns {string} UTC ISO for the same instant (noon UTC+7)
 */
export function installFixedUtc7TestClock(t, dateKey) {
  const iso = fixedUtc7NoonIso(dateKey);
  const nowMs = Date.parse(iso);
  t.mock.timers.enable({ apis: ['Date'], now: nowMs });
  t.after(() => {
    t.mock.timers.reset();
  });
  return iso;
}

/** @param {Node} root @param {(n: object) => boolean} predicate */
export function findDomNodes(root, predicate) {
  const found = [];
  (function walk(n) {
    if (!n) return;
    if (predicate(n)) found.push(n);
    for (const c of n.childNodes || []) walk(c);
  })(root);
  return found;
}

/**
 * @param {Map<string, Function>} handlers
 * @param {{ preventDefault?: () => void, returnValue?: string, _prevented?: boolean }} [eventInit]
 */
export function dispatchBeforeUnload(handlers, eventInit = {}) {
  const fn = handlers.get('beforeunload');
  const event = {
    returnValue: 'x',
    preventDefault() {
      this._prevented = true;
    },
    ...eventInit,
  };
  if (typeof fn === 'function') fn(event);
  return event;
}
