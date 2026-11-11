import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createStore } from './store.mjs';
import {
  ATTACHMENT_MAX_BYTES,
  encodeContentDisposition,
  readBinaryBody,
  validateAttachmentBuffer,
  validateTeacherAttachmentIdList,
  attachmentContentDigest,
  sanitizeAttachmentBasename,
} from './attachments.mjs';
import { assertMutationHeaders, assertAttachmentUploadHeaders as checkAttachmentUploadHeaders } from './request-origin.mjs';
import {
  hashPassword,
  verifyPassword,
  newSessionToken,
  hashToken,
  newCsrfToken,
  normalizeUsername,
  validateUsername,
  validatePassword,
  createRateLimiter,
  parseCookies,
  buildSetCookie,
  sessionExpiryIso,
  isSessionExpired,
  revokeAllSessionsForAccount,
  bumpSessionVersion,
  SESSION_TTL_MS,
} from './auth.mjs';
import {
  lookupOperationReplay,
  rememberOperationReplay,
} from './replay.mjs';
import { teacherBaSnapshot, stripBaFromStudentSnapshot, studentAssignmentClassIds, studentCanAccessAssignmentClass, assertUniqueStudentCode, normalizeOptionalCode } from '../dist/ba-domain.js';
import { tryHandleBaTeacherApi, syncMembershipOnStudentPut } from './ba-routes.mjs';
import {
  startBaReminderWorker,
  flagOverdueJobs,
  processDueJobs,
  runReminderTick,
  reminderLatenessWindowMs,
} from './ba-reminder-worker.mjs';
import {
  tryHandleExamApi,
  tryServePdfJsVendor,
  examTeacherDataExtension,
  examStudentDataExtension,
} from './exam-routes.mjs';
import { markInterruptedJobs, scheduleExamImportProcessing, shutdownExamWorkersForStore } from './exam-worker.mjs';
import { canAccessExamAttachment } from './exam-unified-access.mjs';
import { validateExamAudioBuffer } from './exam-audio.mjs';
import { EXAM_JOB_STATUS } from '../dist/exam-domain.js';
import {
  SUBMISSION_STATUS,
  validateScore,
  checkMissingPages,
  projectStudentVersionGrading,
  canStudentSubmitNewVersion,
  getStudentRevisionForbiddenReason,
  applyFirstSubmittedAt,
  createSubmittedVersion,
  createDraftVersion,
  mergeTeacherSubmissionSave,
  validateBackup,
  assessLegacyLocalMigrate,
  applyLegacyLocalMigrateRecords,
  validateAssignmentInput,
  validateClassInput,
  validateStudentInput,
  getAssignmentsForStudent,
  enrichAssignmentWithAttachments,
} from '../dist/model.js';

const JSON_LIMIT = 2 * 1024 * 1024;
const IMAGE_LIMIT_BYTES = 8 * 1024 * 1024;
const ACCEPTED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

function splitOperationId(body) {
  if (!body || typeof body !== 'object') return { operationId: null, payload: body };
  const operationId = typeof body.operationId === 'string' ? body.operationId : null;
  const payload = { ...body };
  delete payload.operationId;
  return { operationId, payload };
}

async function runWithReplay(store, auth, action, operationId, payloadForHash, work) {
  let clientResult = null;
  let conflictMessage = null;
  try {
    await store.mutate(withCommitAuth(auth, (s) => {
      const lookup = lookupOperationReplay(s, auth, action, operationId, payloadForHash);
      if (lookup.kind === 'conflict') {
        conflictMessage = lookup.error;
        return;
      }
      if (lookup.kind === 'replay') {
        clientResult = { replay: true, ...lookup.result };
        return;
      }
      const fresh = work(s);
      clientResult = fresh.client;
      if (operationId) {
        rememberOperationReplay(s, operationId, {
          actorKey: lookup.actorKey,
          action,
          payloadHash: lookup.payloadHash,
        }, fresh.stored);
      }
    }));
  } catch (e) {
    if (e?.message === 'session-revoked') {
      return { ok: false, status: 401, error: 'Phiên đăng nhập không còn hợp lệ.' };
    }
    const msg = String(e?.message || '');
    if (msg === 'stale-undo' || msg === 'no-undo') {
      return { ok: false, status: 409, error: msg };
    }
    if (msg === 'missing' || msg === 'missing-version' || msg === 'missing-class') {
      return { ok: false, status: 404, error: msg };
    }
    throw e;
  }
  if (conflictMessage) {
    return { ok: false, status: 409, error: conflictMessage };
  }
  return { ok: true, result: clientResult };
}

function sanitizeLegacySvgBuffer(buf) {
  let text = buf.toString('utf8');
  text = text.replace(/<script[\s\S]*?<\/script>/gi, '');
  text = text.replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi, '');
  text = text.replace(/\s(on\w+)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  return Buffer.from(text, 'utf8');
}

function json(res, status, body, headers = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(data);
}

function error(res, status, message) {
  json(res, status, { ok: false, error: message });
}

async function readJsonBody(req, limit = JSON_LIMIT) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('body-too-large');
    chunks.push(chunk);
  }
  if (!chunks.length) return null;
  const text = Buffer.concat(chunks).toString('utf8');
  return JSON.parse(text);
}

function findStudentAccount(state, accountId) {
  return state.studentAccounts.find((a) => a.id === accountId) || null;
}

function findAccountByUsername(state, usernameNorm) {
  if (state.teacherAccount?.usernameNorm === usernameNorm) return { role: 'teacher', account: state.teacherAccount };
  const st = state.studentAccounts.find((a) => a.usernameNorm === usernameNorm && !a.disabled);
  if (st) return { role: 'student', account: st };
  return null;
}

function resolveSession(state, cookies) {
  const token = cookies.bn_session;
  if (!token) return null;
  const hash = hashToken(token);
  const sess = state.sessions[hash];
  if (!sess || isSessionExpired(sess.expiresAt)) return null;
  if (sess.role === 'teacher') {
    const acc = state.teacherAccount;
    if (!acc || acc.disabled || (acc.sessionVersion || 0) !== (sess.sessionVersion || 0)) return null;
    return { role: 'teacher', account: acc, sessionHash: hash };
  }
  const acc = findStudentAccount(state, sess.accountId);
  if (!acc || acc.disabled || (acc.sessionVersion || 0) !== (sess.sessionVersion || 0)) return null;
  return { role: 'student', account: acc, studentId: acc.studentId, sessionHash: hash };
}

function attachStudentRecord(state, auth) {
  if (auth.role !== 'student') return auth;
  const student = state.students.find((s) => s.id === auth.studentId);
  return { ...auth, student };
}

function commitAuthFrom(auth) {
  if (!auth?.sessionHash) return null;
  return {
    sessionHash: auth.sessionHash,
    role: auth.role,
    accountId: auth.account.id,
    studentId: auth.studentId || null,
  };
}

function assertSessionAtCommit(state, ctx) {
  if (!ctx?.sessionHash) throw new Error('session-revoked');
  const sess = state.sessions[ctx.sessionHash];
  if (!sess || isSessionExpired(sess.expiresAt)) throw new Error('session-revoked');
  if (sess.role !== ctx.role) throw new Error('session-revoked');
  if (ctx.role === 'teacher') {
    const acc = state.teacherAccount;
    if (!acc || acc.disabled || acc.id !== ctx.accountId) throw new Error('session-revoked');
    if ((acc.sessionVersion || 0) !== (sess.sessionVersion || 0)) throw new Error('session-revoked');
    return attachStudentRecord(state, { role: 'teacher', account: acc, sessionHash: ctx.sessionHash });
  }
  const acc = findStudentAccount(state, ctx.accountId);
  if (!acc || acc.disabled || acc.id !== ctx.accountId) throw new Error('session-revoked');
  if ((acc.sessionVersion || 0) !== (sess.sessionVersion || 0)) throw new Error('session-revoked');
  if (acc.studentId !== ctx.studentId) throw new Error('session-revoked');
  return attachStudentRecord(state, {
    role: 'student',
    account: acc,
    studentId: acc.studentId,
    sessionHash: ctx.sessionHash,
  });
}

function withCommitAuth(auth, fn) {
  const ctx = commitAuthFrom(auth);
  return (state) => {
    assertSessionAtCommit(state, ctx);
    return fn(state);
  };
}

function stripSubmissionForStudent(sub) {
  const versions = (sub.versions || []).map((v) => {
    if (v.isDraft) {
      return {
        versionId: v.versionId,
        versionNumber: v.versionNumber,
        isDraft: true,
        pageImageIds: v.pageImageIds,
        status: v.status,
        updatedAt: v.updatedAt,
        grading: null,
      };
    }
    return {
      versionId: v.versionId,
      versionNumber: v.versionNumber,
      submittedAt: v.submittedAt,
      isDraft: false,
      pageImageIds: v.pageImageIds,
      status: v.status,
      grading: projectStudentVersionGrading(v.grading),
      feedbackOpenedAt: v.feedbackOpenedAt,
    };
  });
  return {
    id: sub.id,
    assignmentId: sub.assignmentId,
    studentId: sub.studentId,
    firstSubmittedAt: sub.firstSubmittedAt,
    versions,
    feedbackOpenedAt: sub.feedbackOpenedAt,
  };
}

function mapAssignmentsForClient(state, assignments) {
  return assignments.map((a) => enrichAssignmentWithAttachments(a, state.attachmentMeta || {}));
}

async function backfillAttachmentContentFingerprints(store, state) {
  const meta = state.attachmentMeta || {};
  const pending = [];
  for (const [id, row] of Object.entries(meta)) {
    if (row?.contentFingerprint) continue;
    const buf = await store.readAttachment(id);
    if (!buf?.length) continue;
    pending.push({ id, digest: attachmentContentDigest(buf) });
  }
  if (!pending.length) return;
  await store.mutate((s) => {
    for (const { id, digest } of pending) {
      const live = s.attachmentMeta?.[id];
      if (live && !live.contentFingerprint) {
        live.contentFingerprint = digest;
      }
    }
  });
}

function teacherDataSnapshot(state) {
  const teacherId = state.teacherAccount?.id;
  return {
    classes: state.classes,
    students: state.students,
    assignments: mapAssignmentsForClient(state, state.assignments),
    submissions: state.submissions,
    settings: {
      teacherName: state.settings.teacherDisplayName || stateTeacherNameFromState(state),
    },
    ...teacherBaSnapshot(state),
    ...(teacherId ? examTeacherDataExtension(state, teacherId) : {}),
  };
}

function stateTeacherNameFromState(state) {
  return state.teacherAccount?.displayName || state.teacherAccount?.username || 'Giáo viên';
}

function studentDataSnapshot(state, studentId, getNow = () => new Date().toISOString()) {
  const student = state.students.find((s) => s.id === studentId);
  if (!student) return null;
  const atIso = getNow();
  const classIds = studentAssignmentClassIds(student, state.memberships || [], atIso);
  const assignments = mapAssignmentsForClient(
    state,
    getAssignmentsForStudent(state.assignments, student, '', state.memberships || [], atIso),
  );
  const assignmentIds = new Set(assignments.map((a) => a.id));
  const submissions = state.submissions
    .filter((s) => s.studentId === studentId && assignmentIds.has(s.assignmentId))
    .map(stripSubmissionForStudent);
  return stripBaFromStudentSnapshot({
    classes: state.classes.filter((c) => classIds.has(c.id)),
    students: [{ ...student, enrollmentClassIds: [...classIds] }],
    assignments,
    submissions,
    settings: {},
    ...examStudentDataExtension(state, student, () => atIso),
  });
}

function canAccessAttachment(state, auth, attachmentId, getNow = () => new Date().toISOString()) {
  const meta = state.attachmentMeta?.[attachmentId];
  if (!meta) return false;
  if (auth.role === 'teacher') {
    if (meta.ownerAccountId === auth.account.id) return true;
    return canAccessExamAttachment(state, auth, attachmentId, getNow);
  }
  const student = auth.student || state.students.find((s) => s.id === auth.studentId);
  if (!student) return false;
  const atIso = getNow();
  for (const a of state.assignments) {
    if (!studentCanAccessAssignmentClass(student, a.classId, state.memberships || [], atIso)) continue;
    if ((a.attachmentIds || []).includes(attachmentId)) return true;
  }
  return canAccessExamAttachment(state, auth, attachmentId, getNow);
}

function canAccessImage(state, auth, imageId) {
  const meta = state.imageMeta[imageId];
  if (!meta) return false;
  if (auth.role === 'teacher') return true;
  if (meta.ownerStudentId === auth.studentId) return true;
  const subs = state.submissions.filter((s) => s.studentId === auth.studentId);
  for (const sub of subs) {
    for (const v of sub.versions || []) {
      if ((v.pageImageIds || []).includes(imageId)) return true;
    }
  }
  return false;
}

function generateTempPassword() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  let s = '';
  for (let i = 0; i < 12; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

/** Sanitized account fields for /api/auth/me — never expose secrets or session data. */
function publicMe(auth) {
  const acc = auth.account;
  return {
    id: acc.id,
    role: auth.role,
    username: acc.username,
    displayName: acc.displayName || acc.username,
    mustChangePassword: !!acc.mustChangePassword,
    disabled: !!acc.disabled,
  };
}

function assertPublicUserShape(user) {
  const forbidden = ['password', 'salt', 'hash', 'sessionHash', 'sessions', 'sessionVersion'];
  for (const key of forbidden) {
    if (Object.prototype.hasOwnProperty.call(user, key)) {
      throw new Error(`public user leaked ${key}`);
    }
  }
}

function listStudentAccounts(state) {
  return state.studentAccounts.map((acc) => {
    const st = state.students.find((s) => s.id === acc.studentId);
    return {
      id: acc.id,
      studentId: acc.studentId,
      username: acc.username,
      disabled: !!acc.disabled,
      mustChangePassword: !!acc.mustChangePassword,
      studentName: st?.name || '',
      classId: st?.classId || '',
    };
  });
}

export function createServer(options = {}) {
  const host = options.host || '127.0.0.1';
  const secureCookie = !!options.secureCookie;
  const publicOrigin = options.publicOrigin || process.env.PUBLIC_ORIGIN || null;
  const setupToken = String(options.setupToken ?? process.env.SETUP_TOKEN ?? '').trim();
  const checkMutationHeaders = (req, hostHeader, csrfCookie, csrfHeader) =>
    assertMutationHeaders(req, hostHeader, csrfCookie, csrfHeader, publicOrigin);
  const attachmentUploadHeaders = (req, hostHeader, csrfCookie, csrfHeader) =>
    checkAttachmentUploadHeaders(req, hostHeader, csrfCookie, csrfHeader, publicOrigin);
  const store = createStore(options.dataDir);
  const distDir = options.distDir;
  const loginLimiter = createRateLimiter({ windowMs: 60_000, max: 20 });
  const setupLimiter = createRateLimiter({ windowMs: 60_000, max: 10 });

  async function loadLiveAuth(res, cookies, { allowMustChangePassword = false } = {}) {
    const liveState = await store.read();
    let liveAuth = resolveSession(liveState, cookies);
    if (!liveAuth) {
      error(res, 401, 'Chưa đăng nhập.');
      return null;
    }
    if (!allowMustChangePassword && liveAuth.account.mustChangePassword) {
      error(res, 403, 'Cần đổi mật khẩu trước.');
      return null;
    }
    return {
      state: liveState,
      auth: attachStudentRecord(liveState, liveAuth),
    };
  }

  function establishSession(state, account, role, studentId = null) {
    const token = newSessionToken();
    const csrf = newCsrfToken();
    const hash = hashToken(token);
    state.sessions[hash] = {
      accountId: account.id,
      role,
      studentId,
      expiresAt: sessionExpiryIso(),
      sessionVersion: account.sessionVersion || 0,
      createdAt: new Date().toISOString(),
    };
    const maxAge = Math.floor(SESSION_TTL_MS / 1000);
    const cookies = [
      buildSetCookie('bn_session', token, {
        httpOnly: true,
        sameSite: 'Strict',
        secure: secureCookie,
        maxAge,
        path: '/',
      }),
      buildSetCookie('bn_csrf', csrf, {
        httpOnly: false,
        sameSite: 'Strict',
        secure: secureCookie,
        maxAge,
        path: '/',
      }),
    ];
    return { cookies, csrf };
  }

  const getNow = options.getNow || (() => new Date().toISOString());
  const reminderPollingMs = options.reminderWindowMs ?? 60_000;
  const reminderWorker = startBaReminderWorker({
    store,
    getNow,
    windowMs: reminderPollingMs,
    latenessWindowMs: options.reminderLatenessWindowMs ?? reminderLatenessWindowMs(reminderPollingMs),
  });
  reminderWorker.start();

  let shutdownRequested = false;

  const examStartupReady = store.mutate((s) => {
    markInterruptedJobs(s);
    for (const job of s.examImports || []) {
      if (job.status === EXAM_JOB_STATUS.INTERRUPTED) {
        job.status = EXAM_JOB_STATUS.QUEUED;
        job.error = null;
        job.updatedAt = getNow();
      }
    }
  }).then(async () => {
    if (shutdownRequested) return;
    const fresh = await store.read();
    for (const job of fresh.examImports || []) {
      if (job.status === EXAM_JOB_STATUS.QUEUED) {
        scheduleExamImportProcessing(store, job.id, getNow);
      }
    }
  }).catch(() => {});

  const baApiCtx = {
    getNow,
    reminderLatenessWindowMs: options.reminderLatenessWindowMs ?? reminderLatenessWindowMs(reminderPollingMs),
    get reminderFns() {
      return { flagOverdueJobs, processDueJobs, runReminderTick };
    },
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${host}`);
    const pathname = url.pathname;
    const hostHeader = req.headers.host || `${host}:${options.port || 4173}`;

    if (tryServePdfJsVendor(pathname, req, res, error)) {
      return;
    }

    if (pathname.startsWith('/api/')) {
      try {
        await handleApi(req, res, pathname, hostHeader);
      } catch (e) {
        if (e?.message === 'body-too-large') {
          error(res, 413, 'Nội dung quá lớn.');
          return;
        }
        console.error('API error', e?.message || e);
        error(res, 500, 'Lỗi máy chủ.');
      }
      return;
    }

    if (distDir) {
      serveStatic(req, res, pathname, distDir);
      return;
    }

    error(res, 404, 'Not found');
  });

  async function handleApi(req, res, pathname, hostHeader) {
    const state = await store.read();
    const cookies = parseCookies(req.headers.cookie);
    let auth = resolveSession(state, cookies);
    if (auth) auth = attachStudentRecord(state, auth);

    if (pathname === '/api/auth/csrf' && req.method === 'GET') {
      const csrf = cookies.bn_csrf || newCsrfToken();
      const maxAge = Math.floor(SESSION_TTL_MS / 1000);
      json(res, 200, { ok: true }, {
        'Set-Cookie': buildSetCookie('bn_csrf', csrf, {
          httpOnly: false,
          sameSite: 'Strict',
          secure: secureCookie,
          maxAge,
          path: '/',
        }),
      });
      return;
    }

    if (pathname === '/api/bootstrap' && req.method === 'GET') {
      json(res, 200, {
        ok: true,
        initialized: !!state.meta.initialized,
        authenticated: !!auth,
      });
      return;
    }

    if (pathname === '/api/health' && req.method === 'GET') {
      let storageOk = true;
      try {
        await store.read();
      } catch {
        storageOk = false;
      }
      const status = storageOk ? 200 : 503;
      json(res, status, { ok: storageOk, storage: storageOk ? 'ready' : 'error' });
      return;
    }

    if (pathname === '/api/auth/me' && req.method === 'GET') {
      if (!auth) {
        error(res, 401, 'Chưa đăng nhập.');
        return;
      }
      const me = publicMe(auth);
      if (auth.role === 'teacher') {
        me.displayName = state.settings.teacherDisplayName || auth.account.displayName || auth.account.username;
      } else {
        me.displayName = auth.student?.name || auth.account.username;
        me.studentId = auth.studentId;
      }
      assertPublicUserShape(me);
      json(res, 200, { ok: true, user: me });
      return;
    }

    if (pathname === '/api/auth/setup' && req.method === 'POST') {
      if (!setupLimiter.check(req.socket.remoteAddress || 'local')) {
        error(res, 429, 'Quá nhiều lần thử. Chờ một chút.');
        return;
      }
      if (state.meta.initialized) {
        error(res, 403, 'Hệ thống đã được thiết lập.');
        return;
      }
      const publicOriginConfigured = Boolean(String(publicOrigin || '').trim());
      const setupTokenConfigured = Boolean(setupToken);
      if (publicOriginConfigured && !setupTokenConfigured) {
        error(res, 403, 'Thiết lập trên URL công khai cần SETUP_TOKEN (header x-bn-setup-token).');
        return;
      }
      if (setupTokenConfigured) {
        const headerToken = String(req.headers['x-bn-setup-token'] || '');
        if (headerToken !== setupToken) {
          error(res, 403, 'Yêu cầu không hợp lệ.');
          return;
        }
      } else if (!publicOriginConfigured) {
        const remote = req.socket.remoteAddress;
        const isLocal =
          remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
        if (!isLocal) {
          error(res, 403, 'Thiết lập từ xa cần SETUP_TOKEN (header x-bn-setup-token).');
          return;
        }
      }
      if (!checkMutationHeaders(req, hostHeader, cookies.bn_csrf, req.headers['x-bn-csrf'])) {
        error(res, 403, 'Yêu cầu không hợp lệ.');
        return;
      }
      const body = await readJsonBody(req);
      const vu = validateUsername(body?.username);
      if (!vu.ok) { error(res, 400, vu.error); return; }
      const vp = validatePassword(body?.password);
      if (!vp.ok) { error(res, 400, vp.error); return; }
      const displayName = String(body?.displayName || vu.value).trim().slice(0, 80) || vu.value;
      let cookieHeaders;
      try {
        await store.mutate((s) => {
          if (s.meta.initialized) throw new Error('already-init');
          const hp = hashPassword(vp.value);
          s.teacherAccount = {
            id: randomUUID(),
            username: vu.value,
            usernameNorm: normalizeUsername(vu.value),
            password: hp,
            displayName,
            mustChangePassword: false,
            disabled: false,
            sessionVersion: 0,
          };
          s.settings.teacherDisplayName = displayName;
          s.meta.initialized = true;
          cookieHeaders = establishSession(s, s.teacherAccount, 'teacher').cookies;
        });
      } catch {
        error(res, 403, 'Hệ thống đã được thiết lập.');
        return;
      }
      json(res, 200, { ok: true }, { 'Set-Cookie': cookieHeaders });
      return;
    }

    if (pathname === '/api/auth/login' && req.method === 'POST') {
      if (!loginLimiter.check(req.socket.remoteAddress || 'local')) {
        error(res, 429, 'Quá nhiều lần thử. Chờ một chút.');
        return;
      }
      if (!checkMutationHeaders(req, hostHeader, cookies.bn_csrf, req.headers['x-bn-csrf'])) {
        error(res, 403, 'Yêu cầu không hợp lệ.');
        return;
      }
      const body = await readJsonBody(req);
      const usernameNorm = normalizeUsername(body?.username);
      const password = String(body?.password || '');
      const preState = await store.read();
      const preFound = findAccountByUsername(preState, usernameNorm);
      if (!preFound || !verifyPassword(password, preFound.account.password)) {
        error(res, 401, 'Sai tên đăng nhập hoặc mật khẩu.');
        return;
      }
      const credentialEpoch = preFound.account.sessionVersion || 0;
      let sess;
      try {
        sess = await store.mutate((s) => {
          const found = findAccountByUsername(s, usernameNorm);
          if (!found || (found.account.sessionVersion || 0) !== credentialEpoch) {
            throw new Error('stale-login');
          }
          if (!verifyPassword(password, found.account.password)) {
            throw new Error('bad-credentials');
          }
          if (found.account.disabled) throw new Error('disabled');
          const acc = found.role === 'teacher'
            ? s.teacherAccount
            : s.studentAccounts.find((a) => a.id === found.account.id);
          if (!acc) throw new Error('bad-credentials');
          return establishSession(
            s,
            acc,
            found.role,
            found.role === 'student' ? acc.studentId : null,
          );
        });
      } catch (e) {
        const msg = e?.message;
        if (msg === 'bad-credentials' || msg === 'stale-login') {
          error(res, 401, 'Sai tên đăng nhập hoặc mật khẩu.');
          return;
        }
        if (msg === 'disabled') {
          error(res, 403, 'Tài khoản đã bị vô hiệu.');
          return;
        }
        throw e;
      }
      json(res, 200, { ok: true }, { 'Set-Cookie': sess.cookies });
      return;
    }

    if (pathname === '/api/auth/logout' && req.method === 'POST') {
      if (!checkMutationHeaders(req, hostHeader, cookies.bn_csrf, req.headers['x-bn-csrf'])) {
        error(res, 403, 'Yêu cầu không hợp lệ.');
        return;
      }
      await store.mutate((s) => {
        if (auth?.sessionHash) {
          assertSessionAtCommit(s, commitAuthFrom(auth));
          delete s.sessions[auth.sessionHash];
        }
      });
      const clearCookies = [
        buildSetCookie('bn_session', '', { httpOnly: true, sameSite: 'Strict', secure: secureCookie, maxAge: 0, path: '/' }),
        buildSetCookie('bn_csrf', '', { httpOnly: false, sameSite: 'Strict', secure: secureCookie, maxAge: 0, path: '/' }),
      ];
      json(res, 200, { ok: true }, { 'Set-Cookie': clearCookies });
      return;
    }

    if (pathname === '/api/auth/change-password' && req.method === 'POST') {
      if (!auth) { error(res, 401, 'Chưa đăng nhập.'); return; }
      if (!checkMutationHeaders(req, hostHeader, cookies.bn_csrf, req.headers['x-bn-csrf'])) {
        error(res, 403, 'Yêu cầu không hợp lệ.');
        return;
      }
      const body = await readJsonBody(req);
      const vp = validatePassword(body?.newPassword);
      if (!vp.ok) { error(res, 400, vp.error); return; }
      const current = String(body?.currentPassword || '');
      if (!auth.account.mustChangePassword && !verifyPassword(current, auth.account.password)) {
        error(res, 400, 'Mật khẩu hiện tại không đúng.');
        return;
      }
      let sess;
      try {
        sess = await store.mutate(withCommitAuth(auth, (s) => {
          const acc = auth.role === 'teacher'
            ? s.teacherAccount
            : s.studentAccounts.find((a) => a.id === auth.account.id);
          if (!acc) throw new Error('missing');
          if (!acc.mustChangePassword && !verifyPassword(current, acc.password)) throw new Error('bad-pass');
          acc.password = hashPassword(vp.value);
          acc.mustChangePassword = false;
          bumpSessionVersion(acc);
          revokeAllSessionsForAccount(s, acc.id);
          return establishSession(
            s,
            acc,
            auth.role,
            auth.role === 'student' ? acc.studentId : null,
          );
        }));
      } catch (e) {
        if (e?.message === 'bad-pass') {
          error(res, 400, 'Mật khẩu hiện tại không đúng.');
          return;
        }
        throw e;
      }
      json(res, 200, { ok: true }, { 'Set-Cookie': sess.cookies });
      return;
    }

    if (!auth) {
      error(res, 401, 'Chưa đăng nhập.');
      return;
    }

    if (auth.account.mustChangePassword) {
      const allowed = ['/api/auth/me', '/api/auth/change-password', '/api/auth/logout'];
      if (!allowed.includes(pathname)) {
        error(res, 403, 'Cần đổi mật khẩu trước.');
        return;
      }
    }

    if (await tryHandleExamApi({
      req, res, pathname, auth, store, hostHeader, cookies,
      readJsonBody, error, json, runWithReplay, assertMutationHeaders: checkMutationHeaders,
      loadLiveAuth, withCommitAuth, getNow,
    })) return;

    if (pathname === '/api/data' && req.method === 'GET') {
      const liveState = await store.read();
      const liveAuth = resolveSession(liveState, cookies);
      if (!liveAuth) {
        error(res, 401, 'Chưa đăng nhập.');
        return;
      }
      const live = attachStudentRecord(liveState, liveAuth);
      if (live.account.mustChangePassword) {
        error(res, 403, 'Cần đổi mật khẩu trước.');
        return;
      }
      if (live.role === 'teacher') {
        await backfillAttachmentContentFingerprints(store, liveState);
        const freshState = await store.read();
        json(res, 200, { ok: true, data: teacherDataSnapshot(freshState) });
      } else {
        await backfillAttachmentContentFingerprints(store, liveState);
        const freshState = await store.read();
        const data = studentDataSnapshot(freshState, live.studentId, getNow);
        if (!data) { error(res, 403, 'Không có quyền.'); return; }
        json(res, 200, { ok: true, data });
      }
      return;
    }

    if (pathname.startsWith('/api/images/') && req.method === 'GET') {
      const imageId = pathname.slice('/api/images/'.length);
      if (!imageId || imageId.includes('/')) { error(res, 404, 'Không tìm thấy.'); return; }
      const liveState = await store.read();
      const liveAuth = resolveSession(liveState, cookies);
      if (!liveAuth) {
        error(res, 401, 'Chưa đăng nhập.');
        return;
      }
      const live = attachStudentRecord(liveState, liveAuth);
      if (!canAccessImage(liveState, live, imageId)) {
        error(res, 403, 'Không có quyền.');
        return;
      }
      const buf = await store.readImage(imageId);
      if (!buf) { error(res, 404, 'Không tìm thấy.'); return; }
      const meta = liveState.imageMeta[imageId];
      const mime = meta?.mime || 'application/octet-stream';
      if (mime === 'image/svg+xml' && !meta?.legacySandboxSvg) {
        error(res, 403, 'Định dạng ảnh không được hỗ trợ.');
        return;
      }
      res.writeHead(200, {
        'Content-Type': mime,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        ...(mime === 'image/svg+xml'
          ? { 'Content-Security-Policy': "default-src 'none'; script-src 'none'; sandbox" }
          : {}),
      });
      res.end(buf);
      return;
    }

    if (pathname.startsWith('/api/attachments/') && req.method === 'GET') {
      const attachmentId = pathname.slice('/api/attachments/'.length);
      if (!attachmentId || attachmentId.includes('/')) {
        error(res, 404, 'Không tìm thấy.');
        return;
      }
      const liveState = await store.read();
      const liveAuth = resolveSession(liveState, cookies);
      if (!liveAuth) {
        error(res, 401, 'Chưa đăng nhập.');
        return;
      }
      const live = attachStudentRecord(liveState, liveAuth);
      if (live.account.mustChangePassword) {
        error(res, 403, 'Cần đổi mật khẩu trước.');
        return;
      }
      if (!canAccessAttachment(liveState, live, attachmentId, getNow)) {
        error(res, 403, 'Không có quyền.');
        return;
      }
      const buf = await store.readAttachment(attachmentId);
      if (!buf) {
        error(res, 404, 'Không tìm thấy.');
        return;
      }
      const meta = liveState.attachmentMeta[attachmentId];
      const mime = meta?.mime || 'application/octet-stream';
      const inline = mime.startsWith('image/') || mime === 'application/pdf';
      const headers = {
        'Content-Type': mime,
        'Content-Disposition': encodeContentDisposition(meta?.filename || 'file', inline),
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      };
      if (mime === 'application/pdf') {
        headers['Content-Security-Policy'] = "default-src 'none'; sandbox";
      }
      res.writeHead(200, headers);
      res.end(buf);
      return;
    }

    if (pathname === '/api/images' && req.method === 'POST') {
      if (!checkMutationHeaders(req, hostHeader, cookies.bn_csrf, req.headers['x-bn-csrf'])) {
        error(res, 403, 'Yêu cầu không hợp lệ.');
        return;
      }
      const body = await readJsonBody(req, IMAGE_LIMIT_BYTES + 4096);
      const live = await loadLiveAuth(res, cookies);
      if (!live) return;
      const { auth: writeAuth } = live;
      const mime = String(body?.mime || '');
      if (!ACCEPTED_IMAGE_TYPES.has(mime)) {
        error(res, 400, 'Định dạng ảnh không được hỗ trợ.');
        return;
      }
      const b64 = body?.dataBase64;
      if (!b64) { error(res, 400, 'Thiếu dữ liệu ảnh.'); return; }
      const buf = Buffer.from(b64, 'base64');
      if (buf.length > IMAGE_LIMIT_BYTES) {
        error(res, 400, 'Ảnh quá lớn.');
        return;
      }
      const id = randomUUID();
      const meta = {
        id,
        mime,
        ownerAccountId: writeAuth.account.id,
        ownerStudentId: writeAuth.role === 'student' ? writeAuth.studentId : null,
        createdAt: new Date().toISOString(),
      };
      try {
        await store.mutate(withCommitAuth(writeAuth, (s) => {
          store.attachImageInState(s, id, buf, meta);
        }));
      } catch (e) {
        if (e?.message === 'session-revoked') {
          error(res, 401, 'Phiên đăng nhập không còn hợp lệ.');
          return;
        }
        throw e;
      }
      json(res, 200, { ok: true, id });
      return;
    }

    if (pathname === '/api/teacher/accounts' && req.method === 'GET') {
      if (auth.role !== 'teacher') {
        error(res, 403, 'Không có quyền.');
        return;
      }
      json(res, 200, { ok: true, accounts: listStudentAccounts(state) });
      return;
    }

    if (auth.role === 'teacher') {
      await handleTeacherMutation(req, res, pathname, hostHeader, cookies, auth, state);
      return;
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      error(res, 404, 'Không tìm thấy API.');
      return;
    }

    await handleStudentMutation(req, res, pathname, hostHeader, cookies, auth, state);
  }

  async function handleTeacherMutation(req, res, pathname, hostHeader, cookies, auth, state) {
    const teacherAttMatch = pathname.match(/^\/api\/teacher\/attachments\/([^/]+)$/);
    if (teacherAttMatch && (req.method === 'GET' || req.method === 'HEAD')) {
      const attachmentId = teacherAttMatch[1];
      const liveState = await store.read();
      if (!canAccessAttachment(liveState, auth, attachmentId, getNow)) {
        error(res, 403, 'Không có quyền.');
        return;
      }
      const buf = await store.readAttachment(attachmentId);
      if (!buf) {
        error(res, 404, 'Không tìm thấy.');
        return;
      }
      const meta = liveState.attachmentMeta[attachmentId];
      const mime = meta?.mime || 'application/octet-stream';
      const inline = mime.startsWith('image/') || mime.startsWith('audio/') || mime === 'application/pdf';
      const headers = {
        'Content-Type': mime,
        'Content-Disposition': encodeContentDisposition(meta?.filename || 'file', inline),
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        'Accept-Ranges': 'bytes',
      };
      if (mime === 'application/pdf') {
        headers['Content-Security-Policy'] = "default-src 'none'; sandbox";
      }
      const range = req.headers.range;
      const total = buf.length;
      if (range && /^bytes=\d*-\d*$/.test(range) && mime.startsWith('audio/')) {
        const m = range.match(/bytes=(\d*)-(\d*)/);
        let start = m[1] ? parseInt(m[1], 10) : 0;
        let end = m[2] ? parseInt(m[2], 10) : total - 1;
        if (Number.isNaN(start)) start = 0;
        if (Number.isNaN(end) || end >= total) end = total - 1;
        if (start > end || start >= total) {
          res.writeHead(416, { 'Content-Range': `bytes */${total}` });
          res.end();
          return;
        }
        const chunk = buf.slice(start, end + 1);
        res.writeHead(206, {
          ...headers,
          'Content-Range': `bytes ${start}-${end}/${total}`,
          'Content-Length': chunk.length,
        });
        if (req.method === 'HEAD') res.end();
        else res.end(chunk);
        return;
      }
      res.writeHead(200, { ...headers, 'Content-Length': total });
      if (req.method === 'HEAD') res.end();
      else res.end(buf);
      return;
    }

    if (pathname === '/api/teacher/attachments' && req.method === 'POST') {
      if (!attachmentUploadHeaders(req, hostHeader, cookies.bn_csrf, req.headers['x-bn-csrf'])) {
        error(res, 403, 'Yêu cầu không hợp lệ.');
        return;
      }
      const rawName = req.headers['x-bn-filename']
        ? decodeURIComponent(String(req.headers['x-bn-filename']))
        : 'file';
      let buf;
      try {
        buf = await readBinaryBody(req, ATTACHMENT_MAX_BYTES);
      } catch (e) {
        if (e?.message === 'body-too-large') {
          error(res, 413, 'Tệp quá lớn (tối đa 20 MB).');
          return;
        }
        throw e;
      }
      const declaredMime = String(req.headers['content-type'] || '').split(';')[0].trim();
      let checked = validateAttachmentBuffer(buf, rawName, declaredMime);
      if (!checked.ok) {
        const audioChecked = validateExamAudioBuffer(buf, rawName, declaredMime);
        if (!audioChecked.ok) {
          error(res, 400, checked.error);
          return;
        }
        checked = {
          ok: true,
          mime: audioChecked.mime,
          filename: sanitizeAttachmentBasename(rawName),
        };
      }
      const id = randomUUID();
      const meta = {
        id,
        filename: checked.filename,
        mime: checked.mime,
        size: buf.length,
        contentFingerprint: attachmentContentDigest(buf),
        ownerAccountId: auth.account.id,
        createdAt: new Date().toISOString(),
      };
      try {
        await store.mutate(withCommitAuth(auth, (s) => {
          const liveTeacher = s.teacherAccount;
          if (!liveTeacher || liveTeacher.id !== auth.account.id) throw new Error('session-revoked');
          store.attachAttachmentInState(s, id, buf, meta);
        }));
      } catch (e) {
        if (e?.message === 'session-revoked') {
          error(res, 401, 'Phiên đăng nhập không còn hợp lệ.');
          return;
        }
        throw e;
      }
      json(res, 200, {
        ok: true,
        id,
        filename: meta.filename,
        mime: meta.mime,
        size: meta.size,
        contentFingerprint: meta.contentFingerprint,
      });
      return;
    }

    const mutating = req.method !== 'GET' && req.method !== 'HEAD';
    if (mutating && !checkMutationHeaders(req, hostHeader, cookies.bn_csrf, req.headers['x-bn-csrf'])) {
      error(res, 403, 'Yêu cầu không hợp lệ.');
      return;
    }

    Object.assign(baApiCtx, {
      req, res, pathname, auth, store, hostHeader, cookies,
      readJsonBody, error, json, runWithReplay, assertMutationHeaders: checkMutationHeaders,
      loadLiveAuth, withCommitAuth,
    });
    if (await tryHandleBaTeacherApi(baApiCtx)) return;

    if (pathname === '/api/teacher/record/classes' && req.method === 'PUT') {
      const bodyRaw = await readJsonBody(req);
      const { operationId, payload: rec } = splitOperationId(bodyRaw);
      const v = validateClassInput({ name: rec?.name, scheduleDays: rec?.scheduleDays, scheduleTime: rec?.scheduleTime });
      if (!v.ok) { error(res, 400, v.error); return; }
      const replayOut = await runWithReplay(store, auth, 'teacher.class.put', operationId, rec, (s) => {
        const idx = s.classes.findIndex((c) => c.id === rec.id);
        const prev = idx >= 0 ? s.classes[idx] : null;
        const row = {
          id: rec.id || prev?.id || randomUUID(),
          name: String(rec.name).trim(),
          scheduleDays: rec.scheduleDays,
          scheduleTime: rec.scheduleTime,
          createdAt: prev?.createdAt || rec.createdAt || new Date().toISOString(),
          kind: prev?.kind,
          status: prev?.status,
          code: prev?.code,
          subject: prev?.subject,
          notes: prev?.notes,
          meetingUrl: prev?.meetingUrl,
          defaultReminderEnabled: prev?.defaultReminderEnabled,
          defaultReminderOffsetMinutes: prev?.defaultReminderOffsetMinutes,
          studentIds: prev?.studentIds,
        };
        if (idx >= 0) s.classes[idx] = { ...prev, ...row };
        else s.classes.push(row);
        return { client: { ok: true, id: row.id }, stored: { ok: true, id: row.id } };
      });
      if (!replayOut.ok) { error(res, replayOut.status, replayOut.error); return; }
      json(res, 200, replayOut.result);
      return;
    }

    if (pathname === '/api/teacher/record/students' && req.method === 'PUT') {
      const bodyRaw = await readJsonBody(req);
      const { operationId, payload: rec } = splitOperationId(bodyRaw);
      const v = validateStudentInput({ name: rec?.name, classId: rec?.classId });
      if (!v.ok) { error(res, 400, v.error); return; }
      try {
        const replayOut = await runWithReplay(store, auth, 'teacher.student.put', operationId, rec, (s) => {
          if (!s.classes.some((c) => c.id === rec.classId)) throw new Error('bad-class');
          const idx = s.students.findIndex((x) => x.id === rec.id);
          const prior = idx >= 0 ? { ...s.students[idx] } : null;
          const row = {
            id: rec.id || randomUUID(),
            name: String(rec.name).trim(),
            classId: rec.classId,
            code: rec.code != null ? normalizeOptionalCode(rec.code) : prior?.code,
            phone: rec.phone != null ? String(rec.phone).trim() : prior?.phone,
            email: rec.email != null ? String(rec.email).trim() : prior?.email,
            notes: rec.notes != null ? String(rec.notes).trim() : prior?.notes,
            status: rec.status === 'inactive'
              ? 'inactive'
              : (rec.status === 'active' ? 'active' : (prior?.status || 'active')),
          };
          const codeUniq = assertUniqueStudentCode(s.students, row.code, row.id);
          if (!codeUniq.ok) throw new Error(`dup-code:${codeUniq.error}`);
          try {
            syncMembershipOnStudentPut(s, row, prior, getNow);
          } catch (syncErr) {
            if (String(syncErr?.message).startsWith('one-to-one:')) {
              throw new Error(`one-to-one:${syncErr.message.slice(11)}`);
            }
            throw syncErr;
          }
          if (idx >= 0) s.students[idx] = row;
          else {
            s.students.push(row);
            if (!s.memberships.some((m) => m.studentId === row.id && m.classId === row.classId && !m.effectiveTo)) {
              s.memberships.push({
                id: randomUUID(),
                classId: row.classId,
                studentId: row.id,
                effectiveFrom: getNow(),
                effectiveTo: null,
                source: 'student-create',
              });
            }
          }
          return { client: { ok: true, id: row.id }, stored: { ok: true, id: row.id } };
        });
        if (!replayOut.ok) { error(res, replayOut.status, replayOut.error); return; }
        json(res, 200, replayOut.result);
      } catch (e) {
        if (e?.message === 'bad-class') {
          error(res, 400, 'Lớp không tồn tại.');
          return;
        }
        if (String(e?.message).startsWith('one-to-one:')) {
          error(res, 400, e.message.slice(11));
          return;
        }
        if (String(e?.message).startsWith('dup-code:')) {
          error(res, 400, e.message.slice(9));
          return;
        }
        throw e;
      }
      return;
    }

    if (pathname === '/api/teacher/record/assignments' && req.method === 'PUT') {
      const bodyRaw = await readJsonBody(req);
      const { operationId, payload: rec } = splitOperationId(bodyRaw);
      const existingIdx = state.assignments.findIndex((a) => a.id === rec?.id);
      const existing = existingIdx >= 0 ? state.assignments[existingIdx] : null;
      const attachmentIdsForValidation = Object.prototype.hasOwnProperty.call(rec || {}, 'attachmentIds')
        ? rec.attachmentIds
        : (existing?.attachmentIds || []);
      const v = validateAssignmentInput({
        title: rec?.title,
        classId: rec?.classId,
        bookRef: rec?.bookRef,
        dueDateISO: rec?.dueDateISO,
        requiredPageCount: rec?.requiredPageCount,
        attachmentIds: attachmentIdsForValidation,
      });
      if (!v.ok) { error(res, 400, v.error); return; }
      try {
        const replayOut = await runWithReplay(store, auth, 'teacher.assignment.put', operationId, rec, (s) => {
          const idx = s.assignments.findIndex((a) => a.id === rec.id);
          const prior = idx >= 0 ? s.assignments[idx] : null;
          let nextAttachmentIds = prior?.attachmentIds || [];
          if (Object.prototype.hasOwnProperty.call(rec || {}, 'attachmentIds')) {
            const idCheckInner = validateTeacherAttachmentIdList(s, auth.account.id, rec.attachmentIds);
            if (!idCheckInner.ok) throw new Error(`assign-attach:${idCheckInner.error}`);
            nextAttachmentIds = idCheckInner.value;
          }
          const row = {
            id: rec.id || randomUUID(),
            classId: rec.classId,
            title: String(rec.title).trim(),
            bookRef: String(rec.bookRef || '').trim(),
            instructions: String(rec.instructions || '').trim(),
            dueDateISO: rec.dueDateISO,
            requiredPageCount: Number(rec.requiredPageCount),
            attachmentIds: nextAttachmentIds,
            createdAt: rec.createdAt || prior?.createdAt || new Date().toISOString(),
          };
          if (idx >= 0) s.assignments[idx] = row;
          else s.assignments.push(row);
          return { client: { ok: true, id: row.id }, stored: { ok: true, id: row.id } };
        });
        if (!replayOut.ok) { error(res, replayOut.status, replayOut.error); return; }
        json(res, 200, replayOut.result);
      } catch (e) {
        const msg = e?.message || '';
        if (msg.startsWith('assign-attach:')) {
          error(res, 400, msg.slice('assign-attach:'.length));
          return;
        }
        throw e;
      }
      return;
    }

    if (pathname === '/api/teacher/record/submissions' && req.method === 'PUT') {
      const rec = await readJsonBody(req, 4 * 1024 * 1024);
      if (!rec?.id || !rec?.assignmentId || !rec?.studentId) {
        error(res, 400, 'Dữ liệu nộp bài không hợp lệ.');
        return;
      }
      try {
        await store.mutate(withCommitAuth(auth, (s) => {
          const idx = s.submissions.findIndex((x) => x.id === rec.id);
          if (idx < 0) {
            s.submissions.push(rec);
            return;
          }
          const merged = mergeTeacherSubmissionSave(s.submissions[idx], rec);
          if (!merged.ok) throw new Error(merged.error);
          s.submissions[idx] = merged.submission;
        }));
      } catch (e) {
        const msg = e?.message;
        if (msg === 'stale-submission' || msg === 'unknown-version') {
          error(res, 409, 'Dữ liệu nộp bài đã thay đổi — tải lại và thử lại.');
          return;
        }
        if (msg === 'session-revoked') {
          error(res, 401, 'Phiên đăng nhập không còn hợp lệ.');
          return;
        }
        throw e;
      }
      json(res, 200, { ok: true });
      return;
    }

    if (pathname === '/api/teacher/settings' && req.method === 'PUT') {
      const body = await readJsonBody(req);
      const name = String(body?.teacherName || '').trim().slice(0, 80);
      await store.mutate(withCommitAuth(auth, (s) => {
        s.settings.teacherDisplayName = name;
        if (s.teacherAccount) s.teacherAccount.displayName = name;
      }));
      json(res, 200, { ok: true });
      return;
    }

    if (pathname === '/api/teacher/accounts/students' && req.method === 'POST') {
      const bodyRaw = await readJsonBody(req);
      const { operationId, payload: body } = splitOperationId(bodyRaw);
      const studentId = body?.studentId;
      const vu = validateUsername(body?.username);
      if (!vu.ok) { error(res, 400, vu.error); return; }
      const norm = normalizeUsername(vu.value);
      const tempPass = body?.temporaryPassword
        ? String(body.temporaryPassword)
        : generateTempPassword();
      const vp = validatePassword(tempPass);
      if (!vp.ok) { error(res, 400, vp.error); return; }
      const payloadForHash = {
        studentId,
        username: vu.value,
        temporaryPassword: body?.temporaryPassword ? tempPass : null,
      };
      try {
        const replayOut = await runWithReplay(
          store,
          auth,
          'teacher.account.create',
          operationId,
          payloadForHash,
          (s) => {
            const st = s.students.find((x) => x.id === studentId);
            if (!st) throw new Error('no-student');
            if (s.studentAccounts.some((a) => a.studentId === studentId && !a.disabled)) {
              throw new Error('duplicate-student');
            }
            if (s.teacherAccount?.usernameNorm === norm) throw new Error('dup-user');
            if (s.studentAccounts.some((a) => a.usernameNorm === norm)) throw new Error('dup-user');
            const acc = {
              id: randomUUID(),
              studentId,
              username: vu.value,
              usernameNorm: norm,
              password: hashPassword(vp.value),
              mustChangePassword: true,
              disabled: false,
              sessionVersion: 0,
              createdAt: new Date().toISOString(),
            };
            s.studentAccounts.push(acc);
            return {
              client: {
                ok: true,
                username: vu.value,
                temporaryPassword: tempPass,
                accountId: acc.id,
              },
              stored: {
                ok: true,
                username: vu.value,
                accountId: acc.id,
                credentialsIssued: true,
              },
            };
          },
        );
        if (!replayOut.ok) { error(res, replayOut.status, replayOut.error); return; }
        const out = replayOut.result;
        if (out.replay && out.credentialsIssued) {
          json(res, 200, {
            ok: true,
            replay: true,
            username: out.username,
            accountId: out.accountId,
            message: 'Tài khoản đã được tạo trước đó — mật khẩu tạm chỉ hiển thị một lần.',
          });
          return;
        }
        json(res, 200, out);
      } catch (e) {
        const msg = e?.message;
        if (msg === 'no-student') {
          error(res, 400, 'Không tìm thấy học sinh.');
          return;
        }
        if (msg === 'duplicate-student') {
          error(res, 400, 'Học sinh đã có tài khoản.');
          return;
        }
        if (msg === 'dup-user') {
          error(res, 400, 'Tên đăng nhập đã được dùng.');
          return;
        }
        throw e;
      }
      return;
    }

    const accountMatch = pathname.match(/^\/api\/teacher\/accounts\/students\/([^/]+)\/(disable|reactivate|reset-password)$/);
    if (accountMatch && req.method === 'POST') {
      const accountId = accountMatch[1];
      const action = accountMatch[2];
      const bodyRaw = await readJsonBody(req);
      const { operationId } = splitOperationId(bodyRaw || {});
      if (action === 'reset-password') {
        try {
          const replayOut = await runWithReplay(
            store,
            auth,
            'teacher.account.reset-password',
            operationId,
            { accountId },
            (s) => {
              const acc = s.studentAccounts.find((a) => a.id === accountId);
              if (!acc) throw new Error('missing');
              const tp = generateTempPassword();
              acc.password = hashPassword(tp);
              acc.mustChangePassword = true;
              bumpSessionVersion(acc);
              revokeAllSessionsForAccount(s, acc.id);
              return {
                client: { ok: true, temporaryPassword: tp },
                stored: { ok: true, accountId, credentialsIssued: true },
              };
            },
          );
          if (!replayOut.ok) { error(res, replayOut.status, replayOut.error); return; }
          const out = replayOut.result;
          if (out.replay && out.credentialsIssued) {
            json(res, 200, {
              ok: true,
              replay: true,
              message: 'Mật khẩu tạm đã được cấp — chỉ hiển thị một lần.',
            });
            return;
          }
          json(res, 200, out);
        } catch (e) {
          if (e?.message === 'missing') {
            error(res, 404, 'Không tìm thấy tài khoản.');
            return;
          }
          throw e;
        }
        return;
      }
      if (action === 'reactivate') {
        try {
          const replayOut = await runWithReplay(
            store,
            auth,
            'teacher.account.reactivate',
            operationId,
            { accountId },
            (s) => {
              const acc = s.studentAccounts.find((a) => a.id === accountId);
              if (!acc) throw new Error('missing');
              if (s.studentAccounts.some((a) => a.studentId === acc.studentId && !a.disabled && a.id !== accountId)) {
                throw new Error('duplicate-student');
              }
              acc.disabled = false;
              return {
                client: { ok: true },
                stored: { ok: true, accountId },
              };
            },
          );
          if (!replayOut.ok) { error(res, replayOut.status, replayOut.error); return; }
          json(res, 200, replayOut.result);
        } catch (e) {
          if (e?.message === 'missing') {
            error(res, 404, 'Không tìm thấy tài khoản.');
            return;
          }
          if (e?.message === 'duplicate-student') {
            error(res, 400, 'Học sinh đã có tài khoản đang hoạt động.');
            return;
          }
          throw e;
        }
        return;
      }
      await store.mutate(withCommitAuth(auth, (s) => {
        const acc = s.studentAccounts.find((a) => a.id === accountId);
        if (!acc) throw new Error('missing');
        acc.disabled = true;
        bumpSessionVersion(acc);
        revokeAllSessionsForAccount(s, acc.id);
      }));
      json(res, 200, { ok: true });
      return;
    }

    if (pathname === '/api/teacher/migrate-local' && req.method === 'POST') {
      const body = await readJsonBody(req, 20 * 1024 * 1024);
      const v = validateBackup(body?.backup);
      if (!v.ok) { error(res, 400, v.error); return; }
      const liveState = await store.read();
      const migrateCheck = assessLegacyLocalMigrate(liveState, body.backup);
      if (!migrateCheck.ok) {
        json(res, 409, { ok: false, error: migrateCheck.error, conflicts: migrateCheck.conflicts });
        return;
      }
      const images = body?.images || [];
      for (const img of images) {
        if (!img?.id || !img?.dataBase64) continue;
        if (await store.readImage(img.id)) continue;
        let mime = img.mime || 'image/jpeg';
        let buf = Buffer.from(img.dataBase64, 'base64');
        let legacySandboxSvg = false;
        if (mime === 'image/svg+xml') {
          buf = sanitizeLegacySvgBuffer(buf);
          legacySandboxSvg = true;
        }
        await store.saveImage(img.id, buf, {
          id: img.id,
          mime,
          ownerAccountId: auth.account.id,
          ownerStudentId: null,
          createdAt: img.createdAt || new Date().toISOString(),
          legacySandboxSvg,
        });
      }
      const data = body.backup;
      try {
        await store.mutate(withCommitAuth(auth, (s) => {
          const migrateRecheck = assessLegacyLocalMigrate(s, data);
          if (!migrateRecheck.ok) {
            const err = new Error('migrate-conflict');
            err.migrateError = migrateRecheck.error;
            err.conflicts = migrateRecheck.conflicts;
            throw err;
          }
          applyLegacyLocalMigrateRecords(s, data);
        }));
      } catch (e) {
        if (e?.message === 'migrate-conflict') {
          json(res, 409, {
            ok: false,
            error: e.migrateError || migrateCheck.error,
            conflicts: e.conflicts || migrateCheck.conflicts || [],
          });
          return;
        }
        throw e;
      }
      json(res, 200, { ok: true });
      return;
    }

    error(res, 404, 'Không tìm thấy API.');
  }

  async function handleStudentMutation(req, res, pathname, hostHeader, cookies, auth, state) {
    if (pathname.startsWith('/api/teacher/')) {
      error(res, 403, 'Không có quyền.');
      return;
    }
    const mutating = req.method !== 'GET' && req.method !== 'HEAD';
    if (mutating && !checkMutationHeaders(req, hostHeader, cookies.bn_csrf, req.headers['x-bn-csrf'])) {
      error(res, 403, 'Yêu cầu không hợp lệ.');
      return;
    }

    async function runStudentWrite(writeAuth, fn) {
      try {
        await store.mutate(withCommitAuth(writeAuth, fn));
        return true;
      } catch (e) {
        const msg = e?.message;
        if (msg === 'session-revoked') {
          error(res, 401, 'Phiên đăng nhập không còn hợp lệ.');
          return false;
        }
        if (msg === 'cannot-revise' || msg === 'cannot-submit' || msg === 'forbidden') {
          error(res, 403, 'Không thể nộp phiên bản này.');
          return false;
        }
        if (msg === 'bad-assignment' || msg === 'missing') {
          error(res, 400, 'Dữ liệu không hợp lệ.');
          return false;
        }
        if (msg && msg.startsWith('Thiếu')) {
          error(res, 400, msg);
          return false;
        }
        throw e;
      }
    }

    if (pathname === '/api/student/submissions/draft' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const live = await loadLiveAuth(res, cookies);
      if (!live) return;
      const { auth: writeAuth, state: liveState } = live;
      const assignmentId = body?.assignmentId;
      const pageImageIds = body?.pageImageIds;
      if (!assignmentId || !Array.isArray(pageImageIds)) {
        error(res, 400, 'Dữ liệu không hợp lệ.');
        return;
      }
      for (const imgId of pageImageIds) {
        if (!canAccessImage(liveState, writeAuth, imgId)) {
          error(res, 403, 'Ảnh không hợp lệ.');
          return;
        }
      }
      const now = new Date().toISOString();
      const ok = await runStudentWrite(writeAuth, (s) => {
        const studentId = writeAuth.studentId;
        const assignment = s.assignments.find((a) => a.id === assignmentId);
        if (!assignment) throw new Error('bad-assignment');
        const student = s.students.find((x) => x.id === studentId);
        if (!student || !studentCanAccessAssignmentClass(student, assignment.classId, s.memberships || [], getNow())) throw new Error('forbidden');
        let sub = s.submissions.find((x) => x.assignmentId === assignmentId && x.studentId === studentId);
        if (!sub) {
          sub = {
            id: randomUUID(),
            assignmentId,
            studentId,
            firstSubmittedAt: null,
            versions: [],
            feedbackOpenedAt: null,
          };
          s.submissions.push(sub);
        }
        const draft = createDraftVersion({
          versionId: randomUUID(),
          pageImageIds,
          updatedAt: now,
        });
        const others = (sub.versions || []).filter((v) => !v.isDraft);
        sub.versions = [...others, draft];
      });
      if (!ok) return;
      json(res, 200, { ok: true });
      return;
    }

    if (pathname === '/api/student/submissions/submit' && req.method === 'POST') {
      const bodyRaw = await readJsonBody(req);
      const { operationId, payload: body } = splitOperationId(bodyRaw);
      const live = await loadLiveAuth(res, cookies);
      if (!live) return;
      const { auth: writeAuth, state: liveState } = live;
      const assignmentId = body?.assignmentId;
      const pageImageIds = body?.pageImageIds;
      if (!assignmentId || !Array.isArray(pageImageIds)) {
        error(res, 400, 'Dữ liệu không hợp lệ.');
        return;
      }
      for (const imgId of pageImageIds) {
        if (!canAccessImage(liveState, writeAuth, imgId)) {
          error(res, 403, 'Ảnh không hợp lệ.');
          return;
        }
      }
      const assignment = liveState.assignments.find((a) => a.id === assignmentId);
      if (!assignment) {
        error(res, 400, 'Bài tập không tồn tại.');
        return;
      }
      const pageCheck = checkMissingPages(assignment.requiredPageCount, pageImageIds.length);
      if (!pageCheck.ok) {
        error(res, 400, pageCheck.message);
        return;
      }
      const payloadForHash = { assignmentId, pageImageIds };
      const now = new Date().toISOString();
      try {
        const replayOut = await runWithReplay(
          store,
          writeAuth,
          'student.submission.submit',
          operationId,
          payloadForHash,
          (s) => {
            const studentId = writeAuth.studentId;
            const asg = s.assignments.find((a) => a.id === assignmentId);
            if (!asg) throw new Error('bad-assignment');
            const student = s.students.find((x) => x.id === studentId);
            if (!student || !studentCanAccessAssignmentClass(student, asg.classId, s.memberships || [], getNow())) throw new Error('forbidden');
            let sub = s.submissions.find((x) => x.assignmentId === assignmentId && x.studentId === studentId);
            if (!sub) {
              sub = {
                id: randomUUID(),
                assignmentId,
                studentId,
                firstSubmittedAt: null,
                versions: [],
                feedbackOpenedAt: null,
              };
              s.submissions.push(sub);
            }
            const prior = (sub.versions || []).filter((v) => !v.isDraft);
            if (!canStudentSubmitNewVersion({ versions: prior }, 'student') && prior.length) {
              const latest = prior[prior.length - 1];
              if (latest.status !== SUBMISSION_STATUS.NEEDS_REVISION) throw new Error('cannot-submit');
            }
            const version = createSubmittedVersion({
              versionId: randomUUID(),
              submittedAt: now,
              pageImageIds,
              priorVersions: prior,
            });
            sub.firstSubmittedAt = applyFirstSubmittedAt(sub.firstSubmittedAt, now);
            sub.versions = [...prior, version];
            return {
              client: { ok: true, submissionId: sub.id, versionId: version.versionId },
              stored: { ok: true, submissionId: sub.id, versionId: version.versionId },
            };
          },
        );
        if (!replayOut.ok) { error(res, replayOut.status, replayOut.error); return; }
        json(res, 200, replayOut.result);
      } catch (e) {
        const msg = e?.message;
        if (msg === 'cannot-submit' || msg === 'forbidden' || msg === 'bad-assignment') {
          error(res, 403, 'Không thể nộp phiên bản này.');
          return;
        }
        throw e;
      }
      return;
    }

    if (pathname === '/api/student/submissions/feedback-viewed' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const live = await loadLiveAuth(res, cookies);
      if (!live) return;
      const { auth: writeAuth } = live;
      const submissionId = body?.submissionId;
      const ok = await runStudentWrite(writeAuth, (s) => {
        const sub = s.submissions.find((x) => x.id === submissionId && x.studentId === writeAuth.studentId);
        if (!sub) throw new Error('missing');
        sub.feedbackOpenedAt = new Date().toISOString();
      });
      if (!ok) return;
      json(res, 200, { ok: true });
      return;
    }

    if (pathname === '/api/student/submissions/revision' && req.method === 'POST') {
      const bodyRaw = await readJsonBody(req);
      const { operationId, payload: body } = splitOperationId(bodyRaw);
      const live = await loadLiveAuth(res, cookies);
      if (!live) return;
      const { auth: writeAuth, state: liveState } = live;
      const assignmentId = body?.assignmentId;
      const pageImageIds = body?.pageImageIds;
      if (!assignmentId || !Array.isArray(pageImageIds)) {
        error(res, 400, 'Dữ liệu không hợp lệ.');
        return;
      }
      for (const imgId of pageImageIds) {
        if (!canAccessImage(liveState, writeAuth, imgId)) {
          error(res, 403, 'Ảnh không hợp lệ.');
          return;
        }
      }
      const assignment = liveState.assignments.find((a) => a.id === assignmentId);
      if (!assignment) {
        error(res, 400, 'Bài tập không tồn tại.');
        return;
      }
      const payloadForHash = { assignmentId, pageImageIds };
      const replayPeek = lookupOperationReplay(
        liveState,
        writeAuth,
        'student.submission.revision',
        operationId,
        payloadForHash,
      );
      if (replayPeek.kind !== 'replay') {
        const denial = getStudentRevisionForbiddenReason(
          liveState,
          writeAuth.studentId,
          assignmentId,
        );
        if (denial === 'bad-assignment') {
          error(res, 400, 'Bài tập không tồn tại.');
          return;
        }
        if (denial === 'cannot-revise' || denial === 'forbidden') {
          error(res, 403, 'Không thể nộp phiên bản này.');
          return;
        }
      }
      const pageCheck = checkMissingPages(assignment.requiredPageCount, pageImageIds.length);
      if (!pageCheck.ok) {
        error(res, 400, pageCheck.message);
        return;
      }
      const now = new Date().toISOString();
      try {
        const replayOut = await runWithReplay(
          store,
          writeAuth,
          'student.submission.revision',
          operationId,
          payloadForHash,
          (s) => {
            const studentId = writeAuth.studentId;
            const denial = getStudentRevisionForbiddenReason(s, studentId, assignmentId);
            if (denial === 'cannot-revise' || denial === 'forbidden') {
              throw new Error(denial);
            }
            if (denial === 'bad-assignment') throw new Error('bad-assignment');
            const student = s.students.find((x) => x.id === studentId);
            const asg = s.assignments.find((a) => a.id === assignmentId);
            if (!student || !asg) throw new Error('bad-assignment');
            if (!studentCanAccessAssignmentClass(student, asg.classId, s.memberships || [], getNow())) throw new Error('forbidden');
            let sub = s.submissions.find((x) => x.assignmentId === assignmentId && x.studentId === studentId);
            if (!sub) throw new Error('forbidden');
            const prior = (sub.versions || []).filter((v) => !v.isDraft);
            if (!prior.length) throw new Error('cannot-revise');
            const latest = prior[prior.length - 1];
            if (latest.status !== SUBMISSION_STATUS.NEEDS_REVISION) throw new Error('cannot-revise');
            const version = createSubmittedVersion({
              versionId: randomUUID(),
              submittedAt: now,
              pageImageIds,
              priorVersions: prior,
            });
            sub.versions = [...prior, version];
            return {
              client: { ok: true, submissionId: sub.id, versionId: version.versionId },
              stored: { ok: true, submissionId: sub.id, versionId: version.versionId },
            };
          },
        );
        if (!replayOut.ok) { error(res, replayOut.status, replayOut.error); return; }
        json(res, 200, replayOut.result);
      } catch (e) {
        const msg = e?.message;
        if (msg === 'bad-assignment') {
          error(res, 400, 'Bài tập không tồn tại.');
          return;
        }
        if (msg === 'cannot-revise' || msg === 'forbidden') {
          error(res, 403, 'Không thể nộp phiên bản này.');
          return;
        }
        throw e;
      }
      return;
    }

    error(res, 404, 'Không tìm thấy API.');
  }

  return {
    server,
    store,
    host,
    loginLimiter,
    setupLimiter,
    reminderWorker,
    examStartupReady,
    shutdownServices() {
      shutdownRequested = true;
      reminderWorker.stop();
      shutdownExamWorkersForStore(store);
    },
    async closeStore() {
      if (typeof store.close === 'function') {
        await store.close();
      }
    },
  };
}

function serveStatic(req, res, pathname, distDir) {
  let rel;
  try {
    rel = decodeURIComponent(pathname).replace(/^\/+/, '') || 'index.html';
  } catch {
    error(res, 400, 'Bad request');
    return;
  }
  if (rel.endsWith('/')) rel += 'index.html';
  const resolved = path.normalize(path.join(distDir, rel));
  const relToDist = path.relative(distDir, resolved);
  if (relToDist.startsWith('..') || path.isAbsolute(relToDist)) {
    error(res, 403, 'Forbidden');
    return;
  }
  fs.readFile(resolved, (err, data) => {
    if (err) {
      if (err.code === 'ENOENT') {
        fs.readFile(path.join(distDir, 'index.html'), (e2, indexData) => {
          if (e2) { error(res, 404, 'Not found'); return; }
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(indexData);
        });
        return;
      }
      error(res, 404, 'Not found');
      return;
    }
    const ext = path.extname(resolved).toLowerCase();
    const MIME = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
    };
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}
