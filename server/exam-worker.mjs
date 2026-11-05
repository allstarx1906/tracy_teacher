import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { EXAM_JOB_STATUS } from '../dist/exam-domain.js';
import { examContentDigest } from './exam-extract.mjs';
import { findExamImportJob } from './exam-state.mjs';

const WORKER_FILE = fileURLToPath(new URL('./exam-pdf-thread.mjs', import.meta.url));
const JOB_TIMEOUT_MS = 5 * 60_000;

/** @type {Set<string>} */
const activeWorkerKeys = new Set();
/** @type {Map<string, boolean>} */
const storeShutdownFlags = new Map();
/** @type {Map<string, Set<Worker>>} */
const storeWorkers = new Map();

function workerKey(store, jobId) {
  return `${store.dataDir}\0${jobId}`;
}

function trackWorker(store, worker) {
  let set = storeWorkers.get(store.dataDir);
  if (!set) {
    set = new Set();
    storeWorkers.set(store.dataDir, set);
  }
  set.add(worker);
  worker.once('exit', () => {
    set.delete(worker);
  });
}

export function shutdownExamWorkersForStore(store) {
  if (!store?.dataDir) return;
  storeShutdownFlags.set(store.dataDir, true);
  const workers = storeWorkers.get(store.dataDir);
  if (workers) {
    for (const w of workers) {
      w.terminate().catch(() => {});
    }
    workers.clear();
  }
}

function isStoreShutdown(store) {
  return !!storeShutdownFlags.get(store.dataDir);
}

export function markInterruptedJobs(state) {
  for (const job of state.examImports || []) {
    if ([
      EXAM_JOB_STATUS.QUEUED,
      EXAM_JOB_STATUS.EXTRACTING,
      EXAM_JOB_STATUS.PARSING,
    ].includes(job.status)) {
      job.status = EXAM_JOB_STATUS.INTERRUPTED;
      job.error = 'Quá trình bị gián đoạn — thử lại.';
      job.updatedAt = new Date().toISOString();
    }
  }
}

export function scheduleExamImportProcessing(store, jobId, getNow) {
  if (isStoreShutdown(store)) return;
  const key = workerKey(store, jobId);
  if (activeWorkerKeys.has(key)) return;
  activeWorkerKeys.add(key);
  setImmediate(() => {
    processExamImportJob(store, jobId, getNow)
      .catch((e) => console.error('exam import job failed', jobId, e?.message || e))
      .finally(() => activeWorkerKeys.delete(key));
  });
}

function formatPdfExtractError(e) {
  const msg = e?.message;
  if (msg === 'page-out-of-range') return 'Phạm vi trang không hợp lệ.';
  if (msg === 'page-timeout') return 'Trích xuất quá thời gian (60s/trang).';
  if (msg && msg !== 'Không phân tích được PDF.') {
    return `Không phân tích được PDF (${msg}).`;
  }
  return 'Không phân tích được PDF.';
}

function runBuildDraftInWorker(store, buffer, options, timeoutMs = JOB_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_FILE, {
      workerData: {
        bufferBase64: buffer.toString('base64'),
        options,
      },
    });
    trackWorker(store, worker);
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      worker.terminate().catch(() => {});
      reject(new Error('page-timeout'));
    }, timeoutMs);
    worker.on('message', (msg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate().catch(() => {});
      if (msg.ok) resolve(msg.result);
      else reject(new Error(msg.error || 'extract-failed'));
    });
    worker.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate().catch(() => {});
      reject(err);
    });
    worker.on('exit', (code) => {
      if (settled) return;
      if (code !== 0) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(`worker-exit-${code}`));
      }
    });
  });
}

async function processExamImportJob(store, jobId, getNow) {
  if (isStoreShutdown(store)) return;

  let buffer;
  let jobSnapshot;
  await store.mutate((s) => {
    const job = findExamImportJob(s, jobId);
    if (!job || job.status === EXAM_JOB_STATUS.CANCELLED) return;
    job.status = EXAM_JOB_STATUS.EXTRACTING;
    job.stage = 'extracting';
    job.progress = 0.1;
    job.updatedAt = getNow();
    jobSnapshot = { ...job };
  });
  if (!jobSnapshot || isStoreShutdown(store)) return;

  buffer = await store.readAttachment(jobSnapshot.sourceAttachmentId);
  if (!buffer) {
    if (isStoreShutdown(store)) return;
    await store.mutate((s) => {
      const job = findExamImportJob(s, jobId);
      if (!job) return;
      job.status = EXAM_JOB_STATUS.FAILED;
      job.error = 'Không đọc được tệp PDF.';
      job.updatedAt = getNow();
    });
    return;
  }

  if (isStoreShutdown(store)) return;

  await store.mutate((s) => {
    const job = findExamImportJob(s, jobId);
    if (!job || job.status === EXAM_JOB_STATUS.CANCELLED) return;
    job.status = EXAM_JOB_STATUS.PARSING;
    job.stage = 'parsing';
    job.progress = 0.5;
    job.updatedAt = getNow();
  });

  let draftPayload;
  try {
    draftPayload = await runBuildDraftInWorker(store, buffer, {
      questionPages: jobSnapshot.questionPages,
      keyPages: jobSnapshot.keyPages,
      allPages: jobSnapshot.allPages,
      title: jobSnapshot.titleHint || undefined,
      pageTimeoutMs: 60_000,
    });
  } catch (e) {
    if (isStoreShutdown(store)) return;
    const msg = formatPdfExtractError(e);
    await store.mutate((s) => {
      const job = findExamImportJob(s, jobId);
      if (!job) return;
      job.status = EXAM_JOB_STATUS.FAILED;
      job.error = msg;
      job.updatedAt = getNow();
    });
    return;
  }

  if (isStoreShutdown(store)) return;

  await store.mutate((s) => {
    const job = findExamImportJob(s, jobId);
    if (!job || job.status === EXAM_JOB_STATUS.CANCELLED) return;
    const existingDraft = job.draftId ? s.examDrafts.find((d) => d.id === job.draftId) : null;
    const draftId = existingDraft?.id || randomUUID();
    const draft = {
      id: draftId,
      teacherAccountId: job.teacherAccountId,
      importJobId: job.id,
      sourceAttachmentId: job.sourceAttachmentId,
      contentDigest: job.contentDigest,
      createdAt: existingDraft?.createdAt || getNow(),
      updatedAt: getNow(),
      ...draftPayload,
    };
    if (existingDraft) {
      if (existingDraft.manuallyEdited && !job.overwriteConfirmed) {
        job.status = EXAM_JOB_STATUS.NEEDS_REVIEW;
        job.draftId = draftId;
        job.warnings = ['Bản nháp đã chỉnh tay — không ghi đè tự động.'];
        job.progress = 1;
        job.updatedAt = getNow();
        return;
      }
      Object.assign(existingDraft, draft);
    } else {
      s.examDrafts.push(draft);
    }
    job.draftId = draftId;
    job.warnings = draftPayload.warnings || [];
    job.needsOcr = !!draftPayload.needsOcr;
    job.status = draftPayload.needsOcr
      ? EXAM_JOB_STATUS.NEEDS_REVIEW
      : (draftPayload.questions?.length ? EXAM_JOB_STATUS.READY : EXAM_JOB_STATUS.NEEDS_REVIEW);
    job.progress = 1;
    job.stage = 'done';
    job.updatedAt = getNow();
  });
}

export function createImportJobRecord({
  teacherAccountId,
  sourceAttachmentId,
  contentDigest,
  questionPages,
  keyPages,
  allPages,
  titleHint,
  getNow,
}) {
  return {
    id: randomUUID(),
    teacherAccountId,
    sourceAttachmentId,
    contentDigest,
    questionPages,
    keyPages,
    allPages,
    titleHint: titleHint || null,
    status: EXAM_JOB_STATUS.QUEUED,
    stage: 'queued',
    progress: 0,
    draftId: null,
    warnings: [],
    needsOcr: false,
    error: null,
    overwriteConfirmed: false,
    createdAt: getNow(),
    updatedAt: getNow(),
  };
}

export function findExistingImportByDigest(state, teacherAccountId, digest, questionPages, keyPages) {
  return (state.examImports || []).find((j) => j.teacherAccountId === teacherAccountId
    && j.contentDigest === digest
    && JSON.stringify(j.questionPages) === JSON.stringify(questionPages)
    && JSON.stringify(j.keyPages || []) === JSON.stringify(keyPages || [])
    && j.status !== EXAM_JOB_STATUS.CANCELLED);
}

export { examContentDigest };
