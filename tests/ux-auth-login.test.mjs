import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bumpRequestEpoch,
  getRequestEpoch,
  isStaleEpoch,
  getCurrentUser,
  setUnauthorizedHandler,
  login,
  logout,
  apiFetch,
  isLoginCredentialRejection401,
} from '../dist/api-client.js';

function csrfOk() {
  return { ok: true, status: 200, headers: { get: () => '' } };
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json' },
    json: async () => body,
  };
}

test('isLoginCredentialRejection401 matches POST login only', () => {
  assert.equal(isLoginCredentialRejection401('/api/auth/login', 'POST'), true);
  assert.equal(isLoginCredentialRejection401('/api/auth/login', 'GET'), false);
  assert.equal(isLoginCredentialRejection401('/api/bootstrap', 'GET'), false);
});

test('wrong login 401 preserves epoch, user, and surfaces error without global handler', async (t) => {
  const originalFetch = globalThis.fetch;
  const originalDocument = globalThis.document;
  globalThis.document = { cookie: 'bn_csrf=test-csrf-token' };

  let unauthorizedCalls = 0;
  setUnauthorizedHandler(() => {
    unauthorizedCalls += 1;
  });

  globalThis.fetch = async (url, options = {}) => {
    const path = String(url);
    if (path.endsWith('/api/auth/csrf')) return csrfOk();
    if (path.endsWith('/api/auth/logout') && options.method === 'POST') {
      return jsonResponse({ ok: true });
    }
    if (path.endsWith('/api/auth/login') && options.method === 'POST') {
      return jsonResponse({ error: 'Sai tên đăng nhập hoặc mật khẩu.' }, 401);
    }
    throw new Error(`unexpected fetch ${path}`);
  };

  t.after(() => {
    globalThis.fetch = originalFetch;
    globalThis.document = originalDocument;
    setUnauthorizedHandler(null);
  });

  await logout();
  const userBefore = getCurrentUser();
  const epochBefore = getRequestEpoch();

  await assert.rejects(
    () => login('wrong', 'badpass'),
    (err) => err.status === 401 && err.message.includes('Sai tên đăng nhập'),
  );
  assert.equal(getRequestEpoch(), epochBefore, 'login credential 401 must not bump epoch');
  assert.equal(getCurrentUser(), userBefore, 'rejected login must preserve prior session identity');
  assert.equal(unauthorizedCalls, 0, 'login credential 401 must not invoke unauthorized handler');
});

test('protected api 401 still clears session and bumps epoch', async (t) => {
  const originalFetch = globalThis.fetch;
  const originalDocument = globalThis.document;
  globalThis.document = { cookie: 'bn_csrf=test-csrf-token' };

  let unauthorizedCalls = 0;
  setUnauthorizedHandler(() => {
    unauthorizedCalls += 1;
  });

  globalThis.fetch = async (url, options = {}) => {
    const path = String(url);
    if (path.endsWith('/api/auth/csrf')) return csrfOk();
    if (path.endsWith('/api/auth/logout') && options.method === 'POST') {
      return jsonResponse({ ok: true });
    }
    if (path.endsWith('/api/bootstrap') && (!options.method || options.method === 'GET')) {
      return jsonResponse({ error: 'Chưa đăng nhập.' }, 401);
    }
    throw new Error(`unexpected fetch ${path}`);
  };

  await logout();
  const epochBefore = getRequestEpoch();

  t.after(() => {
    globalThis.fetch = originalFetch;
    globalThis.document = originalDocument;
    setUnauthorizedHandler(null);
  });

  await assert.rejects(() => apiFetch('/api/bootstrap'), (err) => err.status === 401);
  assert.equal(getRequestEpoch(), epochBefore + 1);
  assert.equal(unauthorizedCalls, 1);
});

test('retry after wrong login succeeds when credentials correct', async (t) => {
  const originalFetch = globalThis.fetch;
  const originalDocument = globalThis.document;
  globalThis.document = { cookie: 'bn_csrf=test-csrf-token' };

  let loginAttempts = 0;

  globalThis.fetch = async (url, options = {}) => {
    const path = String(url);
    if (path.endsWith('/api/auth/csrf')) return csrfOk();
    if (path.endsWith('/api/auth/logout') && options.method === 'POST') {
      return jsonResponse({ ok: true });
    }
    if (path.endsWith('/api/auth/login') && options.method === 'POST') {
      loginAttempts += 1;
      if (loginAttempts === 1) {
        return jsonResponse({ error: 'Sai tên đăng nhập hoặc mật khẩu.' }, 401);
      }
      return jsonResponse({ ok: true });
    }
    if (path.endsWith('/api/auth/me')) {
      return jsonResponse({
        user: { role: 'teacher', username: 'okuser', mustChangePassword: false },
      });
    }
    throw new Error(`unexpected fetch ${path}`);
  };

  t.after(() => {
    globalThis.fetch = originalFetch;
    globalThis.document = originalDocument;
    setUnauthorizedHandler(null);
  });

  await logout();
  const userBefore = getCurrentUser();
  assert.equal(userBefore, null);

  await assert.rejects(() => login('okuser', 'wrong'));
  assert.equal(getCurrentUser(), userBefore, 'failed attempt leaves anonymous session unchanged');

  const user = await login('okuser', 'right');
  assert.equal(user.username, 'okuser');
  assert.equal(loginAttempts, 2);
});

test('stale login error does not apply when auth shell form generation advances', async (t) => {
  const originalFetch = globalThis.fetch;
  const originalDocument = globalThis.document;
  globalThis.document = { cookie: 'bn_csrf=test-csrf-token' };

  let releaseLogin;
  const loginGate = new Promise((resolve) => { releaseLogin = resolve; });
  let loginStarted;
  const loginEntered = new Promise((resolve) => { loginStarted = resolve; });

  globalThis.fetch = async (url, options = {}) => {
    const path = String(url);
    if (path.endsWith('/api/auth/csrf')) return csrfOk();
    if (path.endsWith('/api/auth/logout') && options.method === 'POST') {
      return jsonResponse({ ok: true });
    }
    if (path.endsWith('/api/auth/login') && options.method === 'POST') {
      loginStarted();
      await loginGate;
      return jsonResponse({ error: 'Sai tên đăng nhập hoặc mật khẩu.' }, 401);
    }
    throw new Error(`unexpected fetch ${path}`);
  };

  t.after(() => {
    globalThis.fetch = originalFetch;
    globalThis.document = originalDocument;
    setUnauthorizedHandler(null);
  });

  await logout();
  const entryEpoch = getRequestEpoch();
  const staleReq = login('u1', 'p1');
  await loginEntered;
  bumpRequestEpoch();
  assert.equal(isStaleEpoch(entryEpoch), true);
  releaseLogin();
  await assert.rejects(staleReq, (err) => err.status === 401);
});
