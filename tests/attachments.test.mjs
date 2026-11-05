import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from '../server.mjs';
import { validateAssignmentInput, enrichAssignmentWithAttachments } from '../dist/model.js';
import { validateAttachmentBuffer, attachmentContentDigest } from '../server/attachments.mjs';

const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAD0lEQVQI12P4z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const MIN_PDF = Buffer.from('%PDF-1.4\n%%EOF\n');

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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bainha-att-'));
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
  let closed = false;
  return {
    base,
    dataDir,
    server,
    close: () => new Promise((resolve, reject) => {
      if (closed) {
        resolve();
        return;
      }
      closed = true;
      shutdownServices();
      server.close(async (e) => {
        try {
          await closeStore();
          if (e && e.code !== 'ERR_SERVER_NOT_RUNNING') reject(e);
          else resolve();
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

async function teacherSetup(ctx) {
  let jar = (await api(ctx.base, {}, '/api/auth/csrf')).jar;
  const setup = await api(ctx.base, jar, '/api/auth/setup', {
    method: 'POST',
    body: { username: 'teacher1', password: 'password123', displayName: 'Cô Test' },
  });
  assert.equal(setup.res.status, 200);
  return setup.jar;
}

async function uploadAttachment(base, jar, name, buffer, mime) {
  const res = await fetch(`${base}/api/teacher/attachments`, {
    method: 'POST',
    headers: {
      cookie: jarHeader(jar),
      'content-type': mime,
      'x-bn-csrf': jar.bn_csrf,
      'x-bn-filename': encodeURIComponent(name),
    },
    body: buffer,
  });
  const data = await res.json();
  return { res, data };
}

async function loginStudent(base, tJar, username, tempPassword) {
  let sJar = (await api(base, tJar, '/api/auth/csrf')).jar;
  const login = await api(base, sJar, '/api/auth/login', {
    method: 'POST',
    body: { username, password: tempPassword },
  });
  assert.equal(login.res.status, 200);
  sJar = login.jar;
  const changed = await api(base, sJar, '/api/auth/change-password', {
    method: 'POST',
    body: { currentPassword: '', newPassword: 'studentpass123' },
  });
  assert.equal(changed.res.status, 200);
  return changed.jar;
}

async function addStudent(ctx, tJar, classId, username) {
  const studentId = randomUUID();
  await api(ctx.base, tJar, '/api/teacher/record/students', {
    method: 'PUT',
    body: { id: studentId, name: username, classId },
  });
  const acc = await api(ctx.base, tJar, '/api/teacher/accounts/students', {
    method: 'POST',
    body: { studentId, username, temporaryPassword: 'temppass123' },
  });
  assert.equal(acc.res.status, 200);
  const jar = await loginStudent(ctx.base, tJar, username, 'temppass123');
  return { studentId, jar };
}

test('validateAttachmentBuffer rejects masqueraded executables and accepts real signatures', () => {
  const exeAsPdf = Buffer.from('MZ\x90\x00fake-pe-content');
  assert.equal(validateAttachmentBuffer(exeAsPdf, 'notes.pdf', 'application/pdf').ok, false);
  assert.equal(validateAttachmentBuffer(MIN_PDF, 'notes.pdf', 'application/pdf').ok, true);
  assert.equal(validateAttachmentBuffer(MIN_PDF, 'notes.pdf', '').ok, true);
  assert.equal(validateAttachmentBuffer(MIN_PDF, 'notes.pdf', 'application/octet-stream').ok, true);
  assert.equal(
    validateAttachmentBuffer(MIN_PDF, 'notes.pdf', 'text/html').ok,
    false,
  );
  assert.equal(validateAttachmentBuffer(TINY_PNG, 'pic.png', 'image/png').ok, true);
  assert.equal(validateAttachmentBuffer(TINY_PNG, 'pic.png', '').ok, true);
  const minDoc = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  assert.equal(validateAttachmentBuffer(minDoc, 'legacy.doc', '').ok, true);
  const minDocx = Buffer.alloc(48);
  minDocx.write('PK\x03\x04', 0);
  minDocx.write('word/document.xml', 8);
  assert.equal(
    validateAttachmentBuffer(minDocx, 'sheet.docx', 'application/octet-stream').ok,
    true,
  );
});

test('validateAssignmentInput book or attachment rule', () => {
  const base = {
    title: 'Bài 1',
    classId: 'c1',
    dueDateISO: '2026-12-01',
    requiredPageCount: 2,
  };
  assert.equal(validateAssignmentInput({ ...base, bookRef: 'Sách 1' }).ok, true);
  assert.equal(validateAssignmentInput({ ...base, bookRef: '', attachmentIds: ['a1'] }).ok, true);
  const neither = validateAssignmentInput({ ...base, bookRef: '', attachmentIds: [] });
  assert.equal(neither.ok, false);
});

test('assignment attachments lifecycle, auth, validation, persistence', async (t) => {
  const ctx = await startEphemeralServer();
  let server2 = null;
  let base2 = null;
  let tJar2 = null;
  let boot2 = null;
  t.after(async () => {
    try {
      await ctx.close();
    } catch {
      /* idempotent */
    }
    if (server2) {
      boot2?.shutdownServices?.();
      await new Promise((resolve) => {
        server2.close(() => resolve());
      });
    }
    try {
      fs.rmSync(ctx.dataDir, { recursive: true, force: true });
    } catch {
      /* temp dir may already be gone */
    }
  });

  const tJar = await teacherSetup(ctx);
  const classId = randomUUID();
  await api(ctx.base, tJar, '/api/teacher/record/classes', {
    method: 'PUT',
    body: {
      id: classId,
      name: 'Lớp A',
      scheduleDays: ['Thứ 2'],
      scheduleTime: '19:00',
      createdAt: new Date().toISOString(),
    },
  });

  const classB = randomUUID();
  await api(ctx.base, tJar, '/api/teacher/record/classes', {
    method: 'PUT',
    body: {
      id: classB,
      name: 'Lớp B',
      scheduleDays: ['Thứ 3'],
      scheduleTime: '19:00',
      createdAt: new Date().toISOString(),
    },
  });

  const htmlUpload = await uploadAttachment(ctx.base, tJar, 'evil.html', Buffer.from('<html><body>x</body></html>'), 'text/html');
  assert.equal(htmlUpload.res.status, 400);
  assert.match(htmlUpload.data.error, /Định dạng/);

  const emptyMimePdf = await uploadAttachment(ctx.base, tJar, 'browser-empty.pdf', MIN_PDF, '');
  assert.equal(emptyMimePdf.res.status, 200);
  assert.ok(emptyMimePdf.data.id);

  const octetPdf = await uploadAttachment(ctx.base, tJar, 'generic.pdf', MIN_PDF, 'application/octet-stream');
  assert.equal(octetPdf.res.status, 200);

  const svgCtUpload = await uploadAttachment(
    ctx.base,
    tJar,
    'icon.svg',
    Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><circle/></svg>'),
    'image/svg+xml',
  );
  assert.equal(svgCtUpload.res.status, 400);
  assert.match(svgCtUpload.data.error, /Định dạng/);

  const masquerade = await uploadAttachment(ctx.base, tJar, 'trojan.pdf', Buffer.from('MZ\x90\x00not-a-pdf'), 'application/pdf');
  assert.equal(masquerade.res.status, 400);
  assert.match(masquerade.data.error, /Định dạng/);

  const big = Buffer.alloc(20 * 1024 * 1024 + 1, 0x25);
  big.write('%PDF', 0);
  const bigUpload = await uploadAttachment(ctx.base, tJar, 'big.pdf', big, 'application/pdf');
  assert.equal(bigUpload.res.status, 413);

  const up = await uploadAttachment(ctx.base, tJar, 'sheet.pdf', MIN_PDF, 'application/pdf');
  assert.equal(up.res.status, 200);
  assert.ok(up.data.id);
  assert.ok(up.data.contentFingerprint);
  assert.equal(up.data.contentFingerprint, attachmentContentDigest(MIN_PDF));
  const attachmentId = up.data.id;

  const unauth = await fetch(`${ctx.base}/api/attachments/${attachmentId}`);
  assert.equal(unauth.status, 401);

  const guess = await api(ctx.base, (await api(ctx.base, {}, '/api/auth/csrf')).jar, `/api/attachments/${randomUUID()}`);
  assert.equal(guess.res.status, 401);

  const teacherGet = await api(ctx.base, tJar, `/api/attachments/${attachmentId}`);
  assert.equal(teacherGet.res.status, 200);

  const { studentId: s1, jar: s1Jar } = await addStudent(ctx, tJar, classId, 'hsa1');
  const unlinkedStudent = await api(ctx.base, s1Jar, `/api/attachments/${attachmentId}`);
  assert.equal(unlinkedStudent.res.status, 403);

  const assignmentId = randomUUID();
  const badAssign = await api(ctx.base, tJar, '/api/teacher/record/assignments', {
    method: 'PUT',
    body: {
      id: assignmentId,
      classId,
      title: 'File bài',
      bookRef: '',
      instructions: 'Làm theo PDF',
      dueDateISO: '2026-12-15',
      requiredPageCount: 1,
      attachmentIds: [randomUUID()],
      createdAt: new Date().toISOString(),
    },
  });
  assert.equal(badAssign.res.status, 400);

  const assignPut = await api(ctx.base, tJar, '/api/teacher/record/assignments', {
    method: 'PUT',
    body: {
      id: assignmentId,
      classId,
      title: 'File bài',
      bookRef: '',
      instructions: 'Làm theo PDF',
      dueDateISO: '2026-12-15',
      requiredPageCount: 1,
      attachmentIds: [attachmentId],
      createdAt: new Date().toISOString(),
    },
  });
  assert.equal(assignPut.res.status, 200);

  const s1Data = await api(ctx.base, s1Jar, '/api/data');
  assert.equal(s1Data.res.status, 200);
  const asg = s1Data.data.data.assignments.find((a) => a.id === assignmentId);
  assert.ok(asg);
  assert.equal(asg.attachments.length, 1);
  assert.equal(asg.attachments[0].filename, 'sheet.pdf');
  assert.equal(asg.attachments[0].contentFingerprint, attachmentContentDigest(MIN_PDF));

  const renamed = await uploadAttachment(ctx.base, tJar, 'copy-renamed.pdf', MIN_PDF, 'application/pdf');
  assert.equal(renamed.res.status, 200);
  assert.equal(renamed.data.contentFingerprint, up.data.contentFingerprint);

  const projected = enrichAssignmentWithAttachments(
    { id: 'a', attachmentIds: [attachmentId] },
    { [attachmentId]: { id: attachmentId, filename: 'x.pdf', mime: 'application/pdf', size: MIN_PDF.length, contentFingerprint: up.data.contentFingerprint } },
  );
  assert.equal(projected.attachments[0].contentFingerprint, up.data.contentFingerprint);

  const s1Get = await api(ctx.base, s1Jar, `/api/attachments/${attachmentId}`);
  assert.equal(s1Get.res.status, 200);

  const { jar: s2Jar } = await addStudent(ctx, tJar, classB, 'hsb1');
  const otherClass = await api(ctx.base, s2Jar, `/api/attachments/${attachmentId}`);
  assert.equal(otherClass.res.status, 403);

  const studentUpload = await uploadAttachment(ctx.base, s1Jar, 'x.pdf', MIN_PDF, 'application/pdf');
  assert.equal(studentUpload.res.status, 403);

  await api(ctx.base, tJar, '/api/teacher/record/students', {
    method: 'PUT',
    body: { id: s1, name: 'hsa1', classId: classB },
  });
  const afterClassMove = await api(ctx.base, s1Jar, `/api/attachments/${attachmentId}`);
  assert.equal(afterClassMove.res.status, 403);

  await ctx.close();

  boot2 = createServer({
    host: '127.0.0.1',
    port: 0,
    dataDir: ctx.dataDir,
    secureCookie: false,
  });
  server2 = boot2.server;
  await boot2.examStartupReady;
  await new Promise((resolve) => {
    server2.listen(0, '127.0.0.1', resolve);
  });
  const port2 = server2.address().port;
  base2 = `http://127.0.0.1:${port2}`;

  tJar2 = (await api(base2, {}, '/api/auth/csrf')).jar;
  const tLogin2 = await api(base2, tJar2, '/api/auth/login', {
    method: 'POST',
    body: { username: 'teacher1', password: 'password123' },
  });
  assert.equal(tLogin2.res.status, 200);
  tJar2 = tLogin2.jar;

  const teacherAfterRestart = await api(base2, tJar2, `/api/attachments/${attachmentId}`);
  assert.equal(teacherAfterRestart.res.status, 200);

  const afterRestartData = await api(base2, tJar2, '/api/data');
  const restartedAsg = afterRestartData.data.data.assignments.find((a) => a.id === assignmentId);
  assert.equal(restartedAsg.attachments[0].contentFingerprint, attachmentContentDigest(MIN_PDF));

  const movedStudentAfterRestart = await api(base2, s1Jar, `/api/attachments/${attachmentId}`);
  assert.equal(movedStudentAfterRestart.res.status, 403);

  const legacyPut = await api(base2, tJar2, '/api/teacher/record/assignments', {
    method: 'PUT',
    body: {
      id: assignmentId,
      classId,
      title: 'File bài đổi tên',
      bookRef: '',
      instructions: 'Làm theo PDF',
      dueDateISO: '2026-12-15',
      requiredPageCount: 1,
      createdAt: new Date().toISOString(),
    },
  });
  assert.equal(legacyPut.res.status, 200);
  const legacyData = await api(base2, tJar2, '/api/data');
  const legacyAsg = legacyData.data.data.assignments.find((a) => a.id === assignmentId);
  assert.equal(legacyAsg.attachmentIds.length, 1);

  const pngUp = await uploadAttachment(base2, tJar2, 'pic.png', TINY_PNG, 'image/png');
  assert.equal(pngUp.res.status, 200);
});

test('assignment save snapshot waits for in-flight attachment uploads', async () => {
  const { waitForInFlightUploads } = await import('../dist/model.js');
  const pendingIds = [];
  const inFlightUploads = new Set();
  let releaseUpload;
  const job = new Promise((resolve) => {
    releaseUpload = resolve;
  });
  inFlightUploads.add(job);
  void (async () => {
    await job;
    pendingIds.push('uploaded-id');
    inFlightUploads.delete(job);
  })();
  let snapshot = null;
  const saving = (async () => {
    await waitForInFlightUploads(inFlightUploads);
    snapshot = [...pendingIds];
  })();
  assert.equal(snapshot, null);
  releaseUpload();
  await saving;
  assert.deepEqual(snapshot, ['uploaded-id']);
});
