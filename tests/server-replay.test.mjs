import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from '../server.mjs';
import { validateAttachmentBuffer } from '../server/attachments.mjs';

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

async function startEphemeralServer() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bainha-replay-'));
  const { server, examStartupReady, shutdownServices, closeStore } = createServer({
    host: '127.0.0.1',
    port: 0,
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

test('class create replay is atomic and stable on retry', async (t) => {
  const ctx = await startEphemeralServer();
  t.after(async () => {
    await ctx.close();
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });

  let jar = (await api(ctx.base, {}, '/api/auth/csrf')).jar;
  const setup = await api(ctx.base, jar, '/api/auth/setup', {
    method: 'POST',
    body: { username: 'teacher1', password: 'password123', displayName: 'Cô Test' },
  });
  assert.equal(setup.res.status, 200);
  jar = setup.jar;

  const classId = randomUUID();
  const op = randomUUID();
  const body = {
    operationId: op,
    id: classId,
    name: 'Lớp replay',
    scheduleDays: ['Thứ 2'],
    scheduleTime: '19:00',
    createdAt: new Date().toISOString(),
  };

  const a = await api(ctx.base, jar, '/api/teacher/record/classes', { method: 'PUT', body });
  const b = await api(ctx.base, jar, '/api/teacher/record/classes', { method: 'PUT', body });
  assert.equal(a.res.status, 200);
  assert.equal(b.res.status, 200);
  assert.equal(b.data.replay, true);
  assert.equal(b.data.id, classId);

  const data = await api(ctx.base, jar, '/api/data');
  assert.equal(data.data.data.classes.filter((c) => c.id === classId).length, 1);

  const conflict = await api(ctx.base, jar, '/api/teacher/record/classes', {
    method: 'PUT',
    body: { ...body, name: 'Tên khác' },
  });
  assert.equal(conflict.res.status, 409);
});

test('large DOCX validates via ZIP central directory scan', () => {
  const cdName = 'word/document.xml';
  const cdEntry = Buffer.alloc(46 + cdName.length);
  cdEntry.write('PK\x01\x02', 0);
  cdEntry.writeUInt16LE(cdName.length, 28);
  cdEntry.write(cdName, 46);
  const local = Buffer.alloc(30);
  local.write('PK\x03\x04', 0);
  const pad = Buffer.alloc(10 * 1024 - local.length, 0x20);
  const cdOffset = local.length + pad.length;
  const eocd = Buffer.alloc(22);
  eocd.write('PK\x05\x06', 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt32LE(cdEntry.length, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  const buf = Buffer.concat([local, pad, cdEntry, eocd]);
  assert.equal(buf.length > 8192, true);
  assert.equal(validateAttachmentBuffer(buf, 'big.docx', 'application/octet-stream').ok, true);
});

async function teacherSetup(ctx, username = 'teacher1') {
  let jar = (await api(ctx.base, {}, '/api/auth/csrf')).jar;
  const setup = await api(ctx.base, jar, '/api/auth/setup', {
    method: 'POST',
    body: { username, password: 'password123', displayName: 'Cô Test' },
  });
  assert.equal(setup.res.status, 200);
  return setup.jar;
}

async function studentLoginFlow(ctx, username, tempPassword, newPassword) {
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

test('student initial submit replays same operation id and keeps one version', async (t) => {
  const ctx = await startEphemeralServer();
  t.after(async () => {
    await ctx.close();
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });

  const tJar = await teacherSetup(ctx, 'subteacher');
  const classId = randomUUID();
  const studentId = randomUUID();
  const assignmentId = randomUUID();
  await api(ctx.base, tJar, '/api/teacher/record/classes', {
    method: 'PUT',
    body: {
      id: classId,
      name: 'Submit Replay',
      scheduleDays: ['Thứ 2'],
      scheduleTime: '19:00',
      createdAt: new Date().toISOString(),
    },
  });
  await api(ctx.base, tJar, '/api/teacher/record/students', {
    method: 'PUT',
    body: { id: studentId, name: 'Replay Student', classId },
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
    body: { studentId, username: 'replaystudent', temporaryPassword: 'temppass123' },
  });

  const sJar = await studentLoginFlow(ctx, 'replaystudent', 'temppass123', 'studentpass123');
  const img = await uploadStudentImage(ctx.base, sJar);
  const operationId = randomUUID();
  const body = { operationId, assignmentId, pageImageIds: [img] };

  const first = await api(ctx.base, sJar, '/api/student/submissions/submit', {
    method: 'POST',
    body,
  });
  assert.equal(first.res.status, 200);
  assert.equal(first.data.ok, true);

  const replay = await api(ctx.base, sJar, '/api/student/submissions/submit', {
    method: 'POST',
    body,
  });
  assert.equal(replay.res.status, 200);
  assert.equal(replay.data.replay, true);

  const data = await api(ctx.base, tJar, '/api/data');
  const subs = data.data.data.submissions.filter(
    (s) => s.assignmentId === assignmentId && s.studentId === studentId,
  );
  assert.equal(subs.length, 1);
  const nonDraft = subs[0].versions.filter((v) => !v.isDraft);
  assert.equal(nonDraft.length, 1);
});
