/**
 * Same-origin API client (session cookie + CSRF header).
 */

let csrfReady = false;
/** @type {{ role: string, displayName: string, mustChangePassword: boolean, studentId?: string } | null} */
let currentUser = null;
let requestEpoch = 0;
/** @type {(() => void) | null} */
let unauthorizedHandler = null;

export function setUnauthorizedHandler(fn) {
  unauthorizedHandler = typeof fn === 'function' ? fn : null;
}

function readCsrfFromCookie() {
  const m = document.cookie.match(/(?:^|;\s*)bn_csrf=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : '';
}

export async function ensureCsrf() {
  if (readCsrfFromCookie()) {
    csrfReady = true;
    return;
  }
  await fetch('/api/auth/csrf', { credentials: 'same-origin' });
  csrfReady = !!readCsrfFromCookie();
}

export function getCurrentUser() {
  return currentUser;
}

export function bumpRequestEpoch() {
  requestEpoch += 1;
  return requestEpoch;
}

export function getRequestEpoch() {
  return requestEpoch;
}

export function isStaleEpoch(epoch) {
  return epoch !== requestEpoch;
}

/** Stable principal string for the signed-in user at call time. */
export function captureAuthPrincipal() {
  const u = currentUser;
  if (!u) return 'anonymous';
  if (u.role === 'student' && u.studentId) return `student:${u.studentId}`;
  return `role:${u.role}:${u.username ?? ''}`;
}

/**
 * @param {number} epochAtStart
 * @param {string|null|undefined} principalAtStart when omitted, only epoch is checked
 */
export function isInitiatingAuthStale(epochAtStart, principalAtStart = null) {
  if (isStaleEpoch(epochAtStart)) return true;
  if (principalAtStart != null && principalAtStart !== captureAuthPrincipal()) return true;
  return false;
}

function throwStaleAuthError() {
  const err = new Error('stale-session');
  err.staleAuth = true;
  throw err;
}

/** Wrong credentials on login — not a global session expiry. */
export function isLoginCredentialRejection401(path, method) {
  return path === '/api/auth/login' && method === 'POST';
}

function applyUnauthorized401SideEffects(epochAtStart, path, method) {
  if (isLoginCredentialRejection401(path, method)) return;
  if (isStaleEpoch(epochAtStart)) return;
  currentUser = null;
  bumpRequestEpoch();
  try {
    unauthorizedHandler?.();
  } catch (handlerErr) {
    console.error(handlerErr);
  }
}

export async function apiFetch(path, options = {}) {
  const epochAtStart = requestEpoch;
  const method = options.method || 'GET';
  const headers = { ...(options.headers || {}) };
  if (method !== 'GET' && method !== 'HEAD') {
    if (!csrfReady) await ensureCsrf();
    headers['Content-Type'] = 'application/json';
    headers['X-BN-CSRF'] = readCsrfFromCookie();
  }
  const res = await fetch(path, {
    ...options,
    method,
    headers,
    credentials: 'same-origin',
    body: options.body != null ? JSON.stringify(options.body) : undefined,
  });
  let data = null;
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) {
    data = await res.json();
  }
  if (res.status === 401) {
    const staleAuthSideEffect = isStaleEpoch(epochAtStart);
    if (!staleAuthSideEffect) {
      applyUnauthorized401SideEffects(epochAtStart, path, method);
    }
    const err = new Error(data?.error || 'Unauthorized');
    err.status = 401;
    err.staleAuth = staleAuthSideEffect;
    throw err;
  }
  if (!res.ok) {
    const err = new Error(data?.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

export async function fetchBootstrap() {
  return apiFetch('/api/bootstrap');
}

export async function fetchMe() {
  const epochAtStart = requestEpoch;
  const data = await apiFetch('/api/auth/me');
  if (!isStaleEpoch(epochAtStart)) {
    currentUser = data.user;
  }
  return data.user;
}

export async function login(username, password) {
  await ensureCsrf();
  await apiFetch('/api/auth/login', { method: 'POST', body: { username, password } });
  return fetchMe();
}

export async function logout() {
  let ok = true;
  try {
    await apiFetch('/api/auth/logout', { method: 'POST', body: {} });
  } catch {
    ok = false;
  }
  currentUser = null;
  bumpRequestEpoch();
  return { ok };
}

export async function setupTeacher({ username, password, displayName }) {
  await ensureCsrf();
  await apiFetch('/api/auth/setup', { method: 'POST', body: { username, password, displayName } });
  return fetchMe();
}

export async function changePassword({ currentPassword, newPassword }) {
  const epochAtStart = requestEpoch;
  await apiFetch('/api/auth/change-password', {
    method: 'POST',
    body: { currentPassword, newPassword },
  });
  if (isStaleEpoch(epochAtStart)) {
    return getCurrentUser();
  }
  const data = await apiFetch('/api/auth/me');
  if (!isStaleEpoch(epochAtStart)) {
    currentUser = data.user;
  }
  return getCurrentUser();
}

export async function loadAppData() {
  const data = await apiFetch('/api/data');
  return data.data;
}

export async function putRecord(collection, record) {
  const map = {
    classes: '/api/teacher/record/classes',
    students: '/api/teacher/record/students',
    assignments: '/api/teacher/record/assignments',
    submissions: '/api/teacher/record/submissions',
  };
  const url = map[collection];
  if (!url) throw new Error('unsupported');
  await apiFetch(url, { method: 'PUT', body: record });
}

export function newOperationId() {
  return crypto.randomUUID();
}

/** @type {Map<string, string>} */
const clientOperationIds = new Map();

export function clearClientOperation(key) {
  if (key) clientOperationIds.delete(key);
}

export function clearClientOperations() {
  clientOperationIds.clear();
}

function resolveClientOperation(key, { fresh = false } = {}) {
  if (fresh) clientOperationIds.delete(key);
  if (!clientOperationIds.has(key)) {
    clientOperationIds.set(key, newOperationId());
  }
  return clientOperationIds.get(key);
}

function ackClientOperation(key, { keep = false } = {}) {
  if (!keep) clientOperationIds.delete(key);
}

export async function updateTeacherSettings(teacherName) {
  await apiFetch('/api/teacher/settings', { method: 'PUT', body: { teacherName } });
}

export async function listStudentAccounts() {
  const data = await apiFetch('/api/teacher/accounts');
  return data.accounts;
}

export async function createStudentAccount(payload) {
  const studentId = payload?.studentId || '';
  const username = String(payload?.username || '').trim();
  const opKey = `create-student-account:${studentId}:${username}`;
  const operationId = payload?.operationId
    || resolveClientOperation(opKey, { fresh: payload?.freshOperation });
  const data = await apiFetch('/api/teacher/accounts/students', {
    method: 'POST',
    body: { ...payload, operationId },
  });
  if (data?.ok && !data?.replay) {
    ackClientOperation(opKey);
  } else if (data?.ok && data?.replay) {
    ackClientOperation(opKey, { keep: true });
  }
  return data;
}

export async function accountAction(accountId, action, options = {}) {
  const opKey = `account:${accountId}:${action}`;
  const operationId = options.operationId
    || resolveClientOperation(opKey, { fresh: options.freshOperation });
  const data = await apiFetch(`/api/teacher/accounts/students/${accountId}/${action}`, {
    method: 'POST',
    body: { operationId },
  });
  if (data?.ok) {
    const keepForLostCredentials = action === 'reset-password' && data.replay;
    ackClientOperation(opKey, { keep: keepForLostCredentials });
  }
  return data;
}

export async function migrateLocalData(backup, images) {
  await apiFetch('/api/teacher/migrate-local', {
    method: 'POST',
    body: { backup, images },
  });
}

export async function uploadImageBlob(
  blob,
  mime = 'image/jpeg',
  epochAtStart = requestEpoch,
  principalAtStart = null,
) {
  const buf = await blob.arrayBuffer();
  if (isInitiatingAuthStale(epochAtStart, principalAtStart)) throwStaleAuthError();
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  const dataBase64 = btoa(binary);
  if (!readCsrfFromCookie()) await ensureCsrf();
  if (isInitiatingAuthStale(epochAtStart, principalAtStart)) throwStaleAuthError();
  const data = await apiFetch('/api/images', {
    method: 'POST',
    body: { mime, dataBase64 },
  });
  if (isInitiatingAuthStale(epochAtStart, principalAtStart)) throwStaleAuthError();
  return data.id;
}

export function imageUrl(imageId) {
  return `/api/images/${encodeURIComponent(imageId)}`;
}

function readCsrfFromCookieForUpload() {
  const m = document.cookie.match(/(?:^|;\s*)bn_csrf=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : '';
}

export function attachmentUrl(attachmentId) {
  return `/api/attachments/${encodeURIComponent(attachmentId)}`;
}

/**
 * @param {File} file
 * @param {(loaded: number, total: number) => void} [onProgress]
 */
export async function uploadTeacherAttachment(file, onProgress) {
  const epochAtStart = requestEpoch;
  await ensureCsrf();
  const csrf = readCsrfFromCookieForUpload();
  const headers = {
    'X-BN-CSRF': csrf,
    'X-BN-Filename': encodeURIComponent(file.name || 'file'),
  };
  if (file.type) headers['Content-Type'] = file.type;
  const res = await fetch('/api/teacher/attachments', {
    method: 'POST',
    headers,
    credentials: 'same-origin',
    body: file,
  });
  let data = null;
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) data = await res.json();
  if (res.status === 401) {
    const staleAuthSideEffect = isStaleEpoch(epochAtStart);
    if (!staleAuthSideEffect) {
      currentUser = null;
      bumpRequestEpoch();
      try {
        unauthorizedHandler?.();
      } catch (handlerErr) {
        console.error(handlerErr);
      }
    }
    const err = new Error(data?.error || 'Unauthorized');
    err.status = 401;
    err.staleAuth = staleAuthSideEffect;
    throw err;
  }
  if (!res.ok) {
    const err = new Error(data?.error || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  if (onProgress) onProgress(file.size, file.size);
  return data;
}

export async function studentSaveDraft(assignmentId, pageImageIds) {
  await apiFetch('/api/student/submissions/draft', {
    method: 'POST',
    body: { assignmentId, pageImageIds },
  });
}

export async function studentSubmitWork(assignmentId, pageImageIds, operationId) {
  const opKey = `student-submit:${assignmentId}`;
  const op = operationId || resolveClientOperation(opKey);
  const data = await apiFetch('/api/student/submissions/submit', {
    method: 'POST',
    body: {
      operationId: op,
      assignmentId,
      pageImageIds,
    },
  });
  if (data?.ok) ackClientOperation(opKey);
  return data;
}

export async function studentSubmitRevision(assignmentId, pageImageIds, operationId) {
  const opKey = `student-revision:${assignmentId}`;
  const op = operationId || resolveClientOperation(opKey);
  const data = await apiFetch('/api/student/submissions/revision', {
    method: 'POST',
    body: {
      operationId: op,
      assignmentId,
      pageImageIds,
    },
  });
  if (data?.ok) ackClientOperation(opKey);
  return data;
}

export async function studentMarkFeedbackViewed(submissionId) {
  await apiFetch('/api/student/submissions/feedback-viewed', {
    method: 'POST',
    body: { submissionId },
  });
}
