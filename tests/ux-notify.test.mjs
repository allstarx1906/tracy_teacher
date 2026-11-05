import test from 'node:test';
import assert from 'node:assert/strict';
import {
  showErrorBanner,
  hideErrorBanner,
  showCredentialPendingNotice,
  isCredentialPendingNoticeVisibleForTests,
  isErrorBannerVisibleForTests,
  clearAllNotifications,
} from '../dist/ux-notify.js';

/** @type {Document|undefined} */
let savedDocument;
/** @type {typeof globalThis.window|undefined} */
let savedWindow;

function createDomFixture() {
  const nodes = new Map();
  /** @type {Document} */
  const doc = {
    getElementById(id) {
      return nodes.get(id) ?? null;
    },
    createElement(tag) {
      const el = {
        tagName: String(tag).toUpperCase(),
        id: '',
        className: '',
        hidden: false,
        children: [],
        /** @type {Map<string, Function[]>|undefined} */
        _listeners: undefined,
        _appendedToBody: false,
        appendChild(child) {
          this.children.push(child);
          return child;
        },
        replaceChildren() {
          this.children = [];
        },
        remove() {
          if (this.id) nodes.delete(this.id);
        },
        addEventListener(type, listener) {
          if (!this._listeners) this._listeners = new Map();
          const list = this._listeners.get(type) ?? [];
          list.push(listener);
          this._listeners.set(type, list);
        },
        setAttribute() {},
        get isConnected() {
          if (globalThis.document !== doc) return false;
          if (this.id) return nodes.has(this.id);
          return this._appendedToBody;
        },
      };
      return el;
    },
    body: {
      appendChild(el) {
        el._appendedToBody = true;
        if (el.id) nodes.set(el.id, el);
      },
    },
  };

  function dispatchClick(el) {
    const listeners = el._listeners?.get('click') ?? [];
    for (const fn of listeners) fn({ type: 'click' });
  }

  return { doc, dispatchClick };
}

function installDomFixture() {
  savedDocument = globalThis.document;
  savedWindow = globalThis.window;
  const fixture = createDomFixture();
  globalThis.document = fixture.doc;
  if (savedWindow === undefined) {
    globalThis.window = {
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
    };
  } else {
    if (typeof globalThis.window.setTimeout !== 'function') {
      globalThis.window.setTimeout = globalThis.setTimeout.bind(globalThis);
    }
    if (typeof globalThis.window.clearTimeout !== 'function') {
      globalThis.window.clearTimeout = globalThis.clearTimeout.bind(globalThis);
    }
  }
  clearAllNotifications();
  return fixture;
}

function restoreDomFixture() {
  clearAllNotifications();
  globalThis.document = savedDocument;
  if (savedWindow === undefined) {
    delete globalThis.window;
  } else {
    globalThis.window = savedWindow;
  }
}

function withDomFixture(fn) {
  const fixture = installDomFixture();
  try {
    fn(fixture);
  } finally {
    restoreDomFixture();
  }
}

function findCloseButton(container) {
  return container.children.find((c) => c.className === 'toast-close');
}

function findRetryButton(banner) {
  return banner.children.find((c) => c.className === 'btn btn-secondary btn-sm');
}

test('hideCredentialPendingNotice does not clear persistent save error banner', () => {
  withDomFixture(({ dispatchClick }) => {
    showErrorBanner('Lưu bài tập thất bại.', {
      persistent: true,
      retryLabel: 'Thử lại',
      retry: () => {},
    });
    showCredentialPendingNotice('Có mật khẩu tạm chờ xem.', { onOpen: () => {} });
    assert.equal(isErrorBannerVisibleForTests(), true);
    assert.equal(isCredentialPendingNoticeVisibleForTests(), true);
    const notice = document.getElementById('ux-credential-notice');
    dispatchClick(findCloseButton(notice));
    assert.equal(isCredentialPendingNoticeVisibleForTests(), false);
    assert.equal(isErrorBannerVisibleForTests(), true);
    hideErrorBanner();
  });
});

test('credential notice dismiss does not invoke error banner retry', () => {
  withDomFixture(({ dispatchClick }) => {
    let retryCalls = 0;
    showErrorBanner('Lỗi lưu.', { retry: () => { retryCalls += 1; } });
    showCredentialPendingNotice('Chờ xem mật khẩu.', { generation: 2, onOpen: () => {} });
    const notice = document.getElementById('ux-credential-notice');
    dispatchClick(findCloseButton(notice));
    assert.equal(retryCalls, 0);
    assert.equal(isErrorBannerVisibleForTests(), true);
  });
});

test('error banner retry remains visible and callable after credential notice close', () => {
  withDomFixture(({ dispatchClick }) => {
    let retryCalls = 0;
    showErrorBanner('Lỗi lưu.', { retry: () => { retryCalls += 1; } });
    showCredentialPendingNotice('Chờ xem mật khẩu.', { generation: 2, onOpen: () => {} });
    const notice = document.getElementById('ux-credential-notice');
    dispatchClick(findCloseButton(notice));
    assert.equal(retryCalls, 0);
    assert.equal(isErrorBannerVisibleForTests(), true);
    const banner = document.getElementById('ux-error-banner');
    dispatchClick(findRetryButton(banner));
    assert.equal(retryCalls, 1);
  });
});

test('cached banner element is not treated as connected after document fixture is replaced', () => {
  let firstBanner;
  withDomFixture(() => {
    showErrorBanner('first fixture', { persistent: true });
    assert.equal(isErrorBannerVisibleForTests(), true);
    firstBanner = document.getElementById('ux-error-banner');
    assert.ok(firstBanner);
  });
  withDomFixture(() => {
    const currentBanner = document.getElementById('ux-error-banner');
    assert.ok(currentBanner);
    assert.notEqual(currentBanner, firstBanner);
    assert.equal(firstBanner.isConnected, false);
    assert.equal(currentBanner.isConnected, true);
    assert.equal(currentBanner.hidden, true);

    showErrorBanner('second fixture', { persistent: true });
    assert.equal(isErrorBannerVisibleForTests(), true);
    assert.equal(currentBanner.hidden, false);
    assert.equal(currentBanner, document.getElementById('ux-error-banner'));
    const textEl = currentBanner.children.find((c) => c.className === 'ux-error-banner-text');
    assert.equal(textEl?.textContent, 'second fixture');
    assert.equal(firstBanner.isConnected, false);
    assert.notEqual(document.getElementById('ux-error-banner'), firstBanner);
  });
});

test('stale auto-dismiss timer does not hide newer persistent error banner', () => {
  withDomFixture(() => {
    const pending = [];
    const boundSetTimeout = globalThis.setTimeout.bind(globalThis);
    globalThis.window.setTimeout = (fn, ms) => {
      const handle = { fn, ms, cleared: false };
      pending.push(handle);
      return handle;
    };
    globalThis.window.clearTimeout = () => {};
    try {
      showErrorBanner('transient');
      showErrorBanner('persistent', { persistent: true });
      assert.equal(isErrorBannerVisibleForTests(), true);
      for (const t of pending) {
        if (!t.cleared) t.fn();
      }
      assert.equal(isErrorBannerVisibleForTests(), true);
    } finally {
      globalThis.window.setTimeout = boundSetTimeout;
      globalThis.window.clearTimeout = globalThis.clearTimeout.bind(globalThis);
    }
  });
});
