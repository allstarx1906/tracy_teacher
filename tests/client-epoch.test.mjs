import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bumpRequestEpoch,
  getRequestEpoch,
  isStaleEpoch,
  getCurrentUser,
  setUnauthorizedHandler,
  apiFetch,
  fetchMe,
  uploadTeacherAttachment,
  uploadImageBlob,
  captureAuthPrincipal,
  changePassword,
  logout,
} from '../dist/api-client.js';

test('auth request epoch invalidates in-flight credential UI callbacks', () => {
  const start = getRequestEpoch();
  assert.equal(isStaleEpoch(start), false);
  bumpRequestEpoch();
  assert.equal(isStaleEpoch(start), true);
  const afterLogout = getRequestEpoch();
  bumpRequestEpoch();
  assert.equal(isStaleEpoch(afterLogout), true);
});

test('stale 401 responses do not clear a newer signed-in session', async (t) => {
  const originalFetch = globalThis.fetch;
  const originalDocument = globalThis.document;
  globalThis.document = { cookie: 'bn_csrf=test-csrf-token' };

  let release401;
  let staleFetchEntered;
  const gate401 = new Promise((resolve) => {
    release401 = resolve;
  });
  const staleFetchStarted = new Promise((resolve) => {
    staleFetchEntered = resolve;
  });
  let unauthorizedCalls = 0;
  setUnauthorizedHandler(() => {
    unauthorizedCalls += 1;
  });

  globalThis.fetch = async (url, options = {}) => {
    const path = String(url);
    if (path.endsWith('/api/auth/csrf')) {
      return { ok: true, status: 200, headers: { get: () => '' } };
    }
    if (path.endsWith('/api/auth/change-password') && options.method === 'POST') {
      staleFetchEntered();
      await gate401;
      return {
        ok: false,
        status: 401,
        headers: { get: () => 'application/json' },
        json: async () => ({ error: 'Mật khẩu hiện tại không đúng.' }),
      };
    }
    if (path.endsWith('/api/auth/me')) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: async () => ({
          user: { role: 'teacher', username: 'live', mustChangePassword: false },
        }),
      };
    }
    throw new Error(`unexpected fetch ${path} ${options.method || 'GET'}`);
  };

  t.after(() => {
    globalThis.fetch = originalFetch;
    globalThis.document = originalDocument;
    setUnauthorizedHandler(null);
  });

  const stalePasswordReq = apiFetch('/api/auth/change-password', {
    method: 'POST',
    body: { currentPassword: 'wrong', newPassword: 'newpass1234' },
  });
  await staleFetchStarted;
  bumpRequestEpoch();
  const liveUser = await fetchMe();
  assert.equal(liveUser.username, 'live');
  assert.ok(getCurrentUser(), 'session established before stale 401 completes');
  release401();
  await assert.rejects(stalePasswordReq, (err) => err.status === 401 && err.staleAuth === true);
  assert.ok(getCurrentUser(), 'newer session user remains after stale 401');
  assert.equal(unauthorizedCalls, 0, 'stale 401 must not invoke global unauthorized handler');
});

test('stale upload 401 responses do not clear a newer signed-in session', async (t) => {
  const originalFetch = globalThis.fetch;
  const originalDocument = globalThis.document;
  globalThis.document = { cookie: 'bn_csrf=test-csrf-token' };

  let release401;
  let staleFetchEntered;
  const gate401 = new Promise((resolve) => {
    release401 = resolve;
  });
  const staleFetchStarted = new Promise((resolve) => {
    staleFetchEntered = resolve;
  });
  let unauthorizedCalls = 0;
  setUnauthorizedHandler(() => {
    unauthorizedCalls += 1;
  });

  const fakeFile = {
    name: 'sheet.pdf',
    type: 'application/pdf',
    size: 4,
  };

  globalThis.fetch = async (url, options = {}) => {
    const path = String(url);
    if (path.endsWith('/api/auth/csrf')) {
      return { ok: true, status: 200, headers: { get: () => '' } };
    }
    if (path.endsWith('/api/teacher/attachments') && options.method === 'POST') {
      staleFetchEntered();
      await gate401;
      return {
        ok: false,
        status: 401,
        headers: { get: () => 'application/json' },
        json: async () => ({ error: 'Phiên đăng nhập không còn hợp lệ.' }),
      };
    }
    if (path.endsWith('/api/auth/me')) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: async () => ({
          user: { role: 'teacher', username: 'live', mustChangePassword: false },
        }),
      };
    }
    throw new Error(`unexpected fetch ${path} ${options.method || 'GET'}`);
  };

  t.after(() => {
    globalThis.fetch = originalFetch;
    globalThis.document = originalDocument;
    setUnauthorizedHandler(null);
  });

  const staleUploadReq = uploadTeacherAttachment(fakeFile);
  await staleFetchStarted;
  bumpRequestEpoch();
  const liveUser = await fetchMe();
  assert.equal(liveUser.username, 'live');
  assert.ok(getCurrentUser(), 'session established before stale upload 401 completes');
  release401();
  await assert.rejects(staleUploadReq, (err) => err.status === 401 && err.staleAuth === true);
  assert.ok(getCurrentUser(), 'newer session user remains after stale upload 401');
  assert.equal(unauthorizedCalls, 0, 'stale upload 401 must not invoke global unauthorized handler');
});

test('stale fetchMe does not overwrite a newer session user', async (t) => {
  const originalFetch = globalThis.fetch;
  const originalDocument = globalThis.document;
  globalThis.document = { cookie: 'bn_csrf=test-csrf-token' };

  let releaseStaleMe;
  const staleMeGate = new Promise((resolve) => {
    releaseStaleMe = resolve;
  });
  let staleMeStarted;
  const staleMeEntered = new Promise((resolve) => {
    staleMeStarted = resolve;
  });

  globalThis.fetch = async (url, options = {}) => {
    const path = String(url);
    if (path.endsWith('/api/auth/csrf')) {
      return { ok: true, status: 200, headers: { get: () => '' } };
    }
    if (path.endsWith('/api/auth/me') && options.method !== 'POST') {
      staleMeStarted();
      await staleMeGate;
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: async () => ({
          user: { role: 'teacher', username: 'stale', mustChangePassword: false },
        }),
      };
    }
    throw new Error(`unexpected fetch ${path}`);
  };

  t.after(() => {
    globalThis.fetch = originalFetch;
    globalThis.document = originalDocument;
  });

  const staleReq = fetchMe();
  await staleMeEntered;
  bumpRequestEpoch();
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('/api/auth/me')) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: async () => ({
          user: { role: 'teacher', username: 'live', mustChangePassword: false },
        }),
      };
    }
    throw new Error('unexpected');
  };
  await fetchMe();
  assert.equal(getCurrentUser().username, 'live');
  releaseStaleMe();
  await staleReq;
  assert.equal(getCurrentUser().username, 'live');
});

test('stale changePassword success does not restore user after logout', async (t) => {
  const originalFetch = globalThis.fetch;
  const originalDocument = globalThis.document;
  globalThis.document = { cookie: 'bn_csrf=test-csrf-token' };

  let releaseChange;
  const changeGate = new Promise((resolve) => { releaseChange = resolve; });
  let changeStarted;
  const changeEntered = new Promise((resolve) => { changeStarted = resolve; });

  globalThis.fetch = async (url, options = {}) => {
    const path = String(url);
    if (path.endsWith('/api/auth/csrf')) {
      return { ok: true, status: 200, headers: { get: () => '' } };
    }
    if (path.endsWith('/api/auth/change-password') && options.method === 'POST') {
      changeStarted();
      await changeGate;
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: async () => ({ ok: true }),
      };
    }
    if (path.endsWith('/api/auth/me')) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: async () => ({
          user: { role: 'teacher', username: 'restored', mustChangePassword: false },
        }),
      };
    }
    if (path.endsWith('/api/auth/logout') && options.method === 'POST') {
      return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({ ok: true }) };
    }
    throw new Error(`unexpected fetch ${path}`);
  };

  t.after(() => {
    globalThis.fetch = originalFetch;
    globalThis.document = originalDocument;
  });

  const changeReq = changePassword({ currentPassword: 'old', newPassword: 'newpass1234' });
  await changeEntered;
  await logout();
  assert.equal(getCurrentUser(), null);
  releaseChange();
  await changeReq;
  assert.equal(getCurrentUser(), null, 'delayed password change must not repopulate session after logout');
});

test('stale changePassword success does not overwrite replacement login', async (t) => {
  const originalFetch = globalThis.fetch;
  const originalDocument = globalThis.document;
  globalThis.document = { cookie: 'bn_csrf=test-csrf-token' };

  let releaseChange;
  const changeGate = new Promise((resolve) => { releaseChange = resolve; });
  let changeStarted;
  const changeEntered = new Promise((resolve) => { changeStarted = resolve; });
  let meUser = { role: 'teacher', username: 'original', mustChangePassword: false };

  globalThis.fetch = async (url, options = {}) => {
    const path = String(url);
    if (path.endsWith('/api/auth/csrf')) {
      return { ok: true, status: 200, headers: { get: () => '' } };
    }
    if (path.endsWith('/api/auth/change-password') && options.method === 'POST') {
      changeStarted();
      await changeGate;
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: async () => ({ ok: true }),
      };
    }
    if (path.endsWith('/api/auth/me')) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: async () => ({ user: meUser }),
      };
    }
    if (path.endsWith('/api/auth/logout') && options.method === 'POST') {
      return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({ ok: true }) };
    }
    throw new Error(`unexpected fetch ${path}`);
  };

  t.after(() => {
    globalThis.fetch = originalFetch;
    globalThis.document = originalDocument;
  });

  const changeReq = changePassword({ currentPassword: 'old', newPassword: 'newpass1234' });
  await changeEntered;
  await logout();
  meUser = { role: 'teacher', username: 'replacement', mustChangePassword: false };
  bumpRequestEpoch();
  await fetchMe();
  assert.equal(getCurrentUser().username, 'replacement');
  releaseChange();
  await changeReq;
  assert.equal(getCurrentUser().username, 'replacement');
});

test('stale principal blocks uploadImageBlob before network', async (t) => {
  const originalFetch = globalThis.fetch;
  const originalDocument = globalThis.document;
  globalThis.document = { cookie: 'bn_csrf=test-csrf-token' };

  let fetchCalls = 0;
  globalThis.fetch = async (url) => {
    fetchCalls += 1;
    throw new Error(`unexpected fetch ${url}`);
  };

  t.after(() => {
    globalThis.fetch = originalFetch;
    globalThis.document = originalDocument;
  });

  const epoch = getRequestEpoch();
  const principal = captureAuthPrincipal();
  bumpRequestEpoch();

  const blob = {
    arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
  };

  await assert.rejects(
    () => uploadImageBlob(blob, 'image/jpeg', epoch, principal),
    (err) => err.staleAuth === true,
  );
  assert.equal(fetchCalls, 0, 'stale initiating auth must not POST image');
});
