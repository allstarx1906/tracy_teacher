import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { createServer } from '../server.mjs';

function parseSetCookies(res) {
  const raw = res.headers.getSetCookie?.() || [];
  if (raw.length) return raw;
  const single = res.headers.get('set-cookie');
  return single ? [single] : [];
}

function cookieJar(setCookieLines) {
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

function assertSanitizedUser(user, expected = {}) {
  assert.ok(user && typeof user === 'object');
  if (expected.role) assert.equal(user.role, expected.role);
  if (expected.username) assert.equal(user.username, expected.username);
  if (expected.studentId) assert.equal(user.studentId, expected.studentId);
  if (expected.mustChangePassword != null) {
    assert.equal(user.mustChangePassword, expected.mustChangePassword);
  }
  for (const key of ['password', 'salt', 'hash', 'sessions', 'sessionHash', 'sessionVersion']) {
    assert.ok(!Object.prototype.hasOwnProperty.call(user, key), `must not expose ${key}`);
  }
}

async function teacherSetup(ctx, username = 'teacher1') {
  let jar = (await api(ctx.base, {}, '/api/auth/csrf')).jar;
  const setup = await api(ctx.base, jar, '/api/auth/setup', {
    method: 'POST',
    body: { username, password: 'password123', displayName: 'Cô Test' },
  });
  assert.equal(setup.res.status, 200);
  return setup.jar;
}

async function startEphemeralServer() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bainha-test-'));
  const port = 0;
  const { server, examStartupReady, shutdownServices, closeStore } = createServer({
    host: '127.0.0.1',
    port,
    dataDir,
    secureCookie: false,
  });
  await examStartupReady;
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const base = `http://127.0.0.1:${addr.port}`;
  return {
    base,
    dataDir,
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

async function api(base, jar, pathname, { method = 'GET', body } = {}) {
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

test('bootstrap, setup race, login, session, must-change, isolation', async (t) => {
  const ctx = await startEphemeralServer();
  t.after(async () => {
    await ctx.close();
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });

  let jar = {};
  let boot = await api(ctx.base, jar, '/api/bootstrap');
  jar = boot.jar;
  assert.equal(boot.data.initialized, false);

  await api(ctx.base, jar, '/api/auth/csrf');
  jar = (await api(ctx.base, jar, '/api/auth/csrf')).jar;

  const setupBody = {
    username: 'teacher1',
    password: 'password123',
    displayName: 'Cô Test',
  };
  const setup = await api(ctx.base, jar, '/api/auth/setup', { method: 'POST', body: setupBody });
  assert.equal(setup.res.status, 200);
  jar = setup.jar;

  const me = await api(ctx.base, jar, '/api/auth/me');
  assert.equal(me.res.status, 200);
  assertSanitizedUser(me.data.user, { role: 'teacher', username: 'teacher1', mustChangePassword: false });
  assert.equal(me.data.user.displayName, 'Cô Test');

  const dup = await api(ctx.base, jar, '/api/auth/setup', { method: 'POST', body: setupBody });
  assert.equal(dup.res.status, 403);

  const badLogin = await api(ctx.base, jar, '/api/auth/login', {
    method: 'POST',
    body: { username: 'teacher1', password: 'wrongpass123' },
  });
  assert.equal(badLogin.res.status, 401);

  await api(ctx.base, jar, '/api/auth/logout', { method: 'POST', body: {} });
  jar = (await api(ctx.base, jar, '/api/auth/csrf')).jar;
  const login = await api(ctx.base, jar, '/api/auth/login', {
    method: 'POST',
    body: { username: 'teacher1', password: 'password123' },
  });
  assert.equal(login.res.status, 200);
  jar = login.jar;

  const classId = randomUUID();
  const studentId = randomUUID();
  await api(ctx.base, jar, '/api/teacher/record/classes', {
    method: 'PUT',
    body: {
      id: classId,
      name: 'Lớp A',
      scheduleDays: ['Thứ 2'],
      scheduleTime: '19:00',
      createdAt: new Date().toISOString(),
    },
  });
  await api(ctx.base, jar, '/api/teacher/record/students', {
    method: 'PUT',
    body: { id: studentId, name: 'HS One', classId },
  });

  const acc = await api(ctx.base, jar, '/api/teacher/accounts/students', {
    method: 'POST',
    body: { studentId, username: 'hsone', temporaryPassword: 'temppass123' },
  });
  assert.equal(acc.res.status, 200);
  assert.ok(acc.data.temporaryPassword);

  await api(ctx.base, jar, '/api/auth/logout', { method: 'POST', body: {} });
  let sJar = (await api(ctx.base, jar, '/api/auth/csrf')).jar;
  const sLogin = await api(ctx.base, sJar, '/api/auth/login', {
    method: 'POST',
    body: { username: 'hsone', password: 'temppass123' },
  });
  assert.equal(sLogin.res.status, 200);
  sJar = sLogin.jar;
  const sMe = await api(ctx.base, sJar, '/api/auth/me');
  assertSanitizedUser(sMe.data.user, {
    role: 'student',
    username: 'hsone',
    studentId,
    mustChangePassword: true,
  });
  assert.equal(sMe.data.user.displayName, 'HS One');

  const blocked = await api(ctx.base, sJar, '/api/data');
  assert.equal(blocked.res.status, 403);

  const changed = await api(ctx.base, sJar, '/api/auth/change-password', {
    method: 'POST',
    body: { currentPassword: '', newPassword: 'studentpass123' },
  });
  assert.equal(changed.res.status, 200);
  sJar = changed.jar;

  const sData = await api(ctx.base, sJar, '/api/data');
  assert.equal(sData.res.status, 200);
  assert.equal(sData.data.data.students.length, 1);
  assert.equal(sData.data.data.students[0].id, studentId);

  const guessClass = await api(ctx.base, sJar, `/api/images/${randomUUID()}`);
  assert.equal(guessClass.res.status, 403);

  const teacherClassWrite = await api(ctx.base, sJar, '/api/teacher/record/classes', {
    method: 'PUT',
    body: { id: classId, name: 'Hack', scheduleDays: [], scheduleTime: '00:00' },
  });
  assert.equal(teacherClassWrite.res.status, 403);
});

test('CSRF required on mutations', async (t) => {
  const ctx = await startEphemeralServer();
  t.after(async () => {
    await ctx.close();
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });
  let jar = (await api(ctx.base, {}, '/api/auth/csrf')).jar;
  const setup = await api(ctx.base, jar, '/api/auth/setup', {
    method: 'POST',
    body: { username: 'teacher2', password: 'password123', displayName: 'T' },
  });
  assert.equal(setup.res.status, 200);
  jar = setup.jar;
  const login = await api(ctx.base, jar, '/api/auth/login', {
    method: 'POST',
    body: { username: 'teacher2', password: 'password123' },
  });
  assert.equal(login.res.status, 200);
  jar = login.jar;

  const noCsrf = await fetch(`${ctx.base}/api/teacher/settings`, {
    method: 'PUT',
    headers: {
      'content-type': 'application/json',
      cookie: jarHeader(jar),
    },
    body: JSON.stringify({ teacherName: 'X' }),
  });
  assert.equal(noCsrf.status, 403);

  const wrongCsrf = await fetch(`${ctx.base}/api/teacher/settings`, {
    method: 'PUT',
    headers: {
      'content-type': 'application/json',
      cookie: jarHeader(jar),
      'x-bn-csrf': 'not-the-cookie',
    },
    body: JSON.stringify({ teacherName: 'Y' }),
  });
  assert.equal(wrongCsrf.status, 403);

  const crossOrigin = await fetch(`${ctx.base}/api/teacher/settings`, {
    method: 'PUT',
    headers: {
      'content-type': 'application/json',
      cookie: jarHeader(jar),
      'x-bn-csrf': jar.bn_csrf,
      origin: 'http://evil.example',
    },
    body: JSON.stringify({ teacherName: 'Z' }),
  });
  assert.equal(crossOrigin.status, 403);
});

test('persistence survives restart', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bainha-persist-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  const bootServer = () => {
    const { server, shutdownServices, closeStore, examStartupReady } = createServer({ host: '127.0.0.1', dataDir, secureCookie: false });
    return examStartupReady.then(() => new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const port = server.address().port;
        resolve({
          base: `http://127.0.0.1:${port}`,
          close: () => new Promise((r, reject) => {
            shutdownServices();
            server.close(async (e) => {
              try {
                await closeStore();
                e ? reject(e) : r();
              } catch (err) {
                reject(err);
              }
            });
          }),
        });
      });
    }));
  };

  let ctx = await bootServer();
  let jar = (await api(ctx.base, {}, '/api/auth/csrf')).jar;
  await api(ctx.base, jar, '/api/auth/setup', {
    method: 'POST',
    body: { username: 'persist', password: 'password123', displayName: 'P' },
  });
  await ctx.close();

  ctx = await bootServer();
  jar = (await api(ctx.base, {}, '/api/auth/csrf')).jar;
  const login = await api(ctx.base, jar, '/api/auth/login', {
    method: 'POST',
    body: { username: 'persist', password: 'password123' },
  });
  assert.equal(login.res.status, 200);
  await ctx.close();
});

test('failed mutate does not block later valid mutations', async (t) => {
  const ctx = await startEphemeralServer();
  t.after(async () => {
    await ctx.close();
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });
  let jar = await teacherSetup(ctx);
  const classId = randomUUID();
  const badAccount = await api(ctx.base, jar, '/api/teacher/accounts/students', {
    method: 'POST',
    body: { studentId: randomUUID(), username: 'ghost', temporaryPassword: 'temppass123' },
  });
  assert.equal(badAccount.res.status, 400);
  const okClass = await api(ctx.base, jar, '/api/teacher/record/classes', {
    method: 'PUT',
    body: {
      id: classId,
      name: 'Still works',
      scheduleDays: ['Thứ 3'],
      scheduleTime: '18:00',
      createdAt: new Date().toISOString(),
    },
  });
  assert.equal(okClass.res.status, 200);
  const data = await api(ctx.base, jar, '/api/data');
  assert.equal(data.data.data.classes.length, 1);
  assert.equal(data.data.data.classes[0].id, classId);
});

test('first-login password change skips current password; later change requires it', async (t) => {
  const ctx = await startEphemeralServer();
  t.after(async () => {
    await ctx.close();
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });
  let jar = await teacherSetup(ctx, 'pwteacher');
  const classId = randomUUID();
  const studentId = randomUUID();
  await api(ctx.base, jar, '/api/teacher/record/classes', {
    method: 'PUT',
    body: {
      id: classId,
      name: 'PW',
      scheduleDays: ['Thứ 2'],
      scheduleTime: '19:00',
      createdAt: new Date().toISOString(),
    },
  });
  await api(ctx.base, jar, '/api/teacher/record/students', {
    method: 'PUT',
    body: { id: studentId, name: 'PW Student', classId },
  });
  await api(ctx.base, jar, '/api/teacher/accounts/students', {
    method: 'POST',
    body: { studentId, username: 'pwstudent', temporaryPassword: 'temppass123' },
  });
  await api(ctx.base, jar, '/api/auth/logout', { method: 'POST', body: {} });
  jar = (await api(ctx.base, jar, '/api/auth/csrf')).jar;
  jar = (await api(ctx.base, jar, '/api/auth/login', {
    method: 'POST',
    body: { username: 'pwstudent', password: 'temppass123' },
  })).jar;

  const first = await api(ctx.base, jar, '/api/auth/change-password', {
    method: 'POST',
    body: { currentPassword: '', newPassword: 'newpass1234' },
  });
  assert.equal(first.res.status, 200);
  jar = first.jar;
  assert.equal((await api(ctx.base, jar, '/api/auth/me')).data.user.mustChangePassword, false);

  const missingCurrent = await api(ctx.base, jar, '/api/auth/change-password', {
    method: 'POST',
    body: { currentPassword: '', newPassword: 'anotherpass1' },
  });
  assert.equal(missingCurrent.res.status, 400);

  const withCurrent = await api(ctx.base, jar, '/api/auth/change-password', {
    method: 'POST',
    body: { currentPassword: 'newpass1234', newPassword: 'anotherpass1' },
  });
  assert.equal(withCurrent.res.status, 200);
});

test('account authorization, published grading, sessions, and invalid payloads', async (t) => {
  const ctx = await startEphemeralServer();
  t.after(async () => {
    await ctx.close();
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });
  let tJar = await teacherSetup(ctx, 'authteacher');
  const classId = randomUUID();
  const studentA = randomUUID();
  const studentB = randomUUID();
  const assignmentId = randomUUID();
  const submissionA = randomUUID();

  await api(ctx.base, tJar, '/api/teacher/record/classes', {
    method: 'PUT',
    body: {
      id: classId,
      name: 'Auth Class',
      scheduleDays: ['Thứ 4'],
      scheduleTime: '20:00',
      createdAt: new Date().toISOString(),
    },
  });
  await api(ctx.base, tJar, '/api/teacher/record/students', {
    method: 'PUT',
    body: { id: studentA, name: 'Student A', classId },
  });
  await api(ctx.base, tJar, '/api/teacher/record/students', {
    method: 'PUT',
    body: { id: studentB, name: 'Student B', classId },
  });
  await api(ctx.base, tJar, '/api/teacher/record/assignments', {
    method: 'PUT',
    body: {
      id: assignmentId,
      classId,
      title: 'Essay',
      bookRef: 'U1',
      dueDateISO: '2030-01-01',
      requiredPageCount: 1,
      createdAt: new Date().toISOString(),
    },
  });
  await api(ctx.base, tJar, '/api/teacher/record/submissions', {
    method: 'PUT',
    body: {
      id: submissionA,
      assignmentId,
      studentId: studentA,
      firstSubmittedAt: new Date().toISOString(),
      versions: [{
        versionId: randomUUID(),
        versionNumber: 1,
        submittedAt: new Date().toISOString(),
        isDraft: false,
        pageImageIds: [],
        status: 'submitted',
        grading: { score: 9, published: false, marks: [] },
      }],
    },
  });

  const accA = await api(ctx.base, tJar, '/api/teacher/accounts/students', {
    method: 'POST',
    body: { studentId: studentA, username: 'studenta', temporaryPassword: 'temppass123' },
  });
  assert.equal(accA.res.status, 200);
  const accB = await api(ctx.base, tJar, '/api/teacher/accounts/students', {
    method: 'POST',
    body: { studentId: studentB, username: 'studentb', temporaryPassword: 'temppass123' },
  });
  assert.equal(accB.res.status, 200);
  const missingStudent = await api(ctx.base, tJar, '/api/teacher/accounts/students', {
    method: 'POST',
    body: { studentId: randomUUID(), username: 'orphan', temporaryPassword: 'temppass123' },
  });
  assert.equal(missingStudent.res.status, 400);

  await api(ctx.base, tJar, '/api/auth/logout', { method: 'POST', body: {} });
  let aJar = (await api(ctx.base, tJar, '/api/auth/csrf')).jar;
  aJar = (await api(ctx.base, aJar, '/api/auth/login', {
    method: 'POST',
    body: { username: 'studenta', password: 'temppass123' },
  })).jar;
  aJar = (await api(ctx.base, aJar, '/api/auth/change-password', {
    method: 'POST',
    body: { currentPassword: '', newPassword: 'studentapass' },
  })).jar;

  const aData = await api(ctx.base, aJar, '/api/data');
  assert.equal(aData.data.data.students.length, 1);
  assert.equal(aData.data.data.students[0].id, studentA);
  assert.equal(aData.data.data.submissions.length, 1);
  assert.equal(aData.data.data.submissions[0].versions[0].grading, null);

  let bJar = (await api(ctx.base, {}, '/api/auth/csrf')).jar;
  bJar = (await api(ctx.base, bJar, '/api/auth/login', {
    method: 'POST',
    body: { username: 'studentb', password: 'temppass123' },
  })).jar;
  bJar = (await api(ctx.base, bJar, '/api/auth/change-password', {
    method: 'POST',
    body: { currentPassword: '', newPassword: 'studentbpass' },
  })).jar;
  const bData = await api(ctx.base, bJar, '/api/data');
  assert.equal(bData.data.data.submissions.length, 0);

  const hackSubmission = await api(ctx.base, aJar, '/api/teacher/record/submissions', {
    method: 'PUT',
    body: {
      id: submissionA,
      assignmentId,
      studentId: studentA,
      firstSubmittedAt: new Date().toISOString(),
      versions: [{
        versionId: randomUUID(),
        versionNumber: 2,
        submittedAt: new Date().toISOString(),
        isDraft: false,
        pageImageIds: [],
        status: 'graded',
        grading: { score: 10, published: true, marks: [] },
      }],
    },
  });
  assert.equal(hackSubmission.res.status, 403);

  const badClass = await api(ctx.base, aJar, '/api/teacher/record/classes', {
    method: 'PUT',
    body: { id: classId, name: '', scheduleDays: [], scheduleTime: '00:00' },
  });
  assert.equal(badClass.res.status, 403);

  tJar = (await api(ctx.base, {}, '/api/auth/csrf')).jar;
  tJar = (await api(ctx.base, tJar, '/api/auth/login', {
    method: 'POST',
    body: { username: 'authteacher', password: 'password123' },
  })).jar;

  await api(ctx.base, tJar, '/api/teacher/accounts/students/' + accA.data.accountId + '/disable', {
    method: 'POST',
    body: {},
  });
  assert.equal((await api(ctx.base, aJar, '/api/auth/me')).res.status, 401);

  aJar = (await api(ctx.base, {}, '/api/auth/csrf')).jar;
  const disabledLogin = await api(ctx.base, aJar, '/api/auth/login', {
    method: 'POST',
    body: { username: 'studenta', password: 'studentapass' },
  });
  assert.equal(disabledLogin.res.status, 401);

  await api(ctx.base, tJar, '/api/teacher/accounts/students/' + accA.data.accountId + '/reactivate', {
    method: 'POST',
    body: {},
  });
  const reset = await api(ctx.base, tJar, '/api/teacher/accounts/students/' + accA.data.accountId + '/reset-password', {
    method: 'POST',
    body: {},
  });
  assert.equal(reset.res.status, 200);
  assert.ok(reset.data.temporaryPassword);

  bJar = (await api(ctx.base, bJar, '/api/auth/logout', { method: 'POST', body: {} })).jar;
  assert.equal((await api(ctx.base, bJar, '/api/auth/me')).res.status, 401);

  const teacherBefore = await api(ctx.base, tJar, '/api/data');
  const classCount = teacherBefore.data.data.classes.length;
  const reject = await api(ctx.base, tJar, '/api/teacher/record/classes', {
    method: 'PUT',
    body: { id: randomUUID(), name: '', scheduleDays: [], scheduleTime: 'bad' },
  });
  assert.equal(reject.res.status, 400);
  const teacherAfter = await api(ctx.base, tJar, '/api/data');
  assert.equal(teacherAfter.data.data.classes.length, classCount);
});

function postJsonPaused(base, jar, pathname, body, pauseAfter, duringPause) {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const url = new URL(pathname, base);
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
          cookie: jarHeader(jar),
          'x-bn-csrf': jar.bn_csrf || '',
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let data = null;
          try {
            data = text ? JSON.parse(text) : null;
          } catch {
            data = { raw: text };
          }
          resolve({ res, data });
        });
      },
    );
    req.on('error', reject);
    req.write(payload.slice(0, pauseAfter));
    Promise.resolve(duringPause?.())
      .then(() => {
        req.write(payload.slice(pauseAfter));
        req.end();
      })
      .catch(reject);
  });
}

async function studentLoginFlow(ctx, _tJar, username, tempPassword, newPassword) {
  let jar = (await api(ctx.base, {}, '/api/auth/csrf')).jar;
  jar = (await api(ctx.base, jar, '/api/auth/login', {
    method: 'POST',
    body: { username, password: tempPassword },
  })).jar;
  jar = (await api(ctx.base, jar, '/api/auth/change-password', {
    method: 'POST',
    body: { currentPassword: '', newPassword },
  })).jar;
  return jar;
}

async function uploadStudentImage(base, jar) {
  const tinyPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const res = await api(base, jar, '/api/images', {
    method: 'POST',
    body: { mime: 'image/png', dataBase64: tinyPng },
  });
  assert.equal(res.res.status, 200);
  return res.data.id;
}

test('revision requires teacher needs-revision not draft-only', async (t) => {
  const ctx = await startEphemeralServer();
  t.after(async () => {
    await ctx.close();
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });
  let tJar = await teacherSetup(ctx, 'revteacher');
  const classId = randomUUID();
  const studentId = randomUUID();
  const assignmentId = randomUUID();
  await api(ctx.base, tJar, '/api/teacher/record/classes', {
    method: 'PUT',
    body: {
      id: classId,
      name: 'Rev',
      scheduleDays: ['Thứ 2'],
      scheduleTime: '19:00',
      createdAt: new Date().toISOString(),
    },
  });
  await api(ctx.base, tJar, '/api/teacher/record/students', {
    method: 'PUT',
    body: { id: studentId, name: 'Rev Student', classId },
  });
  await api(ctx.base, tJar, '/api/teacher/record/assignments', {
    method: 'PUT',
    body: {
      id: assignmentId,
      classId,
      title: 'Rev Essay',
      bookRef: 'U1',
      dueDateISO: '2030-06-01',
      requiredPageCount: 1,
      createdAt: new Date().toISOString(),
    },
  });
  await api(ctx.base, tJar, '/api/teacher/accounts/students', {
    method: 'POST',
    body: { studentId, username: 'revstudent', temporaryPassword: 'temppass123' },
  });
  let sJar = await studentLoginFlow(ctx, tJar, 'revstudent', 'temppass123', 'studentpass123');

  const draft = await api(ctx.base, sJar, '/api/student/submissions/draft', {
    method: 'POST',
    body: { assignmentId, pageImageIds: [] },
  });
  assert.equal(draft.res.status, 200);

  const revision = await api(ctx.base, sJar, '/api/student/submissions/revision', {
    method: 'POST',
    body: { assignmentId, pageImageIds: [] },
  });
  assert.equal(revision.res.status, 403);
});

test('stale teacher submission save rejects conflict and preserves student versions', async (t) => {
  const ctx = await startEphemeralServer();
  t.after(async () => {
    await ctx.close();
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });
  let tJar = await teacherSetup(ctx, 'mergeteacher');
  const classId = randomUUID();
  const studentId = randomUUID();
  const assignmentId = randomUUID();
  await api(ctx.base, tJar, '/api/teacher/record/classes', {
    method: 'PUT',
    body: {
      id: classId,
      name: 'Merge',
      scheduleDays: ['Thứ 3'],
      scheduleTime: '18:00',
      createdAt: new Date().toISOString(),
    },
  });
  await api(ctx.base, tJar, '/api/teacher/record/students', {
    method: 'PUT',
    body: { id: studentId, name: 'Merge Student', classId },
  });
  await api(ctx.base, tJar, '/api/teacher/record/assignments', {
    method: 'PUT',
    body: {
      id: assignmentId,
      classId,
      title: 'Merge Essay',
      bookRef: 'U2',
      dueDateISO: '2030-07-01',
      requiredPageCount: 1,
      createdAt: new Date().toISOString(),
    },
  });
  await api(ctx.base, tJar, '/api/teacher/accounts/students', {
    method: 'POST',
    body: { studentId, username: 'mergestudent', temporaryPassword: 'temppass123' },
  });
  let sJar = await studentLoginFlow(ctx, tJar, 'mergestudent', 'temppass123', 'studentpass123');
  const img1 = await uploadStudentImage(ctx.base, sJar);
  const img2 = await uploadStudentImage(ctx.base, sJar);

  const firstSubmit = await api(ctx.base, sJar, '/api/student/submissions/submit', {
    method: 'POST',
    body: { assignmentId, pageImageIds: [img1] },
  });
  assert.equal(firstSubmit.res.status, 200);

  const teacherData = await api(ctx.base, tJar, '/api/data');
  assert.equal(teacherData.res.status, 200);
  assert.ok(teacherData.data.data.submissions.length >= 1, 'teacher should see student submission');
  const submission = teacherData.data.data.submissions[0];
  const submissionId = submission.id;
  const version1 = submission.versions[0].versionId;
  const staleSnapshot = JSON.parse(JSON.stringify(submission));

  const needsRev = JSON.parse(JSON.stringify(submission));
  needsRev.versions[0].status = 'needs-revision';
  needsRev.versions[0].grading = {
    score: 5,
    published: true,
    publishedAt: new Date().toISOString(),
    needsRevision: true,
    pages: [{ annotations: [] }],
  };
  const needsRevPut = await api(ctx.base, tJar, '/api/teacher/record/submissions', {
    method: 'PUT',
    body: needsRev,
  });
  assert.equal(needsRevPut.res.status, 200);

  const revision = await api(ctx.base, sJar, '/api/student/submissions/revision', {
    method: 'POST',
    body: { assignmentId, pageImageIds: [img2] },
  });
  assert.equal(revision.res.status, 200);

  staleSnapshot.versions[0].status = 'grading';
  staleSnapshot.versions[0].teacherGrading = {
    score: '8',
    overallFeedback: 'ok',
    pages: [{ annotations: [] }],
    undoStacks: {},
  };
  const staleOnlyV1 = await api(ctx.base, tJar, '/api/teacher/record/submissions', {
    method: 'PUT',
    body: staleSnapshot,
  });
  assert.equal(staleOnlyV1.res.status, 409);

  const live = await api(ctx.base, tJar, '/api/data');
  const sub = live.data.data.submissions.find((x) => x.id === submissionId);
  assert.equal(sub.versions.filter((v) => !v.isDraft).length, 2);
  assert.equal(sub.versions[1].pageImageIds[0], img2);
  assert.equal(sub.versions[0].versionId, version1);
});

test('revoked session cannot finish mutation after slow body', async (t) => {
  const ctx = await startEphemeralServer();
  t.after(async () => {
    await ctx.close();
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });
  let tJar = await teacherSetup(ctx, 'sessteacher');
  const classId = randomUUID();
  const studentId = randomUUID();
  const assignmentId = randomUUID();
  await api(ctx.base, tJar, '/api/teacher/record/classes', {
    method: 'PUT',
    body: {
      id: classId,
      name: 'Sess',
      scheduleDays: ['Thứ 5'],
      scheduleTime: '17:00',
      createdAt: new Date().toISOString(),
    },
  });
  await api(ctx.base, tJar, '/api/teacher/record/students', {
    method: 'PUT',
    body: { id: studentId, name: 'Sess Student', classId },
  });
  await api(ctx.base, tJar, '/api/teacher/record/assignments', {
    method: 'PUT',
    body: {
      id: assignmentId,
      classId,
      title: 'Sess Essay',
      bookRef: 'U3',
      dueDateISO: '2030-08-01',
      requiredPageCount: 1,
      createdAt: new Date().toISOString(),
    },
  });
  const created = await api(ctx.base, tJar, '/api/teacher/accounts/students', {
    method: 'POST',
    body: { studentId, username: 'sessstudent', temporaryPassword: 'temppass123' },
  });
  assert.equal(created.res.status, 200);
  let sJar = await studentLoginFlow(ctx, tJar, 'sessstudent', 'temppass123', 'studentpass123');

  const body = { assignmentId, pageImageIds: [] };
  const payload = JSON.stringify(body);
  const pauseAt = payload.indexOf('"pageImageIds"');

  const result = await postJsonPaused(
    ctx.base,
    sJar,
    '/api/student/submissions/draft',
    body,
    pauseAt,
    async () => {
      await api(ctx.base, tJar, '/api/teacher/accounts/students/' + created.data.accountId + '/disable', {
        method: 'POST',
        body: {},
      });
    },
  );
  assert.equal(result.res.statusCode, 401);
});

test('password rotation returns replacement session cookie atomically', async (t) => {
  const ctx = await startEphemeralServer();
  t.after(async () => {
    await ctx.close();
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });
  let tJar = await teacherSetup(ctx, 'pwroteacher');
  const classId = randomUUID();
  const studentId = randomUUID();
  await api(ctx.base, tJar, '/api/teacher/record/classes', {
    method: 'PUT',
    body: {
      id: classId,
      name: 'PW Rot',
      scheduleDays: ['Thứ 2'],
      scheduleTime: '19:00',
      createdAt: new Date().toISOString(),
    },
  });
  await api(ctx.base, tJar, '/api/teacher/record/students', {
    method: 'PUT',
    body: { id: studentId, name: 'PW Rot Student', classId },
  });
  await api(ctx.base, tJar, '/api/teacher/accounts/students', {
    method: 'POST',
    body: { studentId, username: 'pwrotstudent', temporaryPassword: 'temppass123' },
  });
  let sJar = await studentLoginFlow(ctx, tJar, 'pwrotstudent', 'temppass123', 'firstpass1234');
  const oldSession = sJar.bn_session;
  const rotated = await api(ctx.base, sJar, '/api/auth/change-password', {
    method: 'POST',
    body: { currentPassword: 'firstpass1234', newPassword: 'secondpass123' },
  });
  assert.equal(rotated.res.status, 200);
  assert.ok(rotated.jar.bn_session, 'replacement session cookie');
  assert.notEqual(rotated.jar.bn_session, oldSession);
  sJar = rotated.jar;
  assert.equal((await api(ctx.base, sJar, '/api/auth/me')).res.status, 200);
  assert.equal((await api(ctx.base, sJar, '/api/data')).res.status, 200);
});

test('student data keeps published grading visible after server projection', async (t) => {
  const ctx = await startEphemeralServer();
  t.after(async () => {
    await ctx.close();
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });
  let tJar = await teacherSetup(ctx, 'pubteacher');
  const classId = randomUUID();
  const studentId = randomUUID();
  const assignmentId = randomUUID();
  const submissionId = randomUUID();
  const versionId = randomUUID();
  const classPut = await api(ctx.base, tJar, '/api/teacher/record/classes', {
    method: 'PUT',
    body: {
      id: classId,
      name: 'Pub',
      scheduleDays: ['Thứ 2'],
      scheduleTime: '19:00',
      createdAt: new Date().toISOString(),
    },
  });
  assert.equal(classPut.res.status, 200);
  const studentPut = await api(ctx.base, tJar, '/api/teacher/record/students', {
    method: 'PUT',
    body: { id: studentId, name: 'Pub Student', classId },
  });
  assert.equal(studentPut.res.status, 200);
  const assignmentPut = await api(ctx.base, tJar, '/api/teacher/record/assignments', {
    method: 'PUT',
    body: {
      id: assignmentId,
      classId,
      title: 'Pub Essay',
      bookRef: 'U1',
      dueDateISO: '2030-06-01',
      requiredPageCount: 1,
      createdAt: new Date().toISOString(),
    },
  });
  assert.equal(assignmentPut.res.status, 200);
  const pubSubPut = await api(ctx.base, tJar, '/api/teacher/record/submissions', {
    method: 'PUT',
    body: {
      id: submissionId,
      assignmentId,
      studentId,
      firstSubmittedAt: new Date().toISOString(),
      versions: [{
        versionId,
        versionNumber: 1,
        submittedAt: new Date().toISOString(),
        isDraft: false,
        pageImageIds: [],
        status: 'returned',
        grading: {
          score: 9,
          overallFeedback: 'Great work',
          published: true,
          publishedAt: new Date().toISOString(),
          pages: [{ annotations: [] }],
        },
      }],
    },
  });
  assert.equal(pubSubPut.res.status, 200);
  const accountPost = await api(ctx.base, tJar, '/api/teacher/accounts/students', {
    method: 'POST',
    body: { studentId, username: 'pubstudent', temporaryPassword: 'temppass123' },
  });
  assert.equal(accountPost.res.status, 200);
  let sJar = await studentLoginFlow(ctx, tJar, 'pubstudent', 'temppass123', 'studentpass123');
  const sData = await api(ctx.base, sJar, '/api/data');
  assert.equal(sData.res.status, 200);
  const sub = sData.data.data.submissions[0];
  assert.equal(sub.versions[0].grading.score, 9);
  assert.equal(sub.versions[0].grading.published, true);
  assert.equal(sub.versions[0].grading.overallFeedback, 'Great work');
});

test('revision rejects assignment outside current class membership', async (t) => {
  const ctx = await startEphemeralServer();
  t.after(async () => {
    await ctx.close();
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });
  let tJar = await teacherSetup(ctx, 'memteacher');
  const classA = randomUUID();
  const classB = randomUUID();
  const studentId = randomUUID();
  const assignmentA = randomUUID();
  const submissionId = randomUUID();
  const classAPut = await api(ctx.base, tJar, '/api/teacher/record/classes', {
    method: 'PUT',
    body: {
      id: classA,
      name: 'Class A',
      scheduleDays: ['Thứ 2'],
      scheduleTime: '19:00',
      createdAt: new Date().toISOString(),
    },
  });
  assert.equal(classAPut.res.status, 200);
  const classBPut = await api(ctx.base, tJar, '/api/teacher/record/classes', {
    method: 'PUT',
    body: {
      id: classB,
      name: 'Class B',
      scheduleDays: ['Thứ 3'],
      scheduleTime: '18:00',
      createdAt: new Date().toISOString(),
    },
  });
  assert.equal(classBPut.res.status, 200);
  const studentPut = await api(ctx.base, tJar, '/api/teacher/record/students', {
    method: 'PUT',
    body: { id: studentId, name: 'Move Student', classId: classA },
  });
  assert.equal(studentPut.res.status, 200);
  const assignmentPut = await api(ctx.base, tJar, '/api/teacher/record/assignments', {
    method: 'PUT',
    body: {
      id: assignmentA,
      classId: classA,
      title: 'Old Class Work',
      bookRef: 'U1',
      dueDateISO: '2030-06-01',
      requiredPageCount: 1,
      createdAt: new Date().toISOString(),
    },
  });
  assert.equal(assignmentPut.res.status, 200);
  const submissionPut = await api(ctx.base, tJar, '/api/teacher/record/submissions', {
    method: 'PUT',
    body: {
      id: submissionId,
      assignmentId: assignmentA,
      studentId,
      firstSubmittedAt: new Date().toISOString(),
      versions: [{
        versionId: randomUUID(),
        versionNumber: 1,
        submittedAt: new Date().toISOString(),
        isDraft: false,
        pageImageIds: [],
        status: 'needs-revision',
        grading: {
          score: 4,
          published: true,
          publishedAt: new Date().toISOString(),
          needsRevision: true,
          pages: [{ annotations: [] }],
        },
      }],
    },
  });
  assert.equal(submissionPut.res.status, 200);
  const accountPost = await api(ctx.base, tJar, '/api/teacher/accounts/students', {
    method: 'POST',
    body: { studentId, username: 'memstudent', temporaryPassword: 'temppass123' },
  });
  assert.equal(accountPost.res.status, 200);
  const moveStudentPut = await api(ctx.base, tJar, '/api/teacher/record/students', {
    method: 'PUT',
    body: { id: studentId, name: 'Move Student', classId: classB },
  });
  assert.equal(moveStudentPut.res.status, 200);
  let sJar = await studentLoginFlow(ctx, tJar, 'memstudent', 'temppass123', 'studentpass123');
  const revision = await api(ctx.base, sJar, '/api/student/submissions/revision', {
    method: 'POST',
    body: { assignmentId: assignmentA, pageImageIds: [] },
  });
  assert.equal(revision.res.status, 403);
});

test('repeat local migration does not overwrite existing submissions or images', async (t) => {
  const ctx = await startEphemeralServer();
  t.after(async () => {
    await ctx.close();
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });
  let tJar = await teacherSetup(ctx, 'migteacher');
  const classId = randomUUID();
  const studentId = randomUUID();
  const assignmentId = randomUUID();
  const submissionId = randomUUID();
  const versionId = randomUUID();
  const imageId = randomUUID();
  await api(ctx.base, tJar, '/api/teacher/record/classes', {
    method: 'PUT',
    body: {
      id: classId,
      name: 'Mig',
      scheduleDays: ['Thứ 2'],
      scheduleTime: '19:00',
      createdAt: new Date().toISOString(),
    },
  });
  await api(ctx.base, tJar, '/api/teacher/record/students', {
    method: 'PUT',
    body: { id: studentId, name: 'Mig Student', classId },
  });
  await api(ctx.base, tJar, '/api/teacher/record/assignments', {
    method: 'PUT',
    body: {
      id: assignmentId,
      classId,
      title: 'Mig Essay',
      bookRef: 'U1',
      dueDateISO: '2030-06-01',
      requiredPageCount: 1,
      createdAt: new Date().toISOString(),
    },
  });
  await api(ctx.base, tJar, '/api/teacher/accounts/students', {
    method: 'POST',
    body: { studentId, username: 'migstudent', temporaryPassword: 'temppass123' },
  });
  let sJar = await studentLoginFlow(ctx, tJar, 'migstudent', 'temppass123', 'studentpass123');
  const img = await uploadStudentImage(ctx.base, sJar);
  await api(ctx.base, sJar, '/api/student/submissions/submit', {
    method: 'POST',
    body: { assignmentId, pageImageIds: [img] },
  });
  const liveBefore = await api(ctx.base, tJar, '/api/data');
  assert.equal(liveBefore.res.status, 200);
  assert.ok(liveBefore.data.data.submissions.length >= 1);
  const serverSub = liveBefore.data.data.submissions[0];
  const staleBackup = {
    schemaVersion: 1,
    classes: liveBefore.data.data.classes,
    students: liveBefore.data.data.students,
    assignments: liveBefore.data.data.assignments,
    submissions: [{
      id: serverSub.id,
      assignmentId,
      studentId,
      firstSubmittedAt: serverSub.firstSubmittedAt,
      versions: [{
        versionId,
        versionNumber: 1,
        submittedAt: new Date().toISOString(),
        isDraft: false,
        pageImageIds: [],
        status: 'submitted',
        grading: null,
      }],
    }],
  };
  const staleImage = {
    id: imageId,
    mime: 'image/png',
    dataBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    createdAt: new Date().toISOString(),
  };
  await api(ctx.base, tJar, '/api/teacher/migrate-local', {
    method: 'POST',
    body: { backup: staleBackup, images: [staleImage] },
  });
  await api(ctx.base, tJar, '/api/teacher/migrate-local', {
    method: 'POST',
    body: { backup: staleBackup, images: [staleImage] },
  });
  const liveAfter = await api(ctx.base, tJar, '/api/data');
  const afterSub = liveAfter.data.data.submissions.find((x) => x.id === serverSub.id);
  assert.equal(afterSub.versions.filter((v) => !v.isDraft).length, 1);
  assert.equal(afterSub.versions[0].pageImageIds[0], img);
  assert.notEqual(afterSub.versions[0].versionId, versionId);
  const imgRes = await api(ctx.base, tJar, `/api/images/${imageId}`);
  assert.equal(imgRes.res.status, 200);
  const serverImgRes = await api(ctx.base, tJar, `/api/images/${img}`);
  assert.equal(serverImgRes.res.status, 200);
});

test('login rate limiter is scoped per server instance', async (t) => {
  const ctxA = await startEphemeralServer();
  const ctxB = await startEphemeralServer();
  t.after(async () => {
    await ctxA.close();
    await ctxB.close();
    fs.rmSync(ctxA.dataDir, { recursive: true, force: true });
    fs.rmSync(ctxB.dataDir, { recursive: true, force: true });
  });
  await teacherSetup(ctxA, 'limita');
  await teacherSetup(ctxB, 'limitb');
  for (let i = 0; i < 20; i += 1) {
    const jar = (await api(ctxA.base, {}, '/api/auth/csrf')).jar;
    await api(ctxA.base, jar, '/api/auth/login', {
      method: 'POST',
      body: { username: 'limita', password: 'wrong-password' },
    });
  }
  const blockedJar = (await api(ctxA.base, {}, '/api/auth/csrf')).jar;
  const blocked = await api(ctxA.base, blockedJar, '/api/auth/login', {
    method: 'POST',
    body: { username: 'limita', password: 'wrong-password' },
  });
  assert.equal(blocked.res.status, 429);
  const okJar = (await api(ctxB.base, {}, '/api/auth/csrf')).jar;
  const ok = await api(ctxB.base, okJar, '/api/auth/login', {
    method: 'POST',
    body: { username: 'limitb', password: 'password123' },
  });
  assert.equal(ok.res.status, 200);
});

test('pending login cannot succeed after password reset', async (t) => {
  const ctx = await startEphemeralServer();
  t.after(async () => {
    await ctx.close();
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });
  let tJar = await teacherSetup(ctx, 'delayteacher');
  const classId = randomUUID();
  const studentId = randomUUID();
  await api(ctx.base, tJar, '/api/teacher/record/classes', {
    method: 'PUT',
    body: {
      id: classId,
      name: 'Delay',
      scheduleDays: ['Thứ 2'],
      scheduleTime: '19:00',
      createdAt: new Date().toISOString(),
    },
  });
  await api(ctx.base, tJar, '/api/teacher/record/students', {
    method: 'PUT',
    body: { id: studentId, name: 'Delay Student', classId },
  });
  const created = await api(ctx.base, tJar, '/api/teacher/accounts/students', {
    method: 'POST',
    body: { studentId, username: 'delaystudent', temporaryPassword: 'temppass123' },
  });
  assert.equal(created.res.status, 200);
  await studentLoginFlow(ctx, tJar, 'delaystudent', 'temppass123', 'studentpass123');

  const loginBody = { username: 'delaystudent', password: 'studentpass123' };
  const payload = JSON.stringify(loginBody);
  const pauseAt = payload.indexOf('"password"');
  const result = await postJsonPaused(
    ctx.base,
    (await api(ctx.base, {}, '/api/auth/csrf')).jar,
    '/api/auth/login',
    loginBody,
    pauseAt,
    async () => {
      await api(ctx.base, tJar, '/api/teacher/accounts/students/' + created.data.accountId + '/reset-password', {
        method: 'POST',
        body: {},
      });
    },
  );
  assert.equal(result.res.statusCode, 401);
  const after = await api(ctx.base, (await api(ctx.base, {}, '/api/auth/csrf')).jar, '/api/auth/login', {
    method: 'POST',
    body: { username: 'delaystudent', password: 'studentpass123' },
  });
  assert.equal(after.res.status, 401);
});

test('authenticated SVG upload is rejected', async (t) => {
  const ctx = await startEphemeralServer();
  t.after(async () => {
    await ctx.close();
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });
  let tJar = await teacherSetup(ctx, 'svgteacher');
  const classId = randomUUID();
  const studentId = randomUUID();
  await api(ctx.base, tJar, '/api/teacher/record/classes', {
    method: 'PUT',
    body: {
      id: classId,
      name: 'SVG',
      scheduleDays: ['Thứ 2'],
      scheduleTime: '19:00',
      createdAt: new Date().toISOString(),
    },
  });
  await api(ctx.base, tJar, '/api/teacher/record/students', {
    method: 'PUT',
    body: { id: studentId, name: 'SVG Student', classId },
  });
  await api(ctx.base, tJar, '/api/teacher/accounts/students', {
    method: 'POST',
    body: { studentId, username: 'svgstudent', temporaryPassword: 'temppass123' },
  });
  const sJar = await studentLoginFlow(ctx, tJar, 'svgstudent', 'temppass123', 'studentpass123');
  const svgPayload = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    'utf8',
  ).toString('base64');
  const upload = await api(ctx.base, sJar, '/api/images', {
    method: 'POST',
    body: { mime: 'image/svg+xml', dataBase64: svgPayload },
  });
  assert.equal(upload.res.status, 400);
});

test('migrated legacy SVG images are served with sandbox headers', async (t) => {
  const ctx = await startEphemeralServer();
  t.after(async () => {
    await ctx.close();
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });
  const tJar = await teacherSetup(ctx, 'legacysvgteacher');
  const imageId = randomUUID();
  const svgPayload = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><rect width="10" height="10"/></svg>',
  ).toString('base64');
  const migrated = await api(ctx.base, tJar, '/api/teacher/migrate-local', {
    method: 'POST',
    body: {
      backup: {
        schemaVersion: 1,
        classes: [],
        students: [],
        assignments: [],
        submissions: [],
      },
      images: [{
        id: imageId,
        mime: 'image/svg+xml',
        dataBase64: svgPayload,
        createdAt: new Date().toISOString(),
      }],
    },
  });
  assert.equal(migrated.res.status, 200);
  const imgRes = await api(ctx.base, tJar, `/api/images/${imageId}`);
  assert.equal(imgRes.res.status, 200);
  assert.match(imgRes.res.headers.get('content-security-policy') || '', /sandbox/);
});

test('revision replay returns prior result after state no longer needs revision', async (t) => {
  const ctx = await startEphemeralServer();
  t.after(async () => {
    await ctx.close();
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });
  let tJar = await teacherSetup(ctx, 'revreplayteacher');
  const classId = randomUUID();
  const studentId = randomUUID();
  const assignmentId = randomUUID();
  await api(ctx.base, tJar, '/api/teacher/record/classes', {
    method: 'PUT',
    body: {
      id: classId,
      name: 'RevReplay',
      scheduleDays: ['Thứ 2'],
      scheduleTime: '10:00',
      createdAt: new Date().toISOString(),
    },
  });
  await api(ctx.base, tJar, '/api/teacher/record/students', {
    method: 'PUT',
    body: { id: studentId, name: 'Rev Replay', classId },
  });
  await api(ctx.base, tJar, '/api/teacher/record/assignments', {
    method: 'PUT',
    body: {
      id: assignmentId,
      classId,
      title: 'Essay',
      bookRef: 'U1',
      dueDateISO: '2030-01-01',
      requiredPageCount: 1,
      createdAt: new Date().toISOString(),
    },
  });
  await api(ctx.base, tJar, '/api/teacher/accounts/students', {
    method: 'POST',
    body: { studentId, username: 'revreplay', temporaryPassword: 'temppass123' },
  });
  let sJar = await studentLoginFlow(ctx, tJar, 'revreplay', 'temppass123', 'studentpass123');
  const img1 = await uploadStudentImage(ctx.base, sJar);
  const img2 = await uploadStudentImage(ctx.base, sJar);
  await api(ctx.base, sJar, '/api/student/submissions/submit', {
    method: 'POST',
    body: { assignmentId, pageImageIds: [img1] },
  });
  const teacherData = await api(ctx.base, tJar, '/api/data');
  const submission = teacherData.data.data.submissions[0];
  const needsRev = JSON.parse(JSON.stringify(submission));
  needsRev.versions[0].status = 'needs-revision';
  needsRev.versions[0].grading = {
    score: 5,
    published: true,
    publishedAt: new Date().toISOString(),
    needsRevision: true,
    pages: [{ annotations: [] }],
  };
  await api(ctx.base, tJar, '/api/teacher/record/submissions', {
    method: 'PUT',
    body: needsRev,
  });
  const opId = randomUUID();
  const first = await api(ctx.base, sJar, '/api/student/submissions/revision', {
    method: 'POST',
    body: { operationId: opId, assignmentId, pageImageIds: [img2] },
  });
  assert.equal(first.res.status, 200);
  const replay = await api(ctx.base, sJar, '/api/student/submissions/revision', {
    method: 'POST',
    body: { operationId: opId, assignmentId, pageImageIds: [img2] },
  });
  assert.equal(replay.res.status, 200);
  assert.equal(replay.data.versionId, first.data.versionId);
  assert.equal(replay.data.replay, true);
});

test('reactivate blocked when another account for same student is active', async (t) => {
  const ctx = await startEphemeralServer();
  t.after(async () => {
    await ctx.close();
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });
  let tJar = await teacherSetup(ctx, 'oneacctteacher');
  const classId = randomUUID();
  const studentId = randomUUID();
  await api(ctx.base, tJar, '/api/teacher/record/classes', {
    method: 'PUT',
    body: {
      id: classId,
      name: 'OneAcct',
      scheduleDays: ['Thứ 3'],
      scheduleTime: '11:00',
      createdAt: new Date().toISOString(),
    },
  });
  await api(ctx.base, tJar, '/api/teacher/record/students', {
    method: 'PUT',
    body: { id: studentId, name: 'One Student', classId },
  });
  const accA = await api(ctx.base, tJar, '/api/teacher/accounts/students', {
    method: 'POST',
    body: { studentId, username: 'studenta2', temporaryPassword: 'temppass123' },
  });
  assert.equal(accA.res.status, 200);
  await api(ctx.base, tJar, '/api/teacher/accounts/students/' + accA.data.accountId + '/disable', {
    method: 'POST',
    body: {},
  });
  const accB = await api(ctx.base, tJar, '/api/teacher/accounts/students', {
    method: 'POST',
    body: { studentId, username: 'studentb2', temporaryPassword: 'temppass123' },
  });
  assert.equal(accB.res.status, 200);
  const reactivate = await api(ctx.base, tJar, '/api/teacher/accounts/students/' + accA.data.accountId + '/reactivate', {
    method: 'POST',
    body: {},
  });
  assert.equal(reactivate.res.status, 400);
  const accounts = await api(ctx.base, tJar, '/api/teacher/accounts');
  const active = accounts.data.accounts.filter((a) => a.studentId === studentId && !a.disabled);
  assert.equal(active.length, 1);
  assert.equal(active[0].id, accB.data.accountId);
});
