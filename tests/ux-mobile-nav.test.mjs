import test from 'node:test';
import assert from 'node:assert/strict';
import { EXAM_NAV_ITEM } from '../dist/exam-domain.js';
import { BA_NAV_ITEMS } from '../dist/ba-ui.js';
import {
  TEACHER_BOTTOM_TAB_COUNT,
  buildStudentBottomTabs,
  buildTeacherBottomTabs,
  filterNavItemsForRole,
  listTeacherMoreMenuItems,
  resolveMobileBottomActive,
  resetMobileNavControllerForTests,
  getMobileNavController,
  renderMobileNavigation,
  MOBILE_DESKTOP_MIN_WIDTH,
} from '../dist/ux-mobile-nav.js';
import { wireDialogA11y } from '../dist/ux-forms.js';

const SAMPLE_NAV = [
  { id: 'dashboard', label: 'Tổng quan', hash: '#/dashboard', teacher: true },
  { id: 'classes', label: 'Lớp học', hash: '#/classes', teacher: true },
  ...BA_NAV_ITEMS,
  EXAM_NAV_ITEM,
  { id: 'assignments', label: 'Bài tập', hash: '#/assignments', teacher: true, student: true },
  { id: 'grading', label: 'Chấm bài', hash: '#/grading', teacher: true },
  { id: 'accounts', label: 'Tài khoản', hash: '#/accounts', teacher: true },
  { id: 'settings', label: 'Cài đặt', hash: '#/settings', teacher: true, student: true },
];

test('teacher bottom bar exposes exactly five equal primary tabs', () => {
  const tabs = buildTeacherBottomTabs();
  assert.equal(tabs.length, TEACHER_BOTTOM_TAB_COUNT);
  assert.equal(tabs.filter((t) => t.id === 'more').length, 1);
  assert.deepEqual(
    tabs.map((t) => t.id),
    ['dashboard', 'classes', 'assignments', 'grading', 'more'],
  );
});

test('student nav keeps only authorized routes without granting extras', () => {
  const studentSidebar = filterNavItemsForRole(SAMPLE_NAV, { isTeacher: false });
  const ids = studentSidebar.map((i) => i.id);
  assert.deepEqual(ids, ['assignments', 'exams', 'settings']);
  const bottom = buildStudentBottomTabs({ includeExams: EXAM_NAV_ITEM.student });
  assert.equal(bottom.length, 3);
  assert.ok(!bottom.some((t) => t.id === 'more'));
  assert.ok(!bottom.some((t) => t.hash === '#/accounts'));
});

test('teacher sidebar filter retains full desktop nav items', () => {
  const teacherSidebar = filterNavItemsForRole(SAMPLE_NAV, { isTeacher: true });
  assert.ok(teacherSidebar.some((i) => i.id === 'tutor'));
  assert.ok(teacherSidebar.some((i) => i.id === 'accounts'));
});

test('resolveMobileBottomActive maps overflow and primary routes', () => {
  assert.deepEqual(resolveMobileBottomActive({ view: 'dashboard' }, true), {
    tabId: 'dashboard',
    moreActive: false,
  });
  assert.deepEqual(resolveMobileBottomActive({ view: 'class-detail' }, true), {
    tabId: 'classes',
    moreActive: false,
  });
  assert.deepEqual(resolveMobileBottomActive({ view: 'assignment-detail' }, true), {
    tabId: 'assignments',
    moreActive: false,
  });
  assert.deepEqual(resolveMobileBottomActive({ view: 'grading-editor' }, true), {
    tabId: 'grading',
    moreActive: false,
  });
  assert.deepEqual(resolveMobileBottomActive({ view: 'tutor-reports' }, true), {
    tabId: 'more',
    moreActive: true,
  });
  assert.deepEqual(resolveMobileBottomActive({ view: 'exams-hub' }, true), {
    tabId: 'more',
    moreActive: true,
  });
  assert.deepEqual(resolveMobileBottomActive({ view: 'accounts' }, true), {
    tabId: 'more',
    moreActive: true,
  });
  assert.deepEqual(resolveMobileBottomActive({ view: 'exams-take' }, false), {
    tabId: 'exams',
    moreActive: false,
  });
});

test('teacher more menu lists tutor shortcuts and app links', () => {
  const items = listTeacherMoreMenuItems();
  assert.ok(items.some((i) => i.hash === '#/tutor/schedule'));
  assert.ok(items.some((i) => i.hash === '#/tutor/reports'));
  assert.ok(items.some((i) => i.hash === '#/tutor/attendance-calendar'));
  assert.ok(items.some((i) => i.hash === '#/exams'));
  assert.ok(items.some((i) => i.hash === '#/accounts'));
  assert.ok(items.some((i) => i.hash === '#/settings'));
});

function wireChildTree(el) {
  Object.defineProperty(el, 'firstChild', {
    configurable: true,
    enumerable: true,
    get() {
      return el.childNodes[0] ?? null;
    },
  });
  Object.defineProperty(el, 'lastChild', {
    configurable: true,
    enumerable: true,
    get() {
      const nodes = el.childNodes;
      return nodes.length ? nodes[nodes.length - 1] : null;
    },
  });
  el.appendChild = (child) => {
    if (!child) return child;
    if (child.parentNode && child.parentNode !== el) {
      child.parentNode.removeChild(child);
    }
    el.childNodes.push(child);
    child.parentNode = el;
    return child;
  };
  el.removeChild = (child) => {
    const idx = el.childNodes.indexOf(child);
    if (idx >= 0) el.childNodes.splice(idx, 1);
    if (child?.parentNode === el) child.parentNode = null;
    return child;
  };
}

function makeMinimalDoc() {
  const listeners = {};
  const body = {
    childNodes: [],
    classList: {
      _c: new Set(),
      toggle(name, on) {
        if (on) this._c.add(name);
        else this._c.delete(name);
      },
      contains(name) {
        return this._c.has(name);
      },
    },
    appendChild(node) {
      this.childNodes.push(node);
      node.parentNode = this;
      this.lastChild = node;
      return node;
    },
    removeChild(node) {
      const idx = this.childNodes.indexOf(node);
      if (idx >= 0) this.childNodes.splice(idx, 1);
      if (node?.parentNode === this) node.parentNode = null;
      return node;
    },
    className: '',
  };
  const bottomNavEl = {
    childNodes: [],
    ownerDocument: null,
  };
  wireChildTree(bottomNavEl);
  Object.defineProperty(bottomNavEl, 'childElementCount', {
    get() { return bottomNavEl.childNodes.length; },
  });

  const doc = {
    body,
    documentElement: {
      ownerDocument: null,
      style: { getPropertyValue: () => '72px' },
    },
    createElement(tag) {
      const nodeListeners = {};
      const node = {
        tagName: tag.toUpperCase(),
        childNodes: [],
        attributes: {},
        classList: {
          _c: new Set(),
          add(...names) { names.forEach((n) => this._c.add(n)); },
          toggle(name, on) {
            if (on) this._c.add(name);
            else this._c.delete(name);
          },
          has(name) { return this._c.has(name); },
        },
        get className() {
          return [...this.classList._c].join(' ');
        },
        set className(value) {
          this.classList._c = new Set(String(value).split(/\s+/).filter(Boolean));
        },
        style: {},
        hidden: false,
        parentNode: null,
        setAttribute(k, v) {
          this.attributes[k] = v;
        },
        getAttribute(k) {
          return this.attributes[k] ?? null;
        },
        addEventListener(type, fn) {
          (nodeListeners[type] ||= []).push(fn);
        },
        removeEventListener(type, fn) {
          if (!nodeListeners[type]) return;
          nodeListeners[type] = nodeListeners[type].filter((h) => h !== fn);
        },
        dispatchEvent(event) {
          const type = event?.type;
          for (const fn of nodeListeners[type] || []) fn(event);
          return true;
        },
        focus() {},
        remove() {
          if (this.parentNode) this.parentNode.removeChild(this);
        },
        querySelector() { return null; },
        querySelectorAll() { return []; },
      };
      wireChildTree(node);
      return node;
    },
    createElementNS(_ns, tag) {
      return this.createElement(tag);
    },
    defaultView: {
      getComputedStyle() {
        return { getPropertyValue: () => '72px' };
      },
      matchMedia(query) {
        return {
          matches: query.includes(String(MOBILE_DESKTOP_MIN_WIDTH)),
          addEventListener() {},
          removeEventListener() {},
        };
      },
      addEventListener(type, fn) {
        (listeners[type] ||= []).push(fn);
      },
      removeEventListener(type, fn) {
        if (!listeners[type]) return;
        listeners[type] = listeners[type].filter((h) => h !== fn);
      },
    },
    getElementById() { return null; },
    addEventListener(type, fn) {
      (listeners[type] ||= []).push(fn);
    },
    removeEventListener(type, fn) {
      if (!listeners[type]) return;
      listeners[type] = listeners[type].filter((h) => h !== fn);
    },
  };
  doc.defaultView.document = doc;
  doc.documentElement.ownerDocument = doc;
  bottomNavEl.ownerDocument = doc;
  return { doc, bottomNavEl, listeners, body };
}

test('renderMobileNavigation closes sheet on route change and clears when hidden', async (t) => {
  const originalDocument = globalThis.document;
  resetMobileNavControllerForTests();
  const { doc, bottomNavEl, body } = makeMinimalDoc();
  globalThis.document = {
    ...doc,
    activeElement: null,
    addEventListener(type, fn) {
      (doc._globalListeners ||= {})[type] = (doc._globalListeners[type] || []).concat(fn);
    },
    removeEventListener(type, fn) {
      if (!doc._globalListeners?.[type]) return;
      doc._globalListeners[type] = doc._globalListeners[type].filter((h) => h !== fn);
    },
  };
  t.after(() => {
    globalThis.document = originalDocument;
    resetMobileNavControllerForTests();
  });

  const ctrl = getMobileNavController(doc);
  const base = {
    bottomNavEl,
    isTeacher: true,
    navigate: () => {},
    showNav: true,
    includeStudentExams: false,
  };

  renderMobileNavigation({ ...base, route: { view: 'dashboard' } });
  assert.equal(bottomNavEl.childNodes.length, TEACHER_BOTTOM_TAB_COUNT);

  const moreBtn = bottomNavEl.childNodes.find((n) => n.classList.has('mobile-nav-item-more'));
  assert.ok(moreBtn);
  moreBtn.dispatchEvent({ type: 'click' });
  assert.equal(ctrl.isSheetOpen(), true);
  assert.equal(body.classList.contains('mobile-nav-menu-open'), true);

  renderMobileNavigation({ ...base, route: { view: 'tutor-reports' } });
  assert.equal(ctrl.isSheetOpen(), false);

  renderMobileNavigation({ ...base, route: { view: 'tutor-reports' }, showNav: false });
  assert.equal(bottomNavEl.childNodes.length, 0);
  assert.equal(body.classList.contains('mobile-nav-menu-open'), false);
});

test('wireDialogA11y Escape closes mobile menu harness', async (t) => {
  const originalDocument = globalThis.document;
  const handlers = [];
  globalThis.document = {
    activeElement: { focus() {} },
    addEventListener(type, fn) {
      if (type === 'keydown') handlers.push(fn);
    },
    removeEventListener(type, fn) {
      const i = handlers.indexOf(fn);
      if (i >= 0) handlers.splice(i, 1);
    },
  };
  t.after(() => {
    globalThis.document = originalDocument;
  });

  const dialog = {
    querySelectorAll: () => [],
    querySelector: () => ({ focus() {} }),
  };
  let closed = false;
  const dispose = wireDialogA11y({
    backdrop: {},
    dialog,
    titleId: 'mobile-nav-menu-title',
    onRequestClose: () => { closed = true; },
    focusOpener: { focus() {} },
  });
  handlers[0]({ key: 'Escape' });
  assert.equal(closed, true);
  dispose();
});

test('resetMobileNavController destroy removes sheet host without throw', async (t) => {
  const originalDocument = globalThis.document;
  resetMobileNavControllerForTests();
  const { doc, bottomNavEl } = makeMinimalDoc();
  globalThis.document = {
    ...doc,
    activeElement: null,
    addEventListener(type, fn) {
      (doc._globalListeners ||= {})[type] = (doc._globalListeners[type] || []).concat(fn);
    },
    removeEventListener(type, fn) {
      if (!doc._globalListeners?.[type]) return;
      doc._globalListeners[type] = doc._globalListeners[type].filter((h) => h !== fn);
    },
  };
  t.after(() => {
    globalThis.document = originalDocument;
    resetMobileNavControllerForTests();
  });

  const ctrl = getMobileNavController(doc);
  renderMobileNavigation({
    bottomNavEl,
    isTeacher: true,
    navigate: () => {},
    showNav: true,
    includeStudentExams: false,
    route: { view: 'dashboard' },
  });
  const moreBtn = bottomNavEl.childNodes.find((n) => n.classList.has('mobile-nav-item-more'));
  moreBtn.dispatchEvent({ type: 'click' });
  assert.equal(ctrl.isSheetOpen(), true);
  resetMobileNavControllerForTests();
});
