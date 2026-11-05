import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from '../server.mjs';

export function parseSetCookies(res) {
  const raw = res.headers.getSetCookie?.() || [];
  if (raw.length) return raw;
  const single = res.headers.get('set-cookie');
  return single ? [single] : [];
}

export function cookieJar(setCookieLines) {
  const jar = {};
  for (const line of setCookieLines) {
    const part = line.split(';')[0];
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    jar[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return jar;
}

function jarHeader(jar) {
  return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
}

export function createControllableClock(initialIso = '2025-01-01T00:00:00.000Z') {
  let now = initialIso;
  return {
    getNow: () => now,
    set(iso) {
      now = iso;
    },
    advanceMs(ms) {
      now = new Date(new Date(now).getTime() + ms).toISOString();
    },
  };
}

export async function startBaTestServer(options = {}) {
  const clock = options.clock || createControllableClock(options.initialNow || '2025-01-01T00:00:00.000Z');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ba-mvp-test-'));
  const { server, reminderWorker, examStartupReady, shutdownServices, closeStore } = createServer({
    host: '127.0.0.1',
    port: 0,
    dataDir,
    secureCookie: false,
    getNow: clock.getNow,
    reminderWindowMs: options.reminderWindowMs ?? 3600_000,
  });
  await examStartupReady;
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const base = `http://127.0.0.1:${addr.port}`;
  return {
    base,
    dataDir,
    clock,
    reminderWorker,
    close: () => new Promise((resolve, reject) => {
      shutdownServices();
      server.close(async (e) => {
        try {
          await closeStore();
          e ? reject(e) : resolve();
        } catch (err) {
          reject(err);
        }
      });
    }),
  };
}

export async function api(base, jar, pathname, { method = 'GET', body } = {}) {
  const headers = {};
  if (jar && Object.keys(jar).length) headers.cookie = jarHeader(jar);
  if (body != null) {
    headers['content-type'] = 'application/json';
    headers['x-bn-csrf'] = jar.bn_csrf || '';
  }
  const res = await fetch(`${base}${pathname}`, {
    method,
    headers,
    body: body != null ? JSON.stringify(body) : undefined,
  });
  const merged = { ...(jar || {}) };
  for (const line of parseSetCookies(res)) {
    Object.assign(merged, cookieJar([line]));
  }
  let data = null;
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('json')) data = await res.json();
  return { res, data, jar: merged };
}

export async function teacherSetup(ctx, username = 'tchr') {
  let jar = (await api(ctx.base, {}, '/api/auth/csrf')).jar;
  const setup = await api(ctx.base, jar, '/api/auth/setup', {
    method: 'POST',
    body: { username, password: 'password123', displayName: 'GV Test' },
  });
  if (setup.res.status !== 200) throw new Error('setup failed');
  return setup.jar;
}

export async function studentLogin(ctx, jar, username, password = 'password123') {
  const login = await api(ctx.base, jar, '/api/auth/login', {
    method: 'POST',
    body: { username, password },
  });
  return login.jar;
}

/** First login with temporary password — change before using /api/data. */
export async function studentLoginAfterPasswordChange(ctx, username, tempPassword, newPassword = 'studentpass123') {
  let jar = (await api(ctx.base, {}, '/api/auth/csrf')).jar;
  const login = await api(ctx.base, jar, '/api/auth/login', {
    method: 'POST',
    body: { username, password: tempPassword },
  });
  if (login.res.status !== 200) {
    throw new Error(`student login failed: ${login.res.status}`);
  }
  jar = login.jar;
  const changed = await api(ctx.base, jar, '/api/auth/change-password', {
    method: 'POST',
    body: { currentPassword: '', newPassword },
  });
  if (changed.res.status !== 200) {
    throw new Error(`student change-password failed: ${changed.res.status}`);
  }
  return changed.jar;
}

export async function seedClassStudent(ctx, jar, { className = 'Lớp A', studentName = 'HS 1' } = {}) {
  const classId = randomUUID();
  await api(ctx.base, jar, '/api/teacher/record/classes', {
    method: 'PUT',
    body: {
      id: classId,
      name: className,
      scheduleDays: ['Mon'],
      scheduleTime: '19:00',
    },
  });
  const studentId = randomUUID();
  await api(ctx.base, jar, '/api/teacher/record/students', {
    method: 'PUT',
    body: { id: studentId, name: studentName, classId },
  });
  return { classId, studentId };
}

export async function loadTeacherData(ctx, jar) {
  const r = await api(ctx.base, jar, '/api/data');
  return r.data.data;
}

/**
 * Route relative api-client fetch paths to a running BA test server (keeps session cookies).
 * Restores fetch and document on teardown.
 *
 * @param {import('node:test').TestContext} t
 * @param {{ base: string }} ctx
 * @param {Record<string, string>} jar
 */
export function installBaBrowserApiFixture(t, ctx, jar) {
  const originalFetch = globalThis.fetch;
  const originalDocument = globalThis.document;
  const cookieHeader = jarHeader(jar);

  globalThis.fetch = async (url, options = {}) => {
    const path = String(url);
    const abs = path.startsWith('http') ? path : `${ctx.base}${path}`;
    const headers = new Headers(options.headers || {});
    if (!headers.has('cookie') && cookieHeader) headers.set('cookie', cookieHeader);
    return originalFetch(abs, { ...options, headers });
  };

  const priorCookie = typeof originalDocument?.cookie === 'string' ? originalDocument.cookie : '';
  globalThis.document = {
    ...(originalDocument && typeof originalDocument === 'object' ? originalDocument : {}),
    cookie: cookieHeader || priorCookie,
  };

  t.after(() => {
    globalThis.fetch = originalFetch;
    globalThis.document = originalDocument;
  });
}

/** Membership from student PUT uses effectiveFrom=now; backdate so past sessions include the student on roster. */
export async function backdateOpenMembership(ctx, jar, { classId, studentId, effectiveFrom }) {
  const data = await loadTeacherData(ctx, jar);
  const open = (data.memberships || []).find(
    (m) => m.classId === classId && m.studentId === studentId && !m.effectiveTo,
  );
  if (!open) throw new Error('no open membership');
  const res = await api(ctx.base, jar, '/api/teacher/ba/memberships', {
    method: 'PUT',
    body: {
      id: open.id,
      classId,
      studentId,
      effectiveFrom,
      effectiveTo: null,
      confirmImpact: true,
      reason: 'Test fixture backdate',
    },
  });
  return res;
}
