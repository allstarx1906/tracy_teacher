/**
 * Pure domain logic for Bài Nhà (local demo).
 */

export const SUBMISSION_STATUS = Object.freeze({
  DRAFT: 'draft',
  SUBMITTED: 'submitted',
  GRADING: 'grading',
  RETURNED: 'returned',
  NEEDS_REVISION: 'needs-revision',
});

export const MAX_SCORE = 10;
export const MIN_SCORE = 0;
export const MAX_DIRECT_TEXT_LENGTH = 2000;

/** @param {unknown} score */
export function validateScore(score) {
  if (score === null || score === undefined || score === '') {
    return { ok: false, error: 'Điểm không được để trống.' };
  }
  const n = Number(score);
  if (!Number.isFinite(n)) {
    return { ok: false, error: 'Điểm phải là số.' };
  }
  if (n < MIN_SCORE || n > MAX_SCORE) {
    return { ok: false, error: `Điểm phải từ ${MIN_SCORE} đến ${MAX_SCORE}.` };
  }
  return { ok: true, value: Math.round(n * 10) / 10 };
}

/**
 * On-time if first final submission is on or before due date (end of due day local).
 * @param {string|null} firstSubmittedAt ISO
 * @param {string} dueDateISO date-only or full ISO
 */
export function classifyDeadlineTiming(firstSubmittedAt, dueDateISO) {
  if (!firstSubmittedAt) {
    return { onTime: false, late: false, missing: true };
  }
  const dueEnd = deadlineInstant(dueDateISO);
  const first = new Date(firstSubmittedAt);
  if (Number.isNaN(first.getTime()) || !dueEnd || Number.isNaN(dueEnd.getTime())) {
    return { onTime: false, late: true, missing: false };
  }
  const onTime = first.getTime() <= dueEnd.getTime();
  return { onTime, late: !onTime, missing: false };
}

function endOfLocalDay(iso) {
  const [y, m, day] = String(iso).slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, day, 23, 59, 59, 999);
}

/** Date-only due → end of local day; datetime due → exact instant. */
function deadlineInstant(dueDateISO) {
  if (!dueDateISO) return null;
  const trimmed = String(dueDateISO).trim();
  if (trimmed.length <= 10) {
    return endOfLocalDay(trimmed);
  }
  if (/T\d/.test(trimmed)) {
    const d = new Date(trimmed);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return endOfLocalDay(trimmed);
}

/**
 * @param {number} requiredPageCount
 * @param {number} pageCount
 */
export function checkMissingPages(requiredPageCount, pageCount) {
  const required = Math.max(0, Number(requiredPageCount) || 0);
  const have = Math.max(0, Number(pageCount) || 0);
  if (have < required) {
    return {
      ok: false,
      missing: required - have,
      message: `Thiếu ${required - have} trang (cần ${required}, đã có ${have}).`,
    };
  }
  return { ok: true, missing: 0, message: '' };
}

/**
 * Student-visible grading only when published.
 * @param {{ published?: boolean, publishedAt?: string|null }} grading
 * @param {'teacher'|'student'} viewerRole
 */
export function getPublishedGrading(grading, viewerRole) {
  if (!grading) return null;
  if (viewerRole === 'teacher') return grading;
  if (grading.published) {
    return {
      score: grading.score,
      overallFeedback: grading.overallFeedback,
      pages: grading.pages,
      publishedAt: grading.publishedAt,
      needsRevision: grading.needsRevision === true,
    };
  }
  return null;
}

/** Student API snapshot: published fields plus flag so clients do not double-project. */
export function projectStudentVersionGrading(grading) {
  const pub = getPublishedGrading(grading, 'student');
  if (!pub) return null;
  return { ...pub, published: true };
}

/** Resolve student-visible grading from server snapshot or full teacher grading. */
export function resolveStudentPublishedGrading(grading) {
  if (!grading) return null;
  if (grading.published === false) return null;
  if (grading.published === true) return getPublishedGrading(grading, 'student');
  if (grading.score !== undefined && grading.score !== null) {
    return {
      score: grading.score,
      overallFeedback: grading.overallFeedback,
      pages: grading.pages,
      publishedAt: grading.publishedAt,
      needsRevision: grading.needsRevision === true,
    };
  }
  return null;
}

/**
 * Whether student may start a new revision after needs-revision.
 */
export function canStudentSubmitNewVersion(submission, viewerRole) {
  if (viewerRole !== 'student') return false;
  if (!submission?.versions?.length) return true;
  const latest = submission.versions[submission.versions.length - 1];
  if (latest.isDraft) return true;
  return latest.status === SUBMISSION_STATUS.NEEDS_REVISION;
}

/**
 * Returns a denial code when a student may not POST /submissions/revision, else null.
 * Mirrors the mutation guard inside the revision replay transaction.
 */
export function getStudentRevisionForbiddenReason(state, studentId, assignmentId, atIso = new Date().toISOString()) {
  const student = state.students?.find((x) => x.id === studentId);
  const asg = state.assignments?.find((a) => a.id === assignmentId);
  if (!student || !asg) return 'bad-assignment';
  if (!studentCanAccessAssignmentClassClient(student, asg.classId, state.memberships || null, atIso)) {
    return 'forbidden';
  }
  const sub = state.submissions?.find(
    (x) => x.assignmentId === assignmentId && x.studentId === studentId,
  );
  if (!sub) return 'forbidden';
  const prior = (sub.versions || []).filter((v) => !v.isDraft);
  if (!prior.length) return 'cannot-revise';
  const latest = prior[prior.length - 1];
  if (latest.status !== SUBMISSION_STATUS.NEEDS_REVISION) return 'cannot-revise';
  return null;
}

/**
 * SHA-256 of blob bytes (canonical stored image bytes, not client-supplied digests).
 * @param {Blob} blob
 */
export async function blobContentFingerprint(blob) {
  if (blob && typeof blob.arrayBuffer === 'function' && globalThis.crypto?.subtle) {
    const buf = await blob.arrayBuffer();
    const digest = await crypto.subtle.digest('SHA-256', buf);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  return `size:${Number(blob?.size) || 0}`;
}

/**
 * Compress/store student photos in parallel but append ids in file input order.
 * Content duplicates (batch + reservedFingerprints) are skipped with onDuplicateFile.
 *
 * @param {File[]} files
 * @param {object} opts
 * @param {(file: File) => { ok: boolean, error?: string }} opts.validateFile
 * @param {(file: File) => Promise<{ fingerprint: string, blob?: Blob, [key: string]: unknown }>} opts.prepareFile
 * @param {(prepared: object, file: File, initiatingContext: object) => Promise<string>} opts.uploadPrepared
 * @param {(msg: string) => void} opts.onFileError
 * @param {(file: File) => void} [opts.onDuplicateFile]
 * @param {Set<string>} [opts.reservedFingerprints]
 * @param {object} [opts.initiatingContext] frozen epoch/principal/view captured before any async prep
 * @param {(ctx: object) => boolean} [opts.isInitiatingContextStale]
 * @returns {{ jobs: Promise<void>[], applyResultsTo(pageIds: string[]) => Promise<void> }}
 */
export function buildStudentPhotoUploadJobs(files, {
  validateFile,
  prepareFile,
  uploadPrepared,
  onFileError,
  onDuplicateFile,
  reservedFingerprints = new Set(),
  initiatingContext = null,
  isInitiatingContextStale = () => false,
}) {
  const orderedIds = new Array(files.length).fill(null);
  const jobs = [];
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const v = validateFile(file);
    if (!v.ok) {
      onFileError(v.error);
      continue;
    }
    const index = i;
    jobs.push(
      (async () => {
        let fp = null;
        try {
          if (isInitiatingContextStale(initiatingContext)) return;
          const prepared = await prepareFile(file);
          if (isInitiatingContextStale(initiatingContext)) return;
          fp = prepared.fingerprint;
          if (!fp) {
            onFileError('Không đọc được ảnh.');
            return;
          }
          if (reservedFingerprints.has(fp)) {
            onDuplicateFile?.(file);
            return;
          }
          reservedFingerprints.add(fp);
          if (isInitiatingContextStale(initiatingContext)) {
            reservedFingerprints.delete(fp);
            return;
          }
          orderedIds[index] = await uploadPrepared(prepared, file, initiatingContext);
        } catch (e) {
          if (fp) reservedFingerprints.delete(fp);
          if (e?.staleAuth) return;
          onFileError('Không đọc được ảnh.');
        }
      })(),
    );
  }
  return {
    jobs,
    async applyResultsTo(pageIds) {
      await waitForInFlightUploads(jobs);
      if (isInitiatingContextStale(initiatingContext)) return;
      for (const id of orderedIds) {
        if (id) pageIds.push(id);
      }
    },
  };
}

const TEACHER_VERSION_STATUSES = new Set([
  SUBMISSION_STATUS.SUBMITTED,
  SUBMISSION_STATUS.GRADING,
  SUBMISSION_STATUS.RETURNED,
  SUBMISSION_STATUS.NEEDS_REVISION,
]);

function mergeTeacherVersionFields(serverVer, incomingVer) {
  let status = serverVer.status;
  if (incomingVer?.status && TEACHER_VERSION_STATUSES.has(incomingVer.status)) {
    status = incomingVer.status;
  }
  return {
    ...serverVer,
    pageImageIds: [...(serverVer.pageImageIds || [])],
    versionNumber: serverVer.versionNumber,
    submittedAt: serverVer.submittedAt,
    isDraft: false,
    status,
    grading: incomingVer?.grading !== undefined ? incomingVer.grading : serverVer.grading,
    teacherGrading:
      incomingVer?.teacherGrading !== undefined ? incomingVer.teacherGrading : serverVer.teacherGrading,
    feedbackOpenedAt: serverVer.feedbackOpenedAt,
  };
}

/**
 * Merge teacher grading saves without dropping newer student versions.
 * Rejects stale payloads that omit server-side submitted versions.
 */
export function mergeTeacherSubmissionSave(existing, incoming) {
  if (!incoming || typeof incoming !== 'object') {
    return { ok: false, error: 'invalid-payload' };
  }
  if (!existing) {
    return { ok: true, submission: incoming };
  }
  if (incoming.id !== existing.id) return { ok: false, error: 'id-mismatch' };
  if (incoming.assignmentId !== existing.assignmentId || incoming.studentId !== existing.studentId) {
    return { ok: false, error: 'immutable-field' };
  }

  const serverNonDraft = (existing.versions || []).filter((v) => !v.isDraft);
  const incomingNonDraft = (incoming.versions || []).filter((v) => !v.isDraft);
  const incomingById = new Map(incomingNonDraft.map((v) => [v.versionId, v]));

  for (const sv of serverNonDraft) {
    if (!incomingById.has(sv.versionId)) {
      return { ok: false, error: 'stale-submission', stale: true };
    }
  }
  for (const iv of incomingNonDraft) {
    if (!serverNonDraft.some((sv) => sv.versionId === iv.versionId)) {
      return { ok: false, error: 'unknown-version', stale: true };
    }
  }

  const mergedNonDraft = serverNonDraft.map((sv) =>
    mergeTeacherVersionFields(sv, incomingById.get(sv.versionId)),
  );
  const serverDrafts = (existing.versions || []).filter((v) => v.isDraft);

  return {
    ok: true,
    submission: {
      ...existing,
      firstSubmittedAt: existing.firstSubmittedAt ?? incoming.firstSubmittedAt ?? null,
      feedbackOpenedAt: existing.feedbackOpenedAt ?? incoming.feedbackOpenedAt ?? null,
      versions: [...mergedNonDraft, ...serverDrafts],
    },
  };
}

/**
 * Record first submit timestamp (never overwrite on resubmit).
 * @param {string|null} existingFirst
 * @param {string} nowISO
 */
export function applyFirstSubmittedAt(existingFirst, nowISO) {
  if (existingFirst) return existingFirst;
  return nowISO;
}

/**
 * Build new version on final submit; prior versions immutable.
 */
export function createSubmittedVersion({
  versionId,
  submittedAt,
  pageImageIds,
  priorVersions,
}) {
  const versionNumber = (priorVersions?.length || 0) + 1;
  return {
    versionId,
    versionNumber,
    submittedAt,
    isDraft: false,
    pageImageIds: [...pageImageIds],
    status: SUBMISSION_STATUS.SUBMITTED,
    grading: null,
    feedbackOpenedAt: null,
  };
}

export function createDraftVersion({ versionId, pageImageIds, updatedAt }) {
  return {
    versionId,
    versionNumber: 0,
    submittedAt: null,
    isDraft: true,
    pageImageIds: [...pageImageIds],
    status: SUBMISSION_STATUS.DRAFT,
    grading: null,
    updatedAt,
  };
}

/** Normalized annotation coords 0..1 */
export function normalizePoint(x, y, width, height) {
  const w = width || 1;
  const h = height || 1;
  return {
    x: clamp01(x / w),
    y: clamp01(y / h),
  };
}

export function denormalizePoint(nx, ny, width, height) {
  return {
    x: clamp01(nx) * width,
    y: clamp01(ny) * height,
  };
}

export function clamp01(v) {
  return Math.min(1, Math.max(0, Number(v) || 0));
}

/** Resize-safe: update mark geometry from normalized storage */
export function scaleMarkToViewport(mark, width, height) {
  const w = width || 1;
  const h = height || 1;
  switch (mark.type) {
    case 'check':
    case 'cross':
    case 'pin':
      return {
        ...mark,
        x: mark.nx * w,
        y: mark.ny * h,
      };
    case 'highlight':
      return {
        ...mark,
        x: mark.nx * w,
        y: mark.ny * h,
        w: mark.nw * w,
        h: mark.nh * h,
      };
    case 'text':
      return {
        ...mark,
        x: mark.nx * w,
        y: mark.ny * h,
        fontSize: (mark.fontSizeNorm ?? mark.nfs ?? 0.03) * h,
        text: mark.text || '',
        color: mark.color || '#c62828',
      };
    case 'pen':
      return {
        ...mark,
        points: (mark.points || []).map((p) => ({
          x: p.nx * w,
          y: p.ny * h,
        })),
        strokeWidth: (mark.nw ?? 0.004) * w,
        color: mark.color || '#c62828',
      };
    default:
      return mark;
  }
}

export function markToNormalized(mark, width, height) {
  const w = width || 1;
  const h = height || 1;
  switch (mark.type) {
    case 'check':
    case 'cross':
    case 'pin':
      return {
        ...mark,
        nx: clamp01(mark.x / w),
        ny: clamp01(mark.y / h),
      };
    case 'highlight':
      return {
        ...mark,
        nx: clamp01(mark.x / w),
        ny: clamp01(mark.y / h),
        nw: clamp01(mark.w / w),
        nh: clamp01(mark.h / h),
      };
    case 'text':
      return {
        ...mark,
        nx: clamp01(mark.x / w),
        ny: clamp01(mark.y / h),
        fontSizeNorm: mark.fontSizeNorm ?? (mark.fontSize ? mark.fontSize / h : 0.03),
      };
    case 'pen':
      return {
        ...mark,
        nw: mark.nw ?? (mark.strokeWidth ? mark.strokeWidth / w : 0.004),
        points: (mark.points || []).map((p) => {
          if (p.nx != null && p.ny != null) {
            return { nx: clamp01(p.nx), ny: clamp01(p.ny) };
          }
          return {
            nx: clamp01(p.x / w),
            ny: clamp01(p.y / h),
          };
        }),
      };
    default:
      return mark;
  }
}

export const MARK_INK_COLORS = Object.freeze([
  { id: 'red', value: '#c62828', label: 'Đỏ' },
  { id: 'blue', value: '#1565c0', label: 'Xanh dương' },
  { id: 'green', value: '#2e7d32', label: 'Xanh lá' },
  { id: 'black', value: '#212121', label: 'Đen' },
]);

export const PEN_STROKE_PRESETS = Object.freeze({
  thin: 0.0025,
  medium: 0.004,
  thick: 0.007,
});

export const DIRECT_TEXT_SIZES = Object.freeze([16, 20, 24]);

export const DIRECT_TEXT_FONT_FAMILY = 'system-ui, "Segoe UI", sans-serif';

export const MAX_PEN_POINTS = 600;

const VALID_MARK_TYPES = new Set([
  'check',
  'cross',
  'pin',
  'highlight',
  'pen',
  'text',
]);

const VALID_INK = new Set(MARK_INK_COLORS.map((c) => c.value));

function isNorm01(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
}

/** Clamp normalized anchor inside page. */
export function clampNormalizedAnchor(nx, ny) {
  return { nx: clamp01(nx), ny: clamp01(ny) };
}

/** Clamp pen/text point to image bounds in pixel space then normalize. */
export function clampPixelToNormalized(x, y, width, height) {
  const w = width || 1;
  const h = height || 1;
  const n = normalizePoint(
    Math.min(w, Math.max(0, x)),
    Math.min(h, Math.max(0, y)),
    w,
    h,
  );
  return { nx: n.x, ny: n.y };
}

export function boundPenPointsNormalized(points, maxPoints = MAX_PEN_POINTS) {
  const pts = (points || []).filter((p) => isNorm01(p.nx) && isNorm01(p.ny));
  if (pts.length <= maxPoints) return pts;
  const step = (pts.length - 1) / (maxPoints - 1);
  const out = [];
  for (let i = 0; i < maxPoints; i += 1) {
    out.push(pts[Math.round(i * step)]);
  }
  return out;
}

/** Same sampling as live pen drag — keeps endpoint, caps count. */
export function appendLivePenPixelPoint(points, x, y, w, h, maxPoints = MAX_PEN_POINTS) {
  const width = w || 1;
  const height = h || 1;
  const px = Math.min(width, Math.max(0, x));
  const py = Math.min(height, Math.max(0, y));
  const list = points || [];
  const last = list[list.length - 1];
  if (last && Math.hypot(last.x - px, last.y - py) < 1.5) {
    return list;
  }
  let next = list.concat([{ x: px, y: py }]);
  if (next.length <= maxPoints) return next;
  const normalized = next.map((p) => clampPixelToNormalized(p.x, p.y, width, height));
  const bounded = boundPenPointsNormalized(normalized, maxPoints);
  return bounded.map((p) => ({
    x: p.nx * width,
    y: p.ny * height,
  }));
}

/** Pen mark construction used by grading UI on pointerup. */
export function createPenMarkFromPixelStroke({ id, points, w, h, color, nw }) {
  if (!points?.length) return null;
  let norm = points.map((p) => clampPixelToNormalized(p.x, p.y, w, h));
  if (norm.length === 1) {
    norm = [norm[0], { nx: clamp01(norm[0].nx + 0.0001), ny: norm[0].ny }];
  }
  norm = boundPenPointsNormalized(norm);
  if (!norm.length) return null;
  return {
    id,
    type: 'pen',
    color,
    nw,
    points: norm,
  };
}

export function buildPenPathD(points) {
  if (!points?.length) return '';
  const [first, ...rest] = points;
  let d = `M ${first.x} ${first.y}`;
  for (const p of rest) {
    d += ` L ${p.x} ${p.y}`;
  }
  return d;
}

export function distancePointToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * dx + (py - y1) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const cx = x1 + t * dx;
  const cy = y1 + t * dy;
  return Math.hypot(px - cx, py - cy);
}

export const MIN_DIRECT_TEXT_WIDTH_NORM = 0.06;
export const DIRECT_TEXT_FRAME_PAD = 6;
export const DIRECT_TEXT_MOVE_HANDLE_LIFT = 10;
export const DIRECT_TEXT_HANDLE_RADIUS = 7;
export const DEFAULT_DIRECT_TEXT_WIDTH_PAGE_FRACTION = 0.45;

/** Selection chrome in pixels (matches grading overlay handles). */
export function directTextSelectionChromePx() {
  return {
    top: DIRECT_TEXT_FRAME_PAD + DIRECT_TEXT_MOVE_HANDLE_LIFT + DIRECT_TEXT_HANDLE_RADIUS,
    right: DIRECT_TEXT_FRAME_PAD + DIRECT_TEXT_HANDLE_RADIUS,
    left: DIRECT_TEXT_FRAME_PAD + DIRECT_TEXT_HANDLE_RADIUS,
    bottom: DIRECT_TEXT_FRAME_PAD + DIRECT_TEXT_HANDLE_RADIUS,
  };
}

export function directTextSelectionFrameFromBox(box) {
  return {
    bx: box.x - DIRECT_TEXT_FRAME_PAD,
    by: box.y - DIRECT_TEXT_FRAME_PAD,
    bw: box.w + DIRECT_TEXT_FRAME_PAD * 2,
    bh: box.h + DIRECT_TEXT_FRAME_PAD,
  };
}

export function directTextHandleCenters(box) {
  const { bx, by, bw, bh } = directTextSelectionFrameFromBox(box);
  const midY = by + bh / 2;
  return {
    move: { x: bx + bw / 2, y: by - DIRECT_TEXT_MOVE_HANDLE_LIFT },
    e: { x: bx + bw, y: midY },
    w: { x: bx, y: midY },
    se: { x: bx + bw, y: by + bh },
  };
}

export function resolveDirectTextHandleHitRadiusPx(options = {}) {
  const zoom = resolveGradingLayoutZoom(options);
  return Math.max(14, (options.handleHitPx ?? 16) / zoom);
}

function clampDirectTextMarkWithinViewport(mark, width, height, options = {}) {
  const w = width || 1;
  const h = height || 1;
  if (!isNorm01(mark.nx) || !isNorm01(mark.ny)) return mark;
  const chrome = directTextSelectionChromePx();
  let nx = mark.nx;
  let ny = mark.ny;
  let m = { ...mark };
  for (let i = 0; i < 3; i += 1) {
    const box = layoutDirectTextBox({ ...m, nx, ny }, w, h, options);
    const nw =
      m.textWidthNorm != null && isNorm01(m.textWidthNorm) ? m.textWidthNorm : box.w / w;
    const nh = box.h / h;
    let nextNx = nx;
    let nextNy = ny;
    if (box.x + box.w + chrome.right > w + 0.5) {
      nextNx = Math.max(0, nx - (box.x + box.w + chrome.right - w) / w);
    }
    if (box.x - chrome.left < -0.5) {
      nextNx = Math.min(1 - nw, nx + (chrome.left - box.x) / w);
    }
    if (box.y + box.h + chrome.bottom > h + 0.5) {
      nextNy = Math.max(0, ny - (box.y + box.h + chrome.bottom - h) / h);
    }
    if (box.y - chrome.top < -0.5) {
      nextNy = Math.min(Math.max(0, 1 - nh), ny + (chrome.top - box.y) / h);
    }
    nextNx = clamp01(Math.min(1 - nw, Math.max(0, nextNx)));
    nextNy = clamp01(Math.min(1 - nh, Math.max(0, nextNy)));
    if (nextNx === nx && nextNy === ny) break;
    nx = nextNx;
    ny = nextNy;
    m = { ...m, nx, ny };
  }
  return { ...m, nx, ny };
}

export function resolveEraserHitRadiusPx(options = {}) {
  const zoom = resolveGradingLayoutZoom(options);
  const base = Number(options.baseRadius) || 14;
  return base / zoom;
}

function resolvePenHitPadding(paddingOrOptions, width) {
  if (typeof paddingOrOptions === 'number') {
    return paddingOrOptions;
  }
  const opts = paddingOrOptions || {};
  if (opts.zoom != null || opts.baseRadius != null) {
    return resolveEraserHitRadiusPx(opts);
  }
  return opts.padding ?? 8;
}

export function hitTestPenMark(mark, x, y, width, height, paddingOrOptions = 8) {
  const scaled = scaleMarkToViewport(mark, width, height);
  const pts = scaled.points || [];
  const half = (scaled.strokeWidth || 4) / 2 + resolvePenHitPadding(paddingOrOptions, width);
  if (pts.length === 1) {
    return Math.hypot(pts[0].x - x, pts[0].y - y) <= half;
  }
  for (let i = 1; i < pts.length; i += 1) {
    const a = pts[i - 1];
    const b = pts[i];
    if (distancePointToSegment(x, y, a.x, a.y, b.x, b.y) <= half) return true;
  }
  return false;
}

/** Pen marks whose stroke is touched by a point (eraser tip). */
export function listPenMarksAtEraserPoint(annotations, x, y, width, height, options = {}) {
  const hits = [];
  for (const m of annotations || []) {
    if (m.type !== 'pen') continue;
    if (hitTestPenMark(m, x, y, width, height, options)) hits.push(m);
  }
  return hits;
}

function sampleSegmentPoints(x1, y1, x2, y2, stepPx = 6) {
  const dist = Math.hypot(x2 - x1, y2 - y1);
  if (dist < 0.5) return [{ x: x2, y: y2 }];
  const steps = Math.max(1, Math.ceil(dist / stepPx));
  const out = [];
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    out.push({ x: x1 + (x2 - x1) * t, y: y1 + (y2 - y1) * t });
  }
  return out;
}

/** Whole-stroke ids touched along an eraser drag segment (sparse pen points included). */
export function collectPenIdsForEraserSegment(
  annotations,
  x1,
  y1,
  x2,
  y2,
  width,
  height,
  options = {},
) {
  const ids = new Set();
  const step = Math.max(4, (options.segmentStepPx ?? 6) / resolveGradingLayoutZoom(options));
  for (const p of sampleSegmentPoints(x1, y1, x2, y2, step)) {
    for (const m of listPenMarksAtEraserPoint(annotations, p.x, p.y, width, height, options)) {
      ids.add(m.id);
    }
  }
  return ids;
}

export function collectPenIdsForEraserPath(annotations, pathPoints, width, height, options = {}) {
  const ids = new Set();
  const pts = pathPoints || [];
  if (!pts.length) return [];
  for (const p of pts) {
    for (const m of listPenMarksAtEraserPoint(annotations, p.x, p.y, width, height, options)) {
      ids.add(m.id);
    }
  }
  for (let i = 1; i < pts.length; i += 1) {
    const a = pts[i - 1];
    const b = pts[i];
    for (const id of collectPenIdsForEraserSegment(
      annotations,
      a.x,
      a.y,
      b.x,
      b.y,
      width,
      height,
      options,
    )) {
      ids.add(id);
    }
  }
  return [...ids];
}

export function removePenMarksByIds(annotations, penIds) {
  const set = new Set(penIds || []);
  if (!set.size) return annotations || [];
  return (annotations || []).filter((m) => !(m.type === 'pen' && set.has(m.id)));
}

export function applyEraserToAnnotations(annotations, penIds) {
  return removePenMarksByIds(annotations, penIds);
}

export function resolveDirectTextMaxWidthPx(mark, width, height, options = {}) {
  const w = width || 1;
  const scaled = scaleMarkToViewport(mark, w, height || 1);
  const pad = options.pad ?? 4;
  if (mark.textWidthNorm != null && isNorm01(mark.textWidthNorm)) {
    return Math.max(24, mark.textWidthNorm * w);
  }
  return Math.max(24, w - scaled.x - pad);
}

export function defaultDirectTextWidthNorm(mark, width, height, options = {}) {
  const w = width || 1;
  if (mark.textWidthNorm != null && isNorm01(mark.textWidthNorm)) {
    return mark.textWidthNorm;
  }
  const hasText = String(mark?.text || '').trim().length > 0;
  if (!hasText) {
    return clamp01(Math.max(MIN_DIRECT_TEXT_WIDTH_NORM, Math.min(0.4, DEFAULT_DIRECT_TEXT_WIDTH_PAGE_FRACTION)));
  }
  const scaled = scaleMarkToViewport(mark, w, height || 1);
  const pad = options.pad ?? 4;
  const chrome = directTextSelectionChromePx();
  const maxFromAnchor = (w - scaled.x - pad - chrome.right) / w;
  const capped = Math.min(DEFAULT_DIRECT_TEXT_WIDTH_PAGE_FRACTION, maxFromAnchor);
  return clamp01(Math.max(MIN_DIRECT_TEXT_WIDTH_NORM, capped));
}

export function computeDirectTextWidthNormFromPixelWidth(pixelWidth, pageWidth) {
  const w = pageWidth || 1;
  return clamp01(Math.max(MIN_DIRECT_TEXT_WIDTH_NORM, (pixelWidth || 24) / w));
}

export function wrapDirectTextLines(text, maxCharsPerLine = 28) {
  const raw = String(text || '').replace(/\r\n/g, '\n');
  const lines = [];
  for (const paragraph of raw.split('\n')) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    if (!words.length) {
      lines.push('');
      continue;
    }
    let line = words[0];
    for (let i = 1; i < words.length; i += 1) {
      const next = `${line} ${words[i]}`;
      if (next.length > maxCharsPerLine && line.length) {
        lines.push(line);
        line = words[i];
      } else {
        line = next;
      }
    }
    lines.push(line);
  }
  return lines.length ? lines : [''];
}

export function estimateCharWidth(ch, fontSize) {
  const code = ch.codePointAt(0) || 0;
  if (code > 0x2E7F) return fontSize * 0.92;
  if (ch === ' ') return fontSize * 0.33;
  if (ch === 'W' || ch === 'M') return fontSize * 0.78;
  return fontSize * 0.55;
}

/** Cached canvas measurer matching SVG direct-text font (browser); falls back to estimates in Node. */
export function createCanvasMeasureLineWidth(fontFamily = DIRECT_TEXT_FONT_FAMILY) {
  let canvas;
  let ctx;
  return function measureLineWidth(text, fontSize) {
    const fs = Number(fontSize) || DIRECT_TEXT_SIZES[1];
    if (typeof document !== 'undefined') {
      if (!canvas) {
        canvas = document.createElement('canvas');
        ctx = canvas.getContext('2d');
      }
      if (ctx) {
        ctx.font = `${fs}px ${fontFamily}`;
        return ctx.measureText(String(text || '')).width;
      }
    }
    return measureTextLineWidth(text, fs, null);
  };
}

export function directTextSizeOptionValue(fontSizePx) {
  const px = Number(fontSizePx);
  if (!Number.isFinite(px) || px <= 0) return String(DIRECT_TEXT_SIZES[1]);
  return String(px);
}

export function directTextSizeOptionLabel(fontSizePx) {
  const px = Number(fontSizePx);
  const rounded = Math.max(1, Math.round(Number.isFinite(px) && px > 0 ? px : DIRECT_TEXT_SIZES[1]));
  return `${rounded}px`;
}

/** Preserve exact fontSizeNorm on edit unless the user changed the size control. */
export function resolveDirectTextSaveFontSizeNorm({
  fontSizeDirty,
  selectedSizeValue,
  viewportHeight,
  originalFontSizeNorm,
}) {
  if (
    !fontSizeDirty &&
    originalFontSizeNorm != null &&
    Number.isFinite(originalFontSizeNorm) &&
    originalFontSizeNorm > 0
  ) {
    return originalFontSizeNorm;
  }
  const px = Number(selectedSizeValue);
  const h = viewportHeight || 1;
  if (!Number.isFinite(px) || px <= 0) {
    if (originalFontSizeNorm != null && originalFontSizeNorm > 0) return originalFontSizeNorm;
    return DIRECT_TEXT_SIZES[1] / h;
  }
  return px / h;
}

/**
 * Opens direct-text dialog via injected host; returns `{ close }` for grading cleanup.
 * @param {object} host — `{ openDialog, mk, focus?, inkColors?, presetSizes? }`
 */
export function openDirectTextDialogWithHost(host, onSave, initial = {}) {
  const {
    openDialog,
    mk,
    focus = () => {},
    inkColors = MARK_INK_COLORS,
    presetSizes = DIRECT_TEXT_SIZES,
  } = host;
  let fontSizeDirty = false;
  const input = mk('textarea', {
    id: 'direct-text-ta',
    rows: '4',
    'aria-label': 'Chữ trên ảnh',
  }, initial.text || '');
  const colorSel = mk('select', { id: 'direct-text-color', 'aria-label': 'Màu chữ' });
  for (const c of inkColors) {
    colorSel.appendChild(mk('option', { value: c.value }, c.label));
  }
  colorSel.value = initial.color || inkColors[0].value;
  const sizeSel = mk('select', { id: 'direct-text-size', 'aria-label': 'Cỡ chữ' });
  for (const sz of presetSizes) {
    sizeSel.appendChild(mk('option', { value: String(sz) }, `${sz}px`));
  }
  const sizeVal = directTextSizeOptionValue(initial.fontSize || presetSizes[1]);
  const sizeLabel = directTextSizeOptionLabel(initial.fontSize || presetSizes[1]);
  if (![...sizeSel.options].some((o) => o.value === sizeVal)) {
    sizeSel.appendChild(mk('option', { value: sizeVal }, sizeLabel));
  }
  sizeSel.value = sizeVal;
  if (typeof sizeSel.addEventListener === 'function') {
    sizeSel.addEventListener('change', () => {
      fontSizeDirty = true;
    });
  }
  const err = mk('div', { className: 'form-error', role: 'alert' });
  const measureLineWidth =
    typeof initial.measureLineWidth === 'function'
      ? initial.measureLineWidth
      : createCanvasMeasureLineWidth();
  const { close } = openDialog(
    initial.title || 'Chữ trên ảnh',
    [
      mk('div', { className: 'form-field' },
        mk('label', { htmlFor: 'direct-text-ta' }, 'Nội dung (có thể xuống dòng)'),
        input,
      ),
      mk('div', { className: 'form-field form-row-2' },
        mk('div', {},
          mk('label', { htmlFor: 'direct-text-color' }, 'Màu'),
          colorSel,
        ),
        mk('div', {},
          mk('label', { htmlFor: 'direct-text-size' }, 'Cỡ chữ'),
          sizeSel,
        ),
      ),
      err,
    ],
    [
      mk('button', { type: 'button', className: 'btn btn-ghost', onClick: () => close() }, 'Hủy'),
      mk('button', {
        type: 'button',
        className: 'btn btn-primary',
        onClick: () => {
          const text = String(input.value ?? '');
          const saveErr = directTextSaveErrorMessage(text);
          if (saveErr) {
            err.textContent = saveErr;
            focus(input);
            return;
          }
          const fontSizeNorm = resolveDirectTextSaveFontSizeNorm({
            fontSizeDirty,
            selectedSizeValue: sizeSel.value,
            viewportHeight: initial.viewportHeight,
            originalFontSizeNorm: initial.fontSizeNorm,
          });
          const w = initial.viewportWidth || 1;
          const h = initial.viewportHeight || 1;
          let nx;
          let ny;
          if (initial.editMark && isNorm01(initial.editMark.nx) && isNorm01(initial.editMark.ny)) {
            nx = initial.editMark.nx;
            ny = initial.editMark.ny;
          } else {
            const anchor = clampPixelToNormalized(
              initial.anchorX ?? 0,
              initial.anchorY ?? 0,
              w,
              h,
            );
            nx = anchor.nx;
            ny = anchor.ny;
          }
          const placement = validateDirectTextPlacement(
            {
              id: 'preview',
              type: 'text',
              nx,
              ny,
              text: String(text ?? ''),
              color: colorSel.value,
              fontSizeNorm,
            },
            w,
            h,
            { measureLineWidth },
          );
          if (!placement.ok) {
            err.textContent = placement.error;
            focus(input);
            return;
          }
          onSave({
            text: String(text ?? ''),
            color: colorSel.value,
            fontSizeNorm,
          });
          close();
        },
      }, 'Lưu'),
    ],
  );
  focus(input);
  return { close };
}

export function measureTextLineWidth(text, fontSize, measureLineWidth) {
  if (typeof measureLineWidth === 'function') {
    return measureLineWidth(String(text || ''), fontSize);
  }
  let w = 0;
  for (const ch of String(text || '')) w += estimateCharWidth(ch, fontSize);
  return w;
}

export function wrapDirectTextLinesToWidth(text, maxWidthPx, fontSize, measureLineWidth) {
  const maxW = Math.max(8, maxWidthPx);
  const raw = String(text || '').replace(/\r\n/g, '\n');
  const out = [];
  for (const paragraph of raw.split('\n')) {
    if (!paragraph) {
      out.push('');
      continue;
    }
    const words = paragraph.split(/\s+/).filter(Boolean);
    if (!words.length) {
      out.push('');
      continue;
    }
    let line = '';
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (measureTextLineWidth(candidate, fontSize, measureLineWidth) <= maxW) {
        line = candidate;
        continue;
      }
      if (line) {
        out.push(line);
        line = '';
      }
      if (measureTextLineWidth(word, fontSize, measureLineWidth) <= maxW) {
        line = word;
        continue;
      }
      let chunk = '';
      for (const ch of word) {
        const next = chunk + ch;
        if (measureTextLineWidth(next, fontSize, measureLineWidth) <= maxW) {
          chunk = next;
        } else {
          if (chunk) out.push(chunk);
          chunk = ch;
        }
      }
      line = chunk;
    }
    if (line) out.push(line);
  }
  return out.length ? out : [''];
}

export function layoutDirectTextBox(mark, width, height, options = {}) {
  const w = width || 1;
  const h = height || 1;
  const scaled = scaleMarkToViewport(mark, w, h);
  const fontSize = scaled.fontSize || 20;
  const lineHeight = fontSize * 1.25;
  const pad = options.pad ?? 4;
  const maxBoxW = resolveDirectTextMaxWidthPx(mark, w, h, options);
  const measureLineWidth = options.measureLineWidth;
  let lines = wrapDirectTextLinesToWidth(scaled.text, maxBoxW, fontSize, measureLineWidth);
  let maxLineW = 0;
  for (const line of lines) {
    maxLineW = Math.max(maxLineW, measureTextLineWidth(line, fontSize, measureLineWidth));
  }
  const minW = Math.max(24, maxLineW + pad);
  const boxW =
    mark.textWidthNorm != null && isNorm01(mark.textWidthNorm)
      ? maxBoxW
      : Math.min(maxBoxW, Math.max(24, maxLineW + pad));
  const boxH = Math.max(lineHeight + pad, lines.length * lineHeight + pad);
  return {
    x: scaled.x,
    y: scaled.y,
    w: boxW,
    h: boxH,
    fontSize,
    lineHeight,
    lines,
    color: scaled.color,
  };
}

export function validateDirectTextPlacement(mark, width, height, options = {}) {
  const w = width || 1;
  const h = height || 1;
  const fitted = fitDirectTextMarkInPage(mark, w, h, options);
  const box = layoutDirectTextBox(fitted, w, h, options);
  if (box.h > h + 0.5) {
    return {
      ok: false,
      error: 'Chữ quá dài hoặc cỡ chữ quá lớn để vừa trang. Rút ngắn nội dung hoặc giảm cỡ chữ.',
      mark: fitted,
    };
  }
  if (box.x + box.w > w + 0.5 || box.y + box.h > h + 0.5) {
    return {
      ok: false,
      error: 'Chữ quá dài hoặc cỡ chữ quá lớn để vừa trang. Rút ngắn nội dung hoặc giảm cỡ chữ.',
      mark: fitted,
    };
  }
  return { ok: true, mark: fitted };
}

export function estimateDirectTextBox(mark, width, height, options) {
  return layoutDirectTextBox(mark, width, height, options);
}

export function fitDirectTextMarkInPage(mark, width, height, options = {}) {
  const w = width || 1;
  const h = height || 1;
  let m = { ...mark };
  for (let i = 0; i < 4; i += 1) {
    const box = layoutDirectTextBox(m, w, h, options);
    const nw =
      m.textWidthNorm != null && isNorm01(m.textWidthNorm) ? m.textWidthNorm : box.w / w;
    const nh = box.h / h;
    let nx = m.nx;
    let ny = m.ny;
    if (!isNorm01(nx) || !isNorm01(ny)) break;
    if (nx + nw > 1) nx = Math.max(0, 1 - nw);
    if (ny + nh > 1) ny = Math.max(0, 1 - nh);
    if (nx === m.nx && ny === m.ny) break;
    m = { ...m, nx, ny };
  }
  return m;
}

/** Text mark construction used by grading UI after dialog save. */
export function createDirectTextMarkFromPixelAnchor({
  id,
  x,
  y,
  w,
  h,
  text,
  color,
  fontSize,
  fontSizeNorm,
  textWidthNorm,
  measureLineWidth,
}) {
  const anchor = clampPixelToNormalized(x, y, w, h);
  const trimmed = String(text ?? '');
  if (!isDirectTextValid(trimmed)) {
    throw new Error('Nội dung chữ không hợp lệ.');
  }
  const base = {
    id,
    type: 'text',
    nx: anchor.nx,
    ny: anchor.ny,
    text: trimmed,
    color,
    fontSizeNorm:
      fontSizeNorm != null && Number.isFinite(fontSizeNorm) && fontSizeNorm > 0
        ? fontSizeNorm
        : fontSize / (h || 1),
    textWidthNorm:
      textWidthNorm != null && isNorm01(textWidthNorm)
        ? textWidthNorm
        : undefined,
  };
  const options = measureLineWidth ? { measureLineWidth } : {};
  const placement = validateDirectTextPlacement(base, w, h, options);
  return placement.mark;
}

export function hitTestTextMark(mark, x, y, width, height, options) {
  const box = estimateDirectTextBox(mark, width, height, options);
  return x >= box.x && x <= box.x + box.w && y >= box.y && y <= box.y + box.h;
}

/**
 * Topmost hit among annotations (later items on top).
 */
export function hitTestAnnotationAt(annotations, x, y, width, height, options) {
  const list = annotations || [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const m = list[i];
    const scaled = scaleMarkToViewport(m, width, height);
    if (m.type === 'highlight') {
      if (x >= scaled.x && x <= scaled.x + scaled.w && y >= scaled.y && y <= scaled.y + scaled.h) {
        return m;
      }
    } else if (m.type === 'pen') {
      if (hitTestPenMark(m, x, y, width, height)) return m;
    } else if (m.type === 'text') {
      if (hitTestTextMark(m, x, y, width, height, options)) return m;
      if (hitTestDirectTextHandle(m, x, y, width, height, options)) return m;
    } else if (Math.hypot(scaled.x - x, scaled.y - y) < 20) {
      return m;
    }
  }
  return null;
}

export function updateDirectTextAnnotation(annotations, textId, { text, color, fontSizeNorm }) {
  const trimmed = String(text ?? '');
  return (annotations || []).map((m) => {
    if (m.id !== textId || m.type !== 'text') return m;
    const next = { ...m, text: trimmed };
    if (color && VALID_INK.has(color)) next.color = color;
    if (fontSizeNorm != null && Number.isFinite(fontSizeNorm) && fontSizeNorm > 0) {
      next.fontSizeNorm = fontSizeNorm;
    }
    return next;
  });
}

export function moveDirectTextAnnotation(annotations, textId, nx, ny, width, height, options) {
  const w = width || 1;
  const h = height || 1;
  const mark = (annotations || []).find((m) => m.id === textId && m.type === 'text');
  if (!mark) return annotations || [];
  const clamped = clampDirectTextMarkWithinViewport(
    { ...mark, nx: clamp01(nx), ny: clamp01(ny) },
    w,
    h,
    options,
  );
  return (annotations || []).map((m) =>
    m.id === textId && m.type === 'text'
      ? { ...m, nx: clamped.nx, ny: clamped.ny }
      : m,
  );
}

export function resizeDirectTextAnnotation(
  annotations,
  textId,
  { nx, ny, textWidthNorm },
  width,
  height,
  options,
) {
  const w = width || 1;
  const h = height || 1;
  const mark = (annotations || []).find((m) => m.id === textId && m.type === 'text');
  if (!mark) return annotations || [];
  let nextNx = nx != null ? clamp01(nx) : mark.nx;
  let nextNw =
    textWidthNorm != null ? clamp01(Math.max(MIN_DIRECT_TEXT_WIDTH_NORM, textWidthNorm)) : mark.textWidthNorm;
  if (nextNw == null || !isNorm01(nextNw)) {
    const box = estimateDirectTextBox(mark, w, h, options);
    nextNw = clamp01(Math.max(MIN_DIRECT_TEXT_WIDTH_NORM, box.w / w));
  }
  if (nextNx + nextNw > 1) nextNx = Math.max(0, 1 - nextNw);
  const draft = { ...mark, nx: nextNx, ny: ny != null ? clamp01(ny) : mark.ny, textWidthNorm: nextNw };
  const fitted = clampDirectTextMarkWithinViewport(draft, w, h, options);
  const box = estimateDirectTextBox(fitted, w, h, options);
  const nh = box.h / h;
  const clampedNy = clamp01(Math.min(1 - nh, Math.max(0, fitted.ny)));
  return (annotations || []).map((m) =>
    m.id === textId && m.type === 'text'
      ? { ...m, nx: fitted.nx, ny: clampedNy, textWidthNorm: fitted.textWidthNorm ?? nextNw }
      : m,
  );
}

const DIRECT_TEXT_HANDLE_HIT_PRIORITY = ['resize-se', 'resize-e', 'resize-w', 'move'];

function isInsideDirectTextBody(x, y, box) {
  return x >= box.x && x <= box.x + box.w && y >= box.y && y <= box.y + box.h;
}

/** Side resize handles sit on the frame edge; generous hit radii must not steal body interior drags. */
function directTextSideHandleClaimsBodyPoint(handleId, x, y, box) {
  if (handleId === 'resize-w') return x <= box.x;
  if (handleId === 'resize-e') return x >= box.x + box.w;
  return true;
}

function pickDirectTextHandleHit(candidates, x, y, hit, box, { inBody = false } = {}) {
  let bestId = null;
  let bestDist = Infinity;
  for (const c of candidates) {
    if (inBody && !directTextSideHandleClaimsBodyPoint(c.id, x, y, box)) {
      continue;
    }
    const d = Math.hypot(x - c.cx, y - c.cy);
    if (d > hit) continue;
    if (d < bestDist - 1e-6) {
      bestDist = d;
      bestId = c.id;
      continue;
    }
    if (Math.abs(d - bestDist) <= 1e-6 && bestId) {
      if (
        DIRECT_TEXT_HANDLE_HIT_PRIORITY.indexOf(c.id) <
        DIRECT_TEXT_HANDLE_HIT_PRIORITY.indexOf(bestId)
      ) {
        bestId = c.id;
      }
    }
  }
  return bestId;
}

export function hitTestDirectTextHandle(mark, x, y, width, height, options = {}) {
  const box = layoutDirectTextBox(mark, width, height, options);
  const hit = resolveDirectTextHandleHitRadiusPx(options);
  const frame = directTextSelectionFrameFromBox(box);
  const centers = directTextHandleCenters(box);
  const candidates = [
    { id: 'resize-se', cx: centers.se.x, cy: centers.se.y },
    { id: 'resize-e', cx: centers.e.x, cy: centers.e.y },
    { id: 'resize-w', cx: centers.w.x, cy: centers.w.y },
    { id: 'move', cx: centers.move.x, cy: centers.move.y },
  ];
  const inBody = isInsideDirectTextBody(x, y, box);
  if (inBody) {
    const handleInBody = pickDirectTextHandleHit(candidates, x, y, hit, box, { inBody: true });
    if (handleInBody) return handleInBody;
    return 'move';
  }
  const handle = pickDirectTextHandleHit(candidates, x, y, hit, box);
  if (handle) return handle;
  if (x >= frame.bx && x <= frame.bx + frame.bw && y >= frame.by && y <= frame.by + frame.bh) {
    return 'move';
  }
  return null;
}

/** Restore cancelled drag without re-clamping or re-measuring layout. */
export function restoreDirectTextAnnotationPosition(annotations, textId, nx, ny) {
  return (annotations || []).map((m) =>
    m.id === textId && m.type === 'text' ? { ...m, nx, ny } : m,
  );
}

export function isDirectTextValid(text) {
  const s = String(text ?? '');
  return s.trim().length > 0 && s.length <= MAX_DIRECT_TEXT_LENGTH;
}

export function directTextSaveErrorMessage(text) {
  const s = String(text ?? '');
  if (s.trim().length === 0) return 'Nhập nội dung trước khi lưu.';
  if (s.length > MAX_DIRECT_TEXT_LENGTH) {
    return `Nội dung tối đa ${MAX_DIRECT_TEXT_LENGTH} ký tự.`;
  }
  return null;
}

export function validateAnnotationMark(mark) {
  if (!mark || typeof mark !== 'object') {
    return { ok: false, error: 'Mark không phải object.' };
  }
  if (!isId(mark.id)) {
    return { ok: false, error: 'Mark thiếu id hợp lệ.' };
  }
  if (!VALID_MARK_TYPES.has(mark.type)) {
    return { ok: false, error: 'Loại mark không hỗ trợ.' };
  }
  switch (mark.type) {
    case 'check':
    case 'cross':
      if (!isNorm01(mark.nx) || !isNorm01(mark.ny)) {
        return { ok: false, error: 'Tọa độ check/cross không hợp lệ.' };
      }
      return { ok: true };
    case 'pin':
      if (!isNorm01(mark.nx) || !isNorm01(mark.ny)) {
        return { ok: false, error: 'Tọa độ pin không hợp lệ.' };
      }
      if (mark.text != null && !isStringField(String(mark.text), 5000)) {
        return { ok: false, error: 'Nội dung pin quá dài.' };
      }
      return { ok: true };
    case 'highlight':
      if (
        !isNorm01(mark.nx) ||
        !isNorm01(mark.ny) ||
        !isNorm01(mark.nw) ||
        !isNorm01(mark.nh)
      ) {
        return { ok: false, error: 'Vùng highlight không hợp lệ.' };
      }
      return { ok: true };
    case 'pen': {
      if (!Array.isArray(mark.points) || !mark.points.length) {
        return { ok: false, error: 'Pen thiếu điểm.' };
      }
      if (mark.points.length > MAX_PEN_POINTS) {
        return { ok: false, error: 'Pen quá nhiều điểm.' };
      }
      for (const p of mark.points) {
        if (!p || !isNorm01(p.nx) || !isNorm01(p.ny)) {
          return { ok: false, error: 'Điểm pen không hợp lệ.' };
        }
      }
      if (mark.nw != null && (!Number.isFinite(mark.nw) || mark.nw <= 0 || mark.nw > 0.05)) {
        return { ok: false, error: 'Độ dày pen không hợp lệ.' };
      }
      if (mark.color != null && !VALID_INK.has(mark.color)) {
        return { ok: false, error: 'Màu pen không hợp lệ.' };
      }
      return { ok: true };
    }
    case 'text': {
      if (!isNorm01(mark.nx) || !isNorm01(mark.ny)) {
        return { ok: false, error: 'Tọa độ chữ không hợp lệ.' };
      }
      if (!isStringField(String(mark.text || ''), MAX_DIRECT_TEXT_LENGTH)) {
        return { ok: false, error: 'Nội dung chữ không hợp lệ.' };
      }
      if (mark.fontSizeNorm != null && (!Number.isFinite(mark.fontSizeNorm) || mark.fontSizeNorm <= 0)) {
        return { ok: false, error: 'Cỡ chữ không hợp lệ.' };
      }
      if (mark.color != null && !VALID_INK.has(mark.color)) {
        return { ok: false, error: 'Màu chữ không hợp lệ.' };
      }
      if (
        mark.textWidthNorm != null &&
        (!Number.isFinite(mark.textWidthNorm) ||
          mark.textWidthNorm < MIN_DIRECT_TEXT_WIDTH_NORM ||
          mark.textWidthNorm > 1)
      ) {
        return { ok: false, error: 'Độ rộng hộp chữ không hợp lệ.' };
      }
      return { ok: true };
    }
    default:
      return { ok: false, error: 'Loại mark không hỗ trợ.' };
  }
}

/** Drop invalid marks; keep legacy valid marks. */
export function sanitizePageAnnotations(annotations) {
  const out = [];
  for (const m of annotations || []) {
    const v = validateAnnotationMark(m);
    if (v.ok) out.push(m);
  }
  return out;
}

/**
 * Logical page size at zoom 1: fit to container inner width, preserve natural aspect ratio.
 * Independent of current DOM transforms or applied zoom.
 */
export const GRADING_ZOOM_FIT_WIDTH = 'fit-width';
export const GRADING_ZOOM_FIT_PAGE = 'fit-page';
export const GRADING_ZOOM_MANUAL = 'manual';

export const GRADING_MANUAL_ZOOM_MIN = 0.05;
export const GRADING_MANUAL_ZOOM_MAX = 4;
export const GRADING_MANUAL_ZOOM_NUDGE = 0.1;

/** Shared manual-zoom clamp (0.05× … 4× vs fit-width baseline). */
export function clampGradingManualZoom(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 1;
  return Math.min(GRADING_MANUAL_ZOOM_MAX, Math.max(GRADING_MANUAL_ZOOM_MIN, n));
}

export function nudgeGradingManualZoom(current, delta = GRADING_MANUAL_ZOOM_NUDGE) {
  return clampGradingManualZoom((Number(current) || 1) + delta);
}

/** Zoom multiplier used for hit-testing and stroke sampling (same range as manual zoom). */
export function resolveGradingLayoutZoom(options = {}) {
  return clampGradingManualZoom(Number(options.zoom) || 1);
}

/**
 * Side panel accessibility when the score sheet is a mobile bottom sheet vs desktop column.
 */
export function resolveGradingPanelSideState({
  mobileSheetViewport = false,
  mobilePanelOpen = false,
  panelCollapsed = false,
} = {}) {
  if (mobileSheetViewport) {
    const open = !!mobilePanelOpen;
    return {
      sideHidden: !open,
      sideInert: !open,
      sideAriaHidden: open ? 'false' : 'true',
      backdropHidden: !open,
      backdropInert: !open,
      panelToggleExpanded: !panelCollapsed,
    };
  }
  return {
    sideHidden: false,
    sideInert: false,
    sideAriaHidden: 'false',
    backdropHidden: true,
    backdropInert: true,
    panelToggleExpanded: !panelCollapsed,
  };
}

/** True when displayed image pixel size changed enough to invalidate an in-progress gesture. */
export function gradingDisplayedImageSizeChanged(frozenW, frozenH, w, h, tolerance = 0.5) {
  return (
    Math.abs(Number(w) - Number(frozenW)) > tolerance ||
    Math.abs(Number(h) - Number(frozenH)) > tolerance
  );
}

/** Matches SVG direct-text background inset in the grading overlay renderer. */
export const GRADING_INLINE_TEXT_SVG_PAD = 4;

export const GRADING_FOCUS_BODY_CLASS = 'grading-focus-active';

/**
 * Toggle app-level grading focus chrome on `document.body` (for tests and navigation cleanup).
 * @param {Pick<Document, 'body'>|null|undefined} doc
 */
export function applyGradingFocusMode(doc, active) {
  if (!doc?.body) return;
  doc.body.classList.toggle(GRADING_FOCUS_BODY_CLASS, !!active);
}

/**
 * Block undo/redo while inline text editing is open — prevents history pops that drop the mark.
 */
export function shouldBlockGradingUndoRedo({ inlineTextEditing = false } = {}) {
  return !!inlineTextEditing;
}

/** Block delete, navigation, and publish while inline text has not been committed. */
export function shouldBlockGradingDestructiveActions({ inlineTextEditing = false } = {}) {
  return !!inlineTextEditing;
}

export function gradingPendingInlineEditMessage() {
  return 'Hoàn tất chỉnh sửa chữ (bấm Xong hoặc Hủy) trước khi tiếp tục.';
}

export function hasUnsavedInlineTextEdits({
  isNew = false,
  originalText = '',
  draftText = '',
  fontSizeDirty = false,
  colorDirty = false,
} = {}) {
  if (isNew) {
    return String(draftText).trim().length > 0 || fontSizeDirty || colorDirty;
  }
  return (
    String(draftText) !== String(originalText) ||
    fontSizeDirty ||
    colorDirty
  );
}

/** Seed manual zoom multiplier from the current fit-mode displayed scale (fit-width baseline = 1). */
export function seedGradingManualZoomFromFitMode({
  naturalWidth,
  naturalHeight,
  containerInnerWidth,
  containerInnerHeight,
  fitMode,
}) {
  const pct = computeGradingZoomPercent({
    naturalWidth,
    naturalHeight,
    containerInnerWidth,
    containerInnerHeight,
    fitMode,
    manualZoom: 1,
  });
  return clampGradingManualZoom(pct / 100);
}

/**
 * Pixel layout for inline text editor DOM aligned with saved SVG text box metrics.
 * @param {{ x: number, y: number, w: number, h: number, lineHeight?: number }} box
 */
export function computeInlineTextEditorLayout(box) {
  const pad = GRADING_INLINE_TEXT_SVG_PAD;
  const w = Math.max(1, Number(box.w) || 1);
  const h = Math.max(1, Number(box.h) || 1);
  const lh = Math.max(1, Number(box.lineHeight) || h);
  return {
    left: box.x - pad,
    top: box.y - pad,
    width: w + pad * 2,
    minHeight: h + pad,
    textWidth: w,
    textMinHeight: Math.max(h, lh + 8),
  };
}

export function computeEditorBaseContentSize({
  naturalWidth,
  naturalHeight,
  containerInnerWidth,
}) {
  const nw = Math.max(1, Number(naturalWidth) || 1);
  const nh = Math.max(1, Number(naturalHeight) || 1);
  const inner = Math.max(1, Number(containerInnerWidth) || 1);
  const baseWidth = inner;
  const baseHeight = (baseWidth * nh) / nw;
  return { baseWidth, baseHeight };
}

/**
 * Content size for the annotation viewport — fit-width or fit-whole-page in a bounded stage.
 */
export function computeEditorBaseContentSizeForFit({
  naturalWidth,
  naturalHeight,
  containerInnerWidth,
  containerInnerHeight,
  fitMode = GRADING_ZOOM_FIT_WIDTH,
}) {
  const nw = Math.max(1, Number(naturalWidth) || 1);
  const nh = Math.max(1, Number(naturalHeight) || 1);
  const innerW = Math.max(1, Number(containerInnerWidth) || 1);
  const innerH = Math.max(1, Number(containerInnerHeight) || 1);
  const widthFirst = computeEditorBaseContentSize({
    naturalWidth: nw,
    naturalHeight: nh,
    containerInnerWidth: innerW,
  });
  if (fitMode !== GRADING_ZOOM_FIT_PAGE) {
    return widthFirst;
  }
  if (widthFirst.baseHeight <= innerH + 0.5) {
    return widthFirst;
  }
  const scale = innerH / widthFirst.baseHeight;
  return {
    baseWidth: widthFirst.baseWidth * scale,
    baseHeight: innerH,
  };
}

/**
 * Zoom percent relative to fit-width baseline at zoom multiplier 1.
 */
export function computeGradingZoomPercent({
  naturalWidth,
  naturalHeight,
  containerInnerWidth,
  containerInnerHeight,
  fitMode,
  manualZoom = 1,
}) {
  const baseline = computeEditorBaseContentSizeForFit({
    naturalWidth,
    naturalHeight,
    containerInnerWidth,
    containerInnerHeight,
    fitMode: GRADING_ZOOM_FIT_WIDTH,
  });
  const current = computeEditorBaseContentSizeForFit({
    naturalWidth,
    naturalHeight,
    containerInnerWidth,
    containerInnerHeight,
    fitMode: fitMode === GRADING_ZOOM_MANUAL ? GRADING_ZOOM_FIT_WIDTH : fitMode,
  });
  const z = Math.max(0.01, Number(manualZoom) || 1);
  const baseW = baseline.baseWidth || 1;
  const curW =
    fitMode === GRADING_ZOOM_MANUAL ? current.baseWidth * z : current.baseWidth;
  return Math.round((curW / baseW) * 100);
}

/**
 * Full editor layout from image natural size and container — use for DOM layout, not hit tests.
 */
export function computeEditorLayoutFromImage({
  naturalWidth,
  naturalHeight,
  containerInnerWidth,
  containerInnerHeight,
  fitMode = GRADING_ZOOM_FIT_WIDTH,
  zoom = 1,
}) {
  const { baseWidth, baseHeight } = computeEditorBaseContentSizeForFit({
    naturalWidth,
    naturalHeight,
    containerInnerWidth,
    containerInnerHeight: containerInnerHeight ?? containerInnerWidth,
    fitMode:
      fitMode === GRADING_ZOOM_MANUAL ? GRADING_ZOOM_FIT_WIDTH : fitMode,
  });
  const z =
    fitMode === GRADING_ZOOM_MANUAL
      ? Math.max(0.01, Number(zoom) || 1)
      : Math.max(0.01, Number(zoom) || 1);
  return computeEditorStageLayout({
    contentWidth: baseWidth,
    contentHeight: baseHeight,
    zoom: z,
    containerInnerWidth,
  });
}

/**
 * View vs annotate tool toggle; keeps last annotation tool separate from view mode.
 * @param {{ mode: string, tool: string, lastAnnotateTool?: string }} session
 */
export function transitionGradingEditorTool(session, toolId, { readOnly = false } = {}) {
  if (readOnly) return { ...session };
  const next = { ...session, lastAnnotateTool: session.lastAnnotateTool || 'select' };
  if (toolId === 'view') {
    if (session.mode === 'view') {
      next.mode = 'annotate';
      next.tool = next.lastAnnotateTool || 'select';
    } else {
      if (session.tool !== 'view' && session.tool !== 'pan') {
        next.lastAnnotateTool = session.tool;
      }
      next.mode = 'view';
      next.tool = 'view';
    }
  } else {
    next.tool = toolId;
    next.lastAnnotateTool = toolId;
    next.mode = 'annotate';
  }
  return next;
}

/** Ink/size toolbar visibility for grading — inline text edit shows text controls regardless of active tool. */
export function resolveGradingInkControlsVisibility({
  readOnly = false,
  tool,
  inlineTextEditing = false,
} = {}) {
  const inline = !!inlineTextEditing;
  return {
    inkBarHidden: readOnly || (!inline && !['pen', 'text'].includes(tool)),
    strokeSelHidden: inline ? true : tool !== 'pen',
    textSizeSelHidden: inline ? false : tool !== 'text',
  };
}

/**
 * Scroll-stage box for zoomed image editor: top-left scale, stage sized to scaled pixels.
 * @param {{ contentWidth: number, contentHeight: number, zoom?: number, containerInnerWidth?: number }} opts
 */
export function computeEditorStageLayout({
  contentWidth,
  contentHeight,
  zoom = 1,
  containerInnerWidth,
}) {
  const z = Math.max(0.01, Number(zoom) || 1);
  const cw = Math.max(1, Number(contentWidth) || 1);
  const ch = Math.max(1, Number(contentHeight) || 1);
  const scaledWidth = cw * z;
  const scaledHeight = ch * z;
  const inner = Math.max(1, Number(containerInnerWidth) || scaledWidth);
  const centerInContainer = z <= 1 || scaledWidth <= inner;
  return {
    zoom: z,
    contentWidth: cw,
    contentHeight: ch,
    viewportWidth: cw,
    viewportHeight: ch,
    stageWidth: scaledWidth,
    stageHeight: scaledHeight,
    centerInContainer,
  };
}

/** Ordered pin comments on a page (stable 1-based display numbers). */
export function listPinComments(annotations) {
  const pins = [];
  let n = 0;
  for (const m of annotations || []) {
    if (m.type === 'pin') {
      n += 1;
      pins.push({ id: m.id, number: n, text: m.text || '' });
    }
  }
  return pins;
}

/** Map pin mark id → display number for the page. */
export function pinNumberMap(annotations) {
  const map = new Map();
  for (const p of listPinComments(annotations)) {
    map.set(p.id, p.number);
  }
  return map;
}

export function isPinCommentTextValid(text) {
  return String(text || '').trim().length > 0;
}

/** Update pin comment text; preserves id and normalized position fields. */
export function updatePinCommentText(annotations, pinId, text) {
  const trimmed = String(text || '').trim();
  return (annotations || []).map((m) =>
    m.id === pinId && m.type === 'pin' ? { ...m, text: trimmed } : m,
  );
}

/**
 * Class IDs this student may access for homework (primary + memberships, or server snapshot allowlist).
 */
export function studentEnrollmentClassIds(student, memberships = null, atIso = new Date().toISOString()) {
  if (student?.enrollmentClassIds?.length) {
    return new Set(student.enrollmentClassIds);
  }
  const ids = new Set();
  if (student?.classId) ids.add(student.classId);
  if (memberships) {
    for (const m of memberships) {
      if (m.studentId !== student?.id) continue;
      const from = m.effectiveFrom;
      const to = m.effectiveTo;
      if (from && from > atIso) continue;
      if (to && to <= atIso) continue;
      ids.add(m.classId);
    }
  }
  return ids;
}

export function studentCanAccessAssignmentClassClient(student, assignmentClassId, memberships = null, atIso = new Date().toISOString()) {
  return studentEnrollmentClassIds(student, memberships, atIso).has(assignmentClassId);
}

/**
 * Assignments visible to student in preview (primary class + active memberships).
 */
export function getAssignmentsForStudent(assignments, student, classFilterId, memberships = null, atIso = new Date().toISOString()) {
  if (!student) return [];
  const allowed = studentEnrollmentClassIds(student, memberships, atIso);
  const useMembershipFilter = memberships || student?.enrollmentClassIds?.length;
  return assignments.filter((a) => {
    if (useMembershipFilter) {
      if (!allowed.has(a.classId)) return false;
    } else if (a.classId !== student.classId) return false;
    if (classFilterId && a.classId !== classFilterId) return false;
    return true;
  });
}

export function getStudentsInClass(students, classId, memberships = null, atIso = new Date().toISOString()) {
  if (!memberships) {
    return students.filter((s) => s.classId === classId);
  }
  return students.filter((s) => studentCanAccessAssignmentClassClient(s, classId, memberships, atIso));
}

/** Queue item states for grading */
export function gradingQueueState(submission, assignment, now = new Date()) {
  const sub = submission;
  if (!sub || !sub.versions?.length) {
    return { state: 'missing', label: 'Chưa nộp' };
  }
  const latest = sub.versions[sub.versions.length - 1];
  if (latest.isDraft) {
    return { state: 'missing', label: 'Chưa nộp' };
  }
  const timing = classifyDeadlineTiming(sub.firstSubmittedAt, assignment.dueDateISO);
  if (latest.status === SUBMISSION_STATUS.SUBMITTED || latest.status === SUBMISSION_STATUS.GRADING) {
    return {
      state: timing.late ? 'late' : 'submitted',
      label: timing.late ? 'Nộp trễ' : 'Đã nộp',
    };
  }
  if (latest.status === SUBMISSION_STATUS.RETURNED) {
    return { state: 'returned', label: 'Đã trả bài' };
  }
  if (latest.status === SUBMISSION_STATUS.NEEDS_REVISION) {
    return { state: 'needs-revision', label: 'Cần làm lại' };
  }
  return { state: 'submitted', label: 'Đã nộp' };
}

/** HTML boolean IDL properties — false must not become a presence attribute. */
export const BOOLEAN_DOM_PROPERTY_KEYS = new Set([
  'disabled',
  'hidden',
  'checked',
  'selected',
  'required',
  'multiple',
]);

const ACTIONABLE_QUEUE_STATES = new Set(['submitted', 'late', 'needs-revision']);

/**
 * Whether a grading queue row should appear for the given status filter.
 * @param {string} queueState from gradingQueueState().state
 * @param {string} stateFilter '' | 'actionable' | specific state
 */
export function shouldIncludeInGradingQueue(queueState, stateFilter) {
  if (stateFilter === 'actionable') {
    return ACTIONABLE_QUEUE_STATES.has(queueState);
  }
  if (stateFilter) {
    return queueState === stateFilter;
  }
  return true;
}

/**
 * Pure plan for el() prop application (testable without DOM).
 * @param {string} key
 * @param {unknown} value
 */
export function planDomProp(key, value) {
  if (key === 'className') return { action: 'className', value };
  if (key === 'text') return { action: 'text', value };
  if (key === 'htmlFor') return { action: 'property', name: 'htmlFor', value };
  if (key.startsWith('on') && typeof value === 'function') {
    return { action: 'listener', event: key.slice(2).toLowerCase(), value };
  }
  if (value == null) return { action: 'none' };
  if (typeof value === 'boolean' && BOOLEAN_DOM_PROPERTY_KEYS.has(key)) {
    return { action: 'booleanProperty', name: key, value };
  }
  if (typeof value === 'boolean' && key.startsWith('aria-')) {
    return { action: 'attribute', name: key, value: String(value) };
  }
  if (typeof value === 'boolean') {
    return value ? { action: 'attribute', name: key, value: '' } : { action: 'none' };
  }
  return { action: 'attribute', name: key, value: String(value) };
}

/** Dashboard aggregates from raw data */
export function computeDashboardMetrics({
  classes,
  students,
  assignments,
  submissions,
  memberships = null,
  now = new Date(),
}) {
  const classCount = classes.length;
  let missingCount = 0;
  let toGradeCount = 0;
  let onTimeTotal = 0;
  let submittedTotal = 0;
  const atIso = now instanceof Date ? now.toISOString() : String(now);

  for (const assignment of assignments) {
    const classStudents = getStudentsInClass(students, assignment.classId, memberships, atIso);
    for (const st of classStudents) {
      const sub = submissions.find(
        (s) => s.assignmentId === assignment.id && s.studentId === st.id,
      );
      const q = gradingQueueState(sub, assignment, now);
      if (q.state === 'missing') missingCount += 1;
      else {
        submittedTotal += 1;
        const timing = classifyDeadlineTiming(sub?.firstSubmittedAt, assignment.dueDateISO);
        if (timing.onTime) onTimeTotal += 1;
        const latest = sub.versions[sub.versions.length - 1];
        if (
          latest &&
          !latest.isDraft &&
          (latest.status === SUBMISSION_STATUS.SUBMITTED ||
            latest.status === SUBMISSION_STATUS.GRADING)
        ) {
          toGradeCount += 1;
        }
      }
    }
  }

  const onTimePct =
    submittedTotal > 0 ? Math.round((onTimeTotal / submittedTotal) * 100) : 0;

  return {
    classCount,
    missingCount,
    toGradeCount,
    onTimePct,
  };
}

export function formatDateVi(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('vi-VN', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
}

export function formatDateTimeVi(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('vi-VN', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function daysLate(firstSubmittedAt, dueDateISO) {
  const timing = classifyDeadlineTiming(firstSubmittedAt, dueDateISO);
  if (timing.missing || timing.onTime) return 0;
  const dueEnd = deadlineInstant(dueDateISO);
  const first = new Date(firstSubmittedAt);
  if (!dueEnd) return 0;
  const diffMs = first.getTime() - dueEnd.getTime();
  return Math.ceil(diffMs / (24 * 60 * 60 * 1000));
}

/** Export schema v1 */
export const BACKUP_SCHEMA_VERSION = 1;

function isId(value) {
  return typeof value === 'string' && value.length > 0 && value.length < 200;
}

function isStringField(value, maxLen = 5000) {
  return typeof value === 'string' && value.length <= maxLen;
}

const VALID_SUBMISSION_STATUSES = new Set(Object.values(SUBMISSION_STATUS));

function validateGradingPages(pages, label) {
  if (!Array.isArray(pages)) {
    return { ok: false, error: `${label} không hợp lệ.` };
  }
  for (const pg of pages) {
    if (!pg || typeof pg !== 'object' || !Array.isArray(pg.annotations)) {
      return { ok: false, error: 'Chú thích trang chấm không hợp lệ.' };
    }
    for (const ann of pg.annotations) {
      const mv = validateAnnotationMark(ann);
      if (!mv.ok) {
        return { ok: false, error: mv.error || 'Chú thích không hợp lệ.' };
      }
    }
  }
  return { ok: true };
}

function validateTeacherUndoStacks(stacks, pageCount) {
  if (stacks == null) return { ok: true };
  if (typeof stacks !== 'object' || Array.isArray(stacks)) {
    return { ok: false, error: 'Undo chấm nháp không hợp lệ.' };
  }
  for (const [key, stack] of Object.entries(stacks)) {
    if (!/^\d+$/.test(key) || Number(key) < 0 || Number(key) >= pageCount) {
      return { ok: false, error: 'Undo chấm nháp tham chiếu trang không hợp lệ.' };
    }
    if (!stack || typeof stack !== 'object') {
      return { ok: false, error: 'Undo chấm nháp không hợp lệ.' };
    }
    for (const side of ['past', 'future']) {
      if (!Array.isArray(stack[side])) {
        return { ok: false, error: 'Undo chấm nháp không hợp lệ.' };
      }
      for (const snap of stack[side]) {
        if (typeof snap !== 'string') {
          return { ok: false, error: 'Undo chấm nháp không hợp lệ.' };
        }
        let parsed;
        try {
          parsed = JSON.parse(snap);
        } catch {
          return { ok: false, error: 'Undo chấm nháp không hợp lệ.' };
        }
        if (!Array.isArray(parsed)) {
          return { ok: false, error: 'Undo chấm nháp không hợp lệ.' };
        }
        for (const ann of parsed) {
          const mv = validateAnnotationMark(ann);
          if (!mv.ok) {
            return { ok: false, error: mv.error || 'Undo chấm nháp chứa chú thích không hợp lệ.' };
          }
        }
      }
    }
  }
  return { ok: true };
}

function validateTeacherGradingDraftContainers(teacherGrading) {
  if (teacherGrading.pages != null && !Array.isArray(teacherGrading.pages)) {
    return { ok: false, error: 'Trang nháp chấm không hợp lệ.' };
  }
  if (Array.isArray(teacherGrading.pages)) {
    for (const pg of teacherGrading.pages) {
      if (pg != null && typeof pg !== 'object') {
        return { ok: false, error: 'Trang nháp chấm không hợp lệ.' };
      }
      if (
        pg != null &&
        pg.annotations != null &&
        !Array.isArray(pg.annotations)
      ) {
        return { ok: false, error: 'Chú thích trang chấm không hợp lệ.' };
      }
    }
  }
  if (
    teacherGrading.undoStacks != null &&
    (typeof teacherGrading.undoStacks !== 'object' || Array.isArray(teacherGrading.undoStacks))
  ) {
    return { ok: false, error: 'Undo chấm nháp không hợp lệ.' };
  }
  return { ok: true };
}

/**
 * Ensures teacher grading drafts always have pages[] and undoStacks{} before editor use.
 */
export function normalizeTeacherGradingDraft(teacherGrading, pageCount = 0) {
  const count = Math.max(0, pageCount);
  if (teacherGrading == null) {
    return {
      score: '',
      overallFeedback: '',
      pages: Array.from({ length: count }, () => ({ annotations: [] })),
      undoStacks: {},
    };
  }
  const pages = Array.isArray(teacherGrading.pages)
    ? teacherGrading.pages.map((pg) => ({
        annotations: Array.isArray(pg?.annotations) ? pg.annotations : [],
      }))
    : Array.from({ length: count }, () => ({ annotations: [] }));
  while (pages.length < count) {
    pages.push({ annotations: [] });
  }
  const undoStacks =
    teacherGrading.undoStacks &&
    typeof teacherGrading.undoStacks === 'object' &&
    !Array.isArray(teacherGrading.undoStacks)
      ? teacherGrading.undoStacks
      : {};
  return {
    score: teacherGrading.score ?? '',
    overallFeedback: teacherGrading.overallFeedback ?? '',
    pages,
    undoStacks,
  };
}

export function validateTeacherGradingDraft(teacherGrading, pageCount = 0) {
  if (teacherGrading == null) return { ok: true };
  if (typeof teacherGrading !== 'object') {
    return { ok: false, error: 'Nháp chấm giáo viên không hợp lệ.' };
  }
  if (teacherGrading.score != null && !isStringField(String(teacherGrading.score), 20)) {
    return { ok: false, error: 'Điểm nháp không hợp lệ.' };
  }
  if (
    teacherGrading.overallFeedback != null &&
    !isStringField(String(teacherGrading.overallFeedback), 10000)
  ) {
    return { ok: false, error: 'Nhận xét nháp không hợp lệ.' };
  }
  const containerCheck = validateTeacherGradingDraftContainers(teacherGrading);
  if (!containerCheck.ok) return containerCheck;
  const normalized = normalizeTeacherGradingDraft(teacherGrading, pageCount);
  const pv = validateGradingPages(normalized.pages, 'Trang nháp chấm');
  if (!pv.ok) return pv;
  if (pageCount > 0 && normalized.pages.length > pageCount) {
    return { ok: false, error: 'Trang nháp chấm vượt quá số trang bài.' };
  }
  const uv = validateTeacherUndoStacks(
    normalized.undoStacks,
    pageCount || normalized.pages.length || 0,
  );
  if (!uv.ok) return uv;
  return { ok: true };
}

function stableBackupJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => stableBackupJson(v)).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableBackupJson(value[k])}`).join(',')}}`;
}

function backupRecordsMatch(a, b) {
  return stableBackupJson(a) === stableBackupJson(b);
}

/** Strip server/client-only fields so legacy re-import compares semantic assignment data. */
function normalizeRecordForLegacyMigrateCompare(kind, rec) {
  if (!rec || typeof rec !== 'object') return rec;
  if (kind !== 'assignment') return rec;
  const out = { ...rec };
  delete out.attachments;
  const ids = Array.isArray(out.attachmentIds) ? out.attachmentIds.filter(Boolean) : [];
  if (ids.length === 0) delete out.attachmentIds;
  else out.attachmentIds = [...ids].sort();
  return out;
}

/**
 * Detect ID collisions where an incoming legacy backup disagrees with live server records.
 * Identical payloads are safe (repeat import). Conflicts must be resolved before any writes.
 */
export function assessLegacyLocalMigrate(liveState, backup) {
  if (!liveState || !backup) {
    return { ok: false, error: 'Dữ liệu không hợp lệ.', conflicts: [] };
  }
  /** @type {{ kind: string, id: string }[]} */
  const conflicts = [];
  const checkList = (kind, liveList, incomingList) => {
    for (const rec of incomingList || []) {
      if (!rec?.id) continue;
      const existing = (liveList || []).find((x) => x.id === rec.id);
      if (!existing) continue;
      const left = normalizeRecordForLegacyMigrateCompare(kind, existing);
      const right = normalizeRecordForLegacyMigrateCompare(kind, rec);
      if (!backupRecordsMatch(left, right)) {
        conflicts.push({ kind, id: rec.id });
      }
    }
  };
  checkList('class', liveState.classes, backup.classes);
  checkList('student', liveState.students, backup.students);
  checkList('assignment', liveState.assignments, backup.assignments);
  if (conflicts.length) {
    return {
      ok: false,
      error:
        'Backup xung đột với dữ liệu trên máy chủ (cùng mã ID nhưng nội dung khác). '
        + 'Giữ nguyên dữ liệu hiện tại, chỉnh backup hoặc xóa bản ghi trùng trên máy chủ rồi nhập lại.',
      conflicts,
    };
  }
  return { ok: true, conflicts: [] };
}

/**
 * Merge validated legacy backup rows into live state (idempotent on identical payloads).
 * Caller must run assessLegacyLocalMigrate on fresh state immediately before this.
 */
export function applyLegacyLocalMigrateRecords(state, backup) {
  if (!state || !backup) throw new Error('migrate-invalid');
  const mergeList = (kind, listKey, incoming) => {
    const target = state[listKey];
    if (!Array.isArray(target)) throw new Error('migrate-invalid');
    for (const rec of incoming || []) {
      if (!rec?.id) continue;
      const idx = target.findIndex((x) => x.id === rec.id);
      if (idx >= 0) {
        const left = normalizeRecordForLegacyMigrateCompare(kind, target[idx]);
        const right = normalizeRecordForLegacyMigrateCompare(kind, rec);
        if (backupRecordsMatch(left, right)) continue;
        throw new Error('migrate-conflict');
      }
      target.push(rec);
    }
  };
  mergeList('class', 'classes', backup.classes);
  mergeList('student', 'students', backup.students);
  mergeList('assignment', 'assignments', backup.assignments);
  for (const sub of backup.submissions || []) {
    if (!sub?.id) continue;
    const idx = state.submissions.findIndex((x) => x.id === sub.id);
    if (idx >= 0) continue;
    state.submissions.push(sub);
  }
}

export function validateBackup(data) {
  if (!data || typeof data !== 'object') {
    return { ok: false, error: 'Dữ liệu không hợp lệ.' };
  }
  if (data.schemaVersion !== BACKUP_SCHEMA_VERSION) {
    return { ok: false, error: 'Phiên bản backup không được hỗ trợ.' };
  }
  for (const key of ['classes', 'students', 'assignments', 'submissions']) {
    if (!Array.isArray(data[key])) {
      return { ok: false, error: `Thiếu mảng ${key}.` };
    }
  }

  const classIds = new Set();
  for (const c of data.classes) {
    if (!c || typeof c !== 'object' || !isId(c.id)) {
      return { ok: false, error: 'Bản ghi lớp không hợp lệ.' };
    }
    if (!isStringField(c.name, 200)) {
      return { ok: false, error: 'Tên lớp không hợp lệ.' };
    }
    if (!Array.isArray(c.scheduleDays) || !c.scheduleDays.every((d) => isStringField(d, 40))) {
      return { ok: false, error: 'Lịch lớp không hợp lệ.' };
    }
    if (!isStringField(c.scheduleTime || '', 20)) {
      return { ok: false, error: 'Giờ học lớp không hợp lệ.' };
    }
    classIds.add(c.id);
  }

  const studentIds = new Set();
  for (const s of data.students) {
    if (!s || typeof s !== 'object' || !isId(s.id)) {
      return { ok: false, error: 'Bản ghi học sinh không hợp lệ.' };
    }
    if (!isStringField(s.name, 200)) {
      return { ok: false, error: 'Tên học sinh không hợp lệ.' };
    }
    if (!isId(s.classId) || !classIds.has(s.classId)) {
      return { ok: false, error: 'Học sinh tham chiếu lớp không tồn tại.' };
    }
    studentIds.add(s.id);
  }

  const assignmentIds = new Set();
  for (const a of data.assignments) {
    if (!a || typeof a !== 'object' || !isId(a.id)) {
      return { ok: false, error: 'Bản ghi bài tập không hợp lệ.' };
    }
    if (!isId(a.classId) || !classIds.has(a.classId)) {
      return { ok: false, error: 'Bài tập tham chiếu lớp không tồn tại.' };
    }
    if (!isStringField(a.title, 300) || !isStringField(a.bookRef, 300)) {
      return { ok: false, error: 'Tiêu đề/sách bài tập không hợp lệ.' };
    }
    const backupAttachIds = Array.isArray(a.attachmentIds) ? a.attachmentIds : [];
    if (!a.bookRef.trim() && backupAttachIds.length === 0) {
      return { ok: false, error: 'Bài tập cần sách/trang hoặc tệp đính kèm.' };
    }
    if (backupAttachIds.length > 10) {
      return { ok: false, error: 'Quá nhiều tệp đính kèm trong backup.' };
    }
    for (const aid of backupAttachIds) {
      if (!isId(aid)) {
        return { ok: false, error: 'Mã tệp đính kèm không hợp lệ.' };
      }
    }
    if (!isStringField(String(a.dueDateISO || ''), 40)) {
      return { ok: false, error: 'Hạn bài tập không hợp lệ.' };
    }
    const pages = Number(a.requiredPageCount);
    if (!Number.isFinite(pages) || pages < 1) {
      return { ok: false, error: 'Số trang bài tập không hợp lệ.' };
    }
    assignmentIds.add(a.id);
  }

  for (const sub of data.submissions) {
    if (!sub || typeof sub !== 'object' || !isId(sub.id)) {
      return { ok: false, error: 'Bản ghi nộp bài không hợp lệ.' };
    }
    if (!isId(sub.assignmentId) || !assignmentIds.has(sub.assignmentId)) {
      return { ok: false, error: 'Nộp bài tham chiếu bài tập không tồn tại.' };
    }
    if (!isId(sub.studentId) || !studentIds.has(sub.studentId)) {
      return { ok: false, error: 'Nộp bài tham chiếu học sinh không tồn tại.' };
    }
    if (sub.firstSubmittedAt != null && !isStringField(String(sub.firstSubmittedAt), 40)) {
      return { ok: false, error: 'firstSubmittedAt không hợp lệ.' };
    }
    if (!Array.isArray(sub.versions)) {
      return { ok: false, error: 'Phiên bản nộp bài không hợp lệ.' };
    }
    for (const v of sub.versions) {
      if (!v || typeof v !== 'object' || !isId(v.versionId)) {
        return { ok: false, error: 'Phiên bản nộp không hợp lệ.' };
      }
      if (typeof v.isDraft !== 'boolean') {
        return { ok: false, error: 'Trạng thái nháp phiên bản không hợp lệ.' };
      }
      if (v.status && !VALID_SUBMISSION_STATUSES.has(v.status)) {
        return { ok: false, error: 'Trạng thái nộp bài không hợp lệ.' };
      }
      if (!Array.isArray(v.pageImageIds)) {
        return { ok: false, error: 'Danh sách trang ảnh không hợp lệ.' };
      }
      if (v.grading != null) {
        if (typeof v.grading !== 'object') {
          return { ok: false, error: 'Dữ liệu chấm không hợp lệ.' };
        }
        if (v.grading.published === true && !Array.isArray(v.grading.pages)) {
          return { ok: false, error: 'Trang chấm đã trả không hợp lệ.' };
        }
        if (Array.isArray(v.grading.pages)) {
          const pv = validateGradingPages(v.grading.pages, 'Trang chấm đã trả');
          if (!pv.ok) return pv;
        }
      }
      if (v.teacherGrading != null) {
        const tv = validateTeacherGradingDraft(v.teacherGrading, v.pageImageIds?.length || 0);
        if (!tv.ok) return tv;
      }
    }
  }

  return { ok: true };
}

/** Escape for textContent usage — returns string safe to assign to textContent */
export function safeText(str) {
  if (str == null) return '';
  return String(str);
}

export function buildAssignmentShareLink(origin, assignmentId) {
  const base = origin.replace(/\/$/, '');
  return `${base}/#/assignment/${assignmentId}`;
}

export function buildZaloReminderText(assignment, className, link) {
  const bookLine = assignment.bookRef?.trim()
    ? `Sách/trang: ${assignment.bookRef}\n`
    : (assignment.attachments?.length || assignment.attachmentIds?.length)
      ? `Tệp đính kèm: ${(assignment.attachments?.length || assignment.attachmentIds?.length || 0)} tệp\n`
      : '';
  return (
    `[Bài Nhà - demo]\n` +
    `Lớp: ${className}\n` +
    `Bài: ${assignment.title}\n` +
    `Hạn: ${formatDateVi(assignment.dueDateISO)}\n` +
    bookLine +
    `Link bài tập: ${link}\n` +
    `(Tin nhắn demo — chưa gửi qua Zalo.)`
  );
}

export const ASSIGNMENT_ATTACHMENT_LIMITS = Object.freeze({
  maxFiles: 10,
  maxBytes: 20 * 1024 * 1024,
  accept: '.jpg,.jpeg,.png,.webp,.pdf,.doc,.docx',
  acceptMime:
    'image/jpeg,image/png,image/webp,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document',
});

export function formatAttachmentSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function validateAssignmentAttachmentFile(file) {
  if (!file) return { ok: false, error: 'Không có tệp.' };
  if (file.size > ASSIGNMENT_ATTACHMENT_LIMITS.maxBytes) {
    return { ok: false, error: 'Tệp quá lớn (tối đa 20 MB).' };
  }
  const name = String(file.name || '').toLowerCase();
  const ext = name.includes('.') ? name.split('.').pop() : '';
  const allowed = new Set(['jpg', 'jpeg', 'png', 'webp', 'pdf', 'doc', 'docx']);
  if (!allowed.has(ext)) {
    return { ok: false, error: 'Chỉ hỗ trợ JPG, PNG, WebP, PDF, DOC, DOCX.' };
  }
  return { ok: true };
}

export function enrichAssignmentWithAttachments(assignment, attachmentMeta = {}) {
  const ids = Array.isArray(assignment.attachmentIds) ? assignment.attachmentIds : [];
  const attachments = ids.map((id) => {
    const m = attachmentMeta[id];
    if (!m) return null;
    const row = {
      id: m.id,
      filename: m.filename,
      mime: m.mime,
      size: m.size,
    };
    if (m.contentFingerprint) row.contentFingerprint = m.contentFingerprint;
    return row;
  }).filter(Boolean);
  return { ...assignment, attachmentIds: ids, attachments };
}

export function validateAssignmentInput({
  title,
  classId,
  bookRef,
  dueDateISO,
  requiredPageCount,
  attachmentIds,
}) {
  if (!title?.trim()) return { ok: false, error: 'Vui lòng nhập tiêu đề.' };
  if (!classId) return { ok: false, error: 'Vui lòng chọn lớp.' };
  const ids = Array.isArray(attachmentIds) ? attachmentIds.filter(Boolean) : [];
  const hasBook = !!String(bookRef || '').trim();
  if (!hasBook && ids.length === 0) {
    return { ok: false, error: 'Nhập sách/trang hoặc đính kèm ít nhất một tệp.' };
  }
  if (ids.length > ASSIGNMENT_ATTACHMENT_LIMITS.maxFiles) {
    return { ok: false, error: `Tối đa ${ASSIGNMENT_ATTACHMENT_LIMITS.maxFiles} tệp mỗi bài tập.` };
  }
  if (!dueDateISO) return { ok: false, error: 'Vui lòng chọn hạn nộp.' };
  const pages = Number(requiredPageCount);
  if (!Number.isFinite(pages) || pages < 1) {
    return { ok: false, error: 'Số trang yêu cầu phải ≥ 1.' };
  }
  return { ok: true, attachmentIds: ids };
}

/** Merge schedule fields for class PUT: omit preserves legacy; new rows default to []. */
export function normalizeClassScheduleForPut(rec, prev = null) {
  const hasDays = rec && Object.prototype.hasOwnProperty.call(rec, 'scheduleDays');
  const hasTime = rec && Object.prototype.hasOwnProperty.call(rec, 'scheduleTime');
  let scheduleDays;
  let scheduleTime;
  if (hasDays) {
    scheduleDays = Array.isArray(rec.scheduleDays)
      ? rec.scheduleDays.filter((d) => typeof d === 'string' && d.trim()).map((d) => d.trim())
      : [];
  } else if (prev) {
    scheduleDays = Array.isArray(prev.scheduleDays) ? [...prev.scheduleDays] : [];
  } else {
    scheduleDays = [];
  }
  if (hasTime) {
    scheduleTime = String(rec.scheduleTime ?? '').trim();
  } else if (prev) {
    scheduleTime = String(prev.scheduleTime ?? '').trim();
  } else {
    scheduleTime = '';
  }
  return { scheduleDays, scheduleTime };
}

export function validateClassInput({ name, scheduleDays, scheduleTime }) {
  if (!name?.trim()) return { ok: false, error: 'Vui lòng nhập tên lớp.' };
  if (scheduleDays != null) {
    if (!Array.isArray(scheduleDays)) return { ok: false, error: 'Lịch lớp không hợp lệ.' };
    for (const d of scheduleDays) {
      if (!isStringField(d, 40)) return { ok: false, error: 'Lịch lớp không hợp lệ.' };
    }
  }
  if (scheduleTime != null && scheduleTime !== '' && !isStringField(String(scheduleTime), 20)) {
    return { ok: false, error: 'Giờ học lớp không hợp lệ.' };
  }
  return { ok: true };
}

/** Next non-cancelled session at or after nowIso for a class (by earliest startAt). */
export function findNextUpcomingClassSession(classSessions, classId, nowIso = new Date().toISOString()) {
  if (!classId) return null;
  let best = null;
  for (const s of classSessions || []) {
    if (!s || s.classId !== classId) continue;
    if (s.status === 'cancelled') continue;
    if (!s.startAt || String(s.startAt) < String(nowIso)) continue;
    if (!best || s.startAt < best.startAt) best = s;
  }
  return best;
}

export function validateStudentInput({ name, classId }) {
  if (!name?.trim()) return { ok: false, error: 'Vui lòng nhập tên học sinh.' };
  if (!classId) return { ok: false, error: 'Chọn lớp.' };
  return { ok: true };
}

export function normalizeDisplayName(name) {
  return String(name || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

export function findDuplicateClassName(classes, name, excludeId = null) {
  const norm = normalizeDisplayName(name);
  if (!norm) return null;
  return classes.find((c) => c.id !== excludeId && normalizeDisplayName(c.name) === norm) || null;
}

export function findDuplicateStudentName(students, classId, name, excludeId = null) {
  const norm = normalizeDisplayName(name);
  if (!norm || !classId) return null;
  return students.find(
    (s) => s.id !== excludeId && s.classId === classId && normalizeDisplayName(s.name) === norm,
  ) || null;
}

export function findDuplicateAssignmentTitle(assignments, classId, title, excludeId = null) {
  const norm = normalizeDisplayName(title);
  if (!norm || !classId) return null;
  return assignments.find(
    (a) => a.id !== excludeId && a.classId === classId && normalizeDisplayName(a.title) === norm,
  ) || null;
}

export async function fileContentFingerprint(file) {
  const size = Number(file?.size) || 0;
  let hashPart = '';
  if (file && typeof file.arrayBuffer === 'function' && globalThis.crypto?.subtle) {
    const buf = await file.arrayBuffer();
    const digest = await crypto.subtle.digest('SHA-256', buf);
    hashPart = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  if (hashPart) return hashPart;
  return `size:${size}`;
}

/** @param {Set<Promise<any>>|Iterable<Promise<any>>} inFlightSet */
export async function waitForInFlightUploads(inFlightSet) {
  if (!inFlightSet) return;
  const list = inFlightSet instanceof Set ? [...inFlightSet] : [...inFlightSet];
  if (!list.length) return;
  await Promise.all(list);
}

export const PASSWORD_RULES_HINT =
  'Mật khẩu 8–128 ký tự. Học sinh lần đầu phải đổi mật khẩu trước khi dùng app.';

export const COMMENT_TEMPLATES = [
  'Sai thì',
  'Thiếu mạo từ',
  'Kiểm tra chính tả',
];

export const IMAGE_LIMITS = Object.freeze({
  maxFiles: 20,
  maxBytesPerFile: 8 * 1024 * 1024,
  maxDimension: 2000,
  acceptedTypes: ['image/jpeg', 'image/png', 'image/webp'],
});

export function validateImageFile(file) {
  if (!file) return { ok: false, error: 'Không có tệp.' };
  const type = (file.type || '').toLowerCase();
  if (type.includes('heic') || type.includes('heif')) {
    return {
      ok: false,
      error:
        'HEIC/HEIF chưa hỗ trợ. Chuyển sang JPEG/PNG trong Ảnh (iPhone) ho hoặc dùng ảnh chụp màn hình.',
    };
  }
  if (!IMAGE_LIMITS.acceptedTypes.includes(type)) {
    return { ok: false, error: 'Chỉ hỗ trợ JPEG, PNG, WebP.' };
  }
  if (file.size > IMAGE_LIMITS.maxBytesPerFile) {
    return { ok: false, error: 'Ảnh quá lớn (tối đa 8 MB mỗi ảnh).' };
  }
  return { ok: true };
}
