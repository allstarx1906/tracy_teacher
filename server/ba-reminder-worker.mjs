import {
  REMINDER_JOB_STATUS,
  REMINDER_TYPE,
  SESSION_STATUS,
  buildNotificationContent,
  buildReminderJobId,
  buildSessionRecipientRoster,
  computeReminderDueAt,
  resolveSessionReminderConfig,
  runMockSend,
  sessionRevisionKey,
  BATCH_RECIPIENT_STATUS,
  MOCK_PROVIDER_LABEL,
  parseIso,
} from '../dist/ba-domain.js';
import { randomUUID } from 'node:crypto';

/** Small grace beyond poll interval — jobs due longer ago are overdue (no catch-up). */
export const REMINDER_LATENESS_GRACE_MS = 5_000;

/** Allowed lateness for auto-dispatch: polling interval + grace (documented, testable). */
export function reminderLatenessWindowMs(pollingWindowMs = 60_000) {
  return pollingWindowMs + REMINDER_LATENESS_GRACE_MS;
}

/**
 * @param {{ store: object, getNow?: () => string, windowMs?: number, latenessWindowMs?: number }} opts
 */
export function startBaReminderWorker({
  store,
  getNow = () => new Date().toISOString(),
  windowMs = 60_000,
  latenessWindowMs = reminderLatenessWindowMs(windowMs),
}) {
  let timer = null;
  let stopped = false;

  async function tick() {
    if (stopped) return;
    const now = getNow();
    await store.mutate((state) => {
      runReminderTick(state, now, getNow, { latenessWindowMs });
    });
  }

  function start() {
    store.mutate((state) => startupOverdueRecovery(state, getNow(), latenessWindowMs)).catch(console.error);
    tick().catch(console.error);
    timer = setInterval(() => tick().catch(console.error), windowMs);
    if (timer.unref) timer.unref();
  }

  function stop() {
    stopped = true;
    if (timer) clearInterval(timer);
  }

  return { start, stop, tick };
}

/** On server boot: mark past-due pending jobs overdue without dispatch (no catch-up burst). */
export function startupOverdueRecovery(state, nowIso, latenessWindowMs = reminderLatenessWindowMs()) {
  flagOverdueJobs(state, nowIso, latenessWindowMs);
}

export function msSinceDue(job, nowIso) {
  const nowMs = parseIso(nowIso)?.getTime();
  const dueMs = parseIso(job.dueAt)?.getTime();
  if (nowMs == null || dueMs == null) return null;
  return nowMs - dueMs;
}

export function flagOverdueJobs(state, nowIso, latenessWindowMs = reminderLatenessWindowMs()) {
  for (const job of state.reminderJobs || []) {
    if (job.status !== REMINDER_JOB_STATUS.PENDING) continue;
    if (!job.dueAt) continue;
    const lag = msSinceDue(job, nowIso);
    if (lag == null || lag <= 0) continue;
    if (lag > latenessWindowMs) {
      job.status = REMINDER_JOB_STATUS.OVERDUE;
      job.overdueSince = job.overdueSince || nowIso;
    }
  }
}

export function runReminderTick(state, nowIso, getNow, { includeOverdue = false, latenessWindowMs = reminderLatenessWindowMs() } = {}) {
  flagOverdueJobs(state, nowIso, latenessWindowMs);
  processDueJobs(state, nowIso, getNow, { includeOverdue, latenessWindowMs });
}

export function processDueJobs(state, nowIso, getNow, { includeOverdue = false, latenessWindowMs = reminderLatenessWindowMs() } = {}) {
  const due = (state.reminderJobs || []).filter((j) => {
    if (!j.dueAt) return false;
    const lag = msSinceDue(j, nowIso);
    if (lag == null || lag < 0) return false;
    if (j.status === REMINDER_JOB_STATUS.PENDING) {
      return lag <= latenessWindowMs;
    }
    if (includeOverdue && j.status === REMINDER_JOB_STATUS.OVERDUE) return true;
    return false;
  });
  for (const job of due) {
    const session = state.classSessions?.find((s) => s.id === job.sessionId);
    if (!session || session.status === SESSION_STATUS.CANCELLED) {
      job.status = REMINDER_JOB_STATUS.CANCELLED;
      continue;
    }
    if (sessionRevisionKey(session) !== job.sessionRevisionKey) {
      job.status = REMINDER_JOB_STATUS.CANCELLED;
      continue;
    }
    if (job.status === REMINDER_JOB_STATUS.PROCESSING) continue;
    job.status = REMINDER_JOB_STATUS.PROCESSING;
    executeAutoBatch(state, job, session, getNow);
    job.status = REMINDER_JOB_STATUS.DONE;
    job.processedAt = getNow();
  }
}

function executeAutoBatch(state, job, session, getNow) {
  const cls = state.classes?.find((c) => c.id === session.classId);
  const { recipients, skipped } = buildSessionRecipientRoster(state, session);
  const content = buildNotificationContent(session, cls, job.type || REMINDER_TYPE.SESSION_REMINDER);
  const batchId = randomUUID();
  const batch = {
    id: batchId,
    sessionId: session.id,
    jobId: job.id,
    type: job.type || REMINDER_TYPE.SESSION_REMINDER,
    createdAt: getNow(),
    contentSnapshot: content,
    provider: 'mock',
    mode: 'auto',
    mockLabel: MOCK_PROVIDER_LABEL,
    recipientsSnapshot: [...recipients, ...skipped.map((s) => ({ ...s, skipped: true }))],
  };
  state.notificationBatches.push(batch);
  const attemptId = randomUUID();
  const results = runMockSend(recipients, 'all-success');
  for (const r of results) {
    state.notificationAttempts.push({
      id: randomUUID(),
      batchId,
      attemptId,
      canonicalKey: r.canonicalKey,
      status: r.status,
      error: r.error,
      at: r.at,
      auto: true,
    });
  }
  for (const sk of skipped) {
    state.notificationAttempts.push({
      id: randomUUID(),
      batchId,
      attemptId,
      canonicalKey: sk.canonicalKey,
      status: BATCH_RECIPIENT_STATUS.SKIPPED,
      error: sk.skipReason,
      at: getNow(),
      auto: true,
    });
  }
}

export function rebuildSessionReminderJobs(state, session, getNow = () => new Date().toISOString()) {
  cancelPendingJobsForSession(state, session.id);
  if (session.status === SESSION_STATUS.CANCELLED) return;
  const cls = state.classes?.find((c) => c.id === session.classId);
  const cfg = resolveSessionReminderConfig(session, cls);
  if (!cfg.enabled) return;
  const dueAt = computeReminderDueAt(session.startAt, cfg.offsetMinutes);
  if (!dueAt) return;
  const rev = session.revision ?? 0;
  const now = getNow();
  const lag = msSinceDue({ dueAt }, now);
  let status = REMINDER_JOB_STATUS.PENDING;
  if (lag != null && lag > reminderLatenessWindowMs()) {
    status = REMINDER_JOB_STATUS.OVERDUE;
  }
  const job = {
    id: buildReminderJobId(session.id, REMINDER_TYPE.SESSION_REMINDER, rev),
    sessionId: session.id,
    type: REMINDER_TYPE.SESSION_REMINDER,
    sessionRevisionKey: sessionRevisionKey(session),
    revision: rev,
    dueAt,
    status,
    createdAt: now,
  };
  if (status === REMINDER_JOB_STATUS.OVERDUE) job.overdueSince = now;
  const existing = state.reminderJobs?.find((j) => j.id === job.id);
  if (existing?.status === REMINDER_JOB_STATUS.DONE) return;
  if (existing) {
    Object.assign(existing, job);
    return;
  }
  state.reminderJobs.push(job);
}

export function cancelPendingJobsForSession(state, sessionId) {
  for (const job of state.reminderJobs || []) {
    if (job.sessionId !== sessionId) continue;
    if (job.status === REMINDER_JOB_STATUS.PENDING || job.status === REMINDER_JOB_STATUS.OVERDUE) {
      job.status = REMINDER_JOB_STATUS.CANCELLED;
    }
  }
}
