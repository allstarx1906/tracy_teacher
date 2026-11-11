import { el, localInputToIso } from './ba-ui-dom.js';
import { uploadTeacherAttachment } from './api-client.js';
import {
  fetchExamTeacherSummary,
  startExamImport,
  fetchExamImportJob,
  fetchExamDraft,
  saveExamDraft,
  publishExamDraft,
  createExamDraft,
  createPdfOnlyExamDraft,
  fetchExamBankDetail,
  reviseExamVersion,
  appendComposedQuestionsToDraft,
  fetchExamComposeSource,
  createExamAssignment,
  fetchExamAssignmentSummary,
  fetchExamAssignmentGrading,
  saveExamVersionAnswerKey,
  saveExamVersionTextAnswerKey,
  saveExamAttemptManualGrades,
  fetchTeacherExamVersionStudentPreview,
  examDraftSourceUrl,
  pdfJsModuleUrl,
  pdfJsWorkerUrl,
  teacherExamSourcePdfUrl,
  teacherExamVersionSourcePdfUrl,
  saveTeacherPdfAnnotations,
  saveTeacherPdfManualGrade,
  saveExamDraftMedia,
  teacherAttachmentPreviewUrl,
} from './exam-api.js';
import { mountExamPdfEditor } from './exam-pdf-editor.js';
import { withBusyButton, registerDirtyProbe, bumpDirtyNavigationGuard } from './ux-forms.js';
import {
  createExamDraftSaveCoordinator,
  snapshotExamDraftPutPayload,
  applyExamDraftSaveAck,
} from './ux-exam-draft-save.js';
import {
  validateDraftForPublish,
  buildContaminationImportWarning,
  scanExamContentContamination,
  resolveDraftReviewNavigation,
  resolvePublishValidationError,
  publishErrorMessage,
  EXAM_GRADING_MODE,
  normalizeExamGradingMode,
  draftMissingAnswerKeyCount,
  resolveVersionAnswerKey,
  newExamQuestionId,
  newExamSectionId,
  defaultOptionIds,
  normalizeReadingGroup,
  parseExpectedQuestionRange,
  readingGroupQuestionNumbers,
  readingGroupAllDocsFilled,
  readingGroupMissingRequiredContext,
  draftPassagesPendingContextConfirmation,
  draftReadingGroupNeedsReview,
  draftQuestionNeedsReview,
  draftImportWarningStillActive,
  computeDraftReviewFilterCounts,
  buildTeacherPreviewExamProjection,
  formatImportWarningDisplay,
  EXAM_ASSIGNMENT_PURPOSE,
  EXAM_DELIVERY_MODE,
  normalizeExamAssignmentPurpose,
  examAssignmentTypeBadge,
  versionHasAssignableOnlineQuestions,
  versionHasSourcePdf,
  validateExamAssignmentDelivery,
  assignmentRequiredParts,
  resolveBankExamId,
  nextUniqueExamDisplayNumber,
  sortExamQuestionsByOrder,
  pruneUnusedExamPassages,
  countComposerSelectionsBySource,
  formatComposerSelectionSummaryVi,
  EXAM_QUESTION_TYPE,
  normalizeExamQuestionType,
  isChoiceBasedQuestion,
  isManualOnlyQuestion,
  isAutoGradableQuestion,
  questionUsesOptionsForPublish,
  summarizeExamItems,
  formatExamHubItemMeta,
  EXAM_SKILL,
  inferExamSkillFromQuestion,
  normalizeExamSkill,
  computeExamMetadataFilterCounts,
  parseExamMetadataFilters,
} from './exam-domain.js';
import { openTeacherExamStudentPreview, renderReadingGroupCard, mountExamTakeQuestionUi } from './exam-ui-student.js';
import { formatDateVi } from './model.js';

function prefersReducedMotion() {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function escapeDomAttr(value) {
  const s = String(value ?? '');
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(s);
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Inline SVG pencil icon for draft edit triggers (matches compact btn-sm usage). */
function examDraftPencilIconSvg() {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('xmlns', SVG_NS);
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '18');
  svg.setAttribute('height', '18');
  svg.setAttribute('fill', 'currentColor');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute(
    'd',
    'M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34a.9959.9959 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z',
  );
  svg.appendChild(path);
  return svg;
}

let activeTeacherStudentPreviewDispose = null;

function closeActiveTeacherStudentPreview() {
  if (typeof activeTeacherStudentPreviewDispose === 'function') {
    activeTeacherStudentPreviewDispose();
    activeTeacherStudentPreviewDispose = null;
  }
}

function openTeacherStudentPreviewFromContent(ctx, content, assignmentPolicy) {
  closeActiveTeacherStudentPreview();
  const exam = buildTeacherPreviewExamProjection(content, assignmentPolicy || null);
  activeTeacherStudentPreviewDispose = openTeacherExamStudentPreview(ctx, exam, {
    assignmentPolicy,
    onClose: () => {
      activeTeacherStudentPreviewDispose = null;
    },
  });
}

async function openTeacherStudentPreviewFromVersion(ctx, versionId, assignmentPolicy) {
  closeActiveTeacherStudentPreview();
  try {
    const data = await fetchTeacherExamVersionStudentPreview(versionId);
    const content = {
      id: data.exam.versionId || versionId,
      title: data.exam.title,
      sections: data.exam.sections,
      passages: data.exam.passages,
      questions: data.exam.questions,
      audioAttachmentId: data.exam?.media?.audioAttachmentId || data.version?.audioAttachmentId || null,
      audioState: data.exam?.media?.audioState || data.version?.audioState || null,
      mediaBindings: data.exam?.media?.mediaBindings || null,
      mediaRevision: data.exam?.media?.mediaRevision || 0,
      classroomPlaybackAllowed: data.exam?.classroomPlaybackAllowed || data.version?.classroomPlaybackAllowed,
      sourceAttachmentId: data.version?.sourceAttachmentId || null,
      sourcePdfPageCount: data.version?.sourcePdfPageCount || null,
    };
    const exam = buildTeacherPreviewExamProjection(content, assignmentPolicy || null);
    activeTeacherStudentPreviewDispose = openTeacherExamStudentPreview(ctx, exam, {
      assignmentPolicy,
      onClose: () => {
        activeTeacherStudentPreviewDispose = null;
      },
    });
  } catch (e) {
    ctx.toastErr(e.message || 'Không mở được xem trước.');
  }
}

function examDraftTargetPresent(root, target) {
  if (!target || !root?.querySelector) return false;
  if (target.kind === 'question') {
    return !!root.querySelector(`[data-question-id="${escapeDomAttr(target.questionId)}"]`);
  }
  if (target.kind === 'passage') {
    return !!root.querySelector(`[data-passage-id="${escapeDomAttr(target.passageId)}"]`);
  }
  if (target.kind === 'document') {
    return !!root.querySelector(`[data-document-id="${escapeDomAttr(target.documentId)}"]`);
  }
  if (target.kind === 'title') return !!root.querySelector('[data-exam-target="title"]');
  if (target.kind === 'reviewConfirm') return !!root.querySelector('#exam-review-ok');
  if (target.kind === 'gradingMode') return !!root.querySelector('#exam-grading-mode-manual');
  return false;
}

function focusExamDraftTarget(root, target) {
  if (!root || !target) return false;
  let scrollNode = null;
  let focusNode = null;

  if (target.kind === 'question') {
    const block = root.querySelector(`[data-question-id="${escapeDomAttr(target.questionId)}"]`);
    if (!block) return false;
    scrollNode = block;
    if (target.focusRole === 'key') {
      focusNode = block.querySelector('.exam-draft-q-edit-panel input[type="radio"]')
        || block.querySelector('input[type="radio"]')
        || block;
    } else if (target.focusRole === 'options') {
      focusNode = block.querySelector('.exam-draft-q-edit-panel input[type="text"]')
        || block.querySelector('input[type="text"]')
        || block.querySelector('.exam-draft-q-edit-panel textarea')
        || block.querySelector('textarea')
        || block;
    } else {
      focusNode = block.querySelector('[data-exam-draft-q-stem-editor]')
        || block.querySelector('.exam-draft-q-edit-panel textarea')
        || block.querySelector('textarea')
        || block;
    }
  } else if (target.kind === 'passage') {
    const block = root.querySelector(`[data-passage-id="${escapeDomAttr(target.passageId)}"]`);
    if (!block) return false;
    scrollNode = block;
    if (target.focusRole === 'contextConfirm') {
      focusNode = block.querySelector('input[type="checkbox"]') || block;
    } else {
      focusNode = block.querySelector('.exam-draft-passage-edit-panel textarea')
        || block.querySelector('textarea')
        || block;
    }
  } else if (target.kind === 'document') {
    const block = root.querySelector(`[data-document-id="${escapeDomAttr(target.documentId)}"]`);
    if (!block) return false;
    scrollNode = block;
    focusNode = block.querySelector('.exam-draft-doc-edit-panel textarea')
      || block.querySelector('textarea')
      || block;
  } else if (target.kind === 'title') {
    scrollNode = root.querySelector('[data-exam-target="title"]');
    focusNode = scrollNode;
  } else if (target.kind === 'reviewConfirm') {
    scrollNode = root.querySelector('#exam-review-ok');
    focusNode = scrollNode;
  } else if (target.kind === 'gradingMode') {
    scrollNode = root.querySelector('#exam-grading-mode-panel');
    focusNode = root.querySelector('#exam-grading-mode-manual') || scrollNode;
  }

  if (!scrollNode) return false;
  scrollNode.scrollIntoView({
    behavior: prefersReducedMotion() ? 'auto' : 'smooth',
    block: 'center',
  });
  if (focusNode?.focus) focusNode.focus({ preventScroll: true });
  const flashEl = scrollNode;
  flashEl.classList?.add('exam-draft-target-flash');
  const flashMs = prefersReducedMotion() ? 700 : 1400;
  globalThis.setTimeout?.(() => flashEl.classList?.remove('exam-draft-target-flash'), flashMs);
  return true;
}

function pinDraftReviewTarget(reviewFilterPinned, target) {
  if (!target || !reviewFilterPinned) return;
  if (target.questionId) reviewFilterPinned.questionIds.add(target.questionId);
  if (target.passageId) reviewFilterPinned.passageIds.add(target.passageId);
  if (target.documentId && target.passageId) reviewFilterPinned.passageIds.add(target.passageId);
}

function draftReviewTargetVisible(root, draftState, reviewFilterMode, reviewFilterPinned, target) {
  if (reviewFilterMode === 'all') return examDraftTargetPresent(root, target);
  if (examDraftTargetPresent(root, target)) return true;
  return false;
}

function shouldRenderReadingGroup(draftState, raw, reviewFilterMode, reviewFilterPinned) {
  if (reviewFilterMode === 'all') return true;
  const g = normalizeReadingGroup(raw);
  if (reviewFilterPinned.passageIds.has(g.id)) return true;
  if (draftReadingGroupNeedsReview(draftState, raw)) return true;
  for (const q of draftState.questions || []) {
    if (reviewFilterPinned.questionIds.has(q.id)) continue;
    if (!draftQuestionNeedsReview(draftState, q)) continue;
    if (q.passageId === g.id || q.groupId === g.id) return true;
    const range = parseExpectedQuestionRange(g);
    if (range) {
      const v = parseInt(q.displayNumber, 10);
      if (Number.isFinite(v) && v >= range.min && v <= range.max) return true;
    }
  }
  return false;
}

function questionBelongsToReadingGroupNeedingReview(draftState, q) {
  for (const raw of draftState.passages || []) {
    const g = normalizeReadingGroup(raw);
    const linked = q.passageId === g.id || q.groupId === g.id;
    const range = parseExpectedQuestionRange(g);
    const inRange = range && (() => {
      const v = parseInt(q.displayNumber, 10);
      return Number.isFinite(v) && v >= range.min && v <= range.max;
    })();
    if (!linked && !inRange) continue;
    if (draftReadingGroupNeedsReview(draftState, raw)) return true;
  }
  return false;
}

function shouldRenderQuestion(draftState, q, reviewFilterMode, reviewFilterPinned) {
  if (reviewFilterMode === 'all') return true;
  if (reviewFilterPinned.questionIds.has(q.id)) return true;
  if (draftQuestionNeedsReview(draftState, q)) return true;
  return questionBelongsToReadingGroupNeedingReview(draftState, q);
}

function appendDraftReviewBanner(parent, nav, root, onActivate) {
  const actionableTargets = (nav.targets || []).filter((t) => examDraftTargetPresent(root, t));
  const showActions = nav.actionable && actionableTargets.length > 0;
  const banner = el('div', {
    className: 'demo-banner exam-draft-review-banner',
    ...(nav.informational ? { 'data-exam-review-info': '' } : {}),
  });
  banner.appendChild(document.createTextNode(formatImportWarningDisplay(nav.message)));
  if (nav.guidance) {
    banner.appendChild(el('span', { className: 'exam-draft-review-guidance' }, ` ${nav.guidance}`));
  }
  if (showActions) {
    for (const t of actionableTargets) {
      banner.appendChild(document.createTextNode(' '));
      banner.appendChild(el('button', {
        type: 'button',
        className: 'exam-draft-review-action',
        'aria-label': t.label,
        onClick: () => onActivate(t),
      }, t.label));
    }
  }
  parent.appendChild(banner);
}

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function pollImportJob(jobId, onUpdate, isCancelled) {
  for (let i = 0; i < 120; i++) {
    if (isCancelled?.()) return null;
    const data = await fetchExamImportJob(jobId);
    if (isCancelled?.()) return null;
    onUpdate(data.job);
    if (['ready', 'needs-review', 'failed', 'cancelled'].includes(data.job.status)) {
      return data.job;
    }
    await wait(500);
    if (isCancelled?.()) return null;
  }
  return null;
}

/** Textarea value must be set on the IDL property — el() only sets a value attribute. */
function initTextarea(ta, text, onInput) {
  ta.value = text ?? '';
  ta.addEventListener('input', (e) => onInput(e.target.value));
}

async function mountPdfPreview(host, draftId, draftState, ctx, {
  sourceVersionId = null,
  filterSourceVersionId = null,
} = {}) {
  const wrap = el('div', { className: 'exam-pdf-preview' });
  wrap.appendChild(el('strong', {}, 'PDF gốc (chỉ giáo viên)'));
  const canvas = el('canvas', { style: 'max-width:100%;border:1px solid #eee' });
  const pageSel = el('select', { className: 'input' });
  const status = el('p', { 'aria-live': 'polite' }, 'Đang tải PDF…');
  wrap.appendChild(pageSel);
  wrap.appendChild(canvas);
  wrap.appendChild(status);
  host.appendChild(wrap);

  let disposed = false;
  let jumpToPage = null;
  let resolveReady = () => {};
  wrap.__whenReady = new Promise((r) => { resolveReady = r; });
  wrap.__dispose = () => {
    disposed = true;
    jumpToPage = null;
    resolveReady(false);
  };
  wrap.__jumpToSourcePage = (pageNum) => {
    if (typeof jumpToPage === 'function') jumpToPage(pageNum);
  };

  try {
    let lib;
    if (typeof globalThis !== 'undefined' && typeof globalThis.__examPdfJsTestLib === 'function') {
      lib = await globalThis.__examPdfJsTestLib();
    } else {
      const pdfjs = await import(/* webpackIgnore: true */ pdfJsModuleUrl());
      lib = pdfjs.default || pdfjs;
    }
    if (lib.GlobalWorkerOptions) {
      lib.GlobalWorkerOptions.workerSrc = pdfJsWorkerUrl();
    }
    const res = await fetch(examDraftSourceUrl(draftId, sourceVersionId ? { sourceVersionId } : {}), { credentials: 'include' });
    if (!res.ok) throw new Error('Không tải được PDF gốc.');
    const data = await res.arrayBuffer();
    if (disposed) return;
    const pdf = await lib.getDocument({ data }).promise;
    for (let p = 1; p <= pdf.numPages; p++) {
      pageSel.appendChild(el('option', { value: String(p) }, `Trang ${p}`));
    }
    async function renderPage(num) {
      if (disposed) return;
      const page = await pdf.getPage(num);
      const viewport = page.getViewport({ scale: 1.2 });
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
      page.cleanup?.();
      const qOnPage = (draftState.questions || []).filter((q) => {
        if (q.sourcePage !== num) return false;
        if (filterSourceVersionId && q.sourceVersionId !== filterSourceVersionId) return false;
        return true;
      });
      if (qOnPage.length) {
        status.textContent = `Trang ${num}: ${qOnPage.map((q) => `Câu ${q.displayNumber}`).join(', ')}`;
      } else {
        status.textContent = `Trang ${num}`;
      }
    }
    pageSel.addEventListener('change', () => {
      renderPage(Number(pageSel.value)).catch((e) => ctx.toastErr(e.message));
    });
    jumpToPage = (pageNum) => {
      const p = Number(pageNum);
      if (!Number.isInteger(p) || p < 1 || p > pdf.numPages) {
        ctx.toastErr('Không có trang nguồn cho câu này.');
        return;
      }
      pageSel.value = String(p);
      renderPage(p).catch((e) => ctx.toastErr(e.message));
    };
    pageSel.value = '1';
    await renderPage(1);
    if (!disposed) resolveReady(true);
  } catch (e) {
    status.textContent = e.message || 'Không xem được PDF.';
    resolveReady(false);
  }
  return wrap;
}

function teacherHubClassLabel(ctx, classId) {
  const classes = ctx.state?.data?.classes || [];
  const match = classes.find((c) => c.id === classId);
  return match?.name || classId || 'Lớp';
}

function examTeacherHubMetaText(parts) {
  const line = parts.filter(Boolean).join(' · ');
  if (!line) return null;
  return el('p', { className: 'exam-teacher-hub__meta' }, line);
}

function examTeacherHubSectionHead(title, count) {
  return el('div', { className: 'exam-teacher-hub__section-head' }, [
    el('h2', { className: 'exam-teacher-hub__section-title' }, title),
    el('span', { className: 'badge badge-gray exam-teacher-hub__section-count' }, String(count)),
  ]);
}

function examTeacherHubEmpty(message) {
  return el('p', { className: 'empty-state exam-teacher-hub__empty' }, message);
}

function examHubListItemMeta(row) {
  if (row?.itemSummary) return row.itemSummary;
  if (row?.numberedQuestions != null || row?.unnumberedActivities != null) {
    return formatExamHubItemMeta(row);
  }
  if ((row?.questions || []).length) return formatExamHubItemMeta(summarizeExamItems(row));
  return `${row?.questionCount ?? 0} câu`;
}

function renderExamTeacherHubDraftCard(ctx, draft) {
  const badges = [];
  if (draft.needsOcr) badges.push(el('span', { className: 'badge badge-amber' }, 'Cần nhận dạng chữ'));
  if (draft.needsReview) badges.push(el('span', { className: 'badge badge-amber' }, 'Cần kiểm tra'));
  if (!badges.length) badges.push(el('span', { className: 'badge badge-gray' }, 'Bản nháp'));

  const metaParts = [examHubListItemMeta(draft)];

  return el('article', { className: 'exam-teacher-hub__card card' }, [
    el('div', { className: 'exam-teacher-hub__card-body' }, [
      el('h3', { className: 'exam-teacher-hub__card-title' }, draft.title || 'Bản nháp'),
      el('div', { className: 'exam-teacher-hub__badges' }, badges),
      examTeacherHubMetaText(metaParts),
    ].filter(Boolean)),
    el('div', { className: 'exam-teacher-hub__card-actions btn-row' }, [
      el('button', {
        type: 'button',
        className: 'btn btn-primary',
        onClick: () => ctx.navigate(`#/exams/draft/${draft.id}`),
      }, 'Tiếp tục soạn'),
    ]),
  ]);
}

function renderExamTeacherHubBankCard(ctx, bank) {
  const metaParts = [];
  if (bank.versionCount) metaParts.push(`${bank.versionCount} phiên bản`);
  if (bank.draftCount) metaParts.push(`${bank.draftCount} bản nháp`);
  const badges = [];
  if (bank.hasPdf && bank.hasOnline) badges.push(el('span', { className: 'badge badge-accent' }, 'PDF + trực tuyến'));
  else if (bank.hasPdf) badges.push(el('span', { className: 'badge badge-gray' }, 'PDF'));
  else if (bank.hasOnline) badges.push(el('span', { className: 'badge badge-accent' }, 'Trực tuyến'));
  if (bank.needsOcr) badges.push(el('span', { className: 'badge badge-amber' }, 'Cần nhận dạng chữ'));
  if (bank.needsReview) badges.push(el('span', { className: 'badge badge-amber' }, 'Cần kiểm tra'));
  return el('article', { className: 'exam-teacher-hub__card card' }, [
    el('div', { className: 'exam-teacher-hub__card-body' }, [
      el('h3', { className: 'exam-teacher-hub__card-title' }, bank.title || 'Đề thi'),
      el('div', { className: 'exam-teacher-hub__badges' }, badges),
      examTeacherHubMetaText(metaParts),
    ].filter(Boolean)),
    el('div', { className: 'exam-teacher-hub__card-actions btn-row' }, [
      el('button', {
        type: 'button',
        className: 'btn btn-primary',
        'data-exam-action': 'open-bank',
        onClick: () => ctx.navigate(`#/exams/bank/${encodeURIComponent(bank.bankExamId)}`),
      }, 'Mở kho đề'),
    ]),
  ]);
}

function renderExamTeacherHubVersionCard(ctx, version, linkedCount) {
  const metaParts = [examHubListItemMeta(version)];
  if (linkedCount > 0) metaParts.push(`${linkedCount} lớp đã giao`);
  const bankId = version.bankExamId || version.id;

  return el('article', { className: 'exam-teacher-hub__card card' }, [
    el('div', { className: 'exam-teacher-hub__card-body' }, [
      el('h3', { className: 'exam-teacher-hub__card-title' }, version.title || 'Đề thi'),
      el('div', { className: 'exam-teacher-hub__badges' }, [
        el('span', { className: 'badge badge-accent' }, 'Đã xuất bản'),
      ]),
      examTeacherHubMetaText(metaParts),
    ].filter(Boolean)),
    el('div', { className: 'exam-teacher-hub__card-actions btn-row' }, [
      el('button', {
        type: 'button',
        className: 'btn btn-primary',
        onClick: () => ctx.navigate(`#/exams/bank/${encodeURIComponent(bankId)}`),
      }, 'Chi tiết kho'),
      el('button', {
        type: 'button',
        className: 'btn btn-secondary',
        'data-exam-action': 'preview-as-student',
        onClick: () => openTeacherStudentPreviewFromVersion(ctx, version.id),
      }, 'Xem trước'),
      el('button', {
        type: 'button',
        className: 'btn btn-secondary',
        onClick: () => ctx.navigate(`#/exams/assign/${version.id}?purpose=exam`),
      }, 'Giao bài'),
    ]),
  ]);
}

function renderExamTeacherHubAssignmentRow(ctx, assignment, version) {
  const assignTitle = assignment.title || 'Bài thi';
  const classLabel = teacherHubClassLabel(ctx, assignment.classId);
  const metaParts = [];
  if (version?.title) metaParts.push(version.title);
  if (assignment.dueAt) metaParts.push(`Hạn ${formatDateVi(assignment.dueAt)}`);
  metaParts.unshift(examAssignmentTypeBadge(assignment));
  const actionLabel = `${assignTitle} — ${classLabel}`;

  return el('div', { className: 'exam-teacher-hub__assign-row list-row' }, [
    el('div', { className: 'exam-teacher-hub__assign-info' }, [
      el('strong', { className: 'exam-teacher-hub__assign-title' }, assignTitle),
      examTeacherHubMetaText(metaParts),
    ].filter(Boolean)),
    el('div', { className: 'exam-teacher-hub__assign-actions btn-row' }, [
      el('button', {
        type: 'button',
        className: 'btn btn-primary',
        'aria-label': `Chấm bài: ${actionLabel}`,
        onClick: () => ctx.navigate(`#/exams/grade/${assignment.id}`),
      }, 'Chấm bài'),
      el('button', {
        type: 'button',
        className: 'btn btn-secondary',
        'aria-label': `Xem kết quả: ${actionLabel}`,
        onClick: () => ctx.navigate(`#/exams/assign/${assignment.versionId}?assignment=${assignment.id}`),
      }, 'Xem kết quả'),
      el('button', {
        type: 'button',
        className: 'btn btn-ghost',
        'data-exam-action': 'preview-as-student-assignment',
        'aria-label': `Xem trước lớp: ${actionLabel}`,
        onClick: () => openTeacherStudentPreviewFromVersion(ctx, assignment.versionId, {
          purpose: assignment.purpose,
          selectedQuestionIds: assignment.selectedQuestionIds,
          timeLimitMinutes: assignment.timeLimitMinutes,
          showScore: assignment.showScore,
          showAnswersAfter: assignment.showAnswersAfter,
          dueAt: assignment.dueAt,
        }),
      }, 'Xem trước (lớp)'),
    ]),
  ]);
}

function renderExamTeacherHubList(ctx, listHost, data) {
  listHost.replaceChildren();
  const drafts = data.drafts || [];
  const versions = data.versions || [];
  const assignments = data.assignments || [];
  const versionById = Object.fromEntries(versions.map((v) => [v.id, v]));
  const linkedCountByVersion = {};
  for (const a of assignments) {
    linkedCountByVersion[a.versionId] = (linkedCountByVersion[a.versionId] || 0) + 1;
  }

  const draftsSection = el('section', { className: 'exam-teacher-hub__section' });
  draftsSection.appendChild(examTeacherHubSectionHead('Bản nháp', drafts.length));
  if (!drafts.length) {
    draftsSection.appendChild(examTeacherHubEmpty('Chưa có bản nháp. Nhập PDF để bắt đầu soạn đề.'));
  } else {
    const grid = el('div', { className: 'exam-teacher-hub__grid' });
    for (const d of drafts) grid.appendChild(renderExamTeacherHubDraftCard(ctx, d));
    draftsSection.appendChild(grid);
  }
  listHost.appendChild(draftsSection);

  const banks = data.banks || [];
  const banksSection = el('section', { className: 'exam-teacher-hub__section' });
  banksSection.appendChild(examTeacherHubSectionHead('Kho đề', banks.length || versions.length));
  if (banks.length) {
    const grid = el('div', { className: 'exam-teacher-hub__grid exam-teacher-hub__grid--wide' });
    for (const b of banks) grid.appendChild(renderExamTeacherHubBankCard(ctx, b));
    banksSection.appendChild(grid);
  } else if (!versions.length) {
    banksSection.appendChild(examTeacherHubEmpty('Chưa có đề đã xuất bản. Xuất bản từ bản nháp khi đã kiểm tra xong.'));
  } else {
    const grid = el('div', { className: 'exam-teacher-hub__grid exam-teacher-hub__grid--wide' });
    for (const v of versions) {
      grid.appendChild(renderExamTeacherHubVersionCard(ctx, v, linkedCountByVersion[v.id] || 0));
    }
    banksSection.appendChild(grid);
  }
  listHost.appendChild(banksSection);

  const assignSection = el('section', { className: 'exam-teacher-hub__section' });
  assignSection.appendChild(examTeacherHubSectionHead('Bài đã giao', assignments.length));
  if (!assignments.length) {
    assignSection.appendChild(examTeacherHubEmpty('Chưa giao bài thi cho lớp nào.'));
  } else {
    const byClass = new Map();
    for (const a of assignments) {
      const key = a.classId || '';
      if (!byClass.has(key)) byClass.set(key, []);
      byClass.get(key).push(a);
    }
    const classKeys = [...byClass.keys()].sort((a, b) => {
      return teacherHubClassLabel(ctx, a).localeCompare(teacherHubClassLabel(ctx, b), 'vi');
    });
    const groupsHost = el('div', { className: 'exam-teacher-hub__assign-groups' });
    for (const classId of classKeys) {
      const group = el('div', { className: 'exam-teacher-hub__assign-group card' }, [
        el('h3', { className: 'exam-teacher-hub__assign-group-title' }, teacherHubClassLabel(ctx, classId)),
      ]);
      const rows = el('div', { className: 'exam-teacher-hub__assign-list' });
      for (const a of byClass.get(classId)) {
        rows.appendChild(renderExamTeacherHubAssignmentRow(ctx, a, versionById[a.versionId]));
      }
      group.appendChild(rows);
      groupsHost.appendChild(group);
    }
    assignSection.appendChild(groupsHost);
  }
  listHost.appendChild(assignSection);
}

export function renderExamTeacherHub(ctx, root) {
  root.__examDispose = () => {
    closeActiveTeacherStudentPreview();
  };

  const hub = el('div', { className: 'exam-teacher-hub' });
  root.appendChild(hub);

  const hubFilters = { skills: [], types: [] };
  const hubFilterBar = el('div', { className: 'filter-bar exam-hub-filter', 'data-exam-hub-filter': '' });
  const hubFilterStatus = el('span', { className: 'form-hint', 'data-exam-hub-filter-status': '' }, '');
  for (const row of [
    { id: EXAM_SKILL.LISTENING, label: 'Nghe' },
    { id: EXAM_SKILL.READING, label: 'Đọc' },
    { id: EXAM_SKILL.WRITING, label: 'Viết' },
    { id: EXAM_SKILL.SPEAKING, label: 'Nói' },
    { id: EXAM_SKILL.UNCLASSIFIED, label: 'Chưa phân loại' },
  ]) {
    const chip = el('button', {
      type: 'button',
      className: 'btn btn-ghost btn-sm',
      'data-exam-hub-skill': row.id,
    }, row.label);
    chip.addEventListener('click', () => {
      const on = hubFilters.skills.includes(row.id);
      hubFilters.skills = on ? hubFilters.skills.filter((s) => s !== row.id) : [...hubFilters.skills, row.id];
      chip.className = on ? 'btn btn-ghost btn-sm' : 'btn btn-secondary btn-sm exam-filter-chip--active';
      loadSummary();
    });
    hubFilterBar.appendChild(chip);
  }
  hubFilterBar.appendChild(el('span', { className: 'form-hint', style: 'margin-left:0.35rem' }, 'Loại:'));
  for (const row of [
    { id: EXAM_QUESTION_TYPE.SINGLE_CHOICE, label: 'TN' },
    { id: EXAM_QUESTION_TYPE.ESSAY, label: 'Luận' },
    { id: EXAM_QUESTION_TYPE.SHORT_ANSWER, label: 'Ngắn' },
  ]) {
    const chip = el('button', {
      type: 'button',
      className: 'btn btn-ghost btn-sm',
      'data-exam-hub-type': row.id,
    }, row.label);
    chip.addEventListener('click', () => {
      const on = hubFilters.types.includes(row.id);
      hubFilters.types = on ? hubFilters.types.filter((t) => t !== row.id) : [...hubFilters.types, row.id];
      chip.className = on ? 'btn btn-ghost btn-sm' : 'btn btn-secondary btn-sm exam-filter-chip--active';
      loadSummary();
    });
    hubFilterBar.appendChild(chip);
  }
  const hubReset = el('button', { type: 'button', className: 'btn btn-ghost btn-sm' }, 'Đặt lại');
  hubReset.addEventListener('click', () => {
    hubFilters.skills = [];
    hubFilters.types = [];
    for (const b of hubFilterBar.querySelectorAll('[data-exam-hub-skill],[data-exam-hub-type]')) {
      b.className = 'btn btn-ghost btn-sm';
    }
    loadSummary();
  });
  hubFilterBar.appendChild(hubReset);
  hubFilterBar.appendChild(hubFilterStatus);
  hub.appendChild(hubFilterBar);

  hub.appendChild(el('header', { className: 'exam-teacher-hub__header' }, [
    el('h1', { className: 'page-title', id: 'exam-hub-page-title' }, 'Kho đề'),
    el('p', { className: 'subtitle exam-teacher-hub__lede' },
      'Tải đề thi PDF, kiểm tra câu hỏi, xuất bản vào kho rồi tổ chức bài thi hoặc giao bài tập cho lớp.'),
    el('div', { className: 'exam-teacher-hub__header-actions btn-row' }, [
      el('button', {
        type: 'button',
        className: 'btn btn-secondary',
        onClick: () => ctx.navigate('#/exams/compose'),
      }, 'Soạn đề'),
      el('button', {
        type: 'button',
        className: 'btn btn-primary',
        onClick: () => ctx.navigate('#/exams/import'),
      }, 'Tải đề thi PDF'),
    ]),
  ]));

  const listHost = el('div', {
    id: 'exam-teacher-list',
    className: 'exam-teacher-hub__body',
    'aria-busy': 'true',
  });
  hub.appendChild(listHost);
  listHost.appendChild(el('p', {
    className: 'exam-teacher-hub__loading',
    'aria-live': 'polite',
  }, 'Đang tải danh sách…'));

  const loadSummary = () => {
    listHost.replaceChildren(el('p', {
      className: 'exam-teacher-hub__loading',
      'aria-live': 'polite',
    }, 'Đang tải danh sách…'));
    listHost.setAttribute('aria-busy', 'true');
    return fetchExamTeacherSummary(hubFilters)
      .then((data) => {
        listHost.setAttribute('aria-busy', 'false');
        if (data.filterQualification) {
          const u = data.filterQualification.unclassifiedCount ?? 0;
          hubFilterStatus.textContent = `Khớp ${data.filterQualification.matchingVersionCount} đề · ${data.filterQualification.matchingQuestionCount} câu${u ? ` · ${u} chưa phân loại` : ''}`;
        } else hubFilterStatus.textContent = '';
        renderExamTeacherHubList(ctx, listHost, data);
      })
      .catch((e) => {
        listHost.setAttribute('aria-busy', 'false');
        listHost.replaceChildren();
        listHost.appendChild(el('div', { className: 'card exam-teacher-hub__error' }, [
          el('p', { className: 'exam-teacher-hub__error-text' },
            e?.message || 'Không tải được danh sách bài thi.'),
          el('div', { className: 'btn-row' }, [
            el('button', {
              type: 'button',
              className: 'btn btn-secondary',
              onClick: () => loadSummary().catch((err) => ctx.toastErr(err.message)),
            }, 'Thử lại'),
          ]),
        ]));
        ctx.toastErr(e.message);
      });
  };

  loadSummary();
}

export function renderExamComposeView(ctx, root) {
  root.appendChild(el('h1', { className: 'page-title' }, 'Soạn đề'));
  root.appendChild(el('button', {
    type: 'button',
    className: 'btn btn-ghost',
    onClick: () => ctx.navigate('#/exams'),
  }, '← Kho đề'));

  const host = el('div', { className: 'exam-compose card', style: 'padding:1rem;margin-top:0.75rem' });
  root.appendChild(host);

  const titleInput = el('input', { type: 'text', className: 'input', placeholder: 'Tiêu đề (tùy chọn)' });
  const statusEl = el('p', { 'aria-live': 'polite' }, 'Đang tải nguồn đề…');
  const blankBtn = el('button', { type: 'button', className: 'btn btn-secondary' }, 'Bắt đầu trống');
  const createBtn = el('button', { type: 'button', className: 'btn btn-primary' }, 'Tạo bản nháp');
  const versionPickHost = el('div', {
    className: 'exam-compose-version-picks',
    'aria-label': 'Chọn một hoặc nhiều đề đã xuất bản',
  });
  const versionPickState = new Map();
  const pickerHost = el('div', { className: 'exam-compose-picker', style: 'margin-top:0.75rem' });

  host.appendChild(el('label', {}, 'Tiêu đề bản nháp ', titleInput));
  host.appendChild(el('p', { className: 'form-hint', style: 'margin-top:0.5rem' },
    'Tick nhiều đề trong kho — mỗi đề một khối câu hỏi bên dưới.'));
  const composeFilters = { skills: [], types: [] };
  const composeFilterBar = el('div', {
    className: 'filter-bar exam-compose-filter',
    'data-exam-compose-filter': '',
    style: 'margin-top:0.5rem',
  });
  const composeFilterStatus = el('span', { className: 'form-hint' }, '');
  for (const row of [
    { id: EXAM_SKILL.LISTENING, label: 'Nghe' },
    { id: EXAM_SKILL.READING, label: 'Đọc' },
    { id: EXAM_SKILL.WRITING, label: 'Viết' },
    { id: EXAM_SKILL.SPEAKING, label: 'Nói' },
    { id: EXAM_SKILL.UNCLASSIFIED, label: 'Chưa PL' },
  ]) {
    const chip = el('button', {
      type: 'button',
      className: 'btn btn-ghost btn-sm',
      'data-exam-compose-skill': row.id,
    }, row.label);
    chip.addEventListener('click', () => {
      const on = composeFilters.skills.includes(row.id);
      composeFilters.skills = on
        ? composeFilters.skills.filter((s) => s !== row.id)
        : [...composeFilters.skills, row.id];
      chip.className = on ? 'btn btn-ghost btn-sm' : 'btn btn-secondary btn-sm exam-filter-chip--active';
      loadSourcesForSelection();
    });
    composeFilterBar.appendChild(chip);
  }
  composeFilterBar.appendChild(el('span', { className: 'form-hint', style: 'margin-left:0.35rem' }, 'Loại:'));
  for (const row of [
    { id: EXAM_QUESTION_TYPE.SINGLE_CHOICE, label: 'TN' },
    { id: EXAM_QUESTION_TYPE.ESSAY, label: 'Luận' },
    { id: EXAM_QUESTION_TYPE.SHORT_ANSWER, label: 'Ngắn' },
  ]) {
    const chip = el('button', {
      type: 'button',
      className: 'btn btn-ghost btn-sm',
      'data-exam-compose-type': row.id,
    }, row.label);
    chip.addEventListener('click', () => {
      const on = composeFilters.types.includes(row.id);
      composeFilters.types = on
        ? composeFilters.types.filter((t) => t !== row.id)
        : [...composeFilters.types, row.id];
      chip.className = on ? 'btn btn-ghost btn-sm' : 'btn btn-secondary btn-sm exam-filter-chip--active';
      loadSourcesForSelection();
    });
    composeFilterBar.appendChild(chip);
  }
  const composeReset = el('button', { type: 'button', className: 'btn btn-ghost btn-sm' }, 'Đặt lại');
  composeReset.addEventListener('click', () => {
    composeFilters.skills = [];
    composeFilters.types = [];
    for (const b of composeFilterBar.querySelectorAll('[data-exam-compose-skill],[data-exam-compose-type]')) {
      b.className = 'btn btn-ghost btn-sm';
    }
    loadSourcesForSelection();
  });
  composeFilterBar.appendChild(composeReset);
  composeFilterBar.appendChild(composeFilterStatus);
  host.appendChild(composeFilterBar);
  host.appendChild(el('div', { style: 'display:block;margin-top:0.75rem' }, [
    el('span', { style: 'display:block;margin-bottom:0.35rem' }, 'Đề nguồn từ kho'),
    versionPickHost,
  ]));
  host.appendChild(pickerHost);
  host.appendChild(statusEl);
  host.appendChild(el('div', { className: 'btn-row', style: 'margin-top:0.75rem' }, [blankBtn, createBtn]));

  let sources = [];
  const sourceByVersion = new Map();
  /** @type {Map<string, Set<string>>} */
  const selectedByVersion = new Map();

  function bindingsForSummary() {
    const o = {};
    for (const [vid, src] of sourceByVersion) {
      o[vid] = { sourceTitle: src?.title || 'Đề nguồn' };
    }
    return o;
  }

  function selectionCountMap() {
    const m = new Map();
    for (const [vid, set] of selectedByVersion) {
      if (set?.size) m.set(vid, set.size);
    }
    return m;
  }

  function refreshStatusLine() {
    statusEl.textContent = formatComposerSelectionSummaryVi(selectionCountMap(), bindingsForSummary());
  }

  function selectedVersionIds() {
    return [...versionPickState.entries()].filter(([, on]) => on).map(([id]) => id);
  }

  function renderOneSourceBlock(composeSource, versionId) {
    let selectedIds = selectedByVersion.get(versionId);
    if (!selectedIds) {
      selectedIds = new Set();
      selectedByVersion.set(versionId, selectedIds);
    }
    const meta = sources.find((s) => s.id === versionId);
    const block = el('div', { className: 'card', style: 'margin:0.75rem 0;padding:0.75rem' });
    block.appendChild(el('strong', {}, `${meta?.title || composeSource.title || 'Đề'} (${composeSource.questionCount} câu)`));
    if (composeSource.hasSourcePdf) {
      block.appendChild(el('p', { style: 'font-size:0.85rem;color:var(--muted)' }, 'Có PDF nguồn khi soạn trong bản nháp.'));
    }
    const filterInput = el('input', {
      type: 'text',
      className: 'input',
      placeholder: 'Lọc theo số câu',
    });
    const selectAll = el('button', { type: 'button', className: 'btn btn-ghost btn-sm' }, 'Chọn tất cả');
    const selectNone = el('button', { type: 'button', className: 'btn btn-ghost btn-sm' }, 'Bỏ chọn');
    block.appendChild(el('div', { className: 'btn-row' }, [selectAll, selectNone, filterInput]));
    const listHost = el('div', { className: 'exam-compose-question-list' });
    block.appendChild(listHost);

    function renderList() {
      listHost.replaceChildren();
      const filter = String(filterInput.value || '').trim();
      const groups = new Map((composeSource.groups || []).map((g) => [g.id, g]));
      const byGroup = new Map();
      const solo = [];
      for (const q of composeSource.questions || []) {
        if (filter && !String(q.displayNumber || '').includes(filter)) continue;
        if (q.passageId && groups.has(q.passageId)) {
          if (!byGroup.has(q.passageId)) byGroup.set(q.passageId, []);
          byGroup.get(q.passageId).push(q);
        } else solo.push(q);
      }
      const renderRow = (q) => {
        const cb = el('input', {
          type: 'checkbox',
          checked: selectedIds.has(q.id),
          'data-question-id': q.id,
        });
        cb.addEventListener('change', () => {
          if (cb.checked) selectedIds.add(q.id);
          else selectedIds.delete(q.id);
          refreshStatusLine();
        });
        return el('label', {
          className: 'exam-compose-q-row',
          style: 'display:block;margin:0.35rem 0',
        }, [
          cb,
          ` Câu ${q.displayNumber}: ${(q.stemSnippet || '').slice(0, 80)}`,
        ]);
      };
      for (const [gid, qs] of byGroup) {
        const g = groups.get(gid);
        const gWrap = el('div', { className: 'card', style: 'margin:0.5rem 0;padding:0.5rem' });
        gWrap.appendChild(el('strong', {}, g?.label || 'Nhóm'));
        if (g?.contextSnippet) {
          gWrap.appendChild(el('p', { style: 'font-size:0.85rem;color:var(--muted)' },
            g.contextSnippet.slice(0, 100)));
        }
        const gSelect = el('button', {
          type: 'button',
          className: 'btn btn-ghost btn-sm',
        }, 'Chọn nhóm');
        gSelect.addEventListener('click', () => {
          for (const q of qs) selectedIds.add(q.id);
          renderList();
          refreshStatusLine();
        });
        gWrap.appendChild(gSelect);
        for (const q of qs) gWrap.appendChild(renderRow(q));
        listHost.appendChild(gWrap);
      }
      for (const q of solo) listHost.appendChild(renderRow(q));
    }
    selectAll.addEventListener('click', () => {
      for (const q of composeSource.questions || []) selectedIds.add(q.id);
      renderList();
      refreshStatusLine();
    });
    selectNone.addEventListener('click', () => {
      selectedIds.clear();
      renderList();
      refreshStatusLine();
    });
    filterInput.addEventListener('input', renderList);
    renderList();
    return block;
  }

  function renderPicker() {
    pickerHost.replaceChildren();
    const vids = selectedVersionIds();
    for (const vid of [...sourceByVersion.keys()]) {
      if (!vids.includes(vid)) {
        sourceByVersion.delete(vid);
        selectedByVersion.delete(vid);
      }
    }
    refreshStatusLine();
    if (!vids.length) {
      pickerHost.appendChild(el('p', { className: 'form-hint' },
        'Chọn ít nhất một đề đã xuất bản để sao chép câu, hoặc bắt đầu trống.'));
      return;
    }
    for (const vid of vids) {
      const src = sourceByVersion.get(vid);
      if (!src) {
        pickerHost.appendChild(el('p', {}, `Đang tải câu hỏi… (${vid.slice(0, 8)})`));
        continue;
      }
      pickerHost.appendChild(renderOneSourceBlock(src, vid));
    }
  }

  async function loadSourcesForSelection() {
    const vids = selectedVersionIds();
    for (const vid of vids) {
      if (sourceByVersion.has(vid)) continue;
      try {
        statusEl.textContent = 'Đang tải câu hỏi…';
        const data = await fetchExamComposeSource(vid, parseExamMetadataFilters(composeFilters));
        sourceByVersion.set(vid, data.source);
        if (data.filterQualification) {
          composeFilterStatus.textContent = `Khớp ${data.filterQualification.matchingQuestionCount}/${data.filterQualification.totalQuestionCount} câu`;
        }
        if (!selectedByVersion.has(vid)) selectedByVersion.set(vid, new Set());
      } catch (e) {
        ctx.toastErr(e.message);
        statusEl.textContent = e.message || 'Không tải được nguồn.';
        return;
      }
    }
    renderPicker();
    refreshStatusLine();
  }

  fetchExamTeacherSummary().then((data) => {
    sources = data.versions || [];
    versionPickHost.replaceChildren();
    versionPickState.clear();
    for (const v of sources) {
      versionPickState.set(v.id, false);
      const row = el('label', {
        style: 'display:block;margin:0.25rem 0',
        className: 'exam-compose-version-pick',
      });
      const cb = el('input', { type: 'checkbox', 'data-version-id': v.id });
      cb.addEventListener('change', () => {
        versionPickState.set(v.id, !!cb.checked);
        loadSourcesForSelection().catch((e) => ctx.toastErr(e.message));
      });
      row.appendChild(cb);
      row.appendChild(el('span', {}, ` ${v.title || 'Đề'} (${v.questionCount ?? 0} câu)`));
      versionPickHost.appendChild(row);
    }
    if (!sources.length) {
      statusEl.textContent = 'Chưa có đề xuất bản — tải PDF hoặc bắt đầu trống.';
    } else {
      statusEl.textContent = 'Chọn một hoặc nhiều đề nguồn, rồi tick câu cần lấy.';
    }
  }).catch((e) => {
    statusEl.textContent = e.message || 'Không tải danh sách.';
  });

  blankBtn.addEventListener('click', () => withBusyButton(blankBtn, 'Đang tạo…', async () => {
    try {
      const res = await createExamDraft({
        blank: true,
        title: titleInput.value.trim() || undefined,
      });
      ctx.toastOk('Đã tạo bản nháp.');
      ctx.navigate(`#/exams/draft/${res.draftId}`);
    } catch (e) {
      ctx.toastErr(e.message || 'Không tạo được bản nháp.');
    }
  }));

  createBtn.addEventListener('click', () => withBusyButton(createBtn, 'Đang tạo…', async () => {
    try {
      const vids = selectedVersionIds();
      if (!vids.length) {
        ctx.toastErr('Chọn ít nhất một đề nguồn hoặc dùng «Bắt đầu trống».');
        return;
      }
      const rows = [];
      for (const vid of vids) {
        const set = selectedByVersion.get(vid);
        const ids = set ? [...set] : [];
        if (!ids.length) continue;
        rows.push({ sourceVersionId: vid, questionIds: ids });
      }
      if (!rows.length) {
        ctx.toastErr('Chọn ít nhất một câu từ các đề đã chọn.');
        return;
      }
      let payload;
      if (rows.length === 1) {
        payload = {
          sourceVersionId: rows[0].sourceVersionId,
          questionIds: rows[0].questionIds,
          title: titleInput.value.trim() || undefined,
        };
      } else {
        payload = {
          sources: rows,
          title: titleInput.value.trim() || undefined,
        };
      }
      const res = await createExamDraft(payload);
      ctx.toastOk('Đã tạo bản nháp từ kho.');
      ctx.navigate(`#/exams/draft/${res.draftId}`);
    } catch (e) {
      ctx.toastErr(e.message || 'Không tạo được bản nháp.');
    }
  }));
}

export function renderExamImportView(ctx, root) {
  let disposed = false;
  root.__examDispose = () => { disposed = true; };

  root.appendChild(el('h1', { className: 'page-title' }, 'Tải đề thi PDF'));
  root.appendChild(el('button', {
    type: 'button',
    className: 'btn btn-ghost',
    onClick: () => ctx.navigate('#/exams'),
  }, '← Quay lại'));

  const fileInput = el('input', { type: 'file', accept: 'application/pdf,.pdf' });
  const statusEl = el('p', { 'aria-live': 'polite' });
  const keyPagesInput = el('input', {
    type: 'text',
    placeholder: 'vd: 32 hoặc 32,33',
    className: 'input',
  });
  const questionPagesInput = el('input', {
    type: 'text',
    placeholder: 'vd: 12-21 (để trống = mọi trang trừ trang đáp án)',
    className: 'input',
  });
  const btn = el('button', {
    type: 'button',
    className: 'btn btn-primary',
    'data-action': 'exam-import-process',
  }, 'Tải PDF và xử lý');
  root.appendChild(el('div', { className: 'card' },
    el('div', { className: 'form-field file-upload-field' },
      el('label', {}, 'Tệp PDF'),
      el('div', { className: 'file-upload-control' }, fileInput),
    ),
    el('div', { className: 'form-field' },
      el('label', {}, 'Trang câu hỏi'),
      questionPagesInput,
    ),
    el('p', { className: 'form-hint' },
      'Số trang vật lý trong PDF (bắt đầu từ 1). Với sách TOEIC mẫu ETS: nhập 12-21 cho phần Reading. '
      + 'Để trống sẽ quét mọi trang trừ trang đáp án — không khuyến nghị với sách nghe+đọc.',
    ),
    el('div', { className: 'form-field' },
      el('label', {}, 'Trang đáp án'),
      keyPagesInput,
    ),
    el('p', { className: 'form-hint' },
      'Tùy chọn. Nhập trang bảng đáp án trong PDF (ví dụ: 32). Để trống: bản nháp ghi nhận “Chưa có trang đáp án” — '
      + 'bạn vẫn có thể xuất bản nếu chọn giáo viên chấm sau, hoặc điền đáp án thủ công.',
    ),
    statusEl,
    btn,
  ));

  btn.addEventListener('click', () => withBusyButton(btn, 'Đang xử lý…', async () => {
    try {
      const file = fileInput.files?.[0];
      if (!file) {
        ctx.toastErr('Chọn tệp PDF.');
        return;
      }
      statusEl.textContent = 'Đang tải tệp…';
      const uploaded = await uploadTeacherAttachment(file);
      statusEl.textContent = 'Đang xử lý PDF…';
      const keyPages = keyPagesInput.value.trim()
        ? keyPagesInput.value.split(/[,;\s]+/).map((x) => Number(x)).filter(Boolean)
        : [];
      const questionPageRange = questionPagesInput.value.trim();
      const importPayload = {
        sourceAttachmentId: uploaded.id,
        keyPages,
        title: file.name.replace(/\.pdf$/i, ''),
      };
      if (questionPageRange) importPayload.questionPageRange = questionPageRange;
      const started = await startExamImport(importPayload);
      const job = await pollImportJob(started.jobId, (j) => {
        statusEl.textContent = `Trạng thái: ${j.status} (${Math.round((j.progress || 0) * 100)}%)`;
        if (j.needsOcr) statusEl.textContent += ' — cần nhận dạng chữ';
      }, () => disposed);
      if (disposed) return;
      if (!job?.draftId) {
        ctx.toastErr(job?.error || 'Xử lý thất bại.');
        return;
      }
      ctx.toastOk('Đã xử lý xong — mở bản nháp.');
      ctx.navigate(`#/exams/draft/${job.draftId}`);
    } catch (e) {
      ctx.toastErr(e.message || 'Lỗi tải đề thi PDF.');
    }
  }));

  const pdfOnlyBtn = el('button', {
    type: 'button',
    className: 'btn btn-secondary',
    'data-exam-action': 'pdf-only-create',
    style: 'margin-top:0.5rem',
  }, 'Đề PDF-only (không trích câu hỏi)');
  root.lastChild?.appendChild?.(pdfOnlyBtn);
  if (!root.lastChild) root.appendChild(pdfOnlyBtn);
  else {
    const card = root.querySelector('.card');
    if (card) card.appendChild(pdfOnlyBtn);
  }
  pdfOnlyBtn.addEventListener('click', () => withBusyButton(pdfOnlyBtn, 'Đang tạo…', async () => {
    try {
      const file = fileInput.files?.[0];
      if (!file) {
        ctx.toastErr('Chọn tệp PDF.');
        return;
      }
      const uploaded = await uploadTeacherAttachment(file);
      const created = await createPdfOnlyExamDraft({
        sourceAttachmentId: uploaded.id,
        title: file.name.replace(/\.pdf$/i, ''),
      });
      ctx.toastOk('Đã tạo đề PDF-only — có thể xuất bản ngay.');
      ctx.navigate(`#/exams/bank/${encodeURIComponent(created.bankExamId || created.draft?.bankExamId)}`);
    } catch (e) {
      ctx.toastErr(e.message || 'Không tạo được đề PDF-only.');
    }
  }));
}

export function renderExamBankDetailView(ctx, root, bankExamId) {
  root.appendChild(el('h1', { className: 'page-title' }, 'Chi tiết kho đề'));
  root.appendChild(el('button', {
    type: 'button',
    className: 'btn btn-ghost',
    onClick: () => ctx.navigate('#/exams'),
  }, '← Kho đề'));

  const host = el('div', { className: 'exam-bank-detail', 'data-exam-bank-detail': bankExamId });
  root.appendChild(host);
  const tabBar = el('div', { className: 'btn-row exam-bank-tabs', role: 'tablist' });
  const overviewBtn = el('button', { type: 'button', className: 'btn btn-secondary', 'data-exam-bank-tab': 'overview' }, 'Tổng quan');
  const pdfBtn = el('button', { type: 'button', className: 'btn btn-ghost', 'data-exam-bank-tab': 'pdf' }, 'PDF nguồn');
  const onlineBtn = el('button', { type: 'button', className: 'btn btn-ghost', 'data-exam-bank-tab': 'online' }, 'Trực tuyến');
  tabBar.appendChild(overviewBtn);
  tabBar.appendChild(pdfBtn);
  tabBar.appendChild(onlineBtn);
  host.appendChild(tabBar);
  const panel = el('div', { className: 'exam-bank-panel' });
  host.appendChild(panel);

  let bankData = null;
  let activeTab = 'overview';
  let previewDispose = null;

  function versionBadges(v) {
    const badges = [];
    if (v.pdfOnly) badges.push(el('span', { className: 'badge badge-gray' }, 'PDF-only'));
    if (v.hasOnline) badges.push(el('span', { className: 'badge badge-accent' }, 'Sẵn sàng'));
    else if (v.hasPdf) badges.push(el('span', { className: 'badge badge-amber' }, 'Chưa soạn trực tuyến'));
    return badges;
  }

  async function renderPdfTab(versionId) {
    panel.replaceChildren();
    if (!versionId) {
      panel.appendChild(el('p', { className: 'empty-state' }, 'Chưa có PDF nguồn.'));
      return;
    }
    const frame = el('iframe', {
      title: 'PDF nguồn',
      className: 'exam-bank-pdf-frame',
      style: 'width:100%;height:70vh;border:1px solid var(--border);border-radius:0.5rem',
      src: teacherExamVersionSourcePdfUrl(versionId),
    });
    panel.appendChild(frame);
  }

  function renderOnlineTab() {
    panel.replaceChildren();
    const vid = bankData?.activeVersionId;
    if (!vid) {
      panel.appendChild(el('p', { className: 'empty-state' }, 'Chưa có phiên bản trực tuyến.'));
      return;
    }
    fetchTeacherExamVersionStudentPreview(vid).then((data) => {
      if (!data?.exam?.questions?.length) {
        panel.appendChild(el('p', { className: 'empty-state' }, 'Chưa có câu hỏi trực tuyến — dùng «Tải đề thi PDF» hoặc soạn thủ công.'));
        return;
      }
      const previewHost = el('div', { className: 'exam-bank-online-preview' });
      panel.appendChild(previewHost);
      mountExamTakeQuestionUi(previewHost, data.exam, {
        answers: {},
        readOnly: true,
      });
    }).catch((e) => ctx.toastErr(e.message));
  }

  function renderOverview() {
    panel.replaceChildren();
    if (!bankData) {
      panel.appendChild(el('p', {}, 'Đang tải…'));
      return;
    }
    panel.appendChild(el('h2', {}, bankData.title || 'Đề thi'));
    const actions = el('div', { className: 'btn-row', style: 'margin:0.75rem 0' });
    if (bankData.activeVersionId) {
      actions.appendChild(el('button', {
        type: 'button',
        className: 'btn btn-primary',
        'data-exam-action': 'assign-from-bank',
        onClick: () => ctx.navigate(`#/exams/assign/${bankData.activeVersionId}`),
      }, 'Giao bài / tổ chức thi'));
      actions.appendChild(el('button', {
        type: 'button',
        className: 'btn btn-secondary',
        onClick: () => openTeacherStudentPreviewFromVersion(ctx, bankData.activeVersionId),
      }, 'Xem trước học sinh'));
      actions.appendChild(el('button', {
        type: 'button',
        className: 'btn btn-ghost',
        'data-exam-action': 'read-source',
        onClick: () => ctx.navigate(`#/exams/source/${encodeURIComponent(bankData.activeVersionId)}`),
      }, 'Đọc nguồn / thêm câu'));
      const reviseBtn = el('button', {
        type: 'button',
        className: 'btn btn-ghost',
        'data-exam-action': 'revise-from-published',
      }, 'Soạn phiên bản mới');
      reviseBtn.addEventListener('click', () => withBusyButton(reviseBtn, 'Đang tạo…', async () => {
        try {
          const res = await reviseExamVersion(bankData.activeVersionId);
          ctx.toastOk('Đã tạo bản nháp mới cùng kho.');
          ctx.navigate(`#/exams/draft/${res.draftId}`);
        } catch (e) {
          ctx.toastErr(e.message);
        }
      }));
      actions.appendChild(reviseBtn);
    }
    panel.appendChild(actions);

    panel.appendChild(el('h3', {}, 'Phiên bản'));
    const vList = el('ul', { className: 'exam-bank-version-list' });
    for (const v of bankData.versions || []) {
      vList.appendChild(el('li', { className: 'list-row', style: 'margin:0.35rem 0' }, [
        el('span', {}, `${v.title || v.id} — ${v.itemSummary || ''} `),
        el('span', {}, versionBadges(v)),
      ]));
    }
    panel.appendChild(vList);

    if (bankData.drafts?.length) {
      panel.appendChild(el('h3', {}, 'Bản nháp'));
      const dList = el('ul');
      for (const d of bankData.drafts) {
        const badges = [];
        if (d.needsReview) badges.push(el('span', { className: 'badge badge-amber' }, 'Cần kiểm tra'));
        if (d.needsOcr) badges.push(el('span', { className: 'badge badge-amber' }, 'Cần nhận dạng chữ'));
        if (d.explicitPdfOnly) badges.push(el('span', { className: 'badge badge-gray' }, 'PDF-only'));
        dList.appendChild(el('li', {}, [
          el('button', {
            type: 'button',
            className: 'btn btn-ghost',
            onClick: () => ctx.navigate(`#/exams/draft/${d.id}`),
          }, d.title || d.id),
          ' ',
          ...badges,
        ]));
      }
      panel.appendChild(dList);
    }
  }

  function setTab(tab) {
    activeTab = tab;
    for (const btn of [overviewBtn, pdfBtn, onlineBtn]) {
      const on = btn.getAttribute('data-exam-bank-tab') === tab;
      btn.className = on ? 'btn btn-secondary' : 'btn btn-ghost';
    }
    if (tab === 'overview') renderOverview();
    else if (tab === 'pdf') renderPdfTab(bankData?.activeVersionId);
    else renderOnlineTab();
  }
  overviewBtn.addEventListener('click', () => setTab('overview'));
  pdfBtn.addEventListener('click', () => setTab('pdf'));
  onlineBtn.addEventListener('click', () => setTab('online'));

  fetchExamBankDetail(bankExamId).then((data) => {
    bankData = data.bank;
    setTab('overview');
  }).catch((e) => {
    panel.appendChild(el('p', { className: 'demo-banner' }, e.message || 'Không tải được kho đề.'));
  });

  root.__examDispose = () => {
    if (typeof previewDispose === 'function') previewDispose();
  };
}

export function renderExamAssignView(ctx, root, versionId) {
  const hashQuery = (typeof location !== 'undefined' && location.hash.includes('?'))
    ? location.hash.split('?')[1] : '';
  const params = new URLSearchParams(hashQuery);
  const initialPurpose = normalizeExamAssignmentPurpose(params.get('purpose'));
  const isHomework = initialPurpose === EXAM_ASSIGNMENT_PURPOSE.HOMEWORK;

  root.appendChild(el('h1', { className: 'page-title' },
    isHomework ? 'Giao bài tập từ kho đề' : 'Tổ chức bài thi từ kho đề'));
  root.appendChild(el('button', {
    type: 'button',
    className: 'btn btn-ghost',
    onClick: () => ctx.navigate('#/exams'),
  }, '← Kho đề'));

  const host = el('div');
  root.appendChild(host);
  const classes = ctx.state?.data?.classes || [];
  if (!classes.length) {
    host.appendChild(el('p', { className: 'demo-banner' }, 'Chưa có lớp — tạo lớp trước khi giao bài.'));
  }

  const purposeExamRadio = el('input', {
    type: 'radio',
    name: 'exam-assign-purpose',
    id: 'exam-assign-purpose-exam',
    checked: !isHomework,
  });
  const purposeHwRadio = el('input', {
    type: 'radio',
    name: 'exam-assign-purpose',
    id: 'exam-assign-purpose-hw',
    checked: isHomework,
  });
  const classSel = el('select', { className: 'input' });
  for (const c of classes) {
    classSel.appendChild(el('option', { value: c.id }, c.name || c.id));
  }
  const titleInput = el('input', { type: 'text', className: 'input', placeholder: 'Tiêu đề giao bài' });
  const openInput = el('input', { type: 'datetime-local', className: 'input' });
  const dueInput = el('input', { type: 'datetime-local', className: 'input' });
  const durationWrap = el('label', {}, 'Thời gian làm (phút) ');
  const durationInput = el('input', { type: 'number', className: 'input', value: '60', min: '1' });
  durationWrap.appendChild(durationInput);
  const attemptsInput = el('input', { type: 'number', className: 'input', value: '1', min: '1' });
  const showScoreCheck = el('input', { type: 'checkbox', checked: true, id: 'exam-show-score' });
  const releaseSel = el('select', { className: 'input' }, [
    el('option', { value: 'after-due' }, 'Sau hạn nộp'),
    el('option', { value: 'after-submit' }, 'Sau khi nộp'),
    el('option', { value: 'immediate' }, 'Ngay'),
  ]);

  const selectionHost = el('div', { className: 'exam-assign-selection card', style: 'margin:1rem 0;padding:0.75rem' });
  const selectionSummary = el('p', { className: 'exam-assign-selection-summary', 'data-exam-selection-summary': '' }, '');
  const filterInput = el('input', {
    type: 'text',
    className: 'input',
    placeholder: 'Lọc theo số câu (vd. 3)',
    'data-exam-question-filter': '',
  });
  const selectAllBtn = el('button', { type: 'button', className: 'btn btn-ghost btn-sm' }, 'Chọn tất cả');
  const selectNoneBtn = el('button', { type: 'button', className: 'btn btn-ghost btn-sm' }, 'Bỏ chọn');
  selectionHost.appendChild(el('h3', {}, 'Chọn câu hỏi'));
  selectionHost.appendChild(el('p', { style: 'font-size:0.9rem;color:var(--muted)' },
    'Mặc định giao toàn bộ đề. Bỏ chọn để giao một phần — nhóm đọc hiện khi có câu được chọn.'));
  selectionHost.appendChild(el('div', { className: 'btn-row' }, [selectAllBtn, selectNoneBtn, filterInput]));
  selectionHost.appendChild(selectionSummary);
  const questionListHost = el('div', { 'data-exam-question-list': '' });
  selectionHost.appendChild(questionListHost);

  host.appendChild(el('fieldset', { className: 'exam-assign-purpose' }, [
    el('legend', {}, 'Loại giao bài'),
    el('label', { htmlFor: 'exam-assign-purpose-exam' }, [purposeExamRadio, ' Bài thi (có giới hạn thời gian)']),
    el('label', { htmlFor: 'exam-assign-purpose-hw', style: 'margin-left:1rem' },
      [purposeHwRadio, ' Bài tập trực tuyến (đến hạn nộp, không đếm ngược)']),
  ]));

  const deliveryFieldset = el('fieldset', {
    className: 'exam-assign-delivery',
    'data-exam-assign-delivery-fieldset': '',
  });
  deliveryFieldset.appendChild(el('legend', {}, 'Chế độ giao bài (bắt buộc)'));
  const modeOnline = el('input', { type: 'radio', name: 'exam-delivery-mode', id: 'exam-delivery-online', value: EXAM_DELIVERY_MODE.ONLINE, checked: true });
  const modePdf = el('input', { type: 'radio', name: 'exam-delivery-mode', id: 'exam-delivery-pdf', value: EXAM_DELIVERY_MODE.PDF });
  const modeCombined = el('input', { type: 'radio', name: 'exam-delivery-mode', id: 'exam-delivery-combined', value: EXAM_DELIVERY_MODE.COMBINED });
  deliveryFieldset.appendChild(el('label', { htmlFor: 'exam-delivery-online' }, [modeOnline, ' Trực tuyến']));
  deliveryFieldset.appendChild(el('label', { htmlFor: 'exam-delivery-pdf', style: 'margin-left:1rem' }, [modePdf, ' PDF']));
  deliveryFieldset.appendChild(el('label', { htmlFor: 'exam-delivery-combined', style: 'margin-left:1rem' }, [modeCombined, ' Kết hợp']));
  host.appendChild(deliveryFieldset);

  const pdfPagesHost = el('div', { className: 'exam-assign-pdf-pages card', 'data-exam-pdf-pages': '', hidden: true });
  pdfPagesHost.appendChild(el('h3', {}, 'Chọn trang PDF'));
  const pdfPagesList = el('div', { className: 'exam-assign-pdf-page-list' });
  pdfPagesHost.appendChild(pdfPagesList);
  host.appendChild(pdfPagesHost);

  const requiredPartsHost = el('fieldset', { className: 'exam-assign-required-parts', hidden: true, 'data-exam-required-parts': '' });
  requiredPartsHost.appendChild(el('legend', {}, 'Phần bắt buộc (kết hợp)'));
  const reqOnline = el('input', { type: 'checkbox', id: 'exam-req-online', checked: true });
  const reqPdf = el('input', { type: 'checkbox', id: 'exam-req-pdf', checked: true });
  requiredPartsHost.appendChild(el('label', { htmlFor: 'exam-req-online' }, [reqOnline, ' Phần trực tuyến']));
  requiredPartsHost.appendChild(el('label', { htmlFor: 'exam-req-pdf', style: 'margin-left:1rem' }, [reqPdf, ' Phần PDF']));
  host.appendChild(requiredPartsHost);

  const pdfPointsInput = el('input', { type: 'number', className: 'input', min: '0', step: '0.5', placeholder: 'Tùy chọn' });
  host.appendChild(el('label', { className: 'exam-assign-pdf-points', hidden: true, 'data-exam-pdf-points-label': '' },
    'Điểm phần PDF ', pdfPointsInput));
  const onlinePointsInput = el('input', { type: 'number', className: 'input', min: '0', step: '0.5', placeholder: 'Mặc định: tổng điểm câu đã chọn' });
  host.appendChild(el('label', {
    className: 'exam-assign-online-points',
    hidden: true,
    'data-exam-online-points-label': '',
  }, 'Điểm phần trực tuyến ', onlinePointsInput));

  const classroomPlaybackCheck = el('input', { type: 'checkbox', id: 'exam-classroom-playback' });
  host.appendChild(el('label', { htmlFor: 'exam-classroom-playback', className: 'exam-assign-classroom', hidden: true, 'data-exam-classroom-playback': '' },
    [classroomPlaybackCheck, ' Cho phép nghe trên lớp khi thiếu tệp audio']));

  const reviewSummary = el('p', {
    className: 'exam-assign-review-summary form-hint',
    'data-exam-assign-review-summary': '',
  }, '');
  host.appendChild(reviewSummary);

  host.appendChild(el('label', {}, 'Lớp ', classSel));
  host.appendChild(el('label', {}, 'Tiêu đề ', titleInput));
  host.appendChild(el('label', {}, `Mở (UTC+7) `, openInput));
  host.appendChild(el('label', {}, `Hạn nộp (UTC+7) `, dueInput));
  host.appendChild(durationWrap);
  host.appendChild(el('label', {}, 'Số lần làm ', attemptsInput));
  host.appendChild(el('label', { htmlFor: 'exam-show-score' }, [showScoreCheck, ' Hiển thị điểm cho học sinh']));
  host.appendChild(el('label', {}, 'Công bố đáp án ', releaseSel));
  host.appendChild(selectionHost);

  const resultHost = el('div', { className: 'exam-assign-results' });
  host.appendChild(resultHost);

  const previewBtn = el('button', { type: 'button', className: 'btn btn-secondary' }, 'Xem trước bộ câu đã chọn');
  const assignBtn = el('button', { type: 'button', className: 'btn btn-primary' }, isHomework ? 'Giao bài tập' : 'Giao bài thi');
  host.appendChild(el('div', { className: 'btn-row' }, [previewBtn, assignBtn]));

  let versionContent = null;
  let versionMeta = null;
  const selectedIds = new Set();
  const selectedPdfPages = new Set();

  function currentPurpose() {
    return purposeHwRadio.checked
      ? EXAM_ASSIGNMENT_PURPOSE.HOMEWORK
      : EXAM_ASSIGNMENT_PURPOSE.EXAM;
  }

  function syncPurposeUi() {
    const hw = currentPurpose() === EXAM_ASSIGNMENT_PURPOSE.HOMEWORK;
    durationWrap.hidden = hw;
    assignBtn.textContent = hw ? 'Giao bài tập' : 'Giao bài thi';
  }
  purposeExamRadio.addEventListener('change', () => { syncPurposeUi(); updateReviewSummary(); });
  purposeHwRadio.addEventListener('change', () => { syncPurposeUi(); updateReviewSummary(); });
  syncPurposeUi();

  function currentDeliveryMode() {
    if (modePdf.checked) return EXAM_DELIVERY_MODE.PDF;
    if (modeCombined.checked) return EXAM_DELIVERY_MODE.COMBINED;
    return EXAM_DELIVERY_MODE.ONLINE;
  }

  function renderPdfPagePickers() {
    pdfPagesList.replaceChildren();
    const max = Number(versionMeta?.sourcePdfPageCount) || 0;
    selectedPdfPages.clear();
    if (!max) return;
    for (let p = 1; p <= max; p += 1) {
      selectedPdfPages.add(p);
      const cb = el('input', { type: 'checkbox', checked: true, 'data-pdf-page': String(p) });
      cb.addEventListener('change', () => {
        if (cb.checked) selectedPdfPages.add(p);
        else selectedPdfPages.delete(p);
        updateReviewSummary();
      });
      pdfPagesList.appendChild(el('label', { style: 'display:inline-block;margin:0.25rem 0.75rem 0.25rem 0' }, [cb, ` Trang ${p}`]));
    }
  }

  function syncDeliveryUi() {
    const hasOnline = versionHasAssignableOnlineQuestions(versionMeta || versionContent);
    const hasPdf = versionHasSourcePdf(versionMeta || versionContent);
    const pdfOnly = !!(versionMeta?.pdfOnly);
    modeOnline.disabled = pdfOnly || !hasOnline;
    modePdf.disabled = !hasPdf;
    modeCombined.disabled = pdfOnly || !hasOnline || !hasPdf;
    if (pdfOnly && hasPdf) {
      modePdf.checked = true;
      modeOnline.checked = false;
      modeCombined.checked = false;
    } else if (!hasPdf && hasOnline) {
      modeOnline.checked = true;
    } else if (hasPdf && !hasOnline) {
      modePdf.checked = true;
    }
    const mode = currentDeliveryMode();
    selectionHost.hidden = mode === EXAM_DELIVERY_MODE.PDF;
    pdfPagesHost.hidden = mode === EXAM_DELIVERY_MODE.ONLINE;
    requiredPartsHost.hidden = mode !== EXAM_DELIVERY_MODE.COMBINED;
    const pointsLabel = host.querySelector('[data-exam-pdf-points-label]');
    if (pointsLabel) pointsLabel.hidden = mode === EXAM_DELIVERY_MODE.ONLINE;
    const onlinePointsLabel = host.querySelector('[data-exam-online-points-label]');
    if (onlinePointsLabel) onlinePointsLabel.hidden = mode === EXAM_DELIVERY_MODE.PDF;
    const classroomLabel = host.querySelector('[data-exam-classroom-playback]');
    if (classroomLabel) classroomLabel.hidden = !(versionMeta?.audioState === 'pending');
    updateReviewSummary();
  }

  function updateReviewSummary() {
    if (!versionMeta && !versionContent) {
      reviewSummary.textContent = '';
      return;
    }
    const fakeVersion = {
      ...(versionContent || {}),
      ...(versionMeta || {}),
      questions: versionContent?.questions || [],
      sourceAttachmentId: versionMeta?.sourceAttachmentId,
      sourcePdfPageCount: versionMeta?.sourcePdfPageCount,
    };
    const sel = buildSelectionPayload();
    const body = {
      deliveryMode: currentDeliveryMode(),
      selectedQuestionIds: sel.error ? undefined : sel.ids,
      selectedPdfPageIds: [...selectedPdfPages].sort((a, b) => a - b),
      requiredParts: { online: reqOnline.checked, pdf: reqPdf.checked },
    };
    const check = validateExamAssignmentDelivery(fakeVersion, body);
    reviewSummary.textContent = check.ok
      ? `Sẵn sàng giao — ${check.deliveryMode}${check.selectedPdfPageIds?.length ? ` · ${check.selectedPdfPageIds.length} trang PDF` : ''}`
      : (check.error || 'Chưa hợp lệ');
  }

  for (const r of [modeOnline, modePdf, modeCombined]) {
    r.addEventListener('change', () => { syncDeliveryUi(); renderQuestionList(); });
  }
  reqOnline.addEventListener('change', updateReviewSummary);
  reqPdf.addEventListener('change', updateReviewSummary);

  function allQuestionIds() {
    return (versionContent?.questions || []).map((q) => q.id);
  }

  function updateSelectionSummary() {
    const total = (versionContent?.questions || []).length;
    const n = selectedIds.size;
    selectionSummary.textContent = total
      ? `Đã chọn ${n}/${total} câu`
      : 'Đang tải danh sách câu…';
  }

  function renderQuestionList() {
    questionListHost.replaceChildren();
    if (!versionContent) return;
    const filter = String(filterInput.value || '').trim();
    const groups = new Map();
    const ungrouped = [];
    for (const q of versionContent.questions || []) {
      if (filter && !String(q.displayNumber || '').includes(filter)) continue;
      const gid = q.passageId || q.groupId;
      if (gid) {
        if (!groups.has(gid)) groups.set(gid, []);
        groups.get(gid).push(q);
      } else {
        ungrouped.push(q);
      }
    }
    const renderQuestionRow = (q) => {
      const cb = el('input', {
        type: 'checkbox',
        checked: selectedIds.has(q.id),
        'data-question-id': q.id,
      });
      cb.addEventListener('change', () => {
        if (cb.checked) selectedIds.add(q.id);
        else selectedIds.delete(q.id);
        updateSelectionSummary();
      });
      return el('label', { style: 'display:block;margin:0.25rem 0' }, [
        cb,
        ` Câu ${q.displayNumber}`,
      ]);
    };
    for (const [gid, qs] of groups) {
      const raw = (versionContent.passages || []).find((p) => p.id === gid);
      const group = raw ? normalizeReadingGroup(raw) : null;
      const range = group ? parseExpectedQuestionRange(group) : null;
      const title = range ? `Nhóm câu ${range.min}–${range.max}` : (group?.title || 'Nhóm đọc');
      const groupWrap = el('div', { className: 'exam-assign-group', style: 'margin:0.5rem 0' });
      const groupCb = el('input', { type: 'checkbox', 'data-group-id': gid });
      const allInGroup = qs.map((q) => q.id);
      groupCb.checked = allInGroup.every((id) => selectedIds.has(id));
      groupCb.addEventListener('change', () => {
        for (const id of allInGroup) {
          if (groupCb.checked) selectedIds.add(id);
          else selectedIds.delete(id);
        }
        renderQuestionList();
        updateSelectionSummary();
      });
      groupWrap.appendChild(el('label', {}, [groupCb, ` ${title}`]));
      for (const q of qs) groupWrap.appendChild(renderQuestionRow(q));
      questionListHost.appendChild(groupWrap);
    }
    for (const q of ungrouped) questionListHost.appendChild(renderQuestionRow(q));
    updateSelectionSummary();
  }

  selectAllBtn.addEventListener('click', () => {
    for (const id of allQuestionIds()) selectedIds.add(id);
    renderQuestionList();
  });
  selectNoneBtn.addEventListener('click', () => {
    selectedIds.clear();
    renderQuestionList();
  });
  filterInput.addEventListener('input', () => renderQuestionList());

  function buildSelectionPayload() {
    const ids = allQuestionIds().filter((id) => selectedIds.has(id));
    if (!ids.length) return { error: 'Chọn ít nhất một câu hỏi.' };
    if (ids.length === allQuestionIds().length) return { ids: null };
    return { ids };
  }

  function assignmentPolicyForPreview() {
    const sel = buildSelectionPayload();
    if (sel.error) return sel;
    return {
      purpose: currentPurpose(),
      selectedQuestionIds: sel.ids || undefined,
      timeLimitMinutes: currentPurpose() === EXAM_ASSIGNMENT_PURPOSE.HOMEWORK
        ? null
        : (Number(durationInput.value) || 60),
      showScore: showScoreCheck.checked,
      showAnswersAfter: releaseSel.value,
    };
  }

  previewBtn.addEventListener('click', () => {
    if (!versionContent) {
      ctx.toastErr('Chưa tải được đề.');
      return;
    }
    const policy = assignmentPolicyForPreview();
    if (policy.error) {
      ctx.toastErr(policy.error);
      return;
    }
    const sel = buildSelectionPayload();
    const exam = buildTeacherPreviewExamProjection(versionContent, {
      ...policy,
      selectedQuestionIds: sel.ids || undefined,
    });
    closeActiveTeacherStudentPreview();
    activeTeacherStudentPreviewDispose = openTeacherExamStudentPreview(ctx, exam, {
      assignmentPolicy: policy,
      onClose: () => { activeTeacherStudentPreviewDispose = null; },
    });
  });

  fetchTeacherExamVersionStudentPreview(versionId).then((data) => {
    versionMeta = data.version || null;
    versionContent = {
      id: data.exam.versionId || versionId,
      title: data.exam.title,
      sections: data.exam.sections,
      passages: data.exam.passages,
      questions: data.exam.questions,
      sourceAttachmentId: versionMeta?.sourceAttachmentId,
    };
    for (const id of allQuestionIds()) selectedIds.add(id);
    renderPdfPagePickers();
    renderQuestionList();
    syncDeliveryUi();
  }).catch((e) => ctx.toastErr(e.message || 'Không tải được đề.'));

  assignBtn.addEventListener('click', () => withBusyButton(assignBtn, 'Đang giao…', async () => {
    try {
      const classId = classSel.value;
      if (!classId) {
        ctx.toastErr('Chọn lớp.');
        return;
      }
      const openAt = localInputToIso(openInput.value);
      const dueAt = localInputToIso(dueInput.value);
      if (!openAt || !dueAt) {
        ctx.toastErr('Nhập thời gian mở và hạn nộp.');
        return;
      }
      const purpose = currentPurpose();
      const deliveryMode = currentDeliveryMode();
      const sel = buildSelectionPayload();
      if (deliveryMode !== EXAM_DELIVERY_MODE.PDF) {
        if (sel.error) {
          ctx.toastErr(sel.error);
          return;
        }
      }
      const payload = {
        versionId,
        classId,
        title: titleInput.value.trim() || (purpose === EXAM_ASSIGNMENT_PURPOSE.HOMEWORK ? 'Bài tập' : 'Bài thi'),
        openAt,
        dueAt,
        purpose,
        attemptLimit: Number(attemptsInput.value) || 1,
        showScore: showScoreCheck.checked,
        showAnswersAfter: releaseSel.value,
        deliveryMode,
      };
      if (purpose === EXAM_ASSIGNMENT_PURPOSE.EXAM) {
        payload.timeLimitMinutes = Number(durationInput.value) || 60;
      }
      if (deliveryMode !== EXAM_DELIVERY_MODE.PDF && sel.ids) payload.selectedQuestionIds = sel.ids;
      if (deliveryMode !== EXAM_DELIVERY_MODE.ONLINE) {
        const pages = [...selectedPdfPages].sort((a, b) => a - b);
        if (pages.length) payload.selectedPdfPageIds = pages;
      }
      if (payload.deliveryMode === EXAM_DELIVERY_MODE.COMBINED) {
        payload.requiredParts = { online: reqOnline.checked, pdf: reqPdf.checked };
      }
      const pts = Number(pdfPointsInput.value);
      if (Number.isFinite(pts) && pts > 0) payload.pdfPartPoints = pts;
      const onlinePts = Number(onlinePointsInput.value);
      if (Number.isFinite(onlinePts) && onlinePts > 0) payload.onlinePartPoints = onlinePts;
      if (classroomPlaybackCheck.checked) payload.classroomPlaybackAllowed = true;
      await createExamAssignment(payload);
      ctx.toastOk(purpose === EXAM_ASSIGNMENT_PURPOSE.HOMEWORK ? 'Đã giao bài tập.' : 'Đã giao bài thi.');
      ctx.navigate('#/exams');
    } catch (e) {
      ctx.toastErr(e.message || 'Không giao được lớp.');
    }
  }));

  const assignmentId = params.get('assignment');
  if (assignmentId) {
    fetchExamAssignmentSummary(assignmentId).then((data) => {
      resultHost.appendChild(el('h3', {}, 'Kết quả học sinh'));
      if (!data.summary?.length) {
        resultHost.appendChild(el('p', {}, 'Chưa có lượt nộp.'));
        return;
      }
      const ul = el('ul');
      for (const row of data.summary) {
        const scorePart = row.score10 != null ? ` — ${row.score10}/10` : (row.gradingLabel ? ` — ${row.gradingLabel}` : '');
        ul.appendChild(el('li', {}, [
          el('span', {}, `${row.studentId}: ${row.status}${scorePart} `),
          el('button', {
            type: 'button',
            className: 'btn btn-ghost',
            onClick: () => ctx.navigate(`#/exams/grade/${assignmentId}?attemptId=${encodeURIComponent(row.attemptId)}`),
          }, 'Chấm bài'),
        ]));
      }
      resultHost.appendChild(ul);
      resultHost.appendChild(el('button', {
        type: 'button',
        className: 'btn btn-secondary',
        onClick: () => ctx.navigate(`#/exams/grade/${assignmentId}`),
      }, 'Chấm bài / đáp án'));
    }).catch((e) => ctx.toastErr(e.message));
  }
}

export function renderExamDraftEditor(ctx, root, draftId) {
  let disposed = false;
  let previewDispose = null;
  let pdfPreviewWrap = null;
  let lastSavedRevision = null;
  let editorDirty = false;
  let saveStatusEl = null;
  const saveCoordinator = createExamDraftSaveCoordinator();
  let draftWriteBusy = false;
  const removalUndoStack = [];
  const priorDispose = root.__examDispose;
  root.__examDispose = () => {
    disposed = true;
    registerDirtyProbe(null);
    if (previewDispose) previewDispose();
    previewDispose = null;
    closeActiveTeacherStudentPreview();
    if (typeof priorDispose === 'function') priorDispose();
  };

  function refreshSaveStatusLabel() {
    if (!saveStatusEl) return;
    saveStatusEl.textContent = editorDirty ? 'Chưa lưu' : 'Đã lưu';
  }

  function markEditorDirty() {
    editorDirty = true;
    saveCoordinator.bumpDirtyGeneration();
    draftState && (draftState.manuallyEdited = true);
    refreshSaveStatusLabel();
    bumpDirtyNavigationGuard();
  }

  function markEditorClean() {
    editorDirty = false;
    refreshSaveStatusLabel();
    bumpDirtyNavigationGuard();
  }

  function refreshDraftEditorLockState() {
    if (!host) return;
    const lock = composeAppendLocked;
    for (const el of host.querySelectorAll('input, textarea, select, button')) {
      if (el.classList?.contains('exam-draft-merge-submit')) continue;
      if (lock) {
        if (el.dataset.examDraftPrevDisabled === undefined) {
          el.dataset.examDraftPrevDisabled = el.disabled ? '1' : '0';
        }
        el.disabled = true;
      } else {
        const prev = el.dataset.examDraftPrevDisabled;
        if (prev !== undefined) {
          el.disabled = prev === '1';
          delete el.dataset.examDraftPrevDisabled;
        }
      }
    }
  }

  registerDirtyProbe(() => editorDirty);

  root.appendChild(el('h1', { className: 'page-title' }, 'Soạn đề'));
  root.appendChild(el('button', {
    type: 'button',
    className: 'btn btn-ghost',
    onClick: () => {
      if (editorDirty && !globalThis.confirm('Còn thay đổi chưa lưu — rời trang?')) return;
      ctx.navigate('#/exams');
    },
  }, '← Kho đề'));

  const host = el('div', { className: 'exam-draft-editor' });
  root.appendChild(host);

  let draftState = null;
  let viewEpoch = 0;
  let reviewFilterMode = 'all';
  const reviewFilterPinned = { passageIds: new Set(), questionIds: new Set() };
  let pendingFocusTarget = null;
  let refreshReviewFilterLabels = () => {};
  /** When set, that reading-group card shows full edit panels; others stay readable. */
  let draftPassageEditId = null;
  /** When set, that question card shows stem/options/key editors; others stay readable. */
  let draftQuestionEditId = null;
  /** Disables the whole draft editor while compose-append save/sync runs (avoids lost concurrent edits). */
  let composeAppendLocked = false;
  /** When draft has multiple source exams, which PDF to show in the preview column */
  let pdfSourceVersionId = null;
  let mergeComposeSource = null;
  let mergeSelectedVersionId = null;
  const mergeSelectedIds = new Set();
  let teacherPublishedVersions = [];

  function activateDraftTarget(target) {
    if (!target || !draftState) return;
    if (target.kind === 'question' && target.questionId) {
      draftQuestionEditId = target.questionId;
      draftPassageEditId = null;
    } else if ((target.kind === 'passage' || target.kind === 'document') && target.passageId) {
      draftPassageEditId = target.passageId;
      draftQuestionEditId = null;
    } else {
      draftQuestionEditId = null;
      draftPassageEditId = null;
    }
    if (draftReviewTargetVisible(host, draftState, reviewFilterMode, reviewFilterPinned, target)) {
      pendingFocusTarget = target;
      renderDraftBody();
      return;
    }
    pinDraftReviewTarget(reviewFilterPinned, target);
    pendingFocusTarget = target;
    renderDraftBody();
  }

  async function reload() {
    fetchExamTeacherSummary().then((d) => {
      teacherPublishedVersions = d.versions || [];
    }).catch(() => {});
    const data = await fetchExamDraft(draftId);
    if (disposed) return;
    draftState = data.draft;
    const binds = draftState.composedSourceExamBindings || {};
    const withPdf = Object.keys(binds).filter((k) => binds[k]?.sourceAttachmentId);
    if (!pdfSourceVersionId && withPdf.length) [pdfSourceVersionId] = withPdf;
    if (pdfSourceVersionId && !binds[pdfSourceVersionId]?.sourceAttachmentId) {
      pdfSourceVersionId = withPdf[0] || null;
    }
    lastSavedRevision = draftState.revision;
    editorDirty = false;
    draftQuestionEditId = null;
    draftPassageEditId = null;
    saveCoordinator.resetDirtyGeneration();
    bumpDirtyNavigationGuard();
    renderDraftBody();
  }

  function collectDraftPutPayload() {
    const titleInput = host.querySelector('input[data-exam-target="title"]');
    const reviewCheck = host.querySelector('#exam-review-ok');
    const manualRadio = host.querySelector('#exam-grading-mode-manual');
    if (titleInput) draftState.title = titleInput.value;
    if (reviewCheck) draftState.teacherConfirmedReview = reviewCheck.checked;
    if (manualRadio) {
      draftState.gradingMode = manualRadio.checked
        ? EXAM_GRADING_MODE.TEACHER_MANUAL_LATER
        : EXAM_GRADING_MODE.AUTOMATIC;
    }
    return snapshotExamDraftPutPayload({
      title: draftState.title,
      questions: draftState.questions,
      passages: draftState.passages,
      sections: draftState.sections,
      teacherConfirmedReview: draftState.teacherConfirmedReview,
      gradingMode: draftState.gradingMode,
      baseRevision: draftState.revision,
    });
  }

  async function executeDraftPut(savedAtGeneration, payload) {
    draftWriteBusy = true;
    try {
      const res = await saveExamDraft(draftId, payload);
      acknowledgeDraftSaveResponse(res, savedAtGeneration);
      return res;
    } finally {
      draftWriteBusy = false;
    }
  }

  function queueDraftPut() {
    const savedAtGeneration = saveCoordinator.currentDirtyGeneration();
    const payload = collectDraftPutPayload();
    return saveCoordinator.runSerializedWrite(() => executeDraftPut(savedAtGeneration, payload));
  }

  function acknowledgeDraftSaveResponse(res, savedAtGeneration) {
    if (!draftState || disposed) return;
    draftState.revision = res.revision;
    lastSavedRevision = res.revision;
    applyExamDraftSaveAck(saveCoordinator, savedAtGeneration, markEditorClean);
  }

  function renderDraftBody() {
    viewEpoch += 1;
    const epoch = viewEpoch;
    let focusAfterRender = null;
    if (pendingFocusTarget) {
      const t = pendingFocusTarget;
      pendingFocusTarget = null;
      focusAfterRender = t;
      if (t.kind === 'question' && t.questionId) {
        draftQuestionEditId = t.questionId;
        draftPassageEditId = null;
      } else if ((t.kind === 'passage' || t.kind === 'document') && t.passageId) {
        draftPassageEditId = t.passageId;
        draftQuestionEditId = null;
      }
    }
    host.__examPdfMountPromise = null;
    if (previewDispose) previewDispose();
    previewDispose = null;
    closeActiveTeacherStudentPreview();
    while (host.firstChild) host.removeChild(host.firstChild);
    if (!draftState) return;

    if (draftState.publishedVersionId) {
      const pubLock = el('div', {
        className: 'demo-banner',
        'data-exam-published-draft-lock': '',
        style: 'margin-bottom:0.5rem',
      });
      pubLock.appendChild(el('p', {}, 'Đề đã xuất bản — chỉnh cấu trúc câu hỏi cần bản soạn mới trong cùng kho (không sửa tại chỗ).'));
      const revBtn = el('button', { type: 'button', className: 'btn btn-primary btn-sm' }, 'Soạn bản mới');
      revBtn.addEventListener('click', () => withBusyButton(revBtn, 'Đang tạo…', async () => {
        const res = await reviseExamVersion(draftState.publishedVersionId);
        ctx.navigate(`#/exams/draft/${res.draftId}`);
      }).catch((e) => ctx.toastErr(e.message)));
      pubLock.appendChild(revBtn);
      host.appendChild(pubLock);
    }

    if (draftState.needsOcr) {
      const pages = draftState.needsOcrPageNumbers;
      const msg = Array.isArray(pages) && pages.length
        ? `Trang ${pages.join(', ')}: có nội dung hình/ảnh nhưng không trích được lớp chữ — cần nhận dạng chữ hoặc bổ sung văn bản trước khi xuất bản.`
        : 'Một hoặc nhiều trang có nội dung hình/ảnh nhưng không trích được lớp chữ — cần nhận dạng chữ hoặc bổ sung văn bản trước khi xuất bản.';
      host.appendChild(el('p', { className: 'demo-banner' }, msg));
    }

    const layout = el('div', { className: 'exam-draft-layout' });
    const editorCol = el('div', { className: 'exam-draft-editor-col' });
    const previewCol = el('div', { className: 'exam-draft-preview-col' });
    layout.appendChild(editorCol);
    layout.appendChild(previewCol);
    host.appendChild(layout);

    const titleInput = el('input', {
      type: 'text',
      className: 'input',
      value: draftState.title || '',
      'data-exam-target': 'title',
      onInput: (e) => { draftState.title = e.target.value; markEditorDirty(); },
    });
    editorCol.appendChild(el('label', {}, 'Tiêu đề ', titleInput));

    const mediaPanel = el('div', {
      className: 'card exam-draft-media',
      'data-exam-draft-media': '',
      style: 'margin:0.75rem 0;padding:0.75rem',
    });
    const audioTargetSel = el('select', {
      className: 'input',
      'data-exam-draft-audio-target': '',
      style: 'max-width:16rem',
    });
    audioTargetSel.appendChild(el('option', { value: '' }, 'Toàn bài'));
    for (const pg of draftState.passages || []) {
      const g = normalizeReadingGroup(pg);
      const r = parseExpectedQuestionRange(g);
      const label = r ? `Nhóm câu ${r.min}–${r.max}` : (g.title || 'Nhóm');
      audioTargetSel.appendChild(el('option', { value: g.id }, label));
    }
    audioTargetSel.addEventListener('change', () => renderDraftBody());
    const selectedAudioGroup = audioTargetSel.value || null;
    const boundAudioId = (() => {
      if (selectedAudioGroup && draftState.mediaBindings?.groups?.[selectedAudioGroup]) {
        return draftState.mediaBindings.groups[selectedAudioGroup].audioAttachmentId;
      }
      return draftState.audioAttachmentId
        || draftState.mediaBindings?.paper?.audioAttachmentId
        || null;
    })();
    const audioBadge = el('span', {
      className: boundAudioId ? 'badge badge-accent' : 'badge badge-amber',
    }, boundAudioId ? 'Audio: sẵn sàng' : 'Audio: chưa có');
    mediaPanel.appendChild(el('h3', {}, 'Âm thanh'));
    mediaPanel.appendChild(el('label', {}, 'Gắn vào ', audioTargetSel));
    mediaPanel.appendChild(audioBadge);
    const audioFile = el('input', { type: 'file', accept: 'audio/*', 'data-exam-draft-audio-file': '' });
    const attachAudioBtn = el('button', { type: 'button', className: 'btn btn-secondary btn-sm' }, 'Tải lên / thay');
    const removeAudioBtn = el('button', { type: 'button', className: 'btn btn-ghost btn-sm' }, 'Gỡ');
    const audioErr = el('p', {
      className: 'form-hint exam-audio-inline-err',
      role: 'alert',
      hidden: true,
    }, '');
    const postMedia = async (payload) => {
      const gid = audioTargetSel.value ? String(audioTargetSel.value) : null;
      if (gid) payload.groupId = gid;
      await saveExamDraftMedia(draftId, payload);
    };
    attachAudioBtn.addEventListener('click', () => withBusyButton(attachAudioBtn, 'Đang lưu…', async () => {
      const file = audioFile.files?.[0];
      if (!file) {
        ctx.toastErr('Chọn tệp âm thanh.');
        return;
      }
      if (draftState.publishedVersionId && !globalThis.confirm('Bản nháp đã xuất bản — thay audio cần xác nhận tác động. Tiếp tục?')) {
        return;
      }
      const up = await uploadTeacherAttachment(file);
      await postMedia({
        action: boundAudioId ? 'replace' : 'attach',
        audioAttachmentId: up.id,
        baseMediaRevision: draftState.mediaRevision || 0,
        acknowledgeMediaChange: !!draftState.publishedVersionId,
      });
      ctx.toastOk('Đã cập nhật âm thanh.');
      await reload();
    }).catch((e) => ctx.toastErr(e.message)));
    removeAudioBtn.addEventListener('click', () => withBusyButton(removeAudioBtn, 'Đang gỡ…', async () => {
      if (draftState.publishedVersionId && !globalThis.confirm('Gỡ audio trên bản đã xuất bản — xác nhận?')) return;
      await postMedia({
        action: 'remove',
        baseMediaRevision: draftState.mediaRevision || 0,
        acknowledgeMediaChange: !!draftState.publishedVersionId,
      });
      ctx.toastOk('Đã gỡ âm thanh.');
      await reload();
    }).catch((e) => ctx.toastErr(e.message)));
    mediaPanel.appendChild(el('div', { className: 'btn-row' }, [audioFile, attachAudioBtn, removeAudioBtn]));
    if (boundAudioId) {
      const preview = el('audio', {
        controls: true,
        preload: 'metadata',
        src: teacherAttachmentPreviewUrl(boundAudioId),
        style: 'width:100%;margin-top:0.5rem',
      });
      preview.addEventListener('error', () => {
        audioErr.hidden = false;
        audioErr.textContent = 'Không phát được âm thanh — kiểm tra tệp hoặc tải lại.';
      });
      mediaPanel.appendChild(preview);
    }
    mediaPanel.appendChild(audioErr);
    editorCol.appendChild(mediaPanel);

    const provBindings = draftState.composedSourceExamBindings || {};
    const bySource = countComposerSelectionsBySource(draftState.questions || []);
    if (bySource.size) {
      editorCol.appendChild(el('p', {
        className: 'form-hint',
        'data-exam-draft-provenance-summary': '',
      }, formatComposerSelectionSummaryVi(bySource, provBindings)));
    }

    const gradingMode = normalizeExamGradingMode(draftState);
    draftState.gradingMode = gradingMode;
    const missingKeys = draftMissingAnswerKeyCount(draftState);
    const modePanel = el('div', {
      id: 'exam-grading-mode-panel',
      className: 'card',
      style: 'margin:0.75rem 0;padding:0.75rem',
    });
    modePanel.appendChild(el('strong', {}, 'Chế độ chấm điểm'));
    const autoRadio = el('input', {
      type: 'radio',
      name: 'exam-grading-mode',
      id: 'exam-grading-mode-auto',
      checked: gradingMode === EXAM_GRADING_MODE.AUTOMATIC,
    });
    const manualRadio = el('input', {
      type: 'radio',
      name: 'exam-grading-mode',
      id: 'exam-grading-mode-manual',
      checked: gradingMode === EXAM_GRADING_MODE.TEACHER_MANUAL_LATER,
    });
    const syncMode = () => {
      draftState.gradingMode = manualRadio.checked
        ? EXAM_GRADING_MODE.TEACHER_MANUAL_LATER
        : EXAM_GRADING_MODE.AUTOMATIC;
    };
    autoRadio.addEventListener('change', () => { syncMode(); markEditorDirty(); });
    manualRadio.addEventListener('change', () => { syncMode(); markEditorDirty(); });
    modePanel.appendChild(el('label', { style: 'display:block;margin:0.35rem 0' }, [
      autoRadio,
      ' Chấm tự động — cần điền đủ đáp án đúng trước khi xuất bản',
    ]));
    modePanel.appendChild(el('label', { style: 'display:block;margin:0.35rem 0' }, [
      manualRadio,
      ' Giáo viên chấm sau — chỉ cần đọc đề; chọn đáp án đúng khi chấm bài nộp',
    ]));
    if (missingKeys > 0 && manualRadio.checked) {
      modePanel.appendChild(el('p', { className: 'demo-banner', style: 'margin-top:0.5rem' },
        `Còn ${missingKeys} câu chưa có đáp án trong nháp — vẫn xuất bản được ở chế độ giáo viên chấm sau.`));
    }
    editorCol.appendChild(modePanel);

    const filterCounts = computeDraftReviewFilterCounts(draftState);
    const filterBar = el('div', {
      className: 'exam-draft-review-filter filter-bar',
      role: 'radiogroup',
      'aria-label': 'Lọc mục cần kiểm tra',
    });
    const allFilterBtn = el('button', {
      type: 'button',
      className: `btn btn-secondary${reviewFilterMode === 'all' ? ' exam-draft-review-filter--active' : ''}`,
      role: 'radio',
      'aria-checked': reviewFilterMode === 'all' ? 'true' : 'false',
    }, `Tất cả (${filterCounts.groupsTotal} nhóm, ${filterCounts.questionsTotal} câu)`);
    const needFilterBtn = el('button', {
      type: 'button',
      className: `btn btn-secondary${reviewFilterMode === 'needs-review' ? ' exam-draft-review-filter--active' : ''}`,
      role: 'radio',
      'aria-checked': reviewFilterMode === 'needs-review' ? 'true' : 'false',
    }, `Cần kiểm tra (${filterCounts.groupsNeedReview} nhóm, ${filterCounts.questionsNeedReview} câu)`);
    refreshReviewFilterLabels = () => {
      const c = computeDraftReviewFilterCounts(draftState);
      allFilterBtn.textContent = `Tất cả (${c.groupsTotal} nhóm, ${c.questionsTotal} câu)`;
      needFilterBtn.textContent = `Cần kiểm tra (${c.groupsNeedReview} nhóm, ${c.questionsNeedReview} câu)`;
    };
    allFilterBtn.addEventListener('click', () => {
      if (reviewFilterMode === 'all') return;
      reviewFilterMode = 'all';
      renderDraftBody();
    });
    needFilterBtn.addEventListener('click', () => {
      if (reviewFilterMode === 'needs-review') return;
      reviewFilterMode = 'needs-review';
      renderDraftBody();
    });
    filterBar.appendChild(allFilterBtn);
    filterBar.appendChild(needFilterBtn);
    editorCol.appendChild(filterBar);

    const passageById = new Map();
    for (const raw0 of draftState.passages || []) {
      passageById.set(normalizeReadingGroup(raw0).id, raw0);
    }

    const renderedPassageIds = new Set();

    function addQuestion() {
      if (!draftState.sections?.length) {
        draftState.sections = [{ id: newExamSectionId(), title: 'Phần 1', order: 1 }];
      }
      const sec = draftState.sections[0].id;
      const displayNumber = nextUniqueExamDisplayNumber(draftState.questions);
      const order = (draftState.questions?.length || 0) + 1;
      const qid = newExamQuestionId(sec, order);
      const opts = defaultOptionIds(4).map((id) => ({ id, label: id, text: '' }));
      draftState.questions.push({
        id: qid,
        sectionId: sec,
        displayNumber,
        stemText: '',
        options: opts,
        correctOptionId: null,
        points: 1,
        order,
      });
      draftPassageEditId = null;
      draftQuestionEditId = qid;
      markEditorDirty();
      renderDraftBody();
    }

    function moveQuestionById(qid, delta) {
      const sorted = sortExamQuestionsByOrder(draftState.questions);
      const idx = sorted.findIndex((q) => q.id === qid);
      if (idx < 0) return;
      const swapIdx = idx + delta;
      if (swapIdx < 0 || swapIdx >= sorted.length) return;
      const a = sorted[idx];
      const b = sorted[swapIdx];
      const tmp = a.order ?? idx + 1;
      a.order = b.order ?? swapIdx + 1;
      b.order = tmp;
      markEditorDirty();
      renderDraftBody();
    }

    function removeQuestionById(qid) {
      if (draftQuestionEditId === qid) draftQuestionEditId = null;
      const snap = {
        questions: JSON.parse(JSON.stringify(draftState.questions || [])),
        passages: JSON.parse(JSON.stringify(draftState.passages || [])),
      };
      draftState.questions = (draftState.questions || []).filter((q) => q.id !== qid);
      pruneUnusedExamPassages(draftState);
      removalUndoStack.push(snap);
      markEditorDirty();
      renderDraftBody();
      ctx.toastOk('Đã gỡ câu khỏi bản nháp — dùng «Hoàn tác gỡ câu» nếu nhầm.');
    }

    /**
     * @param {object} raw
     * @param {ReturnType<typeof normalizeReadingGroup>} p
     */
    function buildPassageCard(raw, p) {
      raw.contextConfirmed = !!raw.contextConfirmed;
      if (raw.requiresContext == null) raw.requiresContext = !!p.requiresContext;
      if (!raw.documents?.length && p.documents?.length) {
        raw.documents = p.documents;
        raw.bodyText = p.bodyText;
        raw.expectedQuestionRange = p.expectedQuestionRange;
        raw.requiresContext = p.requiresContext;
      }
      const range = parseExpectedQuestionRange(p);
      const memberNums = readingGroupQuestionNumbers(p, draftState.questions || []);
      const rangeLabel = range
        ? `Nhóm câu ${range.min}–${range.max}`
        : (memberNums.length ? `Nhóm (${memberNums.join(', ')})` : 'Nhóm đọc');
      const passageEditing = draftPassageEditId === p.id;
      const pBlock = el('div', {
        className: `card exam-draft-passage-card${passageEditing ? ' exam-draft-passage-card--editing' : ''}`,
        style: 'margin:0.5rem 0;padding:0.75rem',
        'data-passage-id': p.id,
      });
      pBlock.addEventListener('focusin', () => {
        reviewFilterPinned.passageIds.add(p.id);
      });
      const head = el('div', { className: 'btn-row', style: 'align-items:center;flex-wrap:wrap;gap:0.35rem' });
      head.appendChild(el('strong', {}, rangeLabel));
      const passageEditLabel = 'Chỉnh sửa nhóm đọc';
      const pEditBtn = el('button', {
        type: 'button',
        className: 'btn btn-ghost btn-sm exam-draft-passage-edit-btn',
        'aria-label': passageEditLabel,
        title: passageEditLabel,
      }, examDraftPencilIconSvg());
      pEditBtn.addEventListener('click', () => {
        draftPassageEditId = p.id;
        draftQuestionEditId = null;
        renderDraftBody();
      });
      head.appendChild(pEditBtn);
      pBlock.appendChild(head);
      if (p.unsupportedTaskType) {
        pBlock.appendChild(el('p', { className: 'demo-banner' }, p.unsupportedReason || 'Dạng bài chưa hỗ trợ.'));
      }
      if (memberNums.length) {
        pBlock.appendChild(el('p', { className: 'exam-draft-passage-members', style: 'font-size:0.85rem' },
          `Câu thuộc nhóm: ${memberNums.join(', ')}`));
      }
      const skillBulk = el('select', { className: 'input', 'data-exam-group-skill-bulk': '' });
      skillBulk.appendChild(el('option', { value: '' }, '— Kỹ năng cho cả nhóm —'));
      for (const row of [
        { id: EXAM_SKILL.LISTENING, label: 'Nghe' },
        { id: EXAM_SKILL.READING, label: 'Đọc' },
        { id: EXAM_SKILL.WRITING, label: 'Viết' },
        { id: EXAM_SKILL.SPEAKING, label: 'Nói' },
        { id: EXAM_SKILL.UNCLASSIFIED, label: 'Chưa phân loại' },
      ]) skillBulk.appendChild(el('option', { value: row.id }, row.label));
      skillBulk.addEventListener('change', () => {
        if (!skillBulk.value) return;
        for (const q of draftState.questions || []) {
          if (q.passageId === p.id || q.groupId === p.id) q.skill = skillBulk.value;
        }
        markEditorDirty();
        ctx.toastOk('Đã gán kỹ năng cho nhóm.');
      });
      pBlock.appendChild(el('label', { style: 'display:block;margin-top:0.35rem' }, 'Phân loại nhóm ', skillBulk));
      const readSurface = renderReadingGroupCard(p);
      readSurface.classList.add('exam-draft-readable-passage');

      const editPanel = el('div', { className: 'exam-draft-passage-edit-panel' });
      const instrTa = el('textarea', { className: 'input', rows: '2' });
      initTextarea(instrTa, p.instructions || '', (v) => {
        p.instructions = v;
        raw.instructions = v;
        draftState.manuallyEdited = true;
        markEditorDirty();
      });
      editPanel.appendChild(el('label', {}, 'Hướng dẫn ', instrTa));
      const titleTa = el('textarea', { className: 'input', rows: '1' });
      initTextarea(titleTa, p.title || '', (v) => {
        p.title = v;
        raw.title = v;
        draftState.manuallyEdited = true;
        markEditorDirty();
      });
      editPanel.appendChild(el('label', {}, 'Tiêu đề nhóm ', titleTa));
      const docs = p.documents?.length ? p.documents : [];
      for (const doc of docs) {
        const docWrap = el('div', {
          className: 'exam-draft-doc-edit-panel',
          style: 'margin:0.5rem 0;padding:0.5rem;border:1px solid #ddd',
          'data-document-id': doc.id,
          'data-passage-id': p.id,
        });
        const pages = (doc.sourcePages || []).join(', ');
        docWrap.appendChild(el('span', { style: 'font-size:0.85rem' },
          `${doc.title || doc.type || 'Tài liệu'} · trang ${pages || '—'}${doc.requiresReview ? ' · cần bổ sung' : ''}`));
        const bodyTa = el('textarea', { className: 'input', rows: '4' });
        initTextarea(bodyTa, doc.bodyText || '', (v) => {
          doc.bodyText = v;
          raw.documents = p.documents;
          p.bodyText = p.documents.map((d) => d.bodyText).filter(Boolean).join('\n\n');
          raw.bodyText = p.bodyText;
          draftState.manuallyEdited = true;
          markEditorDirty();
          if (p.requiresContext) {
            const allOk = readingGroupAllDocsFilled(p);
            if (!allOk) {
              p.contextConfirmed = false;
              raw.contextConfirmed = false;
            }
          }
          refreshReviewFilterLabels();
        });
        docWrap.appendChild(bodyTa);
        editPanel.appendChild(docWrap);
      }
      if (!docs.length) {
        const bodyTa = el('textarea', { className: 'input', rows: '4' });
        initTextarea(bodyTa, p.bodyText || '', (v) => {
          p.bodyText = v;
          raw.bodyText = v;
          draftState.manuallyEdited = true;
          markEditorDirty();
          if (p.requiresContext) {
            const allOk = readingGroupAllDocsFilled(p);
            if (!allOk) {
              p.contextConfirmed = false;
              raw.contextConfirmed = false;
            }
          }
          refreshReviewFilterLabels();
        });
        editPanel.appendChild(el('label', {}, 'Nội dung đoạn đọc ', bodyTa));
      }
      const passageDone = el('button', { type: 'button', className: 'btn btn-secondary' }, 'Xong');
      passageDone.addEventListener('click', () => {
        draftPassageEditId = null;
        renderDraftBody();
      });
      editPanel.appendChild(passageDone);

      if (passageEditing) {
        pBlock.appendChild(editPanel);
      } else {
        pBlock.appendChild(readSurface);
      }

      const ctxRow = el('div', { className: 'exam-draft-passage-ctx', style: 'font-size:0.85rem;margin-top:0.5rem' });
      if (p.requiresContext && readingGroupAllDocsFilled(p)) {
        const ctxCheck = el('input', {
          type: 'checkbox',
          'data-exam-target': 'context-confirm',
          'data-passage-id': p.id,
        });
        ctxCheck.checked = !!raw.contextConfirmed;
        ctxCheck.disabled = !readingGroupAllDocsFilled(p);
        ctxCheck.addEventListener('change', () => {
          if (!readingGroupAllDocsFilled(p)) {
            ctxCheck.checked = false;
            return;
          }
          p.contextConfirmed = ctxCheck.checked;
          raw.contextConfirmed = ctxCheck.checked;
          markEditorDirty();
          refreshReviewFilterLabels();
        });
        ctxRow.appendChild(el('label', {}, [ctxCheck, ' Tôi đã kiểm tra đầy đủ nội dung nhóm câu hỏi này']));
      } else if (p.requiresContext) {
        ctxRow.appendChild(el('span', { className: 'demo-banner' },
          'Cần bổ sung đủ nội dung nhóm trước khi xác nhận.'));
      }
      if (ctxRow.childNodes.length) pBlock.appendChild(ctxRow);

      return pBlock;
    }

    function renderQuestionBlock(q, sortedIndex, sortedList) {
      const qEditing = draftQuestionEditId === q.id;
      const block = el('div', {
        className: `card exam-draft-q-card${qEditing ? ' exam-draft-q-card--editing' : ''}`,
        style: 'margin:0.5rem 0;padding:0.75rem',
        'data-question-id': q.id,
      });
      block.addEventListener('focusin', () => {
        reviewFilterPinned.questionIds.add(q.id);
      });
      const titleParts = [`Câu ${q.displayNumber}`];
      if (q.originalDisplayNumber && String(q.originalDisplayNumber) !== String(q.displayNumber)) {
        titleParts.push(`(nguồn: ${q.originalDisplayNumber})`);
      }
      const titleRow = el('div', { className: 'btn-row', style: 'align-items:center;flex-wrap:wrap;gap:0.35rem' });
      titleRow.appendChild(el('strong', {}, titleParts.join(' ')));
      const qEditLabel = `Chỉnh sửa câu ${q.displayNumber}`;
      const qEditBtn = el('button', {
        type: 'button',
        className: 'btn btn-ghost btn-sm exam-draft-q-edit-btn',
        'aria-label': qEditLabel,
        title: qEditLabel,
      }, examDraftPencilIconSvg());
      qEditBtn.addEventListener('click', () => {
        draftQuestionEditId = q.id;
        draftPassageEditId = null;
        renderDraftBody();
      });
      titleRow.appendChild(qEditBtn);
      block.appendChild(titleRow);
      if (q.sourceQuestionId) {
        block.appendChild(el('p', {
          className: 'exam-draft-q-provenance',
          style: 'font-size:0.8rem;color:var(--muted)',
        }, `Sao chép từ câu nguồn ${q.originalDisplayNumber || q.sourceQuestionId.slice(0, 8)}`));
      }
      const moveRow = el('div', { className: 'btn-row exam-draft-q-move' });
      const upBtn = el('button', {
        type: 'button',
        className: 'btn btn-ghost btn-sm',
        disabled: sortedIndex === 0,
        'aria-label': 'Di chuyển lên',
      }, '↑');
      upBtn.addEventListener('click', () => moveQuestionById(q.id, -1));
      const downBtn = el('button', {
        type: 'button',
        className: 'btn btn-ghost btn-sm',
        disabled: sortedIndex >= sortedList.length - 1,
        'aria-label': 'Di chuyển xuống',
      }, '↓');
      downBtn.addEventListener('click', () => moveQuestionById(q.id, 1));
      moveRow.appendChild(upBtn);
      moveRow.appendChild(downBtn);
      const bind = q.sourceVersionId
        ? (draftState.composedSourceExamBindings || {})[q.sourceVersionId]
        : null;
      if ((bind?.sourceAttachmentId || draftState.sourceAttachmentId)) {
        const srcBtn = el('button', {
          type: 'button',
          className: 'btn btn-ghost btn-sm',
        }, 'Xem nguồn');
        srcBtn.addEventListener('click', () => {
          const run = async () => {
            const page = q.sourcePage || q.originalSourcePage;
            if (!page) {
              ctx.toastErr('Không có trang PDF nguồn cho câu này.');
              return;
            }
            if (!q.sourceVersionId) {
              ctx.toastErr('Thiếu liên kết nguồn cho câu này.');
              return;
            }
            const pdfToolbarSel = host.querySelector('.exam-draft-pdf-toolbar select');
            if (pdfToolbarSel && pdfToolbarSel.value !== q.sourceVersionId) {
              pdfToolbarSel.value = q.sourceVersionId;
              pdfToolbarSel.dispatchEvent(new Event('change', { bubbles: true }));
              await new Promise((r) => queueMicrotask(r));
            } else if (!pdfToolbarSel && pdfSourceVersionId !== q.sourceVersionId) {
              pdfSourceVersionId = q.sourceVersionId;
              renderDraftBody();
              await new Promise((r) => queueMicrotask(r));
            }
            const col = host.querySelector('.exam-draft-preview-col');
            let wrap = col?.querySelector('.exam-pdf-preview');
            if (wrap?.__whenReady) {
              await wrap.__whenReady.catch(() => {});
            } else {
              await (host.__examPdfMountPromise || Promise.resolve()).catch(() => {});
              wrap = col?.querySelector('.exam-pdf-preview');
              if (wrap?.__whenReady) await wrap.__whenReady.catch(() => {});
            }
            if (typeof wrap?.__jumpToSourcePage === 'function') {
              wrap.__jumpToSourcePage(page);
              col?.scrollIntoView?.({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' });
            } else {
              ctx.toastErr('PDF nguồn chưa tải xong.');
            }
          };
          run().catch((e) => ctx.toastErr(e.message || 'Không mở được PDF nguồn.'));
        });
        moveRow.appendChild(srcBtn);
      }
      block.appendChild(moveRow);

      const groupSel = el('select', {
        className: 'input',
        'data-exam-draft-q-passage-group': '',
      });
      groupSel.appendChild(el('option', { value: '' }, '— Không thuộc nhóm —'));
      for (const pg of draftState.passages || []) {
        const g = normalizeReadingGroup(pg);
        const r = parseExpectedQuestionRange(g);
        const label = r ? `Nhóm câu ${r.min}–${r.max}` : (g.title || g.id);
        groupSel.appendChild(el('option', { value: g.id }, label));
      }
      groupSel.value = q.passageId || q.groupId || '';
      groupSel.addEventListener('change', () => {
        const gid = groupSel.value || null;
        q.passageId = gid;
        q.groupId = gid;
        markEditorDirty();
      });

      const pointsId = `exam-q-points-${q.id}`;
      const pointsInput = el('input', {
        type: 'number',
        className: 'input',
        id: pointsId,
        min: '0.01',
        step: 'any',
        inputMode: 'decimal',
      });
      if (q.points != null && q.points !== '' && Number(q.points) > 0) {
        pointsInput.value = String(q.points);
      } else {
        pointsInput.placeholder = '1';
      }
      pointsInput.addEventListener('input', (e) => {
        const v = String(e.target.value ?? '').trim();
        if (!v) {
          delete q.points;
          markEditorDirty();
          return;
        }
        const n = Number(v);
        if (Number.isFinite(n) && n > 0) q.points = n;
        else q.points = v;
        markEditorDirty();
      });

      const stem = el('textarea', { className: 'input', rows: '2', 'data-exam-draft-q-stem-editor': '' });
      initTextarea(stem, q.stemText || '', (v) => {
        q.stemText = v;
        markEditorDirty();
        refreshReviewFilterLabels();
      });
      const qType = normalizeExamQuestionType(q);
      const skillSel = el('select', {
        className: 'input',
        'data-exam-draft-q-skill': '',
      });
      for (const row of [
        { id: EXAM_SKILL.LISTENING, label: 'Nghe' },
        { id: EXAM_SKILL.READING, label: 'Đọc' },
        { id: EXAM_SKILL.WRITING, label: 'Viết' },
        { id: EXAM_SKILL.SPEAKING, label: 'Nói' },
        { id: EXAM_SKILL.UNCLASSIFIED, label: 'Chưa phân loại' },
      ]) skillSel.appendChild(el('option', { value: row.id }, row.label));
      skillSel.value = normalizeExamSkill(q.skill) || inferExamSkillFromQuestion(q);
      skillSel.addEventListener('change', () => {
        q.skill = skillSel.value;
        markEditorDirty();
      });
      const typeSel = el('select', {
        className: 'input',
        'data-exam-draft-q-question-type': '',
      });
      for (const val of Object.values(EXAM_QUESTION_TYPE)) {
        typeSel.appendChild(el('option', { value: val }, val));
      }
      typeSel.value = qType;
      typeSel.addEventListener('change', () => {
        q.questionType = typeSel.value;
        markEditorDirty();
        renderDraftBody();
      });

      const optHost = el('div', { className: 'exam-draft-q-options-edit' });
      if (questionUsesOptionsForPublish(q) || isChoiceBasedQuestion(q)) {
        for (const o of q.options || []) {
          optHost.appendChild(el('label', { style: 'display:block' }, [
            el('input', {
              type: 'radio',
              name: `key-${q.id}`,
              checked: q.correctOptionId === o.id,
              onChange: () => { q.correctOptionId = o.id; markEditorDirty(); },
            }),
            ` ${o.label != null ? `${o.label}. ` : ''}`,
            el('input', {
              type: 'text',
              className: 'input',
              value: o.text || '',
              onInput: (e) => {
                o.text = e.target.value;
                markEditorDirty();
                refreshReviewFilterLabels();
              },
            }),
          ]));
        }
      } else {
        optHost.appendChild(el('p', { className: 'form-hint' }, 'Loại câu này không dùng danh sách lựa chọn giả.'));
      }

      const metaHost = el('div', { className: 'exam-draft-q-type-meta' });
      if (qType === EXAM_QUESTION_TYPE.SHORT_ANSWER) {
        const maxW = el('input', { type: 'number', className: 'input', min: '1', value: q.maxWords != null ? String(q.maxWords) : '' });
        maxW.addEventListener('input', () => {
          q.maxWords = maxW.value ? Number(maxW.value) : undefined;
          markEditorDirty();
        });
        const accepted = el('textarea', { className: 'input', rows: '2' });
        accepted.value = (q.acceptedAnswers || []).join('\n');
        accepted.addEventListener('input', () => {
          q.acceptedAnswers = accepted.value.split('\n').map((x) => x.trim()).filter(Boolean);
          markEditorDirty();
        });
        metaHost.appendChild(el('label', {}, ['maxWords ', maxW]));
        metaHost.appendChild(el('label', {}, ['Đáp án chấp nhận (mỗi dòng) ', accepted]));
      }
      if (qType === EXAM_QUESTION_TYPE.ESSAY) {
        const minW = el('input', { type: 'number', className: 'input', value: q.minWords != null ? String(q.minWords) : '' });
        const maxW = el('input', { type: 'number', className: 'input', value: q.maxWords != null ? String(q.maxWords) : '' });
        minW.addEventListener('input', () => { q.minWords = minW.value ? Number(minW.value) : undefined; markEditorDirty(); });
        maxW.addEventListener('input', () => { q.maxWords = maxW.value ? Number(maxW.value) : undefined; markEditorDirty(); });
        metaHost.appendChild(el('label', {}, ['minWords ', minW, ' maxWords ', maxW]));
        q.unnumberedActivity = true;
      }
      if (qType === EXAM_QUESTION_TYPE.ORAL_ASSESSMENT) {
        q.unnumberedActivity = true;
        metaHost.appendChild(el('p', { className: 'form-hint' }, 'Hoạt động phỏng vấn — học sinh không nhập câu trả lời.'));
      }

      const editPanel = el('div', { className: 'exam-draft-q-edit-panel' });
      editPanel.appendChild(el('label', {}, 'Kỹ năng ', skillSel));
      editPanel.appendChild(el('label', {}, 'Loại câu ', typeSel));
      editPanel.appendChild(el('label', {}, 'Thuộc nhóm ', groupSel));
      editPanel.appendChild(el('label', { htmlFor: pointsId }, [
        `Điểm câu ${q.displayNumber} `,
        pointsInput,
      ]));
      editPanel.appendChild(stem);
      editPanel.appendChild(metaHost);
      editPanel.appendChild(optHost);
      const qDone = el('button', { type: 'button', className: 'btn btn-secondary' }, 'Xong');
      qDone.addEventListener('click', () => {
        draftQuestionEditId = null;
        renderDraftBody();
      });
      editPanel.appendChild(qDone);
      const rm = el('button', {
        type: 'button',
        className: 'btn btn-ghost',
        onClick: () => removeQuestionById(q.id),
      }, 'Gỡ khỏi đề');
      editPanel.appendChild(rm);

      const readBody = el('div', { className: 'exam-draft-q-read' });
      readBody.appendChild(el('p', {
        className: 'exam-draft-q-stem',
        style: 'white-space:pre-wrap;margin:0.35rem 0;line-height:1.45',
      }, [
        el('strong', {}, `Câu ${q.displayNumber}: `),
        document.createTextNode(q.stemText || ''),
      ]));
      if ((q.options || []).length && (isChoiceBasedQuestion(q) || questionUsesOptionsForPublish(q))) {
        const optList = el('ol', {
          className: 'exam-draft-q-options-read',
          style: 'margin:0.35rem 0 0;padding-left:1.35rem;line-height:1.45;list-style-type:upper-alpha',
        });
        for (const o of q.options || []) {
          optList.appendChild(el('li', { style: 'white-space:pre-wrap;margin:0.2rem 0' }, o.text || ''));
        }
        readBody.appendChild(optList);
      }

      const metaParts = [];
      metaParts.push(`Kỹ năng: ${normalizeExamSkill(q.skill) || inferExamSkillFromQuestion(q)}`);
      metaParts.push(`Loại: ${normalizeExamQuestionType(q)}`);
      metaParts.push(`Điểm: ${q.points != null && q.points !== '' && Number(q.points) > 0 ? q.points : '1'}`);
      const gLabel = (() => {
        const gid = q.passageId || q.groupId;
        if (!gid) return 'Không thuộc nhóm đọc';
        const gr = passageById.get(gid);
        if (!gr) return `Nhóm ${gid.slice(0, 8)}`;
        const g = normalizeReadingGroup(gr);
        const r = parseExpectedQuestionRange(g);
        return r ? `Nhóm câu ${r.min}–${r.max}` : (g.title || 'Nhóm đọc');
      })();
      metaParts.push(gLabel);
      const gm = normalizeExamGradingMode(draftState);
      if (gm === EXAM_GRADING_MODE.TEACHER_MANUAL_LATER) {
        metaParts.push('Chấm sau — chưa cần đáp án trong nháp');
      } else if (q.correctOptionId) {
        const win = (q.options || []).find((o) => o.id === q.correctOptionId);
        metaParts.push(`Đáp án: ${win ? `${win.label}. ${win.text || ''}` : q.correctOptionId}`);
      } else {
        metaParts.push('Chưa chọn đáp án đúng');
      }
      block.appendChild(el('p', {
        className: 'exam-draft-q-meta',
        style: 'font-size:0.8rem;color:var(--muted);margin:0.35rem 0 0;line-height:1.35',
      }, metaParts.join(' · ')));

      if (qEditing) {
        block.appendChild(editPanel);
      } else {
        block.appendChild(readBody);
      }

      return block;
    }

    const sortedQuestions = sortExamQuestionsByOrder(draftState.questions || []);
    for (let i = 0; i < sortedQuestions.length; i++) {
      const q = sortedQuestions[i];
      if (!shouldRenderQuestion(draftState, q, reviewFilterMode, reviewFilterPinned)) continue;
      const gid = q.passageId || q.groupId;
      if (gid) {
        const raw = passageById.get(gid);
        if (raw && shouldRenderReadingGroup(draftState, raw, reviewFilterMode, reviewFilterPinned)) {
          if (!renderedPassageIds.has(gid)) {
            renderedPassageIds.add(gid);
            const p = normalizeReadingGroup(raw);
            editorCol.appendChild(buildPassageCard(raw, p));
          }
        }
      }
      editorCol.appendChild(renderQuestionBlock(q, i, sortedQuestions));
    }

    for (const raw of draftState.passages || []) {
      if (!shouldRenderReadingGroup(draftState, raw, reviewFilterMode, reviewFilterPinned)) continue;
      const p = normalizeReadingGroup(raw);
      if (renderedPassageIds.has(p.id)) continue;
      editorCol.appendChild(buildPassageCard(raw, p));
    }

    const addBtn = el('button', { type: 'button', className: 'btn btn-secondary' }, 'Thêm câu');
    addBtn.addEventListener('click', () => addQuestion());
    editorCol.appendChild(addBtn);

    const mergePanel = el('div', {
      className: 'card exam-draft-merge',
      style: 'margin:0.75rem 0;padding:0.75rem',
      'data-exam-draft-merge-panel': '',
    });
    mergePanel.appendChild(el('strong', {}, 'Thêm câu từ đề đã xuất bản'));
    mergePanel.appendChild(el('p', { style: 'font-size:0.85rem;color:var(--muted)' },
      'Hệ thống sẽ lưu nháp hiện tại trước khi thêm — không ghi đè tay các câu đã sửa. Câu trùng nguồn sẽ được bỏ qua.'));
    const mergeRow = el('div', { className: 'btn-row', style: 'flex-wrap:wrap;align-items:flex-end' });
    const mergeVersionSel = el('select', { className: 'input', 'aria-label': 'Chọn đề nguồn để thêm câu' });
    mergeVersionSel.appendChild(el('option', { value: '' }, '— Chọn đề trong kho —'));
    for (const v of teacherPublishedVersions) {
      mergeVersionSel.appendChild(el('option', { value: v.id },
        `${v.title || 'Đề'} (${v.questionCount ?? 0} câu)`));
    }
    if (mergeSelectedVersionId) mergeVersionSel.value = mergeSelectedVersionId;
    const mergeBtn = el('button', {
      type: 'button',
      className: 'btn btn-secondary exam-draft-merge-submit',
    }, 'Thêm câu đã chọn');
    mergeRow.appendChild(el('label', { style: 'display:flex;flex-direction:column;gap:0.25rem;min-width:12rem' }, [
      'Đề nguồn',
      mergeVersionSel,
    ]));
    mergeRow.appendChild(mergeBtn);
    mergePanel.appendChild(mergeRow);
    const mergePickerHost = el('div', { className: 'exam-draft-merge-picker', style: 'margin-top:0.5rem' });
    const mergeStatusEl = el('p', { className: 'form-hint', 'aria-live': 'polite' }, '');
    mergePanel.appendChild(mergePickerHost);
    mergePanel.appendChild(mergeStatusEl);
    editorCol.appendChild(mergePanel);

    const existingSourceKeys = new Set();
    for (const q of draftState.questions || []) {
      if (q.sourceVersionId && q.sourceQuestionId) {
        existingSourceKeys.add(`${q.sourceVersionId}|${q.sourceQuestionId}`);
      }
    }

    async function loadMergePickerForVersion(vid) {
      mergePickerHost.replaceChildren();
      mergeSelectedIds.clear();
      mergeComposeSource = null;
      if (!vid) {
        mergeStatusEl.textContent = '';
        return;
      }
      mergeStatusEl.textContent = 'Đang tải câu hỏi…';
      try {
        const data = await fetchExamComposeSource(vid);
        mergeComposeSource = data.source;
        mergeStatusEl.textContent = mergeComposeSource.hasSourcePdf
          ? 'Có PDF — dùng «Xem nguồn» theo từng câu (PDF đúng đề).'
          : `${mergeComposeSource.questionCount} câu có thể chọn.`;
      } catch (e) {
        mergeStatusEl.textContent = e.message || 'Không tải được nguồn.';
        ctx.toastErr(e.message);
        return;
      }
      const filterInput = el('input', {
        type: 'text',
        className: 'input',
        placeholder: 'Lọc theo số câu',
      });
      const selectAll = el('button', { type: 'button', className: 'btn btn-ghost btn-sm' }, 'Chọn hết (trừ trùng)');
      const selectNone = el('button', { type: 'button', className: 'btn btn-ghost btn-sm' }, 'Bỏ chọn');
      mergePickerHost.appendChild(el('div', { className: 'btn-row' }, [selectAll, selectNone, filterInput]));
      const listHost = el('div', { className: 'exam-compose-question-list' });
      mergePickerHost.appendChild(listHost);

      function renderMergeList() {
        listHost.replaceChildren();
        if (!mergeComposeSource) return;
        const filter = String(filterInput.value || '').trim();
        const groups = new Map((mergeComposeSource.groups || []).map((g) => [g.id, g]));
        const byGroup = new Map();
        const solo = [];
        for (const q of mergeComposeSource.questions || []) {
          if (filter && !String(q.displayNumber || '').includes(filter)) continue;
          if (q.passageId && groups.has(q.passageId)) {
            if (!byGroup.has(q.passageId)) byGroup.set(q.passageId, []);
            byGroup.get(q.passageId).push(q);
          } else solo.push(q);
        }
        const renderRow = (q) => {
          const dupKey = `${vid}|${q.id}`;
          const isDup = existingSourceKeys.has(dupKey);
          const cb = el('input', {
            type: 'checkbox',
            checked: mergeSelectedIds.has(q.id),
            disabled: isDup,
            'data-merge-qid': q.id,
          });
          if (!isDup) {
            cb.addEventListener('change', () => {
              if (cb.checked) mergeSelectedIds.add(q.id);
              else mergeSelectedIds.delete(q.id);
            });
          }
          const label = el('label', {
            className: 'exam-compose-q-row',
            style: `display:block;margin:0.35rem 0;${isDup ? 'opacity:0.55' : ''}`,
          }, [
            cb,
            ` Câu ${q.displayNumber}: ${(q.stemSnippet || '').slice(0, 80)}`,
            isDup ? ' (đã có trong nháp)' : '',
          ]);
          return label;
        };
        for (const [gid, qs] of byGroup) {
          const g = groups.get(gid);
          const gWrap = el('div', { className: 'card', style: 'margin:0.35rem 0;padding:0.5rem' });
          gWrap.appendChild(el('strong', {}, g?.label || 'Nhóm'));
          const gSelect = el('button', {
            type: 'button',
            className: 'btn btn-ghost btn-sm',
            disabled: qs.every((q) => existingSourceKeys.has(`${vid}|${q.id}`)),
          }, 'Chọn nhóm');
          gSelect.addEventListener('click', () => {
            for (const q of qs) {
              if (!existingSourceKeys.has(`${vid}|${q.id}`)) mergeSelectedIds.add(q.id);
            }
            renderMergeList();
          });
          gWrap.appendChild(gSelect);
          for (const q of qs) gWrap.appendChild(renderRow(q));
          listHost.appendChild(gWrap);
        }
        for (const q of solo) listHost.appendChild(renderRow(q));
      }
      selectAll.addEventListener('click', () => {
        for (const q of mergeComposeSource.questions || []) {
          if (!existingSourceKeys.has(`${vid}|${q.id}`)) mergeSelectedIds.add(q.id);
        }
        renderMergeList();
      });
      selectNone.addEventListener('click', () => {
        mergeSelectedIds.clear();
        renderMergeList();
      });
      filterInput.addEventListener('input', renderMergeList);
      renderMergeList();
    }

    mergeVersionSel.addEventListener('change', () => {
      mergeSelectedVersionId = mergeVersionSel.value || null;
      loadMergePickerForVersion(mergeSelectedVersionId).catch((e) => ctx.toastErr(e.message));
    });
    if (mergeSelectedVersionId) {
      queueMicrotask(() => {
        loadMergePickerForVersion(mergeSelectedVersionId).catch((e) => ctx.toastErr(e.message));
      });
    }

    mergeBtn.addEventListener('click', () => withBusyButton(mergeBtn, 'Đang thêm…', async () => {
      composeAppendLocked = true;
      refreshDraftEditorLockState();
      try {
        const vid = mergeSelectedVersionId || mergeVersionSel.value;
        const ids = [...mergeSelectedIds];
        if (!vid) {
          ctx.toastErr('Chọn đề nguồn.');
          return;
        }
        if (!ids.length) {
          ctx.toastErr('Chọn ít nhất một câu chưa trùng.');
          return;
        }
        try {
          await saveCoordinator.runSerializedWrite(async () => {
            if (editorDirty) {
              const savedAt = saveCoordinator.currentDirtyGeneration();
              const payload = collectDraftPutPayload();
              await executeDraftPut(savedAt, payload);
              if (editorDirty) {
                throw new Error('Còn thay đổi chưa lưu — thử «Lưu đề» rồi thêm lại.');
              }
            }
            const res = await appendComposedQuestionsToDraft(draftId, {
              sourceVersionId: vid,
              questionIds: ids,
            });
            draftState = res.draft;
            lastSavedRevision = res.draft?.revision ?? res.revision;
            editorDirty = false;
            saveCoordinator.resetDirtyGeneration();
            bumpDirtyNavigationGuard();
            const ac = res.addedCount ?? 0;
            const sk = res.skippedDuplicateSourceQuestions ?? 0;
            ctx.toastOk(`Đã thêm ${ac} câu${sk ? ` — bỏ qua ${sk} câu trùng nguồn` : ''}.`);
            renderDraftBody();
          });
        } catch (e) {
          ctx.toastErr(e.message || 'Không thêm được câu.');
        }
      } finally {
        composeAppendLocked = false;
        refreshDraftEditorLockState();
      }
    }));

    const publishErrorsHost = el('div', { className: 'exam-draft-publish-errors', 'aria-live': 'polite' });
    editorCol.appendChild(publishErrorsHost);

    const reviewCheck = el('input', { type: 'checkbox', id: 'exam-review-ok' });
    reviewCheck.checked = !!draftState.teacherConfirmedReview;
    reviewCheck.addEventListener('change', () => {
      draftState.teacherConfirmedReview = reviewCheck.checked;
      markEditorDirty();
    });
    const pendingCtx = draftPassagesPendingContextConfirmation(draftState);
    const reviewWrap = el('div', {
      className: 'card exam-draft-global-review',
      style: 'margin:0.75rem 0;padding:0.75rem',
      id: 'exam-draft-global-review',
    });
    reviewWrap.appendChild(el('strong', {}, 'Xác nhận kiểm tra bản nháp'));
    reviewWrap.appendChild(el('p', { style: 'font-size:0.85rem;margin:0.35rem 0' },
      'Khác với xác nhận từng nhóm câu hỏi bên trên — không thay thế bước đó.'));
    if (draftState.needsReview) {
      reviewWrap.appendChild(el('p', { style: 'font-size:0.85rem' },
        'Bản nháp còn cảnh báo trích xuất — chỉ xác nhận khi bạn đã kiểm tra các mục liên quan.'));
    }
    if (pendingCtx.length) {
      reviewWrap.appendChild(el('p', { className: 'demo-banner' },
        `Còn ${pendingCtx.length} nhóm cần xác nhận nội dung riêng.`));
      const eligible = pendingCtx.filter((raw) => !readingGroupMissingRequiredContext(raw));
      if (eligible.length) {
        const bulkBtn = el('button', { type: 'button', className: 'btn btn-secondary' },
          `Xác nhận nội dung cho ${eligible.length} nhóm đủ nội dung`);
        bulkBtn.addEventListener('click', () => {
          let n = 0;
          for (const raw of eligible) {
            if (!raw.contextConfirmed) {
              raw.contextConfirmed = true;
              n += 1;
            }
          }
          const still = draftPassagesPendingContextConfirmation(draftState).length;
          const missingBody = (draftState.passages || []).filter((raw) => {
            const g = normalizeReadingGroup(raw);
            return g.requiresContext && readingGroupMissingRequiredContext(g);
          }).length;
          let msg = `Đã xác nhận ${n} nhóm.`;
          if (still) msg += ` Còn ${still} nhóm chưa xác nhận.`;
          if (missingBody) msg += ` ${missingBody} nhóm thiếu nội dung — bổ sung trước.`;
          ctx.toastOk(msg);
          refreshReviewFilterLabels();
          renderDraftBody();
        });
        reviewWrap.appendChild(bulkBtn);
      }
    }
    reviewWrap.appendChild(el('label', { htmlFor: 'exam-review-ok' }, [
      reviewCheck,
      ' Tôi đã kiểm tra toàn bộ câu hỏi và cảnh báo trích xuất',
    ]));
    editorCol.appendChild(reviewWrap);

    const saveStatus = el('p', {
      className: 'exam-draft-save-status',
      'aria-live': 'polite',
      style: 'font-size:0.85rem;color:var(--muted)',
    }, editorDirty ? 'Chưa lưu' : 'Đã lưu');
    saveStatusEl = saveStatus;
    editorCol.appendChild(saveStatus);

    const undoBtn = el('button', {
      type: 'button',
      className: 'btn btn-ghost',
      disabled: !removalUndoStack.length,
    }, 'Hoàn tác gỡ câu');
    undoBtn.addEventListener('click', () => {
      const snap = removalUndoStack.pop();
      if (!snap) return;
      draftState.questions = snap.questions;
      draftState.passages = snap.passages;
      markEditorDirty();
      renderDraftBody();
    });

    const saveBtn = el('button', {
      type: 'button',
      className: 'btn btn-secondary',
      disabled: draftWriteBusy,
    }, 'Lưu đề');
    const previewBtn = el('button', {
      type: 'button',
      className: 'btn btn-secondary',
      'data-exam-action': 'preview-as-student',
      disabled: draftWriteBusy,
    }, 'Xem trước');
    const giaoBtn = el('button', {
      type: 'button',
      className: 'btn btn-primary',
      disabled: draftWriteBusy,
    }, 'Giao bài…');
    const pubBtn = el('button', {
      type: 'button',
      className: 'btn btn-secondary',
      hidden: true,
      'aria-hidden': 'true',
    }, 'Xuất bản');
    editorCol.appendChild(el('div', { className: 'btn-row' }, [undoBtn, saveBtn, previewBtn, giaoBtn, pubBtn]));

    previewBtn.addEventListener('click', () => {
      draftState.title = titleInput.value;
      syncMode();
      openTeacherStudentPreviewFromContent(ctx, {
        id: draftState.id,
        title: draftState.title,
        sections: draftState.sections,
        passages: draftState.passages,
        questions: draftState.questions,
      });
      previewDispose = activeTeacherStudentPreviewDispose;
    });

    saveBtn.addEventListener('click', () => withBusyButton(saveBtn, 'Đang lưu…', async () => {
      try {
        await queueDraftPut();
        if (!disposed) ctx.toastOk('Đã lưu đề.');
      } catch (e) {
        if (String(e.message || '').includes('409') || String(e.message || '').includes('thay đổi')) {
          ctx.toastErr('Bản nháp đã thay đổi ở nơi khác — tải lại trang.');
        } else {
          ctx.toastErr(e.message || 'Lỗi lưu.');
        }
      }
    }));

    giaoBtn.addEventListener('click', () => withBusyButton(giaoBtn, 'Đang xử lý…', async () => {
      try {
        await queueDraftPut();
        if (editorDirty) {
          ctx.toastErr('Còn thay đổi chưa lưu — thử lưu lại trước khi giao.');
          return;
        }
        const check = validateDraftForPublish(draftState);
        if (!check.ok) {
          publishErrorsHost.replaceChildren();
          const activate = (t) => activateDraftTarget(t);
          for (const err of check.errors) {
            const nav = resolvePublishValidationError(err, draftState);
            appendDraftReviewBanner(publishErrorsHost, nav, host, activate);
          }
          ctx.toastErr(publishErrorMessage(check.errors[0]));
          publishErrorsHost.scrollIntoView({
            behavior: prefersReducedMotion() ? 'auto' : 'smooth',
            block: 'nearest',
          });
          return;
        }
        publishErrorsHost.replaceChildren();
        const pub = await saveCoordinator.runSerializedWrite(() => publishExamDraft(draftId));
        ctx.toastOk('Đã xuất bản — chọn lớp và hạn nộp.');
        ctx.navigate(`#/exams/assign/${pub.versionId}`);
      } catch (e) {
        ctx.toastErr(e.message || 'Không giao được — kiểm tra đề trước.');
      }
    }));

    pubBtn.addEventListener('click', () => withBusyButton(pubBtn, 'Đang xuất bản…', async () => {
      try {
        draftState.title = titleInput.value;
        draftState.teacherConfirmedReview = reviewCheck.checked;
        syncMode();
        const check = validateDraftForPublish(draftState);
        if (!check.ok) {
          publishErrorsHost.replaceChildren();
          const activate = (t) => activateDraftTarget(t);
          for (const err of check.errors) {
            const nav = resolvePublishValidationError(err, draftState);
            appendDraftReviewBanner(publishErrorsHost, nav, host, activate);
          }
          ctx.toastErr(publishErrorMessage(check.errors[0]));
          publishErrorsHost.scrollIntoView({
            behavior: prefersReducedMotion() ? 'auto' : 'smooth',
            block: 'nearest',
          });
          return;
        }
        publishErrorsHost.replaceChildren();
        let pub;
        await saveCoordinator.runSerializedWrite(async () => {
          const savedAtGeneration = saveCoordinator.currentDirtyGeneration();
          const payload = collectDraftPutPayload();
          payload.teacherConfirmedReview = true;
          await executeDraftPut(savedAtGeneration, payload);
          if (editorDirty) {
            throw new Error('Còn thay đổi chưa lưu — thử lưu lại trước khi xuất bản.');
          }
          pub = await publishExamDraft(draftId);
        });
        ctx.toastOk(`Đã xuất bản — chọn lớp để giao.`);
        ctx.navigate(`#/exams/assign/${pub.versionId}`);
      } catch (e) {
        ctx.toastErr(e.message || 'Không xuất bản được.');
      }
    }));

    const prov = draftState.composedSourceExamBindings || {};
    const pdfIds = Object.keys(prov).filter((id) => prov[id]?.sourceAttachmentId);
    if (draftState.sourceAttachmentId || pdfIds.length) {
      const previewHead = el('div', { className: 'exam-draft-pdf-toolbar', style: 'margin-bottom:0.5rem' });
      if (pdfIds.length > 1) {
        const sel = el('select', { className: 'input', 'aria-label': 'PDF đề nguồn' });
        for (const vid of pdfIds) {
          sel.appendChild(el('option', { value: vid },
            `${prov[vid]?.sourceTitle || vid.slice(0, 8)}`));
        }
        if (pdfSourceVersionId && pdfIds.includes(pdfSourceVersionId)) sel.value = pdfSourceVersionId;
        else sel.value = pdfIds[0];
        pdfSourceVersionId = sel.value;
        sel.addEventListener('change', () => {
          pdfSourceVersionId = sel.value;
          renderDraftBody();
        });
        previewHead.appendChild(el('label', { style: 'display:block;margin-bottom:0.25rem' }, [
          'PDF đề nguồn ',
          sel,
        ]));
      } else if (pdfIds.length === 1) {
        pdfSourceVersionId = pdfIds[0];
      }
      if (previewHead.childNodes.length) previewCol.appendChild(previewHead);
      const bindVid = pdfIds.length ? pdfSourceVersionId : null;
      host.__examPdfMountPromise = mountPdfPreview(previewCol, draftId, draftState, ctx, {
        sourceVersionId: bindVid || undefined,
        filterSourceVersionId: bindVid || undefined,
      }).then((wrap) => {
        pdfPreviewWrap = wrap || previewCol.querySelector('.exam-pdf-preview');
        previewDispose = (wrap || previewCol.querySelector('.exam-pdf-preview'))?.__dispose || null;
        return wrap;
      });
    }

    const reviewBannerHost = el('div', { className: 'exam-draft-review-banners' });
    const activateReviewTarget = (t) => activateDraftTarget(t);
    for (const w of draftState.warnings || []) {
      if (!draftImportWarningStillActive(w, draftState)) continue;
      const nav = resolveDraftReviewNavigation(w, draftState);
      appendDraftReviewBanner(reviewBannerHost, nav, host, activateReviewTarget);
    }
    if (reviewBannerHost.childNodes.length) {
      host.insertBefore(reviewBannerHost, layout);
    }

    if (focusAfterRender) {
      const t = focusAfterRender;
      focusAfterRender = null;
      queueMicrotask(() => focusExamDraftTarget(host, t));
    }

    refreshDraftEditorLockState();
  }

  reload().catch((e) => ctx.toastErr(e.message));
}

export function renderExamGradeView(ctx, root, assignmentId) {
  root.appendChild(el('h1', { className: 'page-title' }, 'Chấm bài / xác nhận đáp án'));
  root.appendChild(el('button', {
    type: 'button',
    className: 'btn btn-ghost',
    onClick: () => ctx.navigate('#/exams'),
  }, '← Danh sách'));

  const host = el('div', { className: 'exam-grade-panel' });
  root.appendChild(host);

  let panelData = null;
  let focusAttemptId = null;
  let answerKeyRevision = 1;
  let textAnswerKeyRevision = 1;
  let draftKeys = {};
  let draftTextKeys = {};
  let draftManual = {};
  let gradingRevision = 0;
  let dirty = false;
  let manualDirty = false;
  let pdfMarkEditor = null;
  const saveStateEl = el('p', { className: 'save-status', 'aria-live': 'polite' }, '');

  async function load(attemptId) {
    const data = await fetchExamAssignmentGrading(assignmentId, attemptId || focusAttemptId);
    panelData = data;
    focusAttemptId = data.focusAttempt?.id || data.attempts?.[0]?.attemptId || null;
    answerKeyRevision = data.version?.answerKeyRevision || 1;
    textAnswerKeyRevision = data.version?.textAnswerKeyRevision || 1;
    draftKeys = { ...(data.version?.confirmedAnswerKey || {}) };
    draftTextKeys = { ...(data.version?.confirmedTextAnswerKey || {}) };
    for (const q of data.version?.questions || []) {
      const eff = resolveVersionAnswerKey(
        { questions: data.version.questions, confirmedAnswerKey: draftKeys },
        q.id,
      );
      if (eff) draftKeys[q.id] = eff;
    }
    gradingRevision = data.focusAttempt?.gradingRevision || 0;
    draftManual = {};
    for (const [qid, row] of Object.entries(data.focusAttempt?.manualGrades || {})) {
      draftManual[qid] = { ...(row || {}) };
    }
    dirty = false;
    manualDirty = false;
    renderPanel();
  }

  function effectiveKey(questionId) {
    if (draftKeys[questionId]) return draftKeys[questionId];
    const q = panelData?.version?.questions?.find((x) => x.id === questionId);
    return q?.correctOptionId || null;
  }

  function renderPanel() {
    pdfMarkEditor?.dispose();
    pdfMarkEditor = null;
    host.replaceChildren();
    if (!panelData?.version) {
      host.appendChild(el('p', {}, 'Đang tải…'));
      return;
    }
    const version = panelData.version;
    host.appendChild(el('p', {}, panelData.assignment?.title || ''));
    const itemSummary = summarizeExamItems(version);
    host.appendChild(el('p', { className: 'form-hint' },
      `${itemSummary.numberedQuestions} câu có số · ${itemSummary.unnumberedActivities} hoạt động · ${itemSummary.totalPoints} điểm`));
    const contamBanner = buildContaminationImportWarning(version);
    if (contamBanner) {
      host.appendChild(el('p', {
        className: 'demo-banner',
        style: 'white-space:pre-wrap',
      }, `${contamBanner} Dùng tải lại đề thi PDF hoặc phiên bản mới trước khi tin vào đáp án trích tự động.`));
    }
    host.appendChild(saveStateEl);

    if (panelData.attempts?.length) {
      const sel = el('select', { className: 'input' });
      for (const a of panelData.attempts) {
        const label = `${a.studentId}${a.gradingLabel ? ` (${a.gradingLabel})` : ''}`;
        sel.appendChild(el('option', { value: a.attemptId }, label));
      }
      sel.value = focusAttemptId || sel.value;
      sel.addEventListener('change', () => {
        if (dirty && !globalThis.confirm('Còn thay đổi chưa lưu — chuyển bài?')) {
          sel.value = focusAttemptId;
          return;
        }
        load(sel.value).catch((e) => ctx.toastErr(e.message));
      });
      host.appendChild(el('label', {}, 'Bài nộp của học sinh ', sel));
    } else {
      host.appendChild(el('p', { className: 'demo-banner' }, 'Chưa có bài nộp — vẫn có thể lưu đáp án cho phiên bản này.'));
    }

    const focus = panelData.focusAttempt;
    const detailRows = focus?.detail?.questions || [];
    const qHost = el('div', { className: 'exam-grade-questions' });
    const rowById = new Map(detailRows.map((r) => [r.questionId, r]));
    for (const q of version.questions || []) {
      const t = normalizeExamQuestionType(q);
      const row = rowById.get(q.id);
      const block = el('div', {
        className: `card exam-grade-q exam-grade-q-${t}`,
        style: 'margin:0.5rem 0;padding:0.75rem',
      });
      block.appendChild(el('p', {}, [
        el('strong', {}, `Câu ${q.displayNumber}: `),
        q.stemText || '',
        el('span', { className: 'form-hint', style: 'margin-left:0.35rem' }, `(${t})`),
      ]));
      if (focus) {
        const preview = row?.responsePreview;
        if (t === EXAM_QUESTION_TYPE.ESSAY && preview && typeof preview === 'object') {
          block.appendChild(el('p', { className: 'exam-grade-response' },
            `Bài viết${preview.topicId ? ` · chủ đề ${preview.topicId}` : ''}: ${preview.text || '—'}`));
        } else if (t === EXAM_QUESTION_TYPE.SHORT_ANSWER) {
          block.appendChild(el('p', { className: 'exam-grade-response' }, `Trả lời: ${preview || '—'}`));
        } else if (isChoiceBasedQuestion(q)) {
          const chosen = focus.answers?.[q.id];
          const chosenOpt = (q.options || []).find((o) => o.id === chosen);
          block.appendChild(el('p', { className: 'exam-grade-response' },
            `HS chọn: ${chosenOpt ? `${chosenOpt.label != null ? `${chosenOpt.label}. ` : ''}${chosenOpt.text || ''}` : (chosen || '—')}`));
        } else if (t === EXAM_QUESTION_TYPE.ORAL_ASSESSMENT) {
          block.appendChild(el('p', { className: 'form-hint' }, 'Hoạt động nói — chấm thủ công bên dưới.'));
        }
      }

      if (isChoiceBasedQuestion(q) && questionUsesOptionsForPublish(q)) {
        block.appendChild(el('p', { style: 'font-size:0.85rem;margin:0.25rem 0' }, 'Đáp án đúng (giáo viên xác nhận):'));
        const keyHost = el('div');
        const currentKey = effectiveKey(q.id);
        for (const o of q.options || []) {
          keyHost.appendChild(el('label', { style: 'display:block' }, [
            el('input', {
              type: 'radio',
              name: `teacher-key-${q.id}`,
              checked: currentKey === o.id,
              onChange: () => {
                draftKeys[q.id] = o.id;
                dirty = true;
                saveStateEl.textContent = 'Chưa lưu đáp án';
                saveStateEl.className = 'save-status pending';
              },
            }),
            ` ${o.label != null ? `${o.label}. ` : ''}${o.text || ''}`,
          ]));
        }
        block.appendChild(keyHost);
      }

      if (t === EXAM_QUESTION_TYPE.SHORT_ANSWER && isAutoGradableQuestion(q)) {
        block.appendChild(el('p', { style: 'font-size:0.85rem' }, 'Đáp án văn bản chấp nhận (mỗi dòng một đáp án):'));
        const ta = el('textarea', {
          className: 'input exam-text-key-editor',
          rows: '2',
        });
        const list = draftTextKeys[q.id]
          || (Array.isArray(q.acceptedAnswers) ? q.acceptedAnswers : []);
        ta.value = (list || []).join('\n');
        ta.addEventListener('input', () => {
          draftTextKeys[q.id] = ta.value.split('\n').map((x) => x.trim()).filter(Boolean);
          dirty = true;
        });
        block.appendChild(ta);
      }

      const needsManual = isManualOnlyQuestion(q) || !!row?.manualOnly
        || (t === EXAM_QUESTION_TYPE.SHORT_ANSWER && focus);
      if (focus && needsManual) {
        const maxPts = Number(q.points) > 0 ? Number(q.points) : 1;
        const mg = draftManual[q.id] || row?.manualGrade || {};
        block.appendChild(el('p', { style: 'font-size:0.85rem' }, `Chấm tay (0–${maxPts} điểm):`));
        const scoreInput = el('input', {
          type: 'number',
          className: 'input exam-manual-score',
          min: '0',
          max: String(maxPts),
          step: '0.01',
          value: mg.score != null ? String(mg.score) : '',
        });
        const fbInput = el('textarea', {
          className: 'input exam-manual-feedback',
          rows: '2',
          placeholder: 'Nhận xét (tùy chọn)',
        });
        fbInput.value = mg.feedback || '';
        const touchManual = () => {
          manualDirty = true;
          draftManual[q.id] = {
            score: scoreInput.value === '' ? null : Number(scoreInput.value),
            feedback: fbInput.value,
          };
        };
        scoreInput.addEventListener('input', touchManual);
        fbInput.addEventListener('input', touchManual);
        block.appendChild(el('label', {}, ['Điểm ', scoreInput]));
        block.appendChild(fbInput);
      }
      qHost.appendChild(block);
    }
    host.appendChild(qHost);

    const pdfGrading = focus?.pdfGrading;
    if (focus && pdfGrading?.selectedPdfPageIds?.length) {
      const pdfPane = el('h2', { className: 'page-title', style: 'margin-top:1rem;font-size:1.1rem' }, 'Chấm phần PDF');
      host.appendChild(pdfPane);
      const pdfHost = el('div', { className: 'exam-grade-pdf-pane' });
      host.appendChild(pdfHost);
      const pdfScore = el('input', {
        type: 'number',
        className: 'input',
        min: '0',
        step: '0.01',
        value: pdfGrading.pdfManualGrade?.score != null ? String(pdfGrading.pdfManualGrade.score) : '',
        'aria-label': 'Điểm phần PDF',
      });
      const pdfFb = el('textarea', {
        className: 'input',
        rows: '2',
        placeholder: 'Nhận xét PDF',
        'aria-label': 'Nhận xét phần PDF',
      });
      pdfFb.value = pdfGrading.pdfManualGrade?.feedback || '';
      const publishCb = el('input', { type: 'checkbox', id: 'exam-pdf-publish-feedback' });
      publishCb.checked = pdfGrading.pdfFeedbackPublished === true;
      host.appendChild(el('label', {}, ['Điểm PDF ', pdfScore]));
      host.appendChild(pdfFb);
      host.appendChild(el('label', {}, [publishCb, ' Công khai nhận xét PDF cho học sinh']));
      mountExamPdfEditor(pdfHost, {
        pageIds: pdfGrading.selectedPdfPageIds,
        sourcePdfUrl: teacherExamSourcePdfUrl(assignmentId),
        readOnly: false,
        role: 'teacher',
        studentPages: pdfGrading.studentFrozenPages || {},
        teacherPages: pdfGrading.teacherPages || {},
        showTeacherLayer: true,
        baseRevision: pdfGrading.teacherPdfAnnotationRevision || 0,
        savePage: async (body) => saveTeacherPdfAnnotations(focus.id, body),
      }).then((editor) => {
        pdfMarkEditor = editor;
      }).catch((e) => ctx.toastErr(e.message));
      const savePdfGradeBtn = el('button', { type: 'button', className: 'btn btn-secondary' }, 'Lưu điểm PDF');
      savePdfGradeBtn.addEventListener('click', () => withBusyButton(savePdfGradeBtn, 'Đang lưu…', async () => {
        try {
          if (pdfMarkEditor?.flushSaves) await pdfMarkEditor.flushSaves();
          await saveTeacherPdfManualGrade(focus.id, {
            score: pdfScore.value === '' ? null : Number(pdfScore.value),
            feedback: pdfFb.value,
            baseRevision: pdfGrading.pdfGradeRevision || 0,
            publishFeedback: publishCb.checked,
          });
          ctx.toastOk('Đã lưu điểm PDF.');
          await load(focusAttemptId);
        } catch (e) {
          ctx.toastErr(e.data?.error || e.message || 'Không lưu được điểm PDF.');
        }
      }));
      host.appendChild(el('div', { className: 'btn-row' }, [savePdfGradeBtn]));
    }

    if (focus) {
      const saveManualBtn = el('button', {
        type: 'button',
        className: 'btn btn-secondary',
      }, 'Lưu điểm chấm tay');
      saveManualBtn.addEventListener('click', () => withBusyButton(saveManualBtn, 'Đang lưu…', async () => {
        try {
          const marks = [];
          for (const q of version.questions || []) {
            const mg = draftManual[q.id];
            if (!mg || mg.score == null || !Number.isFinite(Number(mg.score))) continue;
            marks.push({
              questionId: q.id,
              score: Number(mg.score),
              feedback: mg.feedback || '',
            });
          }
          const res = await saveExamAttemptManualGrades(focus.id, {
            marks,
            baseRevision: gradingRevision,
          });
          gradingRevision = res.gradingRevision;
          manualDirty = false;
          ctx.toastOk('Đã lưu điểm chấm tay.');
          await load(focusAttemptId);
        } catch (e) {
          if (e.status === 409) {
            ctx.toastErr('Điểm chấm đã thay đổi — tải lại.');
            await load(focusAttemptId);
            return;
          }
          ctx.toastErr(e.message || 'Không lưu được điểm chấm.');
        }
      }));
      host.appendChild(el('div', { className: 'btn-row' }, [saveManualBtn]));
    }

    const saveBtn = el('button', { type: 'button', className: 'btn btn-primary' }, 'Lưu đáp án');
    saveBtn.addEventListener('click', () => withBusyButton(saveBtn, 'Đang lưu…', async () => {
      try {
        const keys = {};
        for (const q of version.questions || []) {
          if (!isChoiceBasedQuestion(q)) continue;
          const k = draftKeys[q.id];
          if (k) keys[q.id] = k;
        }
        const textKeys = {};
        for (const q of version.questions || []) {
          if (normalizeExamQuestionType(q) !== EXAM_QUESTION_TYPE.SHORT_ANSWER) continue;
          const list = draftTextKeys[q.id];
          if (Array.isArray(list) && list.length) textKeys[q.id] = list;
        }
        const attemptChoiceSave = async (confirmOverwrite) => saveExamVersionAnswerKey(version.id, {
          keys,
          baseRevision: answerKeyRevision,
          confirmOverwrite: !!confirmOverwrite,
        });
        const attemptTextSave = async (confirmOverwrite) => saveExamVersionTextAnswerKey(version.id, {
          keys: textKeys,
          baseRevision: textAnswerKeyRevision,
          confirmOverwrite: !!confirmOverwrite,
        });
        const runSave = async () => {
          if (Object.keys(keys).length) {
            const res = await attemptChoiceSave(false).catch(async (e) => {
              if (e.status === 409 && e.data?.conflicts?.length) {
                if (!globalThis.confirm('Một số đáp án đúng đã có — ghi đè?')) throw e;
                return attemptChoiceSave(true);
              }
              throw e;
            });
            answerKeyRevision = res.answerKeyRevision;
          }
          if (Object.keys(textKeys).length) {
            const res = await attemptTextSave(false).catch(async (e) => {
              if (e.status === 409 && e.data?.conflicts?.length) {
                if (!globalThis.confirm('Đáp án văn bản đã có — ghi đè?')) throw e;
                return attemptTextSave(true);
              }
              throw e;
            });
            textAnswerKeyRevision = res.textAnswerKeyRevision;
          }
          dirty = false;
          saveStateEl.textContent = 'Đã lưu đáp án';
          saveStateEl.className = 'save-status ok';
          ctx.toastOk('Đã lưu đáp án.');
          await load(focusAttemptId);
        };
        await runSave();
      } catch (e) {
        if (e.status === 409) {
          ctx.toastErr('Đáp án đã thay đổi — tải lại trang.');
          await load(focusAttemptId);
          return;
        }
        ctx.toastErr(e.message || 'Không lưu được.');
      }
    }));
    host.appendChild(el('div', { className: 'btn-row' }, [saveBtn]));
  }

  const gradeHashQuery = new URLSearchParams((typeof location !== 'undefined' && location.hash.includes('?'))
    ? location.hash.split('?')[1] : '');
  const initialAttemptId = gradeHashQuery.get('attemptId') || gradeHashQuery.get('attempt') || null;

  load(initialAttemptId).catch((e) => {
    host.replaceChildren(el('p', {}, e.message || 'Không tải được.'));
    ctx.toastErr(e.message);
  });

  root.__examDispose = () => {
    pdfMarkEditor?.dispose();
    pdfMarkEditor = null;
  };
}
