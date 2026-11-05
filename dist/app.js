import {
  SUBMISSION_STATUS,
  validateScore,
  classifyDeadlineTiming,
  checkMissingPages,
  resolveStudentPublishedGrading,
  applyFirstSubmittedAt,
  scaleMarkToViewport,
  markToNormalized,
  listPinComments,
  pinNumberMap,
  updatePinCommentText,
  isPinCommentTextValid,
  getAssignmentsForStudent,
  getStudentsInClass,
  studentCanAccessAssignmentClassClient,
  gradingQueueState,
  shouldIncludeInGradingQueue,
  planDomProp,
  computeDashboardMetrics,
  formatDateVi,
  formatDateTimeVi,
  daysLate,
  validateBackup,
  BACKUP_SCHEMA_VERSION,
  safeText,
  buildAssignmentShareLink,
  buildZaloReminderText,
  validateAssignmentInput,
  validateClassInput,
  validateStudentInput,
  findDuplicateClassName,
  findDuplicateStudentName,
  findDuplicateAssignmentTitle,
  PASSWORD_RULES_HINT,
  ASSIGNMENT_ATTACHMENT_LIMITS,
  validateAssignmentAttachmentFile,
  formatAttachmentSize,
  COMMENT_TEMPLATES,
  IMAGE_LIMITS,
  validateImageFile,
  canStudentSubmitNewVersion,
  createSubmittedVersion,
  createDraftVersion,
  waitForInFlightUploads,
  buildStudentPhotoUploadJobs,
  blobContentFingerprint,
  computeEditorLayoutFromImage,
  computeEditorBaseContentSizeForFit,
  computeGradingZoomPercent,
  computeInlineTextEditorLayout,
  applyGradingFocusMode,
  shouldBlockGradingUndoRedo,
  shouldBlockGradingDestructiveActions,
  gradingPendingInlineEditMessage,
  seedGradingManualZoomFromFitMode,
  GRADING_ZOOM_FIT_PAGE,
  GRADING_ZOOM_FIT_WIDTH,
  GRADING_ZOOM_MANUAL,
  nudgeGradingManualZoom,
  resolveGradingPanelSideState,
  gradingDisplayedImageSizeChanged,
  transitionGradingEditorTool,
  resolveGradingInkControlsVisibility,
  MARK_INK_COLORS,
  PEN_STROKE_PRESETS,
  DIRECT_TEXT_SIZES,
  buildPenPathD,
  hitTestAnnotationAt,
  updateDirectTextAnnotation,
  moveDirectTextAnnotation,
  restoreDirectTextAnnotationPosition,
  estimateDirectTextBox,
  appendLivePenPixelPoint,
  createPenMarkFromPixelStroke,
  clampPixelToNormalized,
  createDirectTextMarkFromPixelAnchor,
  fitDirectTextMarkInPage,
  createCanvasMeasureLineWidth,
  openDirectTextDialogWithHost,
  normalizeTeacherGradingDraft,
  hitTestDirectTextHandle,
  resizeDirectTextAnnotation,
  computeDirectTextWidthNormFromPixelWidth,
  defaultDirectTextWidthNorm,
  layoutDirectTextBox,
  collectPenIdsForEraserPath,
  applyEraserToAnnotations,
  resolveDirectTextSaveFontSizeNorm,
  isDirectTextValid,
  directTextSaveErrorMessage,
  validateDirectTextPlacement,
  directTextSelectionFrameFromBox,
  directTextHandleCenters,
  DIRECT_TEXT_HANDLE_RADIUS,
  DIRECT_TEXT_FONT_FAMILY,
  directTextSizeOptionValue,
} from './model.js';
import {
  ensureCsrf,
  fetchBootstrap,
  fetchMe,
  login,
  logout,
  setupTeacher,
  changePassword,
  loadAppData,
  putRecord,
  updateTeacherSettings,
  listStudentAccounts,
  createStudentAccount,
  accountAction,
  migrateLocalData,
  uploadImageBlob,
  imageUrl,
  uploadTeacherAttachment,
  attachmentUrl,
  studentSaveDraft,
  studentSubmitWork,
  studentSubmitRevision,
  studentMarkFeedbackViewed,
  getCurrentUser,
  bumpRequestEpoch,
  isStaleEpoch,
  getRequestEpoch,
  captureAuthPrincipal,
  setUnauthorizedHandler,
  clearClientOperations,
} from './api-client.js';
import {
  toastSuccess,
  showErrorBanner,
  clearAllNotifications,
  openCredentialsDialog,
  hideErrorBanner,
  showCredentialPendingNotice,
  hideCredentialPendingNotice,
} from './ux-notify.js';
import { tryRenderBaView, parseBaRoute, BA_NAV_ITEMS, disposeActiveBaViewScope } from './ba-ui.js';
import { tryRenderExamView, parseExamRoute, EXAM_NAV_ITEM } from './exam-ui.js';
import {
  filterNavItemsForRole,
  resolveSidebarNavActive,
  renderMobileNavigation,
} from './ux-mobile-nav.js';
import {
  withBusyButton,
  wireDialogA11y,
  confirmDiscard,
  snapshotFormDirty,
  registerDirtyProbe,
  isGloballyDirty,
  bumpDirtyNavigationGuard,
  runMutationGuard,
  createFormPendingLock,
  closePendingFormDialogAfterSuccessfulSave,
  captureAcknowledgedFormSnapshot,
} from './ux-forms.js';
import {
  rebuildStudentAccountSelect,
  captureCreateAccountDraft,
  applyCreateAccountSuccessAck,
  shouldApplyAccountsViewWork,
  syncCleanFormBaselineAfterProgrammaticSelectRefresh,
  queueCreateAccountCredentialIfValid,
} from './ux-accounts-view.js';
import {
  configureCredentialQueue,
  showCredentialDialog,
  clearCredentialQueueSecrets,
  refreshCredentialQueuePresentation,
  onCredentialRouteNavigation,
} from './ux-credential-queue.js';
import {
  bindModalRouteHost,
  clearModalRouteHost,
  disposeAuthorizedDialogHost,
} from './ux-dialog-host.js';
import { createAppHashNavigation } from './ux-hash-navigation.js';
import {
  guardStudentPhotoMutation,
  isStudentPhotoMutationBlocked,
  runStudentPhotoDraftPersist,
} from './ux-student-photo-lock.js';
import {
  captureStudentPhotoInitiatingContext,
  isStudentPhotoInitiatingContextStale,
  staleStudentPhotoAuthError,
} from './ux-student-photo-pipeline.js';
import {
  captureStudentSubmissionUiScope,
  shouldApplyStudentSubmissionUiWork,
} from './ux-student-submission-view.js';
import { createStudentPhotoDraftAckState } from './ux-student-photo-draft-ack.js';
import { createAttachmentUploadController, probeAssignmentAttachmentsDirty } from './ux-upload.js';
import { openAttachmentImageViewer, disposeImageViewer } from './ux-image-viewer.js';
import { createPersistWithStatus, replayPayloadSignature } from './ux-persist.js';
import {
  closeAssignmentDialogAfterSuccessfulSave,
  resolveNewAssignmentClassId,
} from './ux-assignment-save.js';
import {
  createGradingMutatingCoordinator,
  syncGradingMutatingButton,
  guardGradingNotBusy,
  shouldNavigateAfterGradingPublish,
} from './ux-grading-actions.js';
import { createGradingGestureSettlement } from './ux-grading-gestures.js';
import {
  createGradingDirtyTracker,
  gradingWriteResourceKey,
} from './ux-grading-dirty.js';

const DB_NAME = 'baiNhaDemoLocal';
const DB_VERSION = 1;

/** @type {IDBDatabase|null} */
let legacyDb = null;

/** @type {(() => void) | null} */
let disposeGradingEditor = null;

const state = {
  authPhase: 'loading',
  user: null,
  role: 'teacher',
  previewStudentId: null,
  classFilterId: '',
  route: parseRoute(),
  saveStatus: 'ok',
  saveMessage: 'Đã lưu',
  dataEpoch: 0,
  data: {
    classes: [],
    students: [],
    assignments: [],
    submissions: [],
    settings: { teacherName: 'Giáo viên' },
  },
  imageUrlCache: new Map(),
  gradingSession: null,
  gradingViewVersionId: null,
  studentViewVersionIds: {},
};

function parseRoute() {
  const hash = location.hash.replace(/^#/, '') || '/dashboard';
  const parts = hash.split('/').filter(Boolean);
  if (parts[0] === 'grading' && parts[1]) {
    return {
      view: 'grading-editor',
      assignmentId: parts[1],
      studentId: parts[2] || null,
    };
  }
  if (parts[0] === 'classes') {
    if (parts[1]) return { view: 'class-detail', classId: parts[1] };
    return { view: 'classes' };
  }
  const ba = parseBaRoute(parts);
  if (ba) return ba;
  const exam = parseExamRoute(parts);
  if (exam) return exam;
  if (parts[0] === 'assignment' && parts[1]) {
    return { view: 'assignment-detail', assignmentId: parts[1] };
  }
  const view = parts[0] || 'dashboard';
  if (view === 'change-password') return { view: 'change-password' };
  if (view === 'accounts') return { view: 'accounts' };
  if (view === 'settings') return { view: 'settings' };
  return { view, classId: null, assignmentId: null, studentId: null };
}

function disposeModalHostForAuthorizedNavigation() {
  disposeImageViewer();
  disposeAuthorizedDialogHost({
    clearRoot: () => {
      const root = document.getElementById('dialog-root');
      if (root) clear(root);
    },
    unregisterDirtyProbe: () => registerDirtyProbe(null),
    bumpDialogGeneration: () => { activeDialogGeneration += 1; },
  });
}

function navigate(hash) {
  if (appHashNavigation.isSameRouteNavigate(hash, location.hash)) {
    return;
  }
  if (isGloballyDirty() && !confirmDiscard()) return;
  disposeModalHostForAuthorizedNavigation();
  onCredentialRouteNavigation();
  const { target } = appHashNavigation.prepareAcceptedNavigate(hash);
  location.hash = target;
  state.route = parseRoute();
}

const appHashNavigation = createAppHashNavigation(location.hash);

function restoreAllowedAppHash() {
  const plan = appHashNavigation.beginRestoreCanceledNavigation(location.hash);
  if (plan.action === 'set-hash') {
    location.hash = plan.hash;
  }
}

let activeDialogGeneration = 0;

function isTeacher() {
  return state.user?.role === 'teacher';
}

function syncRoleFromUser() {
  state.role = state.user?.role === 'student' ? 'student' : 'teacher';
  if (state.user?.role === 'student') {
    state.previewStudentId = state.user.studentId || null;
  }
}

function clearSessionClientState() {
  bumpRequestEpoch();
  clearClientOperations();
  resetPersistSession();
  state.dataEpoch += 1;
  state.user = null;
  state.role = 'teacher';
  state.previewStudentId = null;
  state.gradingSession = null;
  state.gradingViewVersionId = null;
  state.studentViewVersionIds = {};
  for (const url of state.imageUrlCache.values()) {
    if (String(url).startsWith('blob:')) URL.revokeObjectURL(url);
  }
  state.imageUrlCache.clear();
  state.data = {
    classes: [],
    students: [],
    assignments: [],
    submissions: [],
    settings: { teacherName: 'Giáo viên' },
  };
  document.getElementById('dialog-root').innerHTML = '';
  disposeImageViewer();
  activeDialogGeneration += 1;
  clearCredentialQueueSecrets();
  clearAllNotifications();
  registerDirtyProbe(null);
}

function guardStudentRoute() {
  if (!state.user) return;
  if (state.user.mustChangePassword) {
    if (state.route.view !== 'change-password') {
      navigate('#/change-password');
    }
    return;
  }
  if (isTeacher()) return;
  state.gradingSession = null;
  state.gradingViewVersionId = null;
  const v = state.route.view;
  if (
    v === 'grading-editor' ||
    v === 'grading' ||
    v === 'classes' ||
    v === 'class-detail' ||
    v === 'dashboard' ||
    v === 'accounts' ||
    String(v).startsWith('tutor')
  ) {
    if (location.hash !== '#/assignments') {
      location.hash = '#/assignments';
      state.route = parseRoute();
    }
  }
}

function measureDisplayedImage(imgEl, zoom = 1) {
  const rect = imgEl.getBoundingClientRect();
  const z = zoom || 1;
  return {
    w: Math.max(1, rect.width / z),
    h: Math.max(1, rect.height / z),
    rect,
    z,
  };
}

function editorWrapInnerWidth(wrapEl) {
  if (!wrapEl) return 1;
  const cs = getComputedStyle(wrapEl);
  const pl = parseFloat(cs.paddingLeft) || 0;
  const pr = parseFloat(cs.paddingRight) || 0;
  return Math.max(1, wrapEl.clientWidth - pl - pr);
}

function editorWrapInnerHeight(wrapEl) {
  if (!wrapEl) return 1;
  const cs = getComputedStyle(wrapEl);
  const pt = parseFloat(cs.paddingTop) || 0;
  const pb = parseFloat(cs.paddingBottom) || 0;
  return Math.max(1, wrapEl.clientHeight - pt - pb);
}

function editorStageInnerHeight(scrollWrap, stageHostEl) {
  const fromWrap = editorWrapInnerHeight(scrollWrap);
  if (!stageHostEl) return fromWrap;
  const hostH = Math.max(1, stageHostEl.clientHeight - 16);
  return Math.min(fromWrap, hostH);
}

function applyEditorStageLayout({
  stage,
  viewport,
  scrollWrap,
  img,
  zoom,
  fitMode = GRADING_ZOOM_FIT_WIDTH,
}) {
  if (!stage || !viewport || !img) return null;
  const z = zoom || 1;
  const innerW = editorWrapInnerWidth(scrollWrap);
  const innerH = editorStageInnerHeight(scrollWrap, scrollWrap?.closest?.('.grading-stage-host'));
  const layout = computeEditorLayoutFromImage({
    naturalWidth: img.naturalWidth,
    naturalHeight: img.naturalHeight,
    containerInnerWidth: innerW,
    containerInnerHeight: innerH,
    fitMode,
    zoom: z,
  });
  viewport.style.width = `${layout.viewportWidth}px`;
  viewport.style.height = `${layout.viewportHeight}px`;
  viewport.style.maxWidth = 'none';
  viewport.style.maxHeight = 'none';
  viewport.style.transformOrigin = 'top left';
  viewport.style.transform = layout.zoom === 1 ? '' : `scale(${layout.zoom})`;
  stage.style.width = `${layout.stageWidth}px`;
  stage.style.height = `${layout.stageHeight}px`;
  stage.style.maxWidth = 'none';
  if (layout.centerInContainer) {
    stage.style.marginLeft = 'auto';
    stage.style.marginRight = 'auto';
  } else {
    stage.style.marginLeft = '0';
    stage.style.marginRight = '0';
  }
  return layout;
}

const EDITOR_ICON_STROKE = 1.85;

function editorIcon(name) {
  const common = {
    xmlns: SVG_NS,
    width: '24',
    height: '24',
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': String(EDITOR_ICON_STROKE),
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
  };
  const paths = {
    select: [
      svgEl('path', { d: 'M5 3l14 7-7 2-2 7z' }),
    ],
    pan: [
      svgEl('path', { d: 'M9 11V6.5a1.5 1.5 0 113 0V11' }),
      svgEl('path', { d: 'M12 11V4.5a1.5 1.5 0 113 0V11' }),
      svgEl('path', { d: 'M15 11V7.5a1.5 1.5 0 113 0V11' }),
      svgEl('path', { d: 'M7 13l-2 7 7-2 2-7' }),
    ],
    pen: [
      svgEl('path', { d: 'M12 20h9' }),
      svgEl('path', { d: 'M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4 12.5-12.5z' }),
    ],
    text: [
      svgEl('path', { d: 'M4 7V5h16v2' }),
      svgEl('path', { d: 'M9 5v14' }),
      svgEl('path', { d: 'M15 5v14' }),
      svgEl('path', { d: 'M8 19h8' }),
    ],
    eraser: [
      svgEl('path', { d: 'M7 21h10' }),
      svgEl('path', { d: 'M5.5 12.5l6-6a2.1 2.1 0 013 3l-6 6-4.5 1.5 1.5-4.5z' }),
    ],
    highlight: [
      svgEl('rect', { x: '4', y: '8', width: '16', height: '10', rx: '1.5' }),
    ],
    comment: [
      svgEl('path', { d: 'M21 11.5a8.4 8.4 0 01-8.4 8.4H7l-4 3v-4.2A8.4 8.4 0 0112.6 3 8.4 8.4 0 0121 11.5z' }),
    ],
    check: [
      svgEl('path', { d: 'M5 12l4 4L19 6' }),
    ],
    cross: [
      svgEl('path', { d: 'M6 6l12 12M18 6L6 18' }),
    ],
    undo: [
      svgEl('path', { d: 'M9 7H5v4' }),
      svgEl('path', { d: 'M5 11a7 7 0 101.6-4.6L5 7' }),
    ],
    redo: [
      svgEl('path', { d: 'M15 7h4v4' }),
      svgEl('path', { d: 'M19 11a7 7 0 11-3.6-4.6L19 7' }),
    ],
    trash: [
      svgEl('path', { d: 'M4 7h16' }),
      svgEl('path', { d: 'M9 7V5h6v2' }),
      svgEl('path', { d: 'M10 11v6M14 11v6' }),
      svgEl('path', { d: 'M6 7l1 14h10l1-14' }),
    ],
    zoomIn: [
      svgEl('path', { d: 'M12 8v8M8 12h8' }),
      svgEl('circle', { cx: '11', cy: '11', r: '7' }),
      svgEl('path', { d: 'M16 16l4 4' }),
    ],
    zoomOut: [
      svgEl('path', { d: 'M8 12h6' }),
      svgEl('circle', { cx: '11', cy: '11', r: '7' }),
      svgEl('path', { d: 'M16 16l4 4' }),
    ],
    fitPage: [
      svgEl('rect', { x: '5', y: '3', width: '14', height: '18', rx: '2' }),
      svgEl('path', { d: 'M8 7h8M8 11h8M8 15h5' }),
    ],
    fitWidth: [
      svgEl('path', { d: 'M4 8V6a2 2 0 012-2h12a2 2 0 012 2v2' }),
      svgEl('path', { d: 'M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2' }),
      svgEl('path', { d: 'M9 12h6' }),
    ],
    expand: [
      svgEl('path', { d: 'M9 3H3v6M15 3h6v6M9 21H3v-6M15 21h6v-6' }),
    ],
    collapse: [
      svgEl('path', { d: 'M4 14h6v6H4zM14 4h6v6h-6z' }),
    ],
    close: [
      svgEl('path', { d: 'M6 6l12 12M18 6L6 18' }),
    ],
    more: [
      svgEl('circle', { cx: '5', cy: '12', r: '1.25', fill: 'currentColor', stroke: 'none' }),
      svgEl('circle', { cx: '12', cy: '12', r: '1.25', fill: 'currentColor', stroke: 'none' }),
      svgEl('circle', { cx: '19', cy: '12', r: '1.25', fill: 'currentColor', stroke: 'none' }),
    ],
    panel: [
      svgEl('rect', { x: '3', y: '4', width: '18', height: '16', rx: '2' }),
      svgEl('path', { d: 'M15 4v16' }),
    ],
    back: [
      svgEl('path', { d: 'M19 12H5' }),
      svgEl('path', { d: 'M12 5l-7 7 7 7' }),
    ],
    view: [
      svgEl('path', { d: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z' }),
      svgEl('circle', { cx: '12', cy: '12', r: '2.5' }),
    ],
  };
  const svg = svgEl('svg', common);
  for (const node of paths[name] || paths.select) svg.appendChild(node);
  return svg;
}

function mountEditorToolButton({ id, iconName, label, parent, onClick, disabled = false }) {
  const btn = el('button', {
    type: 'button',
    className: `editor-tool-btn${id === 'eraser' ? ' tool-eraser' : ''}`,
    title: label,
    'aria-label': label,
    'aria-pressed': 'false',
    disabled,
    onClick,
  }, editorIcon(iconName), el('span', { className: 'editor-tool-label' }, label));
  return btn;
}

function submittedVersions(sub) {
  return (sub?.versions || []).filter((v) => !v.isDraft);
}

async function importBackupAtomically(data) {
  if (!legacyDb) throw new Error('no-legacy-db');
  const stores = ['classes', 'students', 'assignments', 'submissions'];
  return new Promise((resolve, reject) => {
    const tx = legacyDb.transaction(stores, 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error);
    tx.onerror = () => reject(tx.error);
    for (const c of data.classes) tx.objectStore('classes').put(c);
    for (const s of data.students) tx.objectStore('students').put(s);
    for (const a of data.assignments) tx.objectStore('assignments').put(a);
    for (const s of data.submissions) tx.objectStore('submissions').put(s);
  });
}

function openLegacyDb() {
  return new Promise((resolve, reject) => {
    if (!indexedDB) {
      resolve(null);
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains('classes')) d.createObjectStore('classes', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('students')) d.createObjectStore('students', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('assignments')) d.createObjectStore('assignments', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('submissions')) {
        d.createObjectStore('submissions', { keyPath: 'id' });
      }
      if (!d.objectStoreNames.contains('images')) d.createObjectStore('images', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('settings')) d.createObjectStore('settings', { keyPath: 'key' });
    };
    req.onsuccess = () => {
      legacyDb = req.result;
      resolve(legacyDb);
    };
  });
}

async function legacyGetAll(storeName) {
  return new Promise((resolve, reject) => {
    const req = legacyDb.transaction(storeName, 'readonly').objectStore(storeName).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function legacyGetOne(storeName, key) {
  return new Promise((resolve, reject) => {
    const req = legacyDb.transaction(storeName, 'readonly').objectStore(storeName).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function readLegacyIndexedDbExport() {
  await openLegacyDb();
  if (!legacyDb) return null;
  const [classes, students, assignments, submissions, settingsRows] = await Promise.all([
    legacyGetAll('classes'),
    legacyGetAll('students'),
    legacyGetAll('assignments'),
    legacyGetAll('submissions'),
    legacyGetAll('settings'),
  ]);
  if (!classes.length && !students.length && !assignments.length) return null;
  const imageIds = new Set();
  for (const sub of submissions) {
    for (const v of sub.versions || []) {
      for (const id of v.pageImageIds || []) imageIds.add(id);
    }
  }
  const images = [];
  for (const id of imageIds) {
    const rec = await legacyGetOne('images', id);
    if (!rec?.data) continue;
    const bytes = rec.data instanceof ArrayBuffer ? new Uint8Array(rec.data) : new Uint8Array(rec.data);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    images.push({
      id,
      mime: rec.mime || 'image/jpeg',
      dataBase64: btoa(binary),
      createdAt: rec.createdAt,
    });
  }
  return {
    backup: {
      schemaVersion: BACKUP_SCHEMA_VERSION,
      classes,
      students,
      assignments,
      submissions,
      exportedAt: new Date().toISOString(),
    },
    images,
  };
}

function openDirectTextDialog(onSave, initial = {}) {
  return openDirectTextDialogWithHost(
    {
      openDialog,
      mk: el,
      focus: (node) => node?.focus?.(),
    },
    onSave,
    initial,
  );
}

function openPinCommentDialog(onSave, initialText = '', title = 'Thêm nhận xét') {
  const input = el('textarea', {
    id: 'pin-comment-ta',
    rows: '4',
    'aria-label': 'Nội dung nhận xét trên trang',
  }, initialText);
  const err = el('div', { className: 'form-error', role: 'alert' });
  const { close } = openDialog(
    title,
    [
      el('div', { className: 'form-field' },
        el('label', { htmlFor: 'pin-comment-ta' }, 'Nội dung nhận xét'),
        input,
        err,
      ),
    ],
    [
      el('button', { type: 'button', className: 'btn btn-ghost', onClick: () => close() }, 'Hủy'),
      el('button', {
        type: 'button',
        className: 'btn btn-primary',
        onClick: () => {
          const text = safeText(input.value);
          if (!isPinCommentTextValid(text)) {
            err.textContent = 'Nhập nội dung nhận xét trước khi lưu.';
            input.focus();
            return;
          }
          onSave(text);
          close();
        },
      }, 'Lưu'),
    ],
  );
  input.focus();
}

const SVG_NS = 'http://www.w3.org/2000/svg';

let sharedTextMeasureLineWidth = null;
function defaultTextLayoutOptions() {
  if (!sharedTextMeasureLineWidth) {
    sharedTextMeasureLineWidth = createCanvasMeasureLineWidth();
  }
  return { measureLineWidth: sharedTextMeasureLineWidth };
}

function svgEl(name, attrs = {}) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) {
    if (v != null) node.setAttribute(k, String(v));
  }
  return node;
}

function renderMarkGraphic(mark, scaled, { selected = false, pinNumber = null, viewportW = 0, viewportH = 0, textLayoutOptions = null } = {}) {
  const g = svgEl('g', { 'data-id': mark.id, 'data-type': mark.type });
  const x = scaled.x;
  const y = scaled.y;
  if (mark.type === 'check') {
    g.appendChild(svgEl('path', {
      class: 'mark-check',
      d: `M ${x - 8} ${y} L ${x - 2} ${y + 8} L ${x + 12} ${y - 10}`,
    }));
  } else if (mark.type === 'cross') {
    g.appendChild(svgEl('line', { class: 'mark-cross', x1: x - 10, y1: y - 10, x2: x + 10, y2: y + 10 }));
    g.appendChild(svgEl('line', { class: 'mark-cross', x1: x + 10, y1: y - 10, x2: x - 10, y2: y + 10 }));
  } else if (mark.type === 'highlight') {
    g.appendChild(svgEl('rect', {
      class: 'mark-highlight',
      x: scaled.x,
      y: scaled.y,
      width: scaled.w,
      height: scaled.h,
    }));
  } else if (mark.type === 'pin') {
    const r = 14;
    g.appendChild(svgEl('circle', { class: 'mark-pin', cx: x, cy: y, r }));
    const label = svgEl('text', {
      class: 'mark-pin-label',
      x,
      y,
      'text-anchor': 'middle',
      'dominant-baseline': 'central',
      'font-size': '11',
      'font-weight': '700',
      fill: '#ffffff',
    });
    label.textContent = String(pinNumber ?? '•');
    g.appendChild(label);
  } else if (mark.type === 'pen') {
    const pts = scaled.points || [];
    const d = buildPenPathD(pts);
    if (d) {
      g.appendChild(svgEl('path', {
        class: 'mark-pen',
        d,
        fill: 'none',
        stroke: scaled.color || '#c62828',
        'stroke-width': scaled.strokeWidth || 3,
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
      }));
    }
  } else if (mark.type === 'text') {
    const layoutOpts = textLayoutOptions || {};
    const box = estimateDirectTextBox(mark, viewportW || 1, viewportH || 1, layoutOpts);
    const pad = 4;
    const bgW = Math.min(box.w + pad * 2, Math.max(0, (viewportW || box.w) - box.x + pad));
    g.appendChild(svgEl('rect', {
      class: 'mark-text-bg',
      x: box.x - pad,
      y: box.y - pad,
      width: bgW,
      height: box.h + pad,
      rx: 4,
    }));
    const textNode = svgEl('text', {
      class: 'mark-direct-text',
      x: box.x,
      y: box.y + box.fontSize,
      fill: box.color,
      'font-size': String(box.fontSize),
      'font-family': 'system-ui, "Segoe UI", sans-serif',
    });
    box.lines.forEach((line, i) => {
      const tspan = svgEl('tspan', {
        x: box.x,
        dy: i === 0 ? 0 : box.lineHeight,
      });
      tspan.textContent = line;
      textNode.appendChild(tspan);
    });
    g.appendChild(textNode);
  }
  if (selected && (mark.type === 'pin' || mark.type === 'check' || mark.type === 'cross')) {
    g.appendChild(svgEl('circle', {
      class: 'mark-selected-ring',
      cx: x,
      cy: y,
      r: 18,
    }));
  }
  if (selected && mark.type === 'text') {
    const layoutOpts = textLayoutOptions || {};
    const box = estimateDirectTextBox(mark, viewportW || 1, viewportH || 1, layoutOpts);
    const frame = directTextSelectionFrameFromBox(box);
    g.appendChild(svgEl('rect', {
      class: 'mark-selected-box',
      x: frame.bx,
      y: frame.by,
      width: frame.bw,
      height: frame.bh,
      rx: 4,
    }));
    const handleR = DIRECT_TEXT_HANDLE_RADIUS;
    const centers = directTextHandleCenters(box);
    const handles = [
      { cls: 'mark-text-handle mark-text-handle-move', cx: centers.move.x, cy: centers.move.y },
      { cls: 'mark-text-handle mark-text-handle-e', cx: centers.e.x, cy: centers.e.y },
      { cls: 'mark-text-handle mark-text-handle-w', cx: centers.w.x, cy: centers.w.y },
      { cls: 'mark-text-handle mark-text-handle-se', cx: centers.se.x, cy: centers.se.y },
    ];
    for (const h of handles) {
      g.appendChild(svgEl('circle', {
        class: h.cls,
        cx: h.cx,
        cy: h.cy,
        r: handleR,
      }));
    }
  }
  if (selected && mark.type === 'pen') {
    const pts = scaled.points || [];
    if (pts.length) {
      let minX = pts[0].x;
      let minY = pts[0].y;
      let maxX = pts[0].x;
      let maxY = pts[0].y;
      for (const p of pts) {
        minX = Math.min(minX, p.x);
        minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x);
        maxY = Math.max(maxY, p.y);
      }
      const pad = (scaled.strokeWidth || 3) + 6;
      g.appendChild(svgEl('rect', {
        class: 'mark-selected-box',
        x: minX - pad,
        y: minY - pad,
        width: maxX - minX + pad * 2,
        height: maxY - minY + pad * 2,
        rx: 4,
      }));
    }
  }
  if (selected && mark.type === 'highlight') {
    g.appendChild(svgEl('rect', {
      class: 'mark-selected-box',
      x: scaled.x - 2,
      y: scaled.y - 2,
      width: scaled.w + 4,
      height: scaled.h + 4,
      rx: 2,
    }));
  }
  return g;
}

function fillAnnotationSvg(svg, annotations, w, h, { selectedId = null, textLayoutOptions = null, hideTextId = null } = {}) {
  const layoutOpts = textLayoutOptions || defaultTextLayoutOptions();
  const numbers = pinNumberMap(annotations);
  clear(svg);
  for (const mark of annotations || []) {
    if (hideTextId && mark.id === hideTextId && mark.type === 'text') continue;
    const scaled = scaleMarkToViewport(mark, w, h);
    svg.appendChild(renderMarkGraphic(mark, scaled, {
      selected: mark.id === selectedId,
      pinNumber: numbers.get(mark.id),
      viewportW: w,
      viewportH: h,
      textLayoutOptions: layoutOpts,
    }));
  }
}

function mountPageCommentList(container, annotations, {
  selectedId = null,
  editable = false,
  onEdit = null,
  onDelete = null,
} = {}) {
  clear(container);
  const pins = listPinComments(annotations);
  if (!pins.length) {
    container.hidden = true;
    return;
  }
  container.hidden = false;
  container.appendChild(el('h3', { className: 'page-comment-list-title' }, 'Nhận xét trên trang'));
  for (const pin of pins) {
    const row = el('div', {
      className: `page-comment-item${pin.id === selectedId ? ' selected' : ''}`,
    });
    row.appendChild(el('span', { className: 'page-comment-num', title: `Nhận xét số ${pin.number}` }, String(pin.number)));
    const textEl = el('p', { className: 'page-comment-text' });
    textEl.textContent = safeText(pin.text || '(Không có nội dung)');
    row.appendChild(textEl);
    if (editable && onEdit && onDelete) {
      const actions = el('div', { className: 'page-comment-actions' });
      actions.appendChild(el('button', {
        type: 'button',
        title: 'Sửa nhận xét',
        'aria-label': `Sửa nhận xét số ${pin.number}`,
        onClick: () => onEdit(pin.id),
      }, 'Sửa'));
      actions.appendChild(el('button', {
        type: 'button',
        title: 'Xóa nhận xét',
        'aria-label': `Xóa nhận xét số ${pin.number}`,
        onClick: () => onDelete(pin.id),
      }, 'Xóa'));
      row.appendChild(actions);
    }
    container.appendChild(row);
  }
}

window.addEventListener('hashchange', () => {
  const plan = appHashNavigation.planHashChange(location.hash, {
    isDirty: isGloballyDirty,
    confirmDiscard,
  });
  if (plan.kind === 'canceled-restore-noop') {
    return;
  }
  if (plan.kind === 'reject-restore') {
    restoreAllowedAppHash();
    return;
  }
  if (plan.disposeModals) {
    disposeModalHostForAuthorizedNavigation();
  }
  state.route = parseRoute();
  render();
});

function openDb() {
  return openLegacyDb();
}

async function getAll(storeName) {
  if (storeName === 'settings') return [{ key: 'main', value: state.data.settings }];
  return state.data[storeName] || [];
}

async function put(storeName, value) {
  if (!state.user) throw new Error('unauthenticated');
  if (storeName === 'submissions' && !isTeacher()) {
    throw new Error('use-student-actions');
  }
  if (storeName === 'settings') {
    await updateTeacherSettings(value.teacherName || value.value?.teacherName);
    return;
  }
  const payload = { ...value };
  const persistOpId = getActivePersistOperationId();
  if (persistOpId && !payload.operationId) {
    payload.operationId = persistOpId;
  }
  await putRecord(storeName, payload);
}

async function getOne(storeName, key) {
  if (storeName === 'images') {
    return state.imageUrlCache.has(key) ? { id: key } : { id: key };
  }
  if (storeName === 'settings') {
    return { key: 'main', value: state.data.settings };
  }
  const list = state.data[storeName] || [];
  return list.find((x) => x.id === key) || null;
}

function setSaveStatus(kind, message) {
  state.saveStatus = kind;
  state.saveMessage = message;
  const el = document.getElementById('save-status');
  if (!el) return;
  let text = message;
  if (kind === 'ok') {
    const t = new Date();
    text = `${message} · ${t.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })}`;
  }
  el.textContent = text;
  el.className = `save-status ${kind === 'err' ? 'err' : kind === 'pending' ? 'pending' : 'ok'}`;
}

async function reloadAppData() {
  const epoch = state.dataEpoch;
  const data = await loadAppData();
  if (epoch !== state.dataEpoch) return;
  state.data = data;
}

const {
  persistWithStatus,
  resetPersistSession,
  getActivePersistOperationId,
  getPersistRetryHandle,
} = createPersistWithStatus({
  getRequestEpoch,
  isStaleEpoch,
  reloadAppData,
  setSaveStatus,
  showErrorBanner,
  hideErrorBanner,
  toastSuccess,
  onUnauthorized: async () => {
    clearSessionClientState();
    state.authPhase = 'login';
    renderAuthShell();
  },
});

async function loadAllData() {
  await reloadAppData();
}

function uid() {
  return crypto.randomUUID();
}

function workbookSvgDataUrl() {
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="600" height="800" viewBox="0 0 600 800">
  <rect fill="#fffef8" width="600" height="800"/>
  <rect fill="#f6f5f1" x="24" y="24" width="552" height="752" rx="8" stroke="#ccc" stroke-width="1"/>
  <text x="48" y="70" font-family="Georgia, serif" font-size="22" fill="#1e4d3a">Workbook — Unit 4: Present Perfect</text>
  <text x="48" y="110" font-family="system-ui,sans-serif" font-size="14" fill="#555">Complete the sentences using the verb in brackets.</text>
  <text x="48" y="160" font-family="system-ui,sans-serif" font-size="16" fill="#2c2c2c">1. She ______ (study) English for three years.</text>
  <text x="72" y="190" font-family="cursive,Segoe Script,sans-serif" font-size="18" fill="#1a56db">has studied</text>
  <text x="48" y="240" font-family="system-ui,sans-serif" font-size="16" fill="#2c2c2c">2. They ______ (not / visit) Ha Noi yet.</text>
  <text x="72" y="270" font-family="cursive,sans-serif" font-size="18" fill="#1a56db">haven't visited</text>
  <text x="48" y="320" font-family="system-ui,sans-serif" font-size="16" fill="#2c2c2c">3. How long ______ you ______ (live) here?</text>
  <text x="72" y="350" font-family="cursive,sans-serif" font-size="18" fill="#b33a3a">do you live</text>
  <line x1="70" y1="355" x2="200" y2="355" stroke="#b33a3a" stroke-width="2"/>
  <text x="48" y="400" font-family="system-ui,sans-serif" font-size="14" fill="#888">Teacher note: check auxiliary + past participle</text>
</svg>`;
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}

async function svgToImageRecord(id) {
  const res = await fetch(workbookSvgDataUrl());
  const blob = await res.blob();
  const buf = await blob.arrayBuffer();
  return { id, mime: 'image/svg+xml', data: buf, createdAt: new Date().toISOString() };
}

async function seedDemoData() {
  /* Demo seed only for legacy IndexedDB — never runs on authenticated server backend. */
  if (state.user) return;
  const existing = legacyDb ? await legacyGetOne('settings', 'main') : null;
  if (existing?.value?.seeded) return;

  const classDefs = [
    { name: 'IELTS 6.5 — Tối 3 & 6', days: ['Thứ 3', 'Thứ 6'], time: '19:00' },
    { name: 'TOEIC 750 — Sáng CN', days: ['Chủ nhật'], time: '09:00' },
    { name: 'IELTS Speaking Club', days: ['Thứ 5'], time: '18:30' },
  ];
  const namePool = [
    'Nguyễn Minh Anh', 'Trần Bảo Ngọc', 'Lê Hoàng Nam', 'Phạm Thu Hà', 'Võ Đức Thịnh',
    'Hoàng Lan Chi', 'Đặng Quốc Huy', 'Bùi Thảo My', 'Dương Gia Bảo', 'Ngô Khánh Linh',
    'Vũ Trung Kiên', 'Đinh Phương Thảo', 'Lý Hữu Phúc', 'Cao Yến Nhi', 'Trịnh Việt An',
    'Mai Quỳnh Anh', 'Hồ Nhật Minh', 'Lương Thùy Dung', 'Chu Bá Long', 'Tạ Ngọc Hân',
  ];

  const classes = [];
  const students = [];
  const assignments = [];
  const submissions = [];
  const images = [];

  const demoImg1 = await svgToImageRecord(uid());
  const demoImg2 = await svgToImageRecord(uid());
  images.push(demoImg1, demoImg2);

  const today = new Date();
  function isoDaysFromNow(n) {
    const d = new Date(today);
    d.setDate(d.getDate() + n);
    return d.toISOString().slice(0, 10);
  }

  classDefs.forEach((cd, ci) => {
    const classId = uid();
    classes.push({
      id: classId,
      name: cd.name,
      scheduleDays: cd.days,
      scheduleTime: cd.time,
      createdAt: new Date().toISOString(),
    });
    const count = 10 + (ci % 6);
    const classStudents = [];
    for (let i = 0; i < count; i++) {
      const st = {
        id: uid(),
        classId,
        name: namePool[(ci * 7 + i) % namePool.length],
      };
      students.push(st);
      classStudents.push(st);
    }

    const a1 = {
      id: uid(),
      classId,
      title: `Unit 4 — Present Perfect (${cd.name.split('—')[0].trim()})`,
      bookRef: 'English Grammar in Use, tr. 32–34',
      instructions: 'Chụp rõ trang bài làm trong sách, đủ 2 trang.',
      dueDateISO: isoDaysFromNow(ci === 0 ? 2 : ci === 1 ? -1 : 5),
      requiredPageCount: 2,
      createdAt: new Date().toISOString(),
    };
    const a2 = {
      id: uid(),
      classId,
      title: 'TOEIC Part 5 — Collocations',
      bookRef: 'Economy TOEIC 4, Test 2',
      instructions: 'Nộp trang 45–46.',
      dueDateISO: isoDaysFromNow(7 + ci),
      requiredPageCount: 2,
      createdAt: new Date().toISOString(),
    };
    assignments.push(a1, a2);

    classStudents.slice(0, 4).forEach((st, si) => {
      const subId = uid();
      const submittedAt = new Date(today);
      submittedAt.setDate(submittedAt.getDate() - (si + 1));
      const version = createSubmittedVersion({
        versionId: uid(),
        submittedAt: submittedAt.toISOString(),
        pageImageIds: [demoImg1.id, demoImg2.id],
        priorVersions: [],
      });
      version.status = si === 0 ? SUBMISSION_STATUS.GRADING : SUBMISSION_STATUS.SUBMITTED;
      if (si === 1) {
        version.grading = {
          score: 7.5,
          overallFeedback: 'Làm tốt phần 1–2. Câu 3 sai thì.',
          published: true,
          publishedAt: new Date().toISOString(),
          needsRevision: false,
          pages: [
            { annotations: [] },
            {
              annotations: [
                {
                  id: uid(),
                  type: 'cross',
                  nx: 0.12,
                  ny: 0.44,
                },
              ],
            },
          ],
        };
        version.status = SUBMISSION_STATUS.RETURNED;
      }
      submissions.push({
        id: subId,
        assignmentId: a1.id,
        studentId: st.id,
        firstSubmittedAt: submittedAt.toISOString(),
        versions: [version],
        feedbackOpenedAt: null,
      });
    });
  });

  if (!legacyDb) return;
  await new Promise((resolve, reject) => {
    const tx = legacyDb.transaction(['classes', 'students', 'assignments', 'submissions', 'images', 'settings'], 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    for (const c of classes) tx.objectStore('classes').put(c);
    for (const s of students) tx.objectStore('students').put(s);
    for (const a of assignments) tx.objectStore('assignments').put(a);
    for (const s of submissions) tx.objectStore('submissions').put(s);
    for (const img of images) tx.objectStore('images').put(img);
    tx.objectStore('settings').put({ key: 'main', value: { seeded: true, teacherName: 'Cô Lan' } });
  });
}

async function getImageBlob(imageId) {
  if (state.imageUrlCache.has(imageId)) {
    return state.imageUrlCache.get(imageId);
  }
  const url = imageUrl(imageId);
  state.imageUrlCache.set(imageId, url);
  return url;
}

async function storeImageBlob(blob, mime = 'image/jpeg', epochAtStart = getRequestEpoch(), principalAtStart = null) {
  const id = await uploadImageBlob(blob, mime, epochAtStart, principalAtStart);
  if (isStaleEpoch(epochAtStart) || (principalAtStart != null && principalAtStart !== captureAuthPrincipal())) {
    const err = new Error('stale-session');
    err.staleAuth = true;
    throw err;
  }
  state.imageUrlCache.set(id, imageUrl(id));
  return id;
}

async function compressImage(file) {
  const bmp = await createImageBitmap(file);
  let { width, height } = bmp;
  const max = IMAGE_LIMITS.maxDimension;
  if (width > max || height > max) {
    const s = max / Math.max(width, height);
    width = Math.round(width * s);
    height = Math.round(height * s);
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(bmp, 0, 0, width, height);
  bmp.close();
  const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.82));
  return blob;
}

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    const plan = planDomProp(k, v);
    switch (plan.action) {
      case 'className':
        node.className = plan.value;
        break;
      case 'text':
        node.textContent = safeText(plan.value);
        break;
      case 'property':
        node[plan.name] = plan.value;
        break;
      case 'listener':
        node.addEventListener(plan.event, plan.value);
        break;
      case 'booleanProperty':
        node[plan.name] = plan.value;
        if (plan.value) node.setAttribute(plan.name, '');
        else node.removeAttribute(plan.name);
        break;
      case 'attribute':
        node.setAttribute(plan.name, plan.value);
        break;
      default:
        break;
    }
  }
  for (const ch of children) {
    if (ch == null) continue;
    if (typeof ch === 'string') node.appendChild(document.createTextNode(ch));
    else node.appendChild(ch);
  }
  return node;
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

const NAV = [
  { id: 'dashboard', label: 'Tổng quan', hash: '#/dashboard', teacher: true },
  { id: 'classes', label: 'Lớp học', hash: '#/classes', teacher: true },
  ...BA_NAV_ITEMS,
  EXAM_NAV_ITEM,
  { id: 'assignments', label: 'Bài tập', hash: '#/assignments', teacher: true, student: true },
  { id: 'grading', label: 'Chấm bài', hash: '#/grading', teacher: true },
  { id: 'accounts', label: 'Tài khoản', hash: '#/accounts', teacher: true },
  { id: 'settings', label: 'Cài đặt', hash: '#/settings', teacher: true, student: true },
];

function renderNav() {
  const side = document.getElementById('sidebar-nav');
  const bottom = document.getElementById('bottom-nav');
  clear(side);
  const authedNav = state.user && !state.user.mustChangePassword;
  if (authedNav) {
    for (const item of filterNavItemsForRole(NAV, { isTeacher: isTeacher() })) {
      const active = resolveSidebarNavActive(item, state.route);
      const link = el('a', {
        href: item.hash,
        className: active ? 'active' : '',
        'aria-current': active ? 'page' : null,
      }, item.label);
      side.appendChild(el('li', {}, link));
    }
  }
  renderMobileNavigation({
    bottomNavEl: bottom,
    route: state.route,
    isTeacher: isTeacher(),
    navigate,
    showNav: authedNav,
    includeStudentExams: !!EXAM_NAV_ITEM.student,
  });
}

function updateChrome() {
  if (state.route.view !== 'grading-editor') {
    applyGradingFocusMode(document, false);
  }
  const shell = document.querySelector('.app-shell');
  const sidebar = document.querySelector('.sidebar');
  const header = document.querySelector('.top-header');
  const banner = document.querySelector('.demo-banner');
  const bottom = document.getElementById('bottom-nav');

  const authForm = state.authPhase === 'setup' || state.authPhase === 'login';
  const authed = state.authPhase === 'app' && state.user;
  const minimalChrome = authForm || (authed && state.user.mustChangePassword);

  if (shell) shell.hidden = state.authPhase === 'loading';

  if (minimalChrome) {
    if (sidebar) sidebar.hidden = true;
    if (header) header.hidden = true;
    if (banner) banner.hidden = true;
    if (bottom) bottom.hidden = true;
    return;
  }

  if (!authed) {
    if (sidebar) sidebar.hidden = true;
    if (header) header.hidden = true;
    if (banner) banner.hidden = true;
    if (bottom) bottom.hidden = true;
    return;
  }

  if (sidebar) sidebar.hidden = false;
  if (header) header.hidden = false;
  if (banner) banner.hidden = false;
  if (bottom) bottom.hidden = false;

  const d = new Date();
  document.getElementById('header-date').textContent = d.toLocaleDateString('vi-VN', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
  const roleToggle = document.querySelector('.role-toggle');
  const picker = document.getElementById('student-preview');
  if (roleToggle) roleToggle.hidden = true;
  if (picker) picker.hidden = true;

  const displayName = isTeacher()
    ? state.data.settings.teacherName || state.user.displayName
    : previewStudent()?.name || state.user.displayName;
  document.getElementById('profile-name').textContent = displayName;
  document.getElementById('profile-role').textContent =
    isTeacher() ? 'Giáo viên' : 'Học sinh';
  document.getElementById('teacher-avatar').textContent = initials(displayName);

  if (banner) {
    banner.textContent =
      'Môi trường phát triển cục bộ (127.0.0.1) — dữ liệu lưu trên máy chủ Node, không công khai Internet. Không gửi Zalo thật.';
  }

  renderNav();
  setupHeaderCreate();
}

function className(classId) {
  return state.data.classes.find((c) => c.id === classId)?.name || '—';
}

function previewStudent() {
  return state.data.students.find((s) => s.id === state.previewStudentId) || null;
}

function baMemberships() {
  return state.data.memberships || null;
}

function studentsInClass(classId) {
  return getStudentsInClass(state.data.students, classId, baMemberships());
}

function setupHeaderCreate() {
  const btn = document.getElementById('header-create');
  if (!isTeacher()) {
    btn.hidden = true;
    btn.onclick = null;
    return;
  }
  btn.hidden = true;
  const v = state.route.view;
  if (v === 'classes' || v === 'class-detail') {
    btn.hidden = false;
    btn.textContent = 'Tạo lớp';
    btn.onclick = () => openClassDialog();
  } else if (v === 'assignments') {
    btn.hidden = false;
    btn.textContent = 'Tạo bài tập';
    btn.onclick = () => openAssignmentDialog();
  } else {
    btn.hidden = true;
    btn.onclick = null;
  }
}

function filteredClasses() {
  if (state.classFilterId) {
    return state.data.classes.filter((c) => c.id === state.classFilterId);
  }
  return state.data.classes;
}

function classFilterSelect() {
  const wrap = el('div', { className: 'filter-bar' });
  wrap.appendChild(el('label', { className: 'visually-hidden', htmlFor: 'class-filter' }, 'Lọc lớp'));
  const sel = el('select', { id: 'class-filter' });
  sel.appendChild(el('option', { value: '' }, 'Tất cả lớp'));
  for (const c of state.data.classes) {
    sel.appendChild(el('option', { value: c.id }, c.name));
  }
  sel.value = state.classFilterId;
  sel.onchange = () => {
    state.classFilterId = sel.value;
    render();
  };
  wrap.appendChild(sel);
  return wrap;
}

function renderDashboard() {
  const root = document.getElementById('app-root');
  clear(root);
  if (!isTeacher()) {
    renderStudentDashboard(root);
    return;
  }
  root.appendChild(el('h1', { className: 'page-title' }, `Chào ${state.data.settings.teacherName} 👋`));
  root.appendChild(
    el('p', { className: 'subtitle' }, 'Tổng quan lớp IELTS/TOEIC — số liệu tính từ dữ liệu demo cục bộ.'),
  );
  root.appendChild(classFilterSelect());

  const metrics = computeDashboardMetrics({
    classes: filteredClasses(),
    students: state.data.students,
    assignments: state.data.assignments.filter(
      (a) => !state.classFilterId || a.classId === state.classFilterId,
    ),
    submissions: state.data.submissions,
    memberships: baMemberships(),
  });

  const grid = el('div', { className: 'metrics' });
  grid.appendChild(metric('Lớp đang dạy', metrics.classCount));
  grid.appendChild(metric('Chưa nộp bài', metrics.missingCount, 'pending'));
  const gradeMetric = metric('Cần chấm', metrics.toGradeCount);
  if (metrics.toGradeCount > 0) {
    gradeMetric.style.cursor = 'pointer';
    gradeMetric.title = 'Mở hàng đợi chấm bài';
    gradeMetric.addEventListener('click', () => navigate('#/grading'));
  }
  grid.appendChild(gradeMetric);
  grid.appendChild(metric('Đúng hạn %', metrics.onTimePct));
  root.appendChild(grid);

  const two = el('div', { className: 'grid-2' });
  two.appendChild(nextClassesCard());
  two.appendChild(homeworkDueCard());
  root.appendChild(two);
  root.appendChild(el('div', { style: 'height:1rem' }));
  root.appendChild(activityCard());
}

function renderStudentDashboard(root) {
  const st = previewStudent();
  root.appendChild(
    el('h1', { className: 'page-title' }, `Xin chào ${st?.name || 'bạn'} 👋`),
  );
  root.appendChild(
    el('p', { className: 'subtitle' }, 'Xem trước học sinh (demo cục bộ) — chỉ bài tập lớp của bạn.'),
  );
  if (!st) {
    root.appendChild(el('p', { className: 'empty-state' }, 'Chọn học sinh demo ở sidebar.'));
    return;
  }
  const assignments = getAssignmentsForStudent(state.data.assignments, st, null, state.data.memberships || null);
  root.appendChild(el('h2', { style: 'margin-top:1rem' }, 'Bài tập của lớp'));
  for (const a of assignments) {
    const sub = findSubmission(a.id, st.id);
    const q = gradingQueueState(sub, a);
    root.appendChild(
      el('div', { className: 'card', style: 'margin-bottom:0.75rem' },
        el('div', { className: 'list-row' },
          el('div', {},
            el('strong', {}, a.title),
            el('div', { style: 'font-size:0.85rem;color:var(--muted)' },
              `Hạn ${formatDateVi(a.dueDateISO)} · ${q.label}`),
          ),
          el('button', {
            type: 'button',
            className: 'btn btn-primary',
            onClick: () => navigate(`#/assignment/${a.id}`),
          }, 'Mở'),
        ),
      ),
    );
  }
  if (!assignments.length) {
    root.appendChild(el('p', { className: 'empty-state' }, 'Không có bài tập cho lớp này.'));
  }
}

function metric(label, value, extraClass = '') {
  return el('div', { className: `metric-card ${extraClass}` },
    el('div', { className: 'value' }, String(value)),
    el('div', { className: 'label' }, label),
  );
}

function nextClassesCard() {
  const card = el('div', { className: 'card' });
  card.appendChild(el('h2', {}, 'Buổi học sắp tới'));
  for (const c of filteredClasses()) {
    card.appendChild(
      el('div', { className: 'list-row' },
        el('div', {}, el('strong', {}, c.name), el('div', { style: 'font-size:0.85rem;color:var(--muted)' },
          `${c.scheduleDays.join(', ')} · ${c.scheduleTime}`)),
        el('span', { className: 'badge badge-green' }, `${studentsInClass(c.id).length} học sinh`),
      ),
    );
  }
  return card;
}

function homeworkDueCard() {
  const card = el('div', { className: 'card' });
  card.appendChild(el('h2', {}, 'Bài tập sắp đến hạn'));
  const list = [...state.data.assignments]
    .filter((a) => !state.classFilterId || a.classId === state.classFilterId)
    .sort((a, b) => a.dueDateISO.localeCompare(b.dueDateISO))
    .slice(0, 6);
  for (const a of list) {
    const timing = classifyDeadlineTiming(null, a.dueDateISO);
    card.appendChild(
      el('div', { className: 'list-row' },
        el('div', {},
          el('strong', {}, a.title),
          el('div', { style: 'font-size:0.85rem;color:var(--muted)' }, className(a.classId)),
        ),
        el('span', { className: 'badge badge-amber' }, formatDateVi(a.dueDateISO)),
      ),
    );
  }
  return card;
}

function activityCard() {
  const card = el('div', { className: 'card' });
  const title =
    state.classFilterId
      ? `Hoạt động nộp bài (${className(state.classFilterId)})`
      : 'Hoạt động nộp bài (tất cả lớp)';
  card.appendChild(el('h2', {}, title));
  const events = [];
  for (const sub of state.data.submissions) {
    const asg = state.data.assignments.find((a) => a.id === sub.assignmentId);
    if (state.classFilterId && asg?.classId !== state.classFilterId) continue;
    for (const v of sub.versions) {
      if (v.submittedAt && !v.isDraft) {
        events.push({
          at: v.submittedAt,
          studentId: sub.studentId,
          assignmentId: sub.assignmentId,
        });
      }
    }
  }
  events.sort((a, b) => b.at.localeCompare(a.at));
  for (const ev of events.slice(0, 8)) {
    const st = state.data.students.find((s) => s.id === ev.studentId);
    const asg = state.data.assignments.find((a) => a.id === ev.assignmentId);
    card.appendChild(
      el('div', { className: 'list-row' },
        el('div', {},
          el('strong', {}, st?.name || '—'),
          el('div', { style: 'font-size:0.85rem;color:var(--muted)' }, asg?.title || '—'),
        ),
        el('span', { className: 'badge badge-gray' }, formatDateTimeVi(ev.at)),
      ),
    );
  }
  if (!events.length) {
    card.appendChild(el('p', { className: 'empty-state' }, 'Chưa có lượt nộp.'));
  }
  return card;
}

function renderClasses() {
  if (!isTeacher()) {
    navigate('#/assignments');
    return;
  }
  const root = document.getElementById('app-root');
  clear(root);
  root.appendChild(el('h1', { className: 'page-title' }, 'Lớp học'));
  root.appendChild(classFilterSelect());
  const grid = el('div', { className: 'class-grid' });
  for (const c of filteredClasses()) {
    const card = el('article', {
      className: 'card class-card',
      tabindex: '0',
      role: 'button',
      onClick: () => navigate(`#/classes/${c.id}`),
      onKeydown: (e) => {
        if (e.key === 'Enter') navigate(`#/classes/${c.id}`);
      },
    },
    el('h3', {}, c.name),
    el('p', { style: 'font-size:0.9rem;color:var(--muted)' },
      `${c.scheduleDays.join(', ')} · ${c.scheduleTime}`),
    el('p', {}, `${studentsInClass(c.id).length} học sinh`),
    );
    grid.appendChild(card);
  }
  root.appendChild(grid);
  root.appendChild(el('div', { style: 'margin-top:1rem' },
    el('button', { type: 'button', className: 'btn btn-secondary', onClick: () => openStudentDialog() }, 'Thêm học sinh'),
    el('button', { type: 'button', className: 'btn btn-ghost', style: 'margin-left:0.5rem', onClick: () => openBackupDialog() }, 'Sao lưu / Nhập'),
  ));
}

function renderClassDetail(classId) {
  if (!isTeacher()) {
    navigate('#/assignments');
    return;
  }
  const c = state.data.classes.find((x) => x.id === classId);
  const root = document.getElementById('app-root');
  clear(root);
  if (!c) {
    root.appendChild(el('p', {}, 'Không tìm thấy lớp.'));
    return;
  }
  root.appendChild(el('button', { type: 'button', className: 'btn btn-ghost', onClick: () => navigate('#/classes') }, '← Quay lại'));
  root.appendChild(el('h1', { className: 'page-title' }, c.name));
  root.appendChild(el('button', {
    type: 'button',
    className: 'btn btn-secondary',
    style: 'margin-bottom:1rem',
    onClick: () => navigate(`#/tutor/schedule/${classId}`),
  }, 'Lịch gia sư & điểm danh'));
  const learners = studentsInClass(c.id);
  const card1 = el('div', { className: 'card' });
  card1.appendChild(el('h2', {}, 'Học sinh'));
  for (const st of learners) {
    card1.appendChild(el('div', { className: 'list-row' }, el('span', {}, st.name)));
  }
  root.appendChild(card1);
  const card2 = el('div', { className: 'card', style: 'margin-top:1rem' });
  card2.appendChild(el('h2', {}, 'Bài tập của lớp'));
  for (const a of state.data.assignments.filter((a) => a.classId === c.id)) {
    card2.appendChild(
      el('div', { className: 'list-row' },
        el('div', {}, el('strong', {}, a.title), el('div', { style: 'font-size:0.85rem;color:var(--muted)' },
          `Hạn ${formatDateVi(a.dueDateISO)} · ${a.requiredPageCount} trang`)),
        el('button', { type: 'button', className: 'btn btn-ghost', onClick: () => navigate(`#/assignment/${a.id}`) }, 'Mở'),
      ),
    );
  }
  root.appendChild(card2);
}

function visibleAssignments() {
  if (state.role === 'student') {
    const st = previewStudent();
    return getAssignmentsForStudent(state.data.assignments, st, state.classFilterId || null, state.data.memberships || null);
  }
  return state.data.assignments.filter((a) => !state.classFilterId || a.classId === state.classFilterId);
}

function renderAssignments() {
  const root = document.getElementById('app-root');
  clear(root);
  root.appendChild(el('h1', { className: 'page-title' }, 'Bài tập'));
  if (state.role === 'teacher') root.appendChild(classFilterSelect());
  for (const a of visibleAssignments()) {
    root.appendChild(
      el('div', { className: 'card', style: 'margin-bottom:0.75rem' },
        el('div', { className: 'list-row' },
          el('div', {},
            el('strong', {}, a.title),
            el('div', { style: 'font-size:0.85rem;color:var(--muted)' },
              `${className(a.classId)} · Hạn ${formatDateVi(a.dueDateISO)}`),
          ),
          el('button', {
            type: 'button',
            className: 'btn btn-primary',
            onClick: () => navigate(`#/assignment/${a.id}`),
          }, 'Chi tiết'),
        ),
      ),
    );
  }
}

function findSubmission(assignmentId, studentId) {
  return state.data.submissions.find(
    (s) => s.assignmentId === assignmentId && s.studentId === studentId,
  );
}

function assignmentDetailSubtitle(a) {
  const bits = [className(a.classId)];
  if (a.bookRef?.trim()) bits.push(a.bookRef.trim());
  else if (a.attachments?.length) bits.push(`${a.attachments.length} tệp đính kèm`);
  return bits.join(' · ');
}

function attachmentKindLabel(mime) {
  if (mime?.startsWith('image/')) return 'Ảnh';
  if (mime === 'application/pdf') return 'PDF';
  if (mime?.includes('word') || mime === 'application/msword') return 'Word';
  return 'Tệp';
}

function buildAttachmentListItem(att, { removable, onRemove } = {}) {
  const row = el('div', { className: 'attachment-row' });
  row.appendChild(
    el('span', { className: 'attachment-icon', title: attachmentKindLabel(att.mime), 'aria-hidden': 'true' },
      att.mime?.startsWith('image/') ? '▣' : (att.mime === 'application/pdf' ? '▤' : '▥')),
  );
  const info = el('div', { className: 'attachment-info' },
    el('span', { className: 'attachment-name' }, att.filename || 'Tệp'),
    el('span', { className: 'attachment-meta' }, `${attachmentKindLabel(att.mime)} · ${formatAttachmentSize(att.size)}`),
  );
  row.appendChild(info);
  const actions = el('div', { className: 'attachment-actions' });
  if (att.mime?.startsWith('image/')) {
    actions.appendChild(el('button', {
      type: 'button',
      className: 'btn btn-ghost btn-sm attachment-link',
      onClick: () => openAttachmentImageViewer({
        url: attachmentUrl(att.id),
        filename: att.filename,
        mkEl: el,
      }),
    }, 'Xem ảnh'));
  } else if (att.mime === 'application/pdf') {
    actions.appendChild(el('a', {
      className: 'btn btn-ghost btn-sm attachment-link',
      href: attachmentUrl(att.id),
      target: '_blank',
      rel: 'noopener noreferrer',
    }, 'Mở PDF'));
  } else {
    actions.appendChild(el('a', {
      className: 'btn btn-ghost btn-sm attachment-link',
      href: attachmentUrl(att.id),
      download: att.filename || 'file',
    }, 'Tải Word'));
  }
  if (removable && onRemove) {
    actions.appendChild(el('button', {
      type: 'button',
      className: 'btn btn-ghost btn-sm',
      onClick: () => onRemove(att.id),
    }, 'Gỡ'));
  }
  row.appendChild(actions);
  return row;
}

function appendAssignmentAttachmentsBlock(parent, assignment, opts = {}) {
  const items = opts.items || assignment.attachments || [];
  if (!items.length && !opts.alwaysShow) return;
  const card = el('div', { className: 'card attachment-card' });
  card.appendChild(el('h2', {}, 'Tệp đính kèm'));
  if (!items.length) {
    card.appendChild(el('p', { className: 'form-hint' }, 'Chưa có tệp đính kèm.'));
  } else {
    const list = el('div', { className: 'attachment-list' });
    for (const att of items) list.appendChild(buildAttachmentListItem(att, opts));
    card.appendChild(list);
    for (const att of items.filter((x) => x.mime?.startsWith('image/'))) {
      const prev = el('div', { className: 'attachment-preview' });
      const thumb = el('img', {
        src: attachmentUrl(att.id),
        alt: att.filename || 'Ảnh đính kèm',
        loading: 'lazy',
        className: 'attachment-preview-thumb',
        tabIndex: 0,
        role: 'button',
      });
      const openPreview = () => openAttachmentImageViewer({
        url: attachmentUrl(att.id),
        filename: att.filename,
        mkEl: el,
      });
      thumb.addEventListener('click', openPreview);
      thumb.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          openPreview();
        }
      });
      prev.appendChild(thumb);
      card.appendChild(prev);
    }
  }
  parent.appendChild(card);
}

function renderAssignmentDetail(assignmentId) {
  const a = state.data.assignments.find((x) => x.id === assignmentId);
  const root = document.getElementById('app-root');
  clear(root);
  if (!a) {
    root.appendChild(el('p', {}, 'Không tìm thấy bài tập.'));
    return;
  }

  root.appendChild(el('h1', { className: 'page-title' }, a.title));
  root.appendChild(el('p', { className: 'subtitle' }, assignmentDetailSubtitle(a)));
  if (a.instructions?.trim()) {
    root.appendChild(el('p', { className: 'assignment-instructions' }, a.instructions));
  } else if (a.attachments?.length) {
    root.appendChild(el('p', { className: 'assignment-instructions form-hint' },
      'Làm bài theo tệp đính kèm, sau đó nộp ảnh chụp trang bài làm như bình thường.'));
  }
  root.appendChild(el('p', {}, `Hạn nộp: ${formatDateVi(a.dueDateISO)} · Yêu cầu ${a.requiredPageCount} trang ảnh nộp bài`));
  appendAssignmentAttachmentsBlock(root, a);

  if (state.role === 'teacher') {
    root.appendChild(
      el('div', { style: 'margin:1rem 0;display:flex;gap:0.5rem;flex-wrap:wrap' },
        el('button', { type: 'button', className: 'btn btn-secondary', onClick: () => openAssignmentDialog(a) }, 'Sửa bài tập'),
        el('button', { type: 'button', className: 'btn btn-secondary', onClick: () => openShareDialog(a) }, 'Chia sẻ / Zalo demo'),
        el('button', { type: 'button', className: 'btn btn-ghost', onClick: () => navigate('#/grading') }, 'Vào hàng chấm'),
      ),
    );
    const card = el('div', { className: 'card' });
    card.appendChild(el('h2', {}, 'Trạng thái lớp'));
    for (const st of studentsInClass(a.classId)) {
      const sub = findSubmission(a.id, st.id);
      const q = gradingQueueState(sub, a);
      card.appendChild(
        el('div', { className: 'list-row' },
          el('span', {}, st.name),
          el('span', { className: 'badge badge-amber' }, q.label),
        ),
      );
    }
    root.appendChild(card);
    return;
  }

  const st = previewStudent();
  if (!st || !studentCanAccessAssignmentClassClient(st, a.classId, baMemberships())) {
    root.appendChild(el('p', { className: 'empty-state' }, 'Bài tập không thuộc lớp của bạn (demo).'));
    return;
  }
  renderStudentSubmissionUI(root, a, st);
}

async function renderPublishedPages(root, version, published) {
  const card = el('div', { className: 'card', style: 'margin-bottom:1rem' });
  card.appendChild(el('h2', {}, 'Bài đã chấm (chỉ xem)'));
  for (let i = 0; i < version.pageImageIds.length; i++) {
    const pageGrading = published?.pages?.[i];
    const pageBlock = el('div', { className: 'graded-page-block' });
    const wrap = el('div', { className: 'editor-wrap' });
    const stage = el('div', { className: 'editor-stage' });
    const viewport = el('div', { className: 'editor-viewport' });
    const img = el('img', { alt: `Trang ${i + 1} đã chấm` });
    const url = await getImageBlob(version.pageImageIds[i]);
    if (url) img.src = url;
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'annotation-layer');
    viewport.appendChild(img);
    viewport.appendChild(svg);
    stage.appendChild(viewport);
    wrap.appendChild(stage);
    pageBlock.appendChild(wrap);
    const commentList = el('div', { className: 'page-comment-list', hidden: true });
    pageBlock.appendChild(commentList);
    card.appendChild(pageBlock);
    const annotations = pageGrading?.annotations || [];
    img.onload = () => {
      const paint = () => {
        applyEditorStageLayout({ stage, viewport, scrollWrap: wrap, img, zoom: 1 });
        const { w, h } = measureDisplayedImage(img, 1);
        svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
        svg.style.width = `${w}px`;
        svg.style.height = `${h}px`;
        fillAnnotationSvg(svg, annotations, w, h, {
          textLayoutOptions: defaultTextLayoutOptions(),
        });
        mountPageCommentList(commentList, annotations);
      };
      paint();
      if (typeof ResizeObserver !== 'undefined') {
        const ro = new ResizeObserver(() => paint());
        ro.observe(img);
        ro.observe(wrap);
      }
    };
  }
  root.appendChild(card);
}

async function renderStudentSubmissionUI(root, assignment, student) {
  const viewGeneration = ++studentSubmissionViewGeneration;
  studentSubmissionViewLive = { assignmentId: assignment.id, viewGeneration };
  const photoEditHost = el('div', { className: 'student-photo-edit-host' });

  function submissionUiLive() {
    return {
      liveView: studentSubmissionViewLive,
      isStaleEpoch,
      getAuthPrincipal: captureAuthPrincipal,
      viewHostEl: photoEditHost,
    };
  }

  function captureSubmissionUiScopeAtCall() {
    return captureStudentSubmissionUiScope({
      assignmentId: assignment.id,
      viewGeneration,
      getRequestEpoch,
      getAuthPrincipal: captureAuthPrincipal,
    });
  }

  function shouldApplySubmissionUi(scope) {
    return shouldApplyStudentSubmissionUiWork(scope, submissionUiLive());
  }

  let sub = findSubmission(assignment.id, student.id);
  if (!sub) {
    sub = {
      id: uid(),
      assignmentId: assignment.id,
      studentId: student.id,
      firstSubmittedAt: null,
      versions: [],
      feedbackOpenedAt: null,
    };
    state.data.submissions.push(sub);
  }

  let draftPages = [];
  const submitted = submittedVersions(sub);
  const latestSubmitted = submitted[submitted.length - 1];
  const currentVersion = sub.versions[sub.versions.length - 1];
  if (currentVersion?.isDraft) {
    draftPages = [...currentVersion.pageImageIds];
  }

  const draftAck = createStudentPhotoDraftAckState(draftPages);
  let studentPhotoDraftGuardLive = false;
  const pendingPhotoJobs = new Set();
  let draftActionBusy = false;
  const studentPhotoContentFingerprints = new Set();
  const studentPhotoFingerprintByPageId = new Map();
  const studentPhotoFingerprintCache = new Map();

  async function fingerprintStoredPageImage(imageId) {
    if (studentPhotoFingerprintCache.has(imageId)) {
      return studentPhotoFingerprintCache.get(imageId);
    }
    const url = await getImageBlob(imageId);
    const resp = await fetch(url);
    const blob = await resp.blob();
    const fp = await blobContentFingerprint(blob);
    studentPhotoFingerprintCache.set(imageId, fp);
    return fp;
  }

  async function reserveFingerprintsForExistingDraftPages() {
    for (const imageId of draftPages) {
      if (studentPhotoFingerprintByPageId.has(imageId)) {
        studentPhotoContentFingerprints.add(studentPhotoFingerprintByPageId.get(imageId));
        continue;
      }
      try {
        const fp = await fingerprintStoredPageImage(imageId);
        studentPhotoFingerprintByPageId.set(imageId, fp);
        studentPhotoContentFingerprints.add(fp);
      } catch {
        /* legacy / missing blob — skip reservation */
      }
    }
  }

  let baselineFingerprintPrepPending = draftPages.length > 0;
  let baselineFingerprintPrepTask;

  function studentPhotoDraftPagesDirty() {
    return draftAck.isPagesDirty(draftPages);
  }

  function isStudentPhotoDraftDirty() {
    if (!studentPhotoDraftGuardLive) return false;
    if (pendingPhotoJobs.size > 0) return true;
    return studentPhotoDraftPagesDirty();
  }

  function armStudentPhotoDraftGuard() {
    if (studentPhotoDraftGuardLive) {
      bumpDirtyNavigationGuard();
      return;
    }
    studentPhotoDraftGuardLive = true;
    registerDirtyProbe(isStudentPhotoDraftDirty);
    bumpDirtyNavigationGuard();
  }

  function disarmStudentPhotoDraftGuard() {
    if (!studentPhotoDraftGuardLive) return;
    studentPhotoDraftGuardLive = false;
    registerDirtyProbe(null);
  }

  function syncStudentPhotoDraftGuardAfterAck() {
    if (!pendingPhotoJobs.size) {
      if (!studentPhotoDraftPagesDirty()) disarmStudentPhotoDraftGuard();
      else bumpDirtyNavigationGuard();
    } else bumpDirtyNavigationGuard();
  }

  let viewVersion = latestSubmitted || currentVersion;
  let submittedVersionSel = null;
  if (submitted.length > 1) {
    const stored = state.studentViewVersionIds[assignment.id];
    viewVersion = submitted.find((v) => v.versionId === stored) || latestSubmitted;
    submittedVersionSel = el('select', { 'aria-label': 'Phiên bản đã nộp' });
    const verSel = submittedVersionSel;
    for (const v of submitted) {
      verSel.appendChild(
        el('option', { value: v.versionId },
          `Lần ${v.versionNumber} · ${formatDateTimeVi(v.submittedAt)}`),
      );
    }
    verSel.value = viewVersion?.versionId || '';
    verSel.onchange = () => {
      if (isPhotoMutationBlocked()) {
        verSel.value = viewVersion?.versionId || '';
        return;
      }
      if (isStudentPhotoDraftDirty() && !confirmDiscard()) {
        verSel.value = viewVersion?.versionId || '';
        return;
      }
      state.studentViewVersionIds[assignment.id] = verSel.value;
      render();
    };
    root.appendChild(
      el('div', { className: 'filter-bar', style: 'margin-bottom:0.75rem' },
        el('label', { htmlFor: 'student-version-sel', className: 'visually-hidden' }, 'Phiên bản'),
        verSel,
      ),
    );
    verSel.id = 'student-version-sel';
  }

  const mayEdit = canStudentSubmitNewVersion(sub, 'student') || currentVersion?.isDraft;

  const published =
    viewVersion && !viewVersion.isDraft
      ? resolveStudentPublishedGrading(viewVersion.grading)
      : null;

  if (published) {
    const statusLabel =
      viewVersion.status === SUBMISSION_STATUS.NEEDS_REVISION
        ? 'Cần làm lại'
        : viewVersion.status === SUBMISSION_STATUS.RETURNED
          ? 'Đã trả bài'
          : 'Đã chấm';
    const timing = classifyDeadlineTiming(sub.firstSubmittedAt, assignment.dueDateISO);
    const lateNote =
      timing.late && sub.firstSubmittedAt
        ? ` (trễ ${daysLate(sub.firstSubmittedAt, assignment.dueDateISO)} ngày so với hạn ${formatDateVi(assignment.dueDateISO)})`
        : timing.onTime && sub.firstSubmittedAt
          ? ' (đúng hạn)'
          : '';
    root.appendChild(
      el('div', { className: 'card', style: 'margin-bottom:1rem' },
        el('h2', {}, 'Phản hồi của cô'),
        el('p', {}, `Trạng thái: ${statusLabel}${lateNote}`),
        el('p', {}, `Nộp lần đầu: ${formatDateTimeVi(sub.firstSubmittedAt)}`),
        el('p', {}, `Điểm: ${published.score}/10`),
        el('p', {}, published.overallFeedback || ''),
        el('button', {
          type: 'button',
          className: 'btn btn-ghost',
          onClick: async () => {
            const ok = await persistWithStatus(() => studentMarkFeedbackViewed(sub.id), {
              logicalKey: `submission-feedback-viewed:${sub.id}`,
              replayPayloadSignature: replayPayloadSignature({ submissionId: sub.id }),
            });
            if (ok) render();
          },
        }, sub.feedbackOpenedAt ? 'Đã mở phản hồi' : 'Đánh dấu đã xem phản hồi'),
      ),
    );
    await renderPublishedPages(root, viewVersion, published);
  }

  if (!mayEdit && !published) {
    root.appendChild(el('p', { className: 'empty-state' }, 'Bài đang chờ cô chấm.'));
    return;
  }

  if (!mayEdit && published) {
    root.appendChild(
      el('p', { className: 'subtitle' }, 'Chờ cô yêu cầu làm lại để nộp phiên bản mới.'),
    );
    return;
  }

  const uploadSection = el('div', { className: 'card' });
  uploadSection.appendChild(el('h2', {}, 'Nộp bài (ảnh sách)'));
  const errBox = el('div', { className: 'form-error', role: 'alert' });
  uploadSection.appendChild(errBox);
  const thumbGrid = el('div', { className: 'page-thumb-grid' });
  uploadSection.appendChild(thumbGrid);

  async function refreshThumbs() {
    clear(thumbGrid);
    const thumbScope = captureSubmissionUiScopeAtCall();
    const block = isPhotoMutationBlocked();
    for (let i = 0; i < draftPages.length; i++) {
      const imgId = draftPages[i];
      const url = await getImageBlob(imgId);
      if (!shouldApplySubmissionUi(thumbScope)) return;
      const thumb = el('div', { className: 'page-thumb' });
      if (url) thumb.appendChild(el('img', { src: url, alt: `Trang ${i + 1}` }));
      const actions = el('div', { className: 'page-thumb-actions' });
      actions.appendChild(el('button', {
        type: 'button',
        disabled: block,
        onClick: () => {
          guardStudentPhotoMutation(
            isPhotoMutationBlocked(),
            () => movePage(i, -1),
          );
        },
      }, '←'));
      actions.appendChild(el('button', {
        type: 'button',
        disabled: block,
        onClick: () => {
          guardStudentPhotoMutation(
            isPhotoMutationBlocked(),
            () => movePage(i, 1),
          );
        },
      }, '→'));
      actions.appendChild(el('button', {
        type: 'button',
        disabled: block,
        onClick: () => {
          guardStudentPhotoMutation(
            isPhotoMutationBlocked(),
            () => removePage(i),
          );
        },
      }, 'Xóa'));
      thumb.appendChild(actions);
      thumbGrid.appendChild(thumb);
    }
  }

  function movePage(idx, dir) {
    if (isPhotoMutationBlocked()) return;
    const ni = idx + dir;
    if (ni < 0 || ni >= draftPages.length) return;
    const t = draftPages[idx];
    draftPages[idx] = draftPages[ni];
    draftPages[ni] = t;
    armStudentPhotoDraftGuard();
    refreshThumbs();
  }

  function removePage(idx) {
    if (isPhotoMutationBlocked()) return;
    const [removedId] = draftPages.splice(idx, 1);
    const fp = studentPhotoFingerprintByPageId.get(removedId);
    if (fp && !draftPages.includes(removedId)) {
      studentPhotoContentFingerprints.delete(fp);
      studentPhotoFingerprintByPageId.delete(removedId);
    }
    armStudentPhotoDraftGuard();
    refreshThumbs();
  }

  const fileInput = el('input', {
    type: 'file',
    accept: 'image/jpeg,image/png,image/webp',
    multiple: true,
    className: 'visually-hidden',
    id: 'student-upload',
  });
  let saveDraftBtn;
  let submitBtn;
  let uploadPhotoLabel;

  function isPhotoMutationBlocked() {
    return isStudentPhotoMutationBlocked(
      draftActionBusy,
      pendingPhotoJobs.size,
      baselineFingerprintPrepPending,
    );
  }

  function syncStudentPhotoUi() {
    const block = isPhotoMutationBlocked();
    if (saveDraftBtn) saveDraftBtn.disabled = block;
    if (submitBtn) submitBtn.disabled = block;
    if (fileInput) fileInput.disabled = block;
    if (uploadPhotoLabel) {
      uploadPhotoLabel.classList.toggle('is-disabled', block);
      uploadPhotoLabel.setAttribute('aria-disabled', block ? 'true' : 'false');
      if (block) uploadPhotoLabel.removeAttribute('for');
      else uploadPhotoLabel.setAttribute('for', 'student-upload');
    }
    if (submittedVersionSel) submittedVersionSel.disabled = block;
    for (const btn of thumbGrid.querySelectorAll('.page-thumb-actions button')) {
      btn.disabled = block;
    }
  }

  baselineFingerprintPrepTask = (async () => {
    try {
      await reserveFingerprintsForExistingDraftPages();
    } finally {
      baselineFingerprintPrepPending = false;
      syncStudentPhotoUi();
    }
  })();

  fileInput.addEventListener('change', async () => {
    if (isPhotoMutationBlocked()) {
      fileInput.value = '';
      return;
    }
    await baselineFingerprintPrepTask;
    errBox.textContent = '';
    const files = [...fileInput.files];
    if (draftPages.length + files.length > IMAGE_LIMITS.maxFiles) {
      errBox.textContent = `Tối đa ${IMAGE_LIMITS.maxFiles} ảnh.`;
      return;
    }
    if (files.length) armStudentPhotoDraftGuard();
    const photoInitiatingContext = captureStudentPhotoInitiatingContext({
      getRequestEpoch,
      getAuthPrincipal: captureAuthPrincipal,
      assignmentId: assignment.id,
      viewGeneration,
      isViewLive: () => photoEditHost.isConnected,
    });
    const photoContextStale = (ctx) => isStudentPhotoInitiatingContextStale(ctx, {
      isStaleEpoch,
      getAuthPrincipal: captureAuthPrincipal,
      liveView: studentSubmissionViewLive,
    });
    const batch = buildStudentPhotoUploadJobs(files, {
      initiatingContext: photoInitiatingContext,
      isInitiatingContextStale: photoContextStale,
      validateFile: validateImageFile,
      reservedFingerprints: studentPhotoContentFingerprints,
      onDuplicateFile: (file) => {
        errBox.textContent = `Ảnh "${file.name}" trùng nội dung với ảnh đã có trong bài nộp.`;
      },
      prepareFile: async (file) => {
        const blob = await compressImage(file);
        return {
          blob,
          fingerprint: await blobContentFingerprint(blob),
        };
      },
      uploadPrepared: async (prepared, _file, ctx) => {
        if (photoContextStale(ctx)) throw staleStudentPhotoAuthError();
        const id = await storeImageBlob(prepared.blob, 'image/jpeg', ctx.epoch, ctx.principal);
        if (photoContextStale(ctx)) throw staleStudentPhotoAuthError();
        if (prepared.fingerprint) {
          studentPhotoFingerprintByPageId.set(id, prepared.fingerprint);
        }
        return id;
      },
      onFileError: (msg) => {
        errBox.textContent = msg;
      },
    });
    for (const job of batch.jobs) pendingPhotoJobs.add(job);
    syncStudentPhotoUi();
    bumpDirtyNavigationGuard();
    fileInput.value = '';
    try {
      await batch.applyResultsTo(draftPages);
    } finally {
      for (const job of batch.jobs) pendingPhotoJobs.delete(job);
      syncStudentPhotoUi();
      bumpDirtyNavigationGuard();
      await refreshThumbs();
    }
  });

  uploadSection.appendChild(fileInput);
  uploadSection.appendChild(
    uploadPhotoLabel = el('label', { className: 'btn btn-secondary', htmlFor: 'student-upload' }, 'Thêm ảnh (JPEG/PNG/WebP)'),
  );

  async function saveDraft() {
    if (draftActionBusy) return;
    draftActionBusy = true;
    syncStudentPhotoUi();
    const uiScope = captureSubmissionUiScopeAtCall();
    /** @type {{ sequence: number, pageIds: string[] } | null} */
    let draftPersistCaptureToken = null;
    const acknowledgeDraftSaveSuccess = () => {
      if (!shouldApplySubmissionUi(uiScope)) return;
      if (draftPersistCaptureToken) {
        draftAck.markAcknowledgedFromCapture(draftPersistCaptureToken);
      }
      syncStudentPhotoDraftGuardAfterAck();
      render();
    };
    try {
      await runStudentPhotoDraftPersist(
        draftPages,
        () => waitForInFlightUploads(pendingPhotoJobs),
        async (pages) => {
          if (!shouldApplySubmissionUi(uiScope)) return false;
          draftPersistCaptureToken = draftAck.captureForPersist(pages);
          return persistWithStatus(() => studentSaveDraft(assignment.id, pages), {
            silent: true,
            logicalKey: `student-draft:${assignment.id}`,
            replayPayloadSignature: replayPayloadSignature({ assignmentId: assignment.id, pageImageIds: pages }),
            onPersistSuccess: acknowledgeDraftSaveSuccess,
          });
        },
      );
      if (!shouldApplySubmissionUi(uiScope)) return;
    } finally {
      if (shouldApplySubmissionUi(uiScope)) {
        draftActionBusy = false;
        syncStudentPhotoUi();
      }
    }
  }

  async function submitFinal() {
    if (draftActionBusy) return;
    const missing = checkMissingPages(assignment.requiredPageCount, draftPages.length);
    if (!missing.ok) {
      errBox.textContent = missing.message;
      return;
    }
    if (!canStudentSubmitNewVersion(sub, 'student') && sub.versions.some((v) => !v.isDraft)) {
      errBox.textContent = 'Chờ cô yêu cầu làm lại trước khi nộp bản mới.';
      return;
    }
    draftActionBusy = true;
    syncStudentPhotoUi();
    const uiScope = captureSubmissionUiScopeAtCall();
    /** @type {{ sequence: number, pageIds: string[] } | null} */
    let submitPersistCaptureToken = null;
    const acknowledgeSubmitSuccess = () => {
      if (!shouldApplySubmissionUi(uiScope)) return;
      if (submitPersistCaptureToken) {
        draftAck.markAcknowledgedFromCapture(submitPersistCaptureToken);
      }
      syncStudentPhotoDraftGuardAfterAck();
      render();
    };
    try {
      await runStudentPhotoDraftPersist(
        draftPages,
        () => waitForInFlightUploads(pendingPhotoJobs),
        async (pages) => {
          if (!shouldApplySubmissionUi(uiScope)) return false;
          submitPersistCaptureToken = draftAck.captureForPersist(pages);
          const hasPrior = sub.versions.some((v) => !v.isDraft);
          const submitReplayKey = hasPrior
            ? `student-revision:${assignment.id}`
            : `student-submit:${assignment.id}`;
          return persistWithStatus(async () => {
            const op = getActivePersistOperationId();
            if (hasPrior) await studentSubmitRevision(assignment.id, pages, op);
            else await studentSubmitWork(assignment.id, pages, op);
          }, {
            successToast: 'Đã nộp bài thành công.',
            logicalKey: submitReplayKey,
            replayPayloadSignature: replayPayloadSignature({
              assignmentId: assignment.id,
              pageImageIds: pages,
            }),
            onPersistSuccess: acknowledgeSubmitSuccess,
          });
        },
      );
      if (!shouldApplySubmissionUi(uiScope)) return;
    } finally {
      if (shouldApplySubmissionUi(uiScope)) {
        draftActionBusy = false;
        syncStudentPhotoUi();
      }
    }
  }

  uploadSection.appendChild(
    el('div', { style: 'margin-top:1rem;display:flex;gap:0.5rem;flex-wrap:wrap' },
      saveDraftBtn = el('button', { type: 'button', className: 'btn btn-ghost', onClick: saveDraft }, 'Lưu nháp'),
      submitBtn = el('button', { type: 'button', className: 'btn btn-primary', onClick: submitFinal }, 'Nộp bài'),
    ),
  );

  photoEditHost.appendChild(uploadSection);
  root.appendChild(photoEditHost);
  await refreshThumbs();
  syncStudentPhotoUi();
}

function renderGrading() {
  if (!isTeacher()) {
    navigate('#/assignments');
    return;
  }
  const root = document.getElementById('app-root');
  clear(root);
  root.appendChild(el('h1', { className: 'page-title' }, 'Chấm bài'));
  root.appendChild(classFilterSelect());

  const filterRow = el('div', { className: 'filter-bar' });
  const asgSel = el('select', { id: 'grading-asg' });
  asgSel.appendChild(el('option', { value: '' }, 'Tất cả bài'));
  const assignments = state.data.assignments.filter(
    (a) => !state.classFilterId || a.classId === state.classFilterId,
  );
  for (const a of assignments) {
    asgSel.appendChild(el('option', { value: a.id }, a.title));
  }
  filterRow.appendChild(asgSel);
  const stateSel = el('select', { id: 'grading-state', 'aria-label': 'Lọc trạng thái' });
  stateSel.appendChild(el('option', { value: 'actionable' }, 'Cần xử lý (đã nộp)'));
  stateSel.appendChild(el('option', { value: '' }, 'Tất cả trạng thái'));
  stateSel.appendChild(el('option', { value: 'missing' }, 'Chưa nộp'));
  stateSel.appendChild(el('option', { value: 'submitted' }, 'Đã nộp / chờ chấm'));
  stateSel.appendChild(el('option', { value: 'late' }, 'Nộp trễ'));
  stateSel.appendChild(el('option', { value: 'needs-revision' }, 'Cần làm lại'));
  stateSel.appendChild(el('option', { value: 'returned' }, 'Đã trả bài'));
  filterRow.appendChild(stateSel);
  root.appendChild(filterRow);

  const card = el('div', { className: 'card' });
  card.appendChild(el('h2', {}, 'Hàng đợi'));

  function drawQueue(asgFilter, stateFilter) {
    clear(card);
    card.appendChild(el('h2', {}, 'Hàng đợi'));
    let count = 0;
    for (const a of assignments) {
      if (asgFilter && a.id !== asgFilter) continue;
      for (const st of studentsInClass(a.classId)) {
        const sub = findSubmission(a.id, st.id);
        const q = gradingQueueState(sub, a);
        if (!shouldIncludeInGradingQueue(q.state, stateFilter)) continue;
        count += 1;
        card.appendChild(
          el('div', { className: 'list-row' },
            el('div', {},
              el('strong', {}, st.name),
              el('div', { style: 'font-size:0.85rem;color:var(--muted)' }, a.title),
            ),
            el('div', { style: 'display:flex;gap:0.5rem;align-items:center' },
              el('span', { className: 'badge badge-amber' }, q.label),
              el('button', {
                type: 'button',
                className: 'btn btn-primary',
                onClick: () => navigate(`#/grading/${a.id}/${st.id}`),
              }, 'Chấm'),
            ),
          ),
        );
      }
    }
    if (!count) {
      card.appendChild(el('p', { className: 'empty-state' }, 'Không có mục trong hàng đợi với bộ lọc này.'));
    }
  }

  const refreshQueue = () => drawQueue(asgSel.value, stateSel.value);
  asgSel.onchange = refreshQueue;
  stateSel.onchange = refreshQueue;
  refreshQueue();
  root.appendChild(card);
}

function getTeacherGradingDraft(version) {
  const pageCount = version.pageImageIds?.length || 0;
  version.teacherGrading = normalizeTeacherGradingDraft(version.teacherGrading, pageCount);
  return version.teacherGrading;
}

function renderGradingEditor(assignmentId, studentId) {
  if (!isTeacher()) {
    navigate('#/assignments');
    return;
  }
  const a = state.data.assignments.find((x) => x.id === assignmentId);
  const st = state.data.students.find((x) => x.id === studentId);
  const root = document.getElementById('app-root');
  clear(root);
  if (!a || !st) {
    root.appendChild(el('p', {}, 'Không tìm thấy.'));
    return;
  }
  if (!studentCanAccessAssignmentClassClient(st, a.classId, baMemberships())) {
    root.appendChild(el('p', { className: 'empty-state' }, 'Học sinh không thuộc lớp của bài tập này.'));
    return;
  }
  const sub = findSubmission(a.id, st.id);
  if (!sub?.versions?.length) {
    root.appendChild(el('p', {}, 'Học sinh chưa nộp bài.'));
    return;
  }
  const submitted = submittedVersions(sub);
  if (!submitted.length) {
    root.appendChild(el('p', {}, 'Chưa có bản nộp chính thức.'));
    return;
  }
  const latestSubmitted = submitted[submitted.length - 1];
  let version =
    submitted.find((v) => v.versionId === state.gradingViewVersionId) || latestSubmitted;
  const readOnly = version.versionId !== latestSubmitted.versionId;
  state.gradingViewVersionId = version.versionId;

  let versionSel = null;
  let draftSaveBtn = null;
  let needsRevisionBtn = null;
  let returnPublishBtn = null;
  /** @type {ReturnType<typeof createGradingDirtyTracker>|null} */
  let gradingDirtyTracker = null;
  let syncGradingMutatingFreeze = () => {};
  const gradingMutating = createGradingMutatingCoordinator({
    onBusyChange: (busy) => {
      syncGradingMutatingButton(draftSaveBtn, 'Lưu nháp chấm', busy);
      syncGradingMutatingButton(needsRevisionBtn, 'Yêu cầu làm lại', busy);
      syncGradingMutatingButton(returnPublishBtn, 'Trả bài', busy);
      syncGradingMutatingFreeze(busy);
    },
  });

  function isGradingEditorLive(activeSession) {
    return state.gradingSession === activeSession && !gradingMutating.isDisposed();
  }

  function guardGradingExplicitAction(handler) {
    return (...args) => {
      if (gradingMutating.isBusy()) return;
      handler(...args);
    };
  }

  if (submitted.length > 1) {
    versionSel = el('select', { className: 'grading-version-select', 'aria-label': 'Phiên bản nộp' });
    for (const v of submitted) {
      const tag = v.grading?.published ? ' · đã trả' : '';
      versionSel.appendChild(
        el('option', { value: v.versionId },
          `Lần ${v.versionNumber} · ${formatDateTimeVi(v.submittedAt)}${tag}`),
      );
    }
    versionSel.value = version.versionId;
    versionSel.onchange = () => {
      if (gradingMutating.isBusy()) {
        versionSel.value = version.versionId;
        return;
      }
      if (blockIfPendingInlineEdit()) {
        versionSel.value = version.versionId;
        return;
      }
      if (
        gradingDirtyTracker &&
        gradingDirtyTracker.isDirty(gradingDirtyContext()) &&
        !confirmDiscard()
      ) {
        versionSel.value = version.versionId;
        return;
      }
      state.gradingViewVersionId = versionSel.value;
      render();
    };
  }

  const session = {
    assignment: a,
    student: st,
    submission: sub,
    version,
    readOnly,
    pageIndex: 0,
    tool: readOnly ? 'view' : 'select',
    mode: readOnly ? 'view' : 'annotate',
    lastAnnotateTool: 'select',
    zoom: 1,
    zoomFitMode: GRADING_ZOOM_FIT_PAGE,
    manualZoom: 1,
    focusMode: true,
    panelCollapsed: false,
    mobilePanelOpen: false,
    selectedMarkId: null,
    drag: null,
    inkColor: MARK_INK_COLORS[0].value,
    strokePreset: 'medium',
    textFontSize: DIRECT_TEXT_SIZES[1],
    penGesture: null,
    eraserGesture: null,
    inlineTextEditor: null,
    pageImageReady: false,
    imageLoadSeq: 0,
    closeTextDialog: null,
    gestureGeneration: 0,
    commentsDrawerOpen: false,
    panelFocusBeforeOpen: null,
  };
  state.gradingSession = session;
  function layoutZoomLevel() {
    return session.zoomFitMode === GRADING_ZOOM_MANUAL ? session.manualZoom : 1;
  }

  function gradingLayoutContainerSize() {
    const innerW = editorWrapInnerWidth(editorWrap);
    const innerH = editorStageInnerHeight(editorWrap, stageHost);
    return { innerW, innerH };
  }

  function currentDisplayedZoomPercent() {
    const { innerW, innerH } = gradingLayoutContainerSize();
    return computeGradingZoomPercent({
      naturalWidth: img.naturalWidth || 1,
      naturalHeight: img.naturalHeight || 1,
      containerInnerWidth: innerW,
      containerInnerHeight: innerH,
      fitMode: session.zoomFitMode,
      manualZoom: session.manualZoom,
    });
  }

  function ensureManualZoomFromDisplayedScale() {
    if (session.zoomFitMode === GRADING_ZOOM_MANUAL) return;
    const { innerW, innerH } = gradingLayoutContainerSize();
    session.manualZoom = seedGradingManualZoomFromFitMode({
      naturalWidth: img.naturalWidth || 1,
      naturalHeight: img.naturalHeight || 1,
      containerInnerWidth: innerW,
      containerInnerHeight: innerH,
      fitMode: session.zoomFitMode,
    });
    session.zoomFitMode = GRADING_ZOOM_MANUAL;
  }

  function blockIfPendingInlineEdit(targetEl = scoreErr) {
    if (!session.inlineTextEditor) return false;
    const msg = gradingPendingInlineEditMessage();
    if (targetEl) targetEl.textContent = msg;
    const hint = document.querySelector('.grading-workspace .grading-tool-hint');
    if (hint) hint.textContent = msg;
    return true;
  }

  function cancelTextDragGesture() {
    const drag = session.drag;
    if (!drag || (drag.type !== 'text-move' && drag.type !== 'text-resize')) return;
    session.gestureGeneration += 1;
    const pid = drag.pointerId;
    restoreCanceledTextGesture(drag);
    if (pid != null) {
      try {
        svg.releasePointerCapture(pid);
      } catch {
        /* ignore */
      }
    }
    session.drag = null;
    renderOverlay();
  }

  function cancelAllGradingGesturesOnLayoutRefit() {
    session.gestureGeneration += 1;
    cancelPenGesture();
    cancelEraserGesture(true);
    const drag = session.drag;
    if (drag?.type === 'highlight') {
      const pid = drag.pointerId;
      if (pid != null) {
        try {
          svg.releasePointerCapture(pid);
        } catch {
          /* ignore */
        }
      }
      session.drag = null;
    } else if (drag?.type === 'text-move' || drag?.type === 'text-resize') {
      restoreCanceledTextGesture(drag);
      const pid = drag.pointerId;
      if (pid != null) {
        try {
          svg.releasePointerCapture(pid);
        } catch {
          /* ignore */
        }
      }
      session.drag = null;
    }
    renderOverlay();
  }

  function cancelHighlightGesture() {
    if (session.drag?.type !== 'highlight') return;
    session.gestureGeneration += 1;
    const pid = session.drag.pointerId;
    if (pid != null) {
      try {
        svg.releasePointerCapture(pid);
      } catch {
        /* ignore */
      }
    }
    session.drag = null;
    renderOverlay();
  }
  const draft = readOnly
    ? {
        score: version.grading?.score ?? '',
        overallFeedback: version.grading?.overallFeedback ?? '',
        pages:
          version.grading?.pages ||
          (version.pageImageIds || []).map(() => ({ annotations: [] })),
        undoStacks: {},
      }
    : getTeacherGradingDraft(version);

  if (!readOnly) {
    gradingDirtyTracker = createGradingDirtyTracker({
      score: draft.score,
      overallFeedback: draft.overallFeedback,
      pages: draft.pages,
    });
  }

  function gradingDirtyContext() {
    return {
      getScore: () => scoreInput.value,
      getFeedback: () => feedbackInput.value,
      getDraft: () => draft,
      getSession: () => session,
      hasPendingSave: () => gradingMutating.isBusy(),
    };
  }

  function gradingWriteResourceKeyForVersion() {
    return gradingWriteResourceKey(sub.id, version.versionId);
  }

  function gradingDraftPersistOptions() {
    return {
      logicalKey: `submission:${sub.id}:grading-draft`,
      resourceKey: gradingWriteResourceKeyForVersion(),
      replayPayloadSignature: replayPayloadSignature(sub),
    };
  }

  function gradingPublishPersistOptions() {
    return {
      logicalKey: `submission:${sub.id}:grading-publish`,
      resourceKey: gradingWriteResourceKeyForVersion(),
      replayPayloadSignature: replayPayloadSignature(sub),
    };
  }

  function gradingTextLayoutOptions() {
    return defaultTextLayoutOptions();
  }

  function capturePageUndoSnapshot(pageIndex) {
    const key = String(pageIndex);
    const stack = draft.undoStacks[key] || { past: [], future: [] };
    return { past: stack.past.slice(), future: stack.future.slice() };
  }

  function restoreCanceledTextGesture(drag) {
    if (!drag) return;
    const pg = draft.pages[session.pageIndex];
    if (!pg) return;
    if (drag.origSnapshot) {
      const orig = JSON.parse(drag.origSnapshot);
      pg.annotations = pg.annotations.map((m) => (m.id === orig.id ? orig : m));
    } else if (drag.type === 'text-move') {
      pg.annotations = restoreDirectTextAnnotationPosition(
        pg.annotations,
        drag.id,
        drag.origNx,
        drag.origNy,
      );
    }
    if (drag.preUndoStacks) {
      const stack = getStack();
      stack.past = drag.preUndoStacks.past.slice();
      stack.future = drag.preUndoStacks.future.slice();
    } else if (drag.didUndo) {
      const stack = getStack();
      if (stack.past.length) stack.past.pop();
    }
  }

  function directTextHandleHitOptions(layoutOpts) {
    const coarse =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(pointer: coarse)')?.matches;
    return {
      ...layoutOpts,
      zoom: layoutZoomLevel(),
      handleHitPx: coarse ? 28 : 16,
    };
  }

  function cancelPenGesture() {
    if (session.penGesture?.livePath?.parentNode) {
      session.penGesture.livePath.parentNode.removeChild(session.penGesture.livePath);
    }
    session.penGesture = null;
  }

  function cancelEraserGesture(silent = false) {
    const g = session.eraserGesture;
    if (!g) return;
    if (g.preSnapshot) {
      const pg = draft.pages[g.pageIndex ?? session.pageIndex];
      if (pg) pg.annotations = JSON.parse(g.preSnapshot);
    }
    session.eraserGesture = null;
    if (!silent) renderOverlay();
  }

  function closeInlineTextEditor(cancel = false) {
    const ed = session.inlineTextEditor;
    if (!ed) return;
    if (ed.wrap?.parentNode) ed.wrap.parentNode.removeChild(ed.wrap);
    if (cancel && ed.savedUndo) {
      const stack = draft.undoStacks[String(ed.pageIndex ?? session.pageIndex)];
      if (stack?.past?.length) stack.past.pop();
    }
    session.inlineTextEditor = null;
    if (typeof editorWrap !== 'undefined' && editorWrap) {
      editorWrap.classList.remove('inline-text-editing');
    }
    renderOverlay();
  }

  function openInlineTextEditor({
    markId = null,
    anchorX,
    anchorY,
    text = '',
    color,
    fontSizeNorm,
    textWidthNorm,
    pageIndex = session.pageIndex,
  }) {
    closeInlineTextEditor(true);
    closeGradingTextDialog();
    const { w, h, z } = measureDisplayedImage(img, layoutZoomLevel());
    const layoutOpts = gradingTextLayoutOptions();
    let mark = markId
      ? draft.pages[pageIndex]?.annotations?.find((m) => m.id === markId && m.type === 'text')
      : null;
    const isNew = !mark;
    const draftMark = mark || {
      id: markId || uid(),
      type: 'text',
      nx: clampPixelToNormalized(anchorX, anchorY, w, h).nx,
      ny: clampPixelToNormalized(anchorX, anchorY, w, h).ny,
      text: text || 'M',
      color: color || session.inkColor,
      fontSizeNorm: fontSizeNorm ?? session.textFontSize / h,
      textWidthNorm:
        textWidthNorm ??
        defaultDirectTextWidthNorm(
          { type: 'text', nx: anchorX / w, ny: anchorY / h },
          w,
          h,
          layoutOpts,
        ),
    };
    markId = draftMark.id;
    session.selectedMarkId = markId;
    const box = layoutDirectTextBox(draftMark, w, h, layoutOpts);
    const chrome = computeInlineTextEditorLayout(box);
    const wrap = el('div', { className: 'grading-inline-text-editor' });
    wrap.style.left = `${chrome.left}px`;
    wrap.style.top = `${chrome.top}px`;
    wrap.style.width = `${chrome.width}px`;
    wrap.style.minHeight = `${chrome.minHeight}px`;
    const textarea = el('textarea', {
      className: 'grading-inline-text-input',
      'aria-label': 'Sửa chữ trên ảnh',
    });
    textarea.value = isNew ? '' : (draftMark.text || '');
    textarea.style.color = draftMark.color || session.inkColor;
    textarea.style.fontSize = `${box.fontSize}px`;
    textarea.style.lineHeight = `${box.lineHeight}px`;
    textarea.style.fontFamily = DIRECT_TEXT_FONT_FAMILY;
    textarea.style.width = `${chrome.textWidth}px`;
    textarea.style.minHeight = `${chrome.textMinHeight}px`;
    const originalFontSizeNorm = draftMark.fontSizeNorm;
    if (!isNew) {
      const sizeVal = directTextSizeOptionValue(box.fontSize);
      if ([...textSizeSel.options].some((o) => o.value === sizeVal)) {
        textSizeSel.value = sizeVal;
      } else {
        textSizeSel.appendChild(el('option', { value: sizeVal }, `${Math.round(box.fontSize)}px`));
        textSizeSel.value = sizeVal;
      }
      session.textFontSize = Number(sizeVal) || box.fontSize;
    }
    const syncInlineTextPreview = () => {
      const { w: cw, h: ch } = measureDisplayedImage(img, layoutZoomLevel());
      const opts = gradingTextLayoutOptions();
      const ed = session.inlineTextEditor;
      if (!ed) return;
      const fsNorm = resolveDirectTextSaveFontSizeNorm({
        fontSizeDirty: ed.fontSizeDirty,
        selectedSizeValue: String(session.textFontSize),
        viewportHeight: ch,
        originalFontSizeNorm: ed.originalFontSizeNorm,
      });
      const previewMark = {
        ...draftMark,
        text: textarea.value.length ? textarea.value : 'M',
        fontSizeNorm: fsNorm,
        color: ed.draftColor || draftMark.color || session.inkColor,
      };
      const previewBox = layoutDirectTextBox(previewMark, cw, ch, opts);
      const previewChrome = computeInlineTextEditorLayout(previewBox);
      wrap.style.left = `${previewChrome.left}px`;
      wrap.style.top = `${previewChrome.top}px`;
      wrap.style.width = `${previewChrome.width}px`;
      wrap.style.minHeight = `${previewChrome.minHeight}px`;
      textarea.style.fontSize = `${previewBox.fontSize}px`;
      textarea.style.lineHeight = `${previewBox.lineHeight}px`;
      textarea.style.color = previewMark.color;
      textarea.style.width = `${previewChrome.textWidth}px`;
      textarea.style.minHeight = `${previewChrome.textMinHeight}px`;
    };
    const err = el('div', { className: 'form-error grading-inline-text-error' });
    const actions = el('div', { className: 'grading-inline-text-actions' });
    const finish = () => {
      const raw = textarea.value;
      if (!isDirectTextValid(raw)) {
        err.textContent = directTextSaveErrorMessage(raw) || 'Nội dung không hợp lệ.';
        textarea.focus();
        return;
      }
      const pg = draft.pages[pageIndex];
      if (!pg) return;
      const { w: saveW, h: saveH } = measureDisplayedImage(img, layoutZoomLevel());
      const layoutOpts = gradingTextLayoutOptions();
      const fsNorm = resolveDirectTextSaveFontSizeNorm({
        fontSizeDirty: session.inlineTextEditor?.fontSizeDirty ?? false,
        selectedSizeValue: String(session.textFontSize),
        viewportHeight: saveH,
        originalFontSizeNorm: session.inlineTextEditor?.originalFontSizeNorm ?? originalFontSizeNorm,
      });
      const saveColor =
        session.inlineTextEditor?.draftColor || draftMark.color || session.inkColor;
      const placement = validateDirectTextPlacement(
        {
          ...draftMark,
          text: raw,
          fontSizeNorm: fsNorm,
          color: saveColor,
        },
        saveW,
        saveH,
        layoutOpts,
      );
      if (!placement.ok) {
        err.textContent = placement.error;
        textarea.focus();
        return;
      }
      if (!session.inlineTextEditor?.savedUndo) {
        pushUndoForPage(pageIndex);
        session.inlineTextEditor.savedUndo = true;
      }
      const saveBox = layoutDirectTextBox(placement.mark, saveW, saveH, layoutOpts);
      const saved = createDirectTextMarkFromPixelAnchor({
        id: markId,
        x: saveBox.x,
        y: saveBox.y,
        w: saveW,
        h: saveH,
        text: raw,
        color: saveColor,
        fontSizeNorm: fsNorm,
        textWidthNorm: placement.mark.textWidthNorm ?? draftMark.textWidthNorm,
        measureLineWidth: layoutOpts.measureLineWidth,
      });
      if (isNew) {
        pg.annotations.push(saved);
      } else {
        const idx = pg.annotations.findIndex((m) => m.id === markId);
        if (idx < 0) {
          err.textContent = 'Không tìm thấy đánh dấu — bấm Hủy và thử lại.';
          textarea.focus();
          return;
        }
        pg.annotations[idx] = saved;
      }
      closeInlineTextEditor(false);
      session.selectedMarkId = markId;
      if (isNew) {
        Object.assign(session, transitionGradingEditorTool(session, 'select', { readOnly }));
      }
      saveGradingDraft(false);
      updateToolbar();
      renderOverlay();
    };
    actions.appendChild(
      el('button', { type: 'button', className: 'btn btn-primary btn-sm', onClick: finish }, 'Xong'),
    );
    actions.appendChild(
      el('button', {
        type: 'button',
        className: 'btn btn-ghost btn-sm',
        onClick: () => closeInlineTextEditor(true),
      }, 'Hủy'),
    );
    textarea.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') {
        e.preventDefault();
        closeInlineTextEditor(true);
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        finish();
      }
    });
    textarea.addEventListener('pointerdown', (e) => e.stopPropagation());
    textarea.addEventListener('input', () => syncInlineTextPreview());
    wrap.appendChild(textarea);
    wrap.appendChild(err);
    wrap.appendChild(actions);
    viewport.appendChild(wrap);
    session.inlineTextEditor = {
      wrap,
      textarea,
      markId,
      pageIndex,
      isNew,
      savedUndo: false,
      originalText: isNew ? '' : (draftMark.text || ''),
      originalColor: draftMark.color || session.inkColor,
      colorDirty: false,
      originalFontSizeNorm,
      fontSizeDirty: false,
      draftColor: draftMark.color || session.inkColor,
      syncPreview: syncInlineTextPreview,
    };
    editorWrap.classList.add('inline-text-editing');
    renderOverlay();
    textarea.focus();
  }

  function closeGradingTextDialog() {
    if (session.closeTextDialog) {
      session.closeTextDialog();
      session.closeTextDialog = null;
    }
  }

  function gradingEditContext() {
    return {
      pageIndex: session.pageIndex,
      versionId: version.versionId,
      imageLoadSeq: session.imageLoadSeq,
    };
  }

  function isGradingEditContextCurrent(ctx) {
    return (
      ctx.pageIndex === session.pageIndex &&
      ctx.versionId === version.versionId &&
      ctx.imageLoadSeq === session.imageLoadSeq
    );
  }

  function openGuardedDirectTextDialog(onSave, initial) {
    closeGradingTextDialog();
    const ctx = gradingEditContext();
    const { close } = openDirectTextDialog((payload) => {
      if (!isGradingEditContextCurrent(ctx)) return;
      onSave(payload, ctx);
    }, initial);
    session.closeTextDialog = () => {
      close();
      session.closeTextDialog = null;
    };
  }

  const scoreInput = el('input', {
    id: 'grading-score',
    type: 'number',
    min: '0',
    max: '10',
    step: '0.5',
    value: String(draft.score ?? ''),
    disabled: readOnly,
  });
  const feedbackInput = el('textarea', { id: 'grading-feedback', disabled: readOnly }, draft.overallFeedback || '');
  const scoreErr = el('div', { className: 'form-error', role: 'alert', 'aria-live': 'assertive' });

  if (!readOnly && gradingDirtyTracker) {
    registerDirtyProbe(
      () => gradingDirtyTracker.isDirty(gradingDirtyContext()),
      { fields: [scoreInput, feedbackInput] },
    );
    bumpDirtyNavigationGuard();
  }

  const editorWrap = el('div', { className: 'editor-wrap grading-editor-scroll' });
  const editorStage = el('div', { className: 'editor-stage' });
  const viewport = el('div', { className: 'editor-viewport' });
  const img = el('img', { alt: 'Trang bài làm' });
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'annotation-layer interactive');
  viewport.appendChild(img);
  viewport.appendChild(svg);
  editorStage.appendChild(viewport);
  editorWrap.appendChild(editorStage);
  const pageCommentWrap = el('div', { className: 'page-comment-wrap', hidden: true });
  const commentsToggleBtn = el('button', {
    type: 'button',
    className: 'page-comment-drawer-toggle btn btn-ghost btn-sm',
    'aria-expanded': 'false',
    hidden: true,
  }, 'Nhận xét trang');
  commentsToggleBtn.onclick = () => {
    session.commentsDrawerOpen = !session.commentsDrawerOpen;
    pageCommentList.classList.toggle('is-expanded', session.commentsDrawerOpen);
    commentsToggleBtn.setAttribute('aria-expanded', session.commentsDrawerOpen ? 'true' : 'false');
    commentsToggleBtn.textContent = session.commentsDrawerOpen ? 'Ẩn nhận xét trang' : 'Nhận xét trang';
  };
  const pageCommentList = el('div', { className: 'page-comment-list page-comment-drawer', hidden: true });
  pageCommentWrap.appendChild(commentsToggleBtn);
  pageCommentWrap.appendChild(pageCommentList);

  const stageHost = el('div', { className: 'grading-stage-host' });
  stageHost.appendChild(editorWrap);

  const pageSel = el('select', { className: 'grading-page-select', 'aria-label': 'Chọn trang' });

  const workspace = el('div', { className: 'grading-workspace' });
  const focusBar = el('header', { className: 'grading-focus-bar' });
  const focusSaveStatus = el('span', {
    className: 'grading-focus-save save-status ok',
    'aria-live': 'polite',
  }, 'Đã lưu');
  const focusToggleBtn = el('button', {
    type: 'button',
    className: 'editor-tool-btn grading-focus-toggle',
    title: 'Chế độ tập trung',
    'aria-label': 'Chế độ tập trung',
    'aria-pressed': 'true',
  }, editorIcon('expand'), el('span', { className: 'editor-tool-label' }, 'Tập trung'));
  const panelToggleBtn = el('button', {
    type: 'button',
    className: 'editor-tool-btn grading-panel-toggle',
    title: 'Bảng điểm & nhận xét',
    'aria-label': 'Bảng điểm & nhận xét',
    'aria-expanded': 'true',
  }, editorIcon('panel'), el('span', { className: 'editor-tool-label' }, 'Điểm & nhận xét'));
  const mobilePanelOpenBtn = el('button', {
    type: 'button',
    className: 'btn btn-secondary btn-sm grading-mobile-panel-open',
  }, 'Điểm & nhận xét');
  const focusRowPrimary = el('div', { className: 'grading-focus-row grading-focus-row-primary' });
  const focusRowSecondary = el('div', { className: 'grading-focus-row grading-focus-row-secondary' });
  focusRowPrimary.appendChild(
    el('button', {
      type: 'button',
      className: 'editor-tool-btn grading-back-btn',
      title: 'Quay lại hàng chấm',
      'aria-label': 'Quay lại hàng chấm',
      onClick: () => {
        if (blockIfPendingInlineEdit()) return;
        navigate('#/grading');
      },
    }, editorIcon('back'), el('span', { className: 'editor-tool-label' }, 'Hàng chấm')),
  );
  focusRowPrimary.appendChild(
    el('div', { className: 'grading-focus-title' },
      el('strong', { className: 'grading-focus-student' }, st.name),
      el('span', { className: 'grading-focus-assignment' }, a.title),
      readOnly ? el('span', { className: 'grading-readonly-tag' }, 'Chỉ xem') : null,
    ),
  );
  focusRowSecondary.appendChild(el('span', { className: 'grading-focus-demo' }, 'Demo cục bộ'));
  if (versionSel) focusRowSecondary.appendChild(versionSel);
  focusRowSecondary.appendChild(pageSel);
  focusRowSecondary.appendChild(focusSaveStatus);
  focusRowSecondary.appendChild(focusToggleBtn);
  focusRowSecondary.appendChild(panelToggleBtn);
  focusRowSecondary.appendChild(mobilePanelOpenBtn);
  focusBar.appendChild(focusRowPrimary);
  focusBar.appendChild(focusRowSecondary);

  const workspaceBody = el('div', { className: 'grading-workspace-body' });
  const canvasColumn = el('div', { className: 'grading-canvas-column' });

  const pinnedToolbar = el('aside', {
    className: 'grading-pinned-toolbar',
    role: 'toolbar',
    'aria-label': 'Công cụ chấm',
  });
  const toolHint = el('p', { className: 'grading-tool-hint', 'aria-live': 'polite' });

  const primaryTools = [
    ['select', 'select', 'Chọn'],
    ['pan', 'pan', 'Cuộn'],
    ['pen', 'pen', 'Bút'],
    ['text', 'text', 'Chữ'],
    ['eraser', 'eraser', 'Tẩy'],
  ];
  const secondaryTools = [
    ['check', 'check', 'Đúng'],
    ['cross', 'cross', 'Sai'],
    ['highlight', 'highlight', 'Vùng'],
    ['pin', 'comment', 'Nhận xét'],
    ['view', 'view', 'Xem'],
  ];
  const toolButtons = new Map();
  const toolbarMainRow = el('div', {
    className: 'grading-toolbar-row grading-toolbar-row-main',
    role: 'group',
    'aria-label': 'Công cụ chính',
  });
  const toolbarMoreWrap = el('div', { className: 'grading-toolbar-more' });
  const toolbarMoreMenu = el('div', {
    className: 'grading-toolbar-more-menu',
    hidden: true,
    role: 'menu',
    'aria-label': 'Công cụ đánh dấu phụ',
  });
  const toolbarContextRow = el('div', {
    className: 'grading-toolbar-row grading-toolbar-row-context',
    hidden: true,
  });
  const toolbarZoomRow = el('div', {
    className: 'grading-toolbar-row grading-toolbar-row-zoom',
    role: 'group',
    'aria-label': 'Thu phóng',
  });
  const toolTitle = (id) => {
    if (id === 'pen') return 'Bút — kéo trên ảnh để vẽ nét tự do';
    if (id === 'text') return 'Chữ — bấm vị trí để thêm; kéo tay cầm khung để chỉnh; Xong chuyển sang Chọn';
    if (id === 'eraser') return 'Tẩy — chạm hoặc kéo qua nét để xóa (chỉ nét bút)';
    if (id === 'pin') return 'Thêm nhận xét — bấm vị trí trên bài';
    if (id === 'highlight') return 'Đánh dấu vùng — kéo khung trên bài';
    if (id === 'pan') return 'Cuộn ảnh';
    if (id === 'view') return 'Chỉ xem, không vẽ';
    if (id === 'select') return 'Chọn — bấm để chọn; kéo chữ hoặc khung';
    return primaryTools.find(([k]) => k === id)?.[2] || secondaryTools.find(([k]) => k === id)?.[2] || id;
  };
  function selectTool(id) {
    if (gradingMutating.isBusy()) return;
    if (blockIfPendingInlineEdit()) return;
    cancelPenGesture();
    cancelEraserGesture(true);
    closeInlineTextEditor(true);
    Object.assign(session, transitionGradingEditorTool(session, id, { readOnly }));
    updateToolbar();
    renderOverlay();
  }
  function mountToolButton(id, iconName, label, parent) {
    const title = toolTitle(id);
    const btn = mountEditorToolButton({
      id,
      iconName,
      label: title,
      parent,
      disabled: readOnly && id !== 'view' && id !== 'pan',
      onClick: () => selectTool(id),
    });
    toolButtons.set(id, btn);
    parent.appendChild(btn);
  }
  for (const [id, icon, label] of primaryTools) mountToolButton(id, icon, label, toolbarMainRow);
  for (const [id, icon, label] of secondaryTools) mountToolButton(id, icon, label, toolbarMoreMenu);
  const moreToolsBtn = mountEditorToolButton({
    id: 'more-tools',
    iconName: 'more',
    label: 'Thêm công cụ',
    parent: toolbarMoreWrap,
    onClick: (e) => {
      e.stopPropagation();
      const open = toolbarMoreMenu.hidden;
      toolbarMoreMenu.hidden = !open;
      moreToolsBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    },
  });
  moreToolsBtn.setAttribute('aria-haspopup', 'menu');
  moreToolsBtn.setAttribute('aria-expanded', 'false');
  toolbarMoreWrap.appendChild(moreToolsBtn);
  toolbarMoreWrap.appendChild(toolbarMoreMenu);
  document.addEventListener('pointerdown', (e) => {
    if (toolbarMoreMenu.hidden) return;
    if (toolbarMoreWrap.contains(e.target)) return;
    toolbarMoreMenu.hidden = true;
    moreToolsBtn.setAttribute('aria-expanded', 'false');
  });
  toolbarMainRow.appendChild(toolbarMoreWrap);

  const inkBar = el('div', { className: 'ink-bar ink-bar-compact', role: 'group', 'aria-label': 'Mực và nét' });
  for (const c of MARK_INK_COLORS) {
    const sw = el('button', {
      type: 'button',
      className: 'ink-swatch',
      title: c.label,
      'aria-label': c.label,
      disabled: readOnly,
      onClick: () => {
        session.inkColor = c.value;
        const ed = session.inlineTextEditor;
        if (ed) {
          ed.draftColor = c.value;
          ed.colorDirty = c.value !== ed.originalColor;
          ed.syncPreview?.();
        }
        updateInkBar();
      },
    }, el('span', {
      className: 'ink-swatch-dot',
      style: `--swatch:${c.value}`,
      'aria-hidden': 'true',
    }));
    inkBar.appendChild(sw);
  }
  const strokeSel = el('select', { className: 'grading-context-select', 'aria-label': 'Độ dày nét', disabled: readOnly });
  strokeSel.appendChild(el('option', { value: 'thin' }, 'Mỏng'));
  strokeSel.appendChild(el('option', { value: 'medium' }, 'Vừa'));
  strokeSel.appendChild(el('option', { value: 'thick' }, 'Dày'));
  strokeSel.value = session.strokePreset;
  strokeSel.onchange = () => {
    session.strokePreset = strokeSel.value;
  };
  inkBar.appendChild(strokeSel);
  const textSizeSel = el('select', { className: 'grading-context-select', 'aria-label': 'Cỡ chữ trên ảnh', disabled: readOnly });
  for (const sz of DIRECT_TEXT_SIZES) {
    textSizeSel.appendChild(el('option', { value: String(sz) }, `${sz}px`));
  }
  textSizeSel.value = String(session.textFontSize);
  textSizeSel.onchange = () => {
    session.textFontSize = Number(textSizeSel.value) || DIRECT_TEXT_SIZES[1];
    const ed = session.inlineTextEditor;
    if (ed) {
      ed.fontSizeDirty = true;
      ed.syncPreview?.();
    }
  };
  inkBar.appendChild(textSizeSel);
  toolbarContextRow.appendChild(inkBar);

  const undoBtn = mountEditorToolButton({
    id: 'undo',
    iconName: 'undo',
    label: 'Hoàn tác',
    onClick: () => undo(),
  });
  const redoBtn = mountEditorToolButton({
    id: 'redo',
    iconName: 'redo',
    label: 'Làm lại',
    onClick: () => redo(),
  });
  const delBtn = mountEditorToolButton({
    id: 'delete',
    iconName: 'trash',
    label: 'Xóa đánh dấu',
    onClick: () => deleteSelectedMark(),
  });
  const editCommentBtn = mountEditorToolButton({
    id: 'edit-comment',
    iconName: 'comment',
    label: 'Sửa nhận xét',
    onClick: () => {
      const mark = selectedPinMark();
      if (mark) openEditPinDialog(mark.id);
    },
  });
  const editTextBtn = mountEditorToolButton({
    id: 'edit-text',
    iconName: 'text',
    label: 'Sửa chữ',
    onClick: () => {
      const mark = selectedTextMark();
      if (mark) openEditTextDialog(mark.id);
    },
  });
  const editActionsBar = el('div', {
    className: 'grading-toolbar-edits',
    role: 'group',
    'aria-label': 'Sửa và hoàn tác',
  });
  toolbarMoreMenu.prepend(editTextBtn);
  toolbarMoreMenu.prepend(editCommentBtn);
  editActionsBar.appendChild(undoBtn);
  editActionsBar.appendChild(redoBtn);
  editActionsBar.appendChild(delBtn);
  toolbarMainRow.appendChild(editActionsBar);

  const zoomPct = el('span', { className: 'grading-zoom-pct', 'aria-live': 'polite' }, '100%');
  const zoomControls = el('div', { className: 'zoom-controls grading-zoom-controls', role: 'presentation' });
  const fitPageBtn = mountEditorToolButton({
    id: 'fit-page',
    iconName: 'fitPage',
    label: 'Vừa trang',
    onClick: () => applyZoomFitMode(GRADING_ZOOM_FIT_PAGE),
  });
  const fitWidthBtn = mountEditorToolButton({
    id: 'fit-width',
    iconName: 'fitWidth',
    label: 'Vừa ngang',
    onClick: () => applyZoomFitMode(GRADING_ZOOM_FIT_WIDTH),
  });
  const zoomOutBtn = mountEditorToolButton({
    id: 'zoom-out',
    iconName: 'zoomOut',
    label: 'Thu nhỏ',
    onClick: () => nudgeManualZoom(-0.1),
  });
  const zoomInBtn = mountEditorToolButton({
    id: 'zoom-in',
    iconName: 'zoomIn',
    label: 'Phóng to',
    onClick: () => nudgeManualZoom(0.1),
  });
  zoomControls.appendChild(fitPageBtn);
  zoomControls.appendChild(fitWidthBtn);
  zoomControls.appendChild(zoomOutBtn);
  zoomControls.appendChild(zoomPct);
  zoomControls.appendChild(zoomInBtn);
  toolbarZoomRow.appendChild(zoomControls);
  pinnedToolbar.appendChild(toolbarMainRow);
  pinnedToolbar.appendChild(toolbarContextRow);
  pinnedToolbar.appendChild(toolbarZoomRow);

  const gradingToolbarReadOnlyDisabled = (id) => readOnly && id !== 'view' && id !== 'pan';
  syncGradingMutatingFreeze = (busy) => {
    if (readOnly) return;
    workspace.classList.toggle('is-grading-mutating', busy);
    workspace.toggleAttribute('aria-busy', busy);
    editorWrap.inert = busy;
    scoreInput.disabled = busy;
    feedbackInput.disabled = busy;
    templates.disabled = busy;
    for (const [id, btn] of toolButtons) {
      btn.disabled = busy || gradingToolbarReadOnlyDisabled(id);
    }
    for (const btn of [undoBtn, redoBtn, delBtn, editCommentBtn, editTextBtn, moreToolsBtn]) {
      btn.disabled = busy;
    }
    for (const sw of inkBar.querySelectorAll('.ink-swatch')) {
      sw.disabled = busy;
    }
    strokeSel.disabled = busy;
    textSizeSel.disabled = busy;
    if (busy) {
      toolbarMoreMenu.hidden = true;
      moreToolsBtn.setAttribute('aria-expanded', 'false');
      closeGradingTextDialog();
    }
    renderOverlay();
  };

  if (!readOnly) {
    canvasColumn.appendChild(toolHint);
  }
  canvasColumn.appendChild(pinnedToolbar);
  canvasColumn.appendChild(stageHost);
  canvasColumn.appendChild(pageCommentWrap);

  const side = el('aside', { className: 'grading-panel card sidebar-panel' });
  const mobilePanelCloseBtn = el('button', {
    type: 'button',
    className: 'editor-tool-btn grading-panel-close',
    'aria-label': 'Đóng bảng điểm',
    title: 'Đóng',
  }, editorIcon('close'));
  const panelTitleRow = el('div', { className: 'grading-panel-header' });
  panelTitleRow.appendChild(el('h2', { className: 'grading-panel-title' }, 'Điểm & nhận xét'));
  panelTitleRow.appendChild(mobilePanelCloseBtn);
  side.appendChild(panelTitleRow);
  side.appendChild(el('label', { htmlFor: 'grading-score' }, 'Điểm (0–10)'));
  side.appendChild(scoreInput);
  side.appendChild(scoreErr);
  side.appendChild(el('label', { htmlFor: 'grading-feedback' }, 'Nhận xét chung'));
  side.appendChild(feedbackInput);
  const templates = el('select', { className: 'grading-context-select', 'aria-label': 'Mẫu nhận xét', disabled: readOnly });
  templates.appendChild(el('option', { value: '' }, 'Mẫu nhanh…'));
  for (const t of COMMENT_TEMPLATES) {
    templates.appendChild(el('option', { value: t }, t));
  }
  templates.onchange = () => {
    if (blockIfPendingInlineEdit()) {
      templates.value = '';
      return;
    }
    if (templates.value) {
      draft.overallFeedback = (draft.overallFeedback ? draft.overallFeedback + ' ' : '') + templates.value;
      feedbackInput.value = draft.overallFeedback;
      templates.value = '';
    }
  };
  side.appendChild(templates);

  if (!readOnly) {
    draftSaveBtn = el('button', {
      type: 'button',
      className: 'btn btn-secondary',
      onClick: guardGradingExplicitAction(() => {
        if (blockIfPendingInlineEdit()) return;
        saveGradingDraft(true);
      }),
    }, 'Lưu nháp chấm');
    side.appendChild(draftSaveBtn);
    needsRevisionBtn = el('button', {
      type: 'button',
      className: 'btn btn-ghost',
      onClick: guardGradingExplicitAction(() => {
        if (blockIfPendingInlineEdit()) return;
        publishGrading(true);
      }),
    }, 'Yêu cầu làm lại');
    side.appendChild(needsRevisionBtn);
    returnPublishBtn = el('button', {
      type: 'button',
      className: 'btn btn-primary',
      onClick: guardGradingExplicitAction(() => {
        if (blockIfPendingInlineEdit()) return;
        publishGrading(false);
      }),
    }, 'Trả bài');
    side.appendChild(returnPublishBtn);
  }

  const mobilePanelBackdrop = el('button', {
    type: 'button',
    className: 'grading-panel-backdrop',
    'aria-label': 'Đóng bảng điểm',
  });
  workspaceBody.appendChild(canvasColumn);
  workspaceBody.appendChild(side);
  workspaceBody.appendChild(mobilePanelBackdrop);
  workspace.appendChild(focusBar);
  workspace.appendChild(workspaceBody);
  root.appendChild(workspace);

  let editorLayoutRo = null;
  let mobileSheetMq = null;
  let onMobileSheetViewportChange = null;
  if (typeof ResizeObserver !== 'undefined') {
    editorLayoutRo = new ResizeObserver(() => {
      cancelAllGradingGesturesOnLayoutRefit();
      session.inlineTextEditor?.syncPreview?.();
      if (session.zoomFitMode !== GRADING_ZOOM_MANUAL) {
        requestAnimationFrame(() => renderOverlay());
      }
    });
    editorLayoutRo.observe(stageHost);
  }
  if (typeof window !== 'undefined' && window.matchMedia) {
    mobileSheetMq = window.matchMedia('(max-width: 1023px)');
    onMobileSheetViewportChange = () => {
      syncPanelChrome();
      cancelAllGradingGesturesOnLayoutRefit();
      session.inlineTextEditor?.syncPreview?.();
      if (session.zoomFitMode !== GRADING_ZOOM_MANUAL) {
        requestAnimationFrame(() => renderOverlay());
      }
    };
    mobileSheetMq.addEventListener('change', onMobileSheetViewportChange);
  }

  function syncFocusSaveStatus() {
    const global = document.getElementById('save-status');
    if (!global || !focusSaveStatus) return;
    focusSaveStatus.textContent = global.textContent;
    focusSaveStatus.className = global.className.replace(/\bsave-status\b/, 'grading-focus-save save-status');
  }

  function syncFocusMode() {
    applyGradingFocusMode(document, !!session.focusMode);
    workspace.classList.toggle('is-focus', !!session.focusMode);
    workspace.classList.toggle('is-workspace', !session.focusMode);
    focusToggleBtn.setAttribute('aria-pressed', session.focusMode ? 'true' : 'false');
    focusToggleBtn.title = session.focusMode ? 'Thoát chế độ tập trung' : 'Chế độ tập trung';
    const focusLabel = focusToggleBtn.querySelector('.editor-tool-label');
    focusToggleBtn.replaceChildren(
      editorIcon(session.focusMode ? 'collapse' : 'expand'),
      focusLabel || el('span', { className: 'editor-tool-label' }, 'Tập trung'),
    );
    syncFocusSaveStatus();
  }

  function setFocusMode(enabled) {
    session.focusMode = !!enabled;
    syncFocusMode();
  }

  focusToggleBtn.onclick = () => {
    if (blockIfPendingInlineEdit()) return;
    setFocusMode(!session.focusMode);
  };

  function syncPanelChrome() {
    side.classList.toggle('is-collapsed', session.panelCollapsed);
    const panelState = resolveGradingPanelSideState({
      mobileSheetViewport: window.matchMedia('(max-width: 1023px)').matches,
      mobilePanelOpen: session.mobilePanelOpen,
      panelCollapsed: session.panelCollapsed,
    });
    panelToggleBtn.setAttribute('aria-expanded', panelState.panelToggleExpanded ? 'true' : 'false');
    workspace.classList.toggle('panel-collapsed', session.panelCollapsed);
    workspace.classList.toggle('mobile-panel-open', session.mobilePanelOpen);
    side.hidden = panelState.sideHidden;
    side.inert = panelState.sideInert;
    side.setAttribute('aria-hidden', panelState.sideAriaHidden);
    mobilePanelBackdrop.hidden = panelState.backdropHidden;
    mobilePanelBackdrop.inert = panelState.backdropInert;
    if (panelState.sideHidden) {
      if (side.contains(document.activeElement)) {
        (session.panelFocusBeforeOpen || mobilePanelOpenBtn).focus?.();
      }
      session.panelFocusBeforeOpen = null;
    }
  }

  panelToggleBtn.onclick = () => {
    session.panelCollapsed = !session.panelCollapsed;
    syncPanelChrome();
    if (session.zoomFitMode !== GRADING_ZOOM_MANUAL) {
      requestAnimationFrame(() => renderOverlay());
    }
  };
  mobilePanelOpenBtn.onclick = () => {
    session.panelFocusBeforeOpen = document.activeElement;
    session.mobilePanelOpen = true;
    syncPanelChrome();
    scoreInput.focus();
    if (session.zoomFitMode !== GRADING_ZOOM_MANUAL) {
      requestAnimationFrame(() => renderOverlay());
    }
  };
  mobilePanelCloseBtn.onclick = () => {
    session.mobilePanelOpen = false;
    syncPanelChrome();
    if (session.zoomFitMode !== GRADING_ZOOM_MANUAL) {
      requestAnimationFrame(() => renderOverlay());
    }
  };
  mobilePanelBackdrop.onclick = () => {
    session.mobilePanelOpen = false;
    syncPanelChrome();
    if (session.zoomFitMode !== GRADING_ZOOM_MANUAL) {
      requestAnimationFrame(() => renderOverlay());
    }
  };

  function updateInkBar() {
    const activeColor =
      session.inlineTextEditor?.draftColor ?? session.inkColor;
    for (const btn of inkBar.querySelectorAll('.ink-swatch')) {
      const label = btn.getAttribute('aria-label');
      const col = MARK_INK_COLORS.find((c) => c.label === label);
      btn.classList.toggle('active', col?.value === activeColor);
    }
  }
  updateInkBar();

  function updateZoomUi() {
    const { innerW, innerH } = gradingLayoutContainerSize();
    const nw = img.naturalWidth || 1;
    const nh = img.naturalHeight || 1;
    const pct = computeGradingZoomPercent({
      naturalWidth: nw,
      naturalHeight: nh,
      containerInnerWidth: innerW,
      containerInnerHeight: innerH,
      fitMode: session.zoomFitMode,
      manualZoom: session.manualZoom,
    });
    zoomPct.textContent = `${pct}%`;
    fitPageBtn.classList.toggle('active', session.zoomFitMode === GRADING_ZOOM_FIT_PAGE);
    fitWidthBtn.classList.toggle('active', session.zoomFitMode === GRADING_ZOOM_FIT_WIDTH);
    fitPageBtn.setAttribute('aria-pressed', session.zoomFitMode === GRADING_ZOOM_FIT_PAGE ? 'true' : 'false');
    fitWidthBtn.setAttribute('aria-pressed', session.zoomFitMode === GRADING_ZOOM_FIT_WIDTH ? 'true' : 'false');
  }

  function applyZoomFitMode(mode) {
    session.zoomFitMode = mode;
    session.manualZoom = 1;
    session.zoom = 1;
    renderOverlay();
    requestAnimationFrame(() => renderOverlay());
  }

  function nudgeManualZoom(delta) {
    ensureManualZoomFromDisplayedScale();
    session.manualZoom = nudgeGradingManualZoom(session.manualZoom, delta);
    session.zoom = session.manualZoom;
    renderOverlay();
  }

  function updateToolbar() {
    for (const [id, btn] of toolButtons) {
      const active =
        id === 'view'
          ? session.mode === 'view'
          : session.mode === 'annotate' && session.tool === id;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    }
    editorWrap.classList.toggle('tool-pen', session.tool === 'pen' && session.mode === 'annotate');
    editorWrap.classList.toggle('tool-eraser', session.tool === 'eraser' && session.mode === 'annotate');
    editorWrap.classList.toggle('tool-text', session.tool === 'text' && session.mode === 'annotate');
    editorWrap.classList.toggle(
      'tool-select',
      session.tool === 'select' && session.mode === 'annotate',
    );
    editorWrap.classList.toggle('text-dragging', ['text-move', 'text-resize'].includes(session.drag?.type));
    editorWrap.classList.toggle(
      'tool-draw',
      ['pen', 'text', 'eraser', 'highlight', 'check', 'cross', 'pin'].includes(session.tool) &&
        session.mode === 'annotate',
    );
    const inkVis = resolveGradingInkControlsVisibility({
      readOnly,
      tool: session.tool,
      inlineTextEditing: !!session.inlineTextEditor,
    });
    inkBar.hidden = inkVis.inkBarHidden;
    strokeSel.hidden = inkVis.strokeSelHidden;
    textSizeSel.hidden = inkVis.textSizeSelHidden;
    toolbarContextRow.hidden = inkVis.inkBarHidden && inkVis.strokeSelHidden && inkVis.textSizeSelHidden;
    const hints = {
      pen: 'Bút: kéo trên ảnh để vẽ.',
      eraser: 'Tẩy: chạm hoặc kéo qua nét bút.',
      text: 'Chữ: bấm vị trí; Xong chuyển sang Chọn.',
      pin: 'Nhận xét: bấm vị trí trên bài.',
      select: 'Chọn: bấm hoặc kéo tay cầm khung.',
      highlight: 'Kéo khung đánh dấu vùng.',
      pan: 'Cuộn ảnh bằng kéo hoặc thanh cuộn.',
    };
    toolHint.textContent = readOnly
      ? ''
      : hints[session.tool] || (session.mode === 'view' ? 'Chế độ xem.' : '');
    updateInkBar();
    updateZoomUi();
  }

  syncFocusMode();
  syncPanelChrome();

  const saveStatusObserver = new MutationObserver(() => syncFocusSaveStatus());
  const globalSave = document.getElementById('save-status');
  if (globalSave) {
    saveStatusObserver.observe(globalSave, { attributes: true, childList: true, characterData: true, subtree: true });
  }

  function pageKey() {
    return String(session.pageIndex);
  }

  function getStack() {
    if (!draft.undoStacks[pageKey()]) {
      draft.undoStacks[pageKey()] = { past: [], future: [] };
    }
    return draft.undoStacks[pageKey()];
  }

  function pushUndo() {
    pushUndoForPage(session.pageIndex);
  }

  function pushUndoForPage(pageIndex) {
    const pg = draft.pages[pageIndex];
    if (!pg) return;
    const key = String(pageIndex);
    if (!draft.undoStacks[key]) {
      draft.undoStacks[key] = { past: [], future: [] };
    }
    const stack = draft.undoStacks[key];
    stack.past.push(JSON.stringify(pg.annotations));
    stack.future = [];
  }

  function undo() {
    if (readOnly || gradingMutating.isBusy()) return;
    if (shouldBlockGradingUndoRedo({ inlineTextEditing: !!session.inlineTextEditor })) return;
    const stack = getStack();
    if (!stack.past.length) return;
    const pg = draft.pages[session.pageIndex];
    stack.future.push(JSON.stringify(pg.annotations));
    pg.annotations = JSON.parse(stack.past.pop());
    renderOverlay();
    bumpDirtyNavigationGuard();
    saveGradingDraft(false);
  }

  function redo() {
    if (readOnly || gradingMutating.isBusy()) return;
    if (shouldBlockGradingUndoRedo({ inlineTextEditing: !!session.inlineTextEditor })) return;
    const stack = getStack();
    if (!stack.future.length) return;
    const pg = draft.pages[session.pageIndex];
    stack.past.push(JSON.stringify(pg.annotations));
    pg.annotations = JSON.parse(stack.future.pop());
    renderOverlay();
    bumpDirtyNavigationGuard();
    saveGradingDraft(false);
  }

  function deleteSelectedMark() {
    if (readOnly || gradingMutating.isBusy() || !session.selectedMarkId) return;
    if (shouldBlockGradingDestructiveActions({ inlineTextEditing: !!session.inlineTextEditor })) {
      scoreErr.textContent = gradingPendingInlineEditMessage();
      return;
    }
    pushUndo();
    const pg = draft.pages[session.pageIndex];
    pg.annotations = pg.annotations.filter((m) => m.id !== session.selectedMarkId);
    session.selectedMarkId = null;
    renderOverlay();
    saveGradingDraft(false);
  }

  undoBtn.onclick = undo;
  redoBtn.onclick = redo;
  delBtn.onclick = deleteSelectedMark;
  if (readOnly) {
    undoBtn.disabled = true;
    redoBtn.disabled = true;
    delBtn.disabled = true;
    editCommentBtn.disabled = true;
    editTextBtn.disabled = true;
  }

  function selectedPinMark() {
    const pg = draft.pages[session.pageIndex] || { annotations: [] };
    const mark = pg.annotations.find((m) => m.id === session.selectedMarkId);
    return mark?.type === 'pin' ? mark : null;
  }

  function selectedTextMark() {
    const pg = draft.pages[session.pageIndex] || { annotations: [] };
    const mark = pg.annotations.find((m) => m.id === session.selectedMarkId);
    return mark?.type === 'text' ? mark : null;
  }

  function openEditTextDialog(textId) {
    if (readOnly || gradingMutating.isBusy()) return;
    const pg = draft.pages[session.pageIndex];
    const mark = pg.annotations.find((m) => m.id === textId && m.type === 'text');
    if (!mark) return;
    const { w, h } = measureDisplayedImage(img, layoutZoomLevel());
    const scaled = scaleMarkToViewport(mark, w, h);
    openInlineTextEditor({
      markId: textId,
      anchorX: scaled.x,
      anchorY: scaled.y,
      text: mark.text || '',
      color: mark.color || session.inkColor,
      fontSizeNorm: mark.fontSizeNorm,
      textWidthNorm: mark.textWidthNorm,
    });
  }

  function openEditPinDialog(pinId) {
    if (readOnly || gradingMutating.isBusy()) return;
    const pg = draft.pages[session.pageIndex];
    const mark = pg.annotations.find((m) => m.id === pinId && m.type === 'pin');
    if (!mark) return;
    session.selectedMarkId = pinId;
    openPinCommentDialog((text) => {
      if (gradingMutating.isBusy()) return;
      pushUndo();
      pg.annotations = updatePinCommentText(pg.annotations, pinId, text);
      renderOverlay();
      saveGradingDraft(false);
    }, mark.text || '', 'Sửa nhận xét');
  }

  function deletePinComment(pinId) {
    if (readOnly || gradingMutating.isBusy()) return;
    pushUndo();
    const pg = draft.pages[session.pageIndex];
    pg.annotations = pg.annotations.filter((m) => m.id !== pinId);
    if (session.selectedMarkId === pinId) session.selectedMarkId = null;
    renderOverlay();
    saveGradingDraft(false);
  }

  editCommentBtn.onclick = guardGradingNotBusy(() => gradingMutating.isBusy(), () => {
    const mark = selectedPinMark();
    if (mark) openEditPinDialog(mark.id);
  });
  editTextBtn.onclick = guardGradingNotBusy(() => gradingMutating.isBusy(), () => {
    const mark = selectedTextMark();
    if (mark) openEditTextDialog(mark.id);
  });

  function penStrokeWidthNorm() {
    return PEN_STROKE_PRESETS[session.strokePreset] || PEN_STROKE_PRESETS.medium;
  }

  function gradingKeyHandler(e) {
    if (e.key === 'Escape') {
      if (session.inlineTextEditor) return;
      if (session.penGesture) {
        e.preventDefault();
        cancelPenGesture();
        return;
      }
      if (session.eraserGesture) {
        e.preventDefault();
        cancelEraserGesture();
        return;
      }
      if (session.drag) {
        e.preventDefault();
        if (session.drag.type === 'highlight') {
          cancelHighlightGesture();
          return;
        }
        if (session.drag.type === 'text-move' || session.drag.type === 'text-resize') {
          restoreCanceledTextGesture(session.drag);
        }
        session.drag = null;
        renderOverlay();
        return;
      }
      if (session.focusMode) {
        e.preventDefault();
        setFocusMode(false);
        return;
      }
    }
    if (e.target.matches('input, textarea, select')) return;
    if (gradingMutating.isBusy()) return;
    if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
      e.preventDefault();
      if (shouldBlockGradingUndoRedo({ inlineTextEditing: !!session.inlineTextEditor })) return;
      if (e.shiftKey) redo();
      else undo();
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (session.inlineTextEditor) return;
      if (session.selectedMarkId) {
        e.preventDefault();
        deleteSelectedMark();
      }
    }
  }

  async function loadPage() {
    clear(pageSel);
    version.pageImageIds.forEach((_, i) => {
      pageSel.appendChild(el('option', { value: String(i) }, `Trang ${i + 1}`));
    });
    pageSel.value = String(session.pageIndex);
    pageSel.onchange = () => {
      if (blockIfPendingInlineEdit()) {
        pageSel.value = String(session.pageIndex);
        return;
      }
      cancelPenGesture();
      cancelHighlightGesture();
      closeGradingTextDialog();
      session.selectedMarkId = null;
      session.pageIndex = Number(pageSel.value);
      loadPageImage();
    };
    await loadPageImage();
  }

  async function loadPageImage() {
    cancelPenGesture();
    cancelEraserGesture(true);
    cancelHighlightGesture();
    closeInlineTextEditor(true);
    closeGradingTextDialog();
    session.pageImageReady = false;
    session.drag = null;
    const loadSeq = (session.imageLoadSeq += 1);
    const loadPageIndex = session.pageIndex;
    const loadVersionId = version.versionId;
    const imgId = version.pageImageIds[session.pageIndex];
    renderOverlay();
    const url = imgId ? await getImageBlob(imgId) : null;
    if (
      loadSeq !== session.imageLoadSeq ||
      loadPageIndex !== session.pageIndex ||
      loadVersionId !== version.versionId
    ) {
      return;
    }
    img.onload = () => {
      if (
        loadSeq !== session.imageLoadSeq ||
        loadPageIndex !== session.pageIndex ||
        loadVersionId !== version.versionId
      ) {
        return;
      }
      session.pageImageReady = true;
      renderOverlay();
      if (typeof ResizeObserver !== 'undefined') {
        if (img._gradingRo) img._gradingRo.disconnect();
        img._gradingRo = new ResizeObserver(() => renderOverlay());
        img._gradingRo.observe(img);
      }
    };
    img.onerror = () => {
      if (loadSeq !== session.imageLoadSeq) return;
      session.pageImageReady = true;
      renderOverlay();
    };
    if (url) {
      img.src = url;
    } else {
      img.removeAttribute('src');
      session.pageImageReady = true;
      renderOverlay();
    }
  }

  function renderOverlay() {
    const layoutZoom =
      session.zoomFitMode === GRADING_ZOOM_MANUAL ? session.manualZoom : 1;
    applyEditorStageLayout({
      stage: editorStage,
      viewport,
      scrollWrap: editorWrap,
      img,
      zoom: layoutZoom,
      fitMode: session.zoomFitMode,
    });
    const { w, h } = measureDisplayedImage(img, layoutZoom);
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    svg.style.width = `${w}px`;
    svg.style.height = `${h}px`;
    const pg = draft.pages[session.pageIndex] || { annotations: [] };
    let annotations = pg.annotations;
    if (session.eraserGesture?.preSnapshot && session.eraserGesture.pageIndex === session.pageIndex) {
      annotations = applyEraserToAnnotations(
        JSON.parse(session.eraserGesture.preSnapshot),
        [...(session.eraserGesture.touchedIds || [])],
      );
    }
    const editingId = session.inlineTextEditor?.markId;
    const interactive =
      !readOnly &&
      session.pageImageReady &&
      session.mode === 'annotate' &&
      session.tool !== 'pan' &&
      session.tool !== 'view' &&
      !session.inlineTextEditor;
    svg.classList.toggle('interactive', interactive);
    fillAnnotationSvg(svg, annotations, w, h, {
      selectedId: session.selectedMarkId,
      textLayoutOptions: gradingTextLayoutOptions(),
      hideTextId: editingId,
    });
    mountPageCommentList(pageCommentList, pg.annotations, {
      selectedId: session.selectedMarkId,
      editable: !readOnly && !gradingMutating.isBusy(),
      onEdit: openEditPinDialog,
      onDelete: deletePinComment,
    });
    const pinCount = listPinComments(pg.annotations).length;
    pageCommentWrap.hidden = pinCount === 0;
    commentsToggleBtn.hidden = pinCount === 0;
    pageCommentList.classList.toggle('page-comment-drawer', pinCount > 0);
    pageCommentList.classList.toggle('is-expanded', !!session.commentsDrawerOpen);
    commentsToggleBtn.setAttribute('aria-expanded', session.commentsDrawerOpen ? 'true' : 'false');
    commentsToggleBtn.textContent = session.commentsDrawerOpen
      ? 'Ẩn nhận xét trang'
      : 'Nhận xét trang';
    if (!readOnly) {
      const mutating = gradingMutating.isBusy();
      editCommentBtn.disabled = mutating || !selectedPinMark();
      editTextBtn.disabled = mutating || !selectedTextMark();
      const stack = getStack();
      undoBtn.disabled =
        mutating ||
        readOnly ||
        !stack.past.length ||
        shouldBlockGradingUndoRedo({ inlineTextEditing: !!session.inlineTextEditor });
      redoBtn.disabled =
        mutating ||
        readOnly ||
        !stack.future.length ||
        shouldBlockGradingUndoRedo({ inlineTextEditing: !!session.inlineTextEditor });
      delBtn.disabled =
        mutating ||
        !session.selectedMarkId ||
        shouldBlockGradingDestructiveActions({ inlineTextEditing: !!session.inlineTextEditor });
    }
    session.inlineTextEditor?.syncPreview?.();
    updateToolbar();
  }

  let queueGradingAutosaveFromGesture = () => {};
  const gestureSettlement = createGradingGestureSettlement({
    getSession: () => session,
    getDraft: () => draft,
    getVersionId: () => version.versionId,
    getPageIndex: () => session.pageIndex,
    measureDisplaySize: () => measureDisplayedImage(img, layoutZoomLevel()),
    pushUndo,
    getUndoStack: (pageIndex) => {
      const key = String(pageIndex);
      if (!draft.undoStacks[key]) {
        draft.undoStacks[key] = { past: [], future: [] };
      }
      return draft.undoStacks[key];
    },
    renderOverlay,
    uid,
    queueAutosave: () => queueGradingAutosaveFromGesture(),
    releasePointerCapture: (pointerId) => svg.releasePointerCapture(pointerId),
  });

  function imagePointerCoords(e) {
    const { w, h, rect, z } = measureDisplayedImage(img, layoutZoomLevel());
    return {
      x: (e.clientX - rect.left) / z,
      y: (e.clientY - rect.top) / z,
      w,
      h,
    };
  }

  function resolveDirectTextHit(annotations, x, y, w, h, layoutOpts, hitOpts, preferredId) {
    const list = annotations || [];
    if (preferredId) {
      const selected = list.find((m) => m.id === preferredId && m.type === 'text');
      if (selected) {
        const handle = hitTestDirectTextHandle(selected, x, y, w, h, hitOpts);
        if (handle) return { mark: selected, handle };
      }
    }
    const hit = hitTestAnnotationAt(list, x, y, w, h, layoutOpts);
    if (hit?.type === 'text') {
      const handle = hitTestDirectTextHandle(hit, x, y, w, h, hitOpts);
      return { mark: hit, handle };
    }
    return { mark: hit, handle: null };
  }

  function beginDirectTextHandleGesture(e, hit, handle, x, y, w, h, layoutOpts) {
    if (!hit || hit.type !== 'text' || !handle) return false;
    session.selectedMarkId = hit.id;
    const preUndoStacks = capturePageUndoSnapshot(session.pageIndex);
    if (handle === 'resize-e' || handle === 'resize-se') {
      e.preventDefault();
      const box = layoutDirectTextBox(hit, w, h, layoutOpts);
      const nw =
        hit.textWidthNorm != null ? hit.textWidthNorm : computeDirectTextWidthNormFromPixelWidth(box.w, w);
      session.drag = {
        type: 'text-resize',
        mode: 'e',
        pointerId: e.pointerId,
        id: hit.id,
        origNx: hit.nx,
        origNw: nw,
        startX: x,
        origSnapshot: JSON.stringify(hit),
        preUndoStacks,
        w,
        h,
        didUndo: false,
        generation: session.gestureGeneration,
      };
      svg.setPointerCapture(e.pointerId);
      return true;
    }
    if (handle === 'resize-w') {
      e.preventDefault();
      const box = layoutDirectTextBox(hit, w, h, layoutOpts);
      const nw =
        hit.textWidthNorm != null ? hit.textWidthNorm : computeDirectTextWidthNormFromPixelWidth(box.w, w);
      session.drag = {
        type: 'text-resize',
        mode: 'w',
        pointerId: e.pointerId,
        id: hit.id,
        origNx: hit.nx,
        origNw: nw,
        origRightNx: hit.nx + nw,
        startX: x,
        origSnapshot: JSON.stringify(hit),
        preUndoStacks,
        w,
        h,
        didUndo: false,
        generation: session.gestureGeneration,
      };
      svg.setPointerCapture(e.pointerId);
      return true;
    }
    if (handle === 'move') {
      e.preventDefault();
      session.drag = {
        type: 'text-move',
        pointerId: e.pointerId,
        id: hit.id,
        startX: x,
        startY: y,
        origNx: hit.nx,
        origNy: hit.ny,
        origSnapshot: JSON.stringify(hit),
        preUndoStacks,
        w,
        h,
        didUndo: false,
        generation: session.gestureGeneration,
      };
      svg.setPointerCapture(e.pointerId);
      return true;
    }
    return false;
  }

  svg.addEventListener('pointerdown', (e) => {
    if (gradingMutating.isBusy()) return;
    if (readOnly || !session.pageImageReady || session.mode === 'view' || session.tool === 'pan') return;
    if (session.inlineTextEditor) return;
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    if (session.penGesture || session.eraserGesture) return;
    if (session.drag?.type === 'text-move' || session.drag?.type === 'text-resize') return;
    const { x, y, w, h } = imagePointerCoords(e);
    const layoutOpts = gradingTextLayoutOptions();
    const hitOpts = directTextHandleHitOptions(layoutOpts);

    if (session.tool === 'eraser') {
      e.preventDefault();
      svg.setPointerCapture(e.pointerId);
      const pg = draft.pages[session.pageIndex];
      const touchedIds = new Set(
        collectPenIdsForEraserPath(pg.annotations, [{ x, y }], w, h, hitOpts),
      );
      session.eraserGesture = {
        pointerId: e.pointerId,
        pageIndex: session.pageIndex,
        versionId: version.versionId,
        imageLoadSeq: session.imageLoadSeq,
        preSnapshot: JSON.stringify(pg.annotations),
        touchedIds,
        points: [{ x, y }],
        w,
        h,
      };
      renderOverlay();
      return;
    }

    if (session.tool === 'pen') {
      if (session.penGesture) return;
      e.preventDefault();
      svg.setPointerCapture(e.pointerId);
      const livePath = svgEl('path', {
        class: 'mark-pen mark-pen-live',
        fill: 'none',
        stroke: session.inkColor,
        'stroke-width': penStrokeWidthNorm() * w,
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
      });
      svg.appendChild(livePath);
      session.penGesture = {
        pointerId: e.pointerId,
        pageIndex: session.pageIndex,
        versionId: version.versionId,
        imageLoadSeq: session.imageLoadSeq,
        w,
        h,
        color: session.inkColor,
        nw: penStrokeWidthNorm(),
        points: [{ x, y }],
        livePath,
      };
      livePath.setAttribute('d', buildPenPathD([{ x, y }, { x: x + 0.01, y }]));
      return;
    }

    if (session.tool === 'select') {
      const pg = draft.pages[session.pageIndex];
      const { mark: hit, handle } = resolveDirectTextHit(
        pg.annotations,
        x,
        y,
        w,
        h,
        layoutOpts,
        hitOpts,
        session.selectedMarkId,
      );
      session.selectedMarkId = hit?.id || null;
      if (hit?.type === 'text' && handle) {
        if (beginDirectTextHandleGesture(e, hit, handle, x, y, w, h, layoutOpts)) {
          renderOverlay();
          return;
        }
      } else {
        session.drag = null;
      }
      renderOverlay();
      return;
    }

    if (session.tool === 'highlight') {
      e.preventDefault();
      session.gestureGeneration += 1;
      const gen = session.gestureGeneration;
      session.drag = {
        type: 'highlight',
        pointerId: e.pointerId,
        generation: gen,
        x,
        y,
        x2: x,
        y2: y,
        frozenW: w,
        frozenH: h,
      };
      svg.setPointerCapture(e.pointerId);
      return;
    }

    const pg = draft.pages[session.pageIndex];
    if (session.tool === 'text') {
      const { mark: hit, handle } = resolveDirectTextHit(
        pg.annotations,
        x,
        y,
        w,
        h,
        layoutOpts,
        hitOpts,
        session.selectedMarkId,
      );
      if (hit?.type === 'text' && handle) {
        if (beginDirectTextHandleGesture(e, hit, handle, x, y, w, h, layoutOpts)) {
          renderOverlay();
          return;
        }
      }
      if (hit?.type === 'text') {
        e.preventDefault();
        session.selectedMarkId = hit.id;
        openEditTextDialog(hit.id);
        renderOverlay();
        return;
      }
      e.preventDefault();
      openInlineTextEditor({
        anchorX: x,
        anchorY: y,
        color: session.inkColor,
        fontSizeNorm: session.textFontSize / h,
      });
      return;
    }

    if (session.tool === 'check' || session.tool === 'cross') {
      pushUndo();
      pg.annotations.push(
        markToNormalized({ id: uid(), type: session.tool, x, y }, w, h),
      );
      renderOverlay();
      saveGradingDraft(false);
    } else if (session.tool === 'pin') {
      const pending = { x, y, w, h };
      openPinCommentDialog((text) => {
        if (gradingMutating.isBusy()) return;
        pushUndo();
        pg.annotations.push(
          markToNormalized(
            { id: uid(), type: 'pin', x: pending.x, y: pending.y, text: safeText(text) },
            pending.w,
            pending.h,
          ),
        );
        renderOverlay();
        saveGradingDraft(false);
      });
    }
  });

  svg.addEventListener('dblclick', (e) => {
    if (gradingMutating.isBusy()) return;
    if (readOnly || session.inlineTextEditor) return;
    if (session.tool !== 'select' && session.tool !== 'text') return;
    const { x, y, w, h } = imagePointerCoords(e);
    const pg = draft.pages[session.pageIndex];
    const hit = hitTestAnnotationAt(pg.annotations, x, y, w, h, gradingTextLayoutOptions());
    if (hit?.type === 'text') openEditTextDialog(hit.id);
  });

  svg.addEventListener('pointermove', (e) => {
    if (readOnly) return;
    const { x, y, w, h } = imagePointerCoords(e);

    if (session.penGesture && session.penGesture.pointerId === e.pointerId) {
      if (
        session.penGesture.pageIndex !== session.pageIndex ||
        session.penGesture.versionId !== version.versionId ||
        session.penGesture.imageLoadSeq !== session.imageLoadSeq
      ) {
        cancelPenGesture();
        return;
      }
      const fw = session.penGesture.w;
      const fh = session.penGesture.h;
      if (Math.abs(w - fw) > 0.5 || Math.abs(h - fh) > 0.5) {
        cancelPenGesture();
        return;
      }
      const pts = session.penGesture.points;
      session.penGesture.points = appendLivePenPixelPoint(pts, x, y, fw, fh);
      session.penGesture.livePath.setAttribute(
        'd',
        buildPenPathD(session.penGesture.points),
      );
      return;
    }

    if (session.eraserGesture && session.eraserGesture.pointerId === e.pointerId) {
      if (
        session.eraserGesture.pageIndex !== session.pageIndex ||
        session.eraserGesture.versionId !== version.versionId ||
        session.eraserGesture.imageLoadSeq !== session.imageLoadSeq
      ) {
        cancelEraserGesture(true);
        return;
      }
      const g = session.eraserGesture;
      const fw = g.w;
      const fh = g.h;
      if (Math.abs(w - fw) > 0.5 || Math.abs(h - fh) > 0.5) {
        cancelEraserGesture(true);
        return;
      }
      const last = g.points[g.points.length - 1];
      if (Math.hypot(last.x - x, last.y - y) > 2) {
        g.points.push({ x, y });
        for (const id of collectPenIdsForEraserPath(
          JSON.parse(g.preSnapshot),
          g.points,
          fw,
          fh,
          { ...gradingTextLayoutOptions(), zoom: layoutZoomLevel() },
        )) {
          g.touchedIds.add(id);
        }
        renderOverlay();
      }
      return;
    }

    if (session.drag?.type === 'text-resize') {
      if (session.drag.pointerId !== e.pointerId) return;
      if (session.drag.generation !== session.gestureGeneration) return;
      const fw = session.drag.w;
      const fh = session.drag.h;
      if (gradingDisplayedImageSizeChanged(fw, fh, w, h)) {
        cancelTextDragGesture();
        return;
      }
      const dx = x - (session.drag.startX ?? x);
      if (!session.drag.didUndo && Math.abs(dx) > 3) {
        pushUndo();
        session.drag.didUndo = true;
      }
      if (!session.drag.didUndo) return;
      const pg = draft.pages[session.pageIndex];
      const layoutOpts = gradingTextLayoutOptions();
      const mark = pg.annotations.find((m) => m.id === session.drag.id && m.type === 'text');
      if (!mark) return;
      if (session.drag.mode === 'e') {
        const box = layoutDirectTextBox(mark, w, h, layoutOpts);
        const newW = Math.max(24, x - box.x);
        const textWidthNorm = computeDirectTextWidthNormFromPixelWidth(newW, w);
        const candidate = resizeDirectTextAnnotation(
          pg.annotations,
          session.drag.id,
          { textWidthNorm },
          w,
          h,
          layoutOpts,
        );
        const updated = candidate.find((m) => m.id === session.drag.id && m.type === 'text');
        if (
          updated &&
          validateDirectTextPlacement(updated, w, h, layoutOpts).ok
        ) {
          pg.annotations = candidate;
        }
      } else if (session.drag.mode === 'w') {
        const newNx = Math.max(0, Math.min(session.drag.origRightNx - 0.06, x / w));
        const textWidthNorm = Math.max(0.06, session.drag.origRightNx - newNx);
        const candidate = resizeDirectTextAnnotation(
          pg.annotations,
          session.drag.id,
          { nx: newNx, textWidthNorm },
          w,
          h,
          layoutOpts,
        );
        const updated = candidate.find((m) => m.id === session.drag.id && m.type === 'text');
        if (
          updated &&
          validateDirectTextPlacement(updated, w, h, layoutOpts).ok
        ) {
          pg.annotations = candidate;
        }
      }
      renderOverlay();
      return;
    }

    if (session.drag?.type === 'text-move') {
      if (session.drag.pointerId !== e.pointerId) return;
      if (session.drag.generation !== session.gestureGeneration) return;
      const fw = session.drag.w;
      const fh = session.drag.h;
      if (gradingDisplayedImageSizeChanged(fw, fh, w, h)) {
        cancelTextDragGesture();
        return;
      }
      const dx = x - session.drag.startX;
      const dy = y - session.drag.startY;
      if (!session.drag.didUndo && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) {
        pushUndo();
        session.drag.didUndo = true;
      }
      if (!session.drag.didUndo) return;
      const pg = draft.pages[session.pageIndex];
      const nx = session.drag.origNx + dx / w;
      const ny = session.drag.origNy + dy / h;
      pg.annotations = moveDirectTextAnnotation(
        pg.annotations,
        session.drag.id,
        nx,
        ny,
        w,
        h,
        gradingTextLayoutOptions(),
      );
      renderOverlay();
      return;
    }

    if (!session.drag || session.drag.type !== 'highlight') return;
    if (session.drag.pointerId !== e.pointerId) return;
    if (session.drag.generation !== session.gestureGeneration) return;
    session.drag.x2 = x;
    session.drag.y2 = y;
  });

  function finishPenPointer(e) {
    gestureSettlement.finishPenPointer(e);
  }

  svg.addEventListener('pointerup', (e) => {
    if (readOnly) return;
    if (session.penGesture) {
      finishPenPointer(e);
      return;
    }
    if (session.eraserGesture?.pointerId === e.pointerId) {
      gestureSettlement.finishEraserPointer(e);
      return;
    }
    if (session.drag?.type === 'text-move' || session.drag?.type === 'text-resize') {
      if (session.drag.pointerId !== e.pointerId) return;
      if (session.drag.generation !== session.gestureGeneration) {
        session.drag = null;
        return;
      }
      try {
        svg.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      session.drag = null;
      renderOverlay();
      saveGradingDraft(false);
      return;
    }
    if (!session.drag || session.drag.type !== 'highlight') return;
    if (session.drag.pointerId !== e.pointerId) return;
    if (session.drag.generation !== session.gestureGeneration) return;
    try {
      svg.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    const w = session.drag.frozenW ?? measureDisplayedImage(img, layoutZoomLevel()).w;
    const h = session.drag.frozenH ?? measureDisplayedImage(img, layoutZoomLevel()).h;
    pushUndo();
    const x = Math.min(session.drag.x, session.drag.x2);
    const y = Math.min(session.drag.y, session.drag.y2);
    const rw = Math.abs(session.drag.x2 - session.drag.x);
    const rh = Math.abs(session.drag.y2 - session.drag.y);
    if (rw >= 3 && rh >= 3) {
      draft.pages[session.pageIndex].annotations.push(
        markToNormalized({ id: uid(), type: 'highlight', x, y, w: rw, h: rh }, w, h),
      );
      saveGradingDraft(false);
    }
    session.drag = null;
    renderOverlay();
  });

  svg.addEventListener('pointercancel', (e) => {
    if (session.penGesture?.pointerId === e.pointerId) {
      cancelPenGesture();
    }
    if (session.eraserGesture?.pointerId === e.pointerId) {
      cancelEraserGesture();
    }
    if (session.drag?.type === 'highlight' && session.drag.pointerId === e.pointerId) {
      cancelHighlightGesture();
    }
    if (
      (session.drag?.type === 'text-move' || session.drag?.type === 'text-resize') &&
      session.drag.pointerId === e.pointerId
    ) {
      restoreCanceledTextGesture(session.drag);
      session.drag = null;
      renderOverlay();
    }
  });

  svg.addEventListener('lostpointercapture', (e) => {
    if (session.penGesture?.pointerId === e.pointerId) {
      cancelPenGesture();
    }
    if (session.eraserGesture?.pointerId === e.pointerId) {
      cancelEraserGesture();
    }
    if (session.drag?.type === 'highlight' && session.drag.pointerId === e.pointerId) {
      cancelHighlightGesture();
    }
    if (
      (session.drag?.type === 'text-move' || session.drag?.type === 'text-resize') &&
      session.drag.pointerId === e.pointerId
    ) {
      restoreCanceledTextGesture(session.drag);
      session.drag = null;
      renderOverlay();
    }
  });

  async function persistGradingDraft(explicit, { settleGestures = true } = {}) {
    if (explicit && !isGradingEditorLive(session)) return false;
    if (settleGestures) gestureSettlement.settleGradingGesturesIntoDraft();
    draft.score = scoreInput.value;
    draft.overallFeedback = feedbackInput.value;
    if (version.status === SUBMISSION_STATUS.SUBMITTED) {
      version.status = SUBMISSION_STATUS.GRADING;
    }
    if (explicit && !isGradingEditorLive(session)) return false;
    const activeSession = session;
    let persistCaptureToken = null;
    if (gradingDirtyTracker) {
      persistCaptureToken = gradingDirtyTracker.captureForPersist(
        draft,
        scoreInput.value,
        feedbackInput.value,
      );
    }
    const acknowledgeGradingDraftPersist = () => {
      if (!isGradingEditorLive(activeSession)) return;
      if (gradingDirtyTracker && persistCaptureToken) {
        gradingDirtyTracker.markAcknowledgedFromCapture(persistCaptureToken);
        bumpDirtyNavigationGuard();
      }
    };
    const ok = await persistWithStatus(() => put('submissions', sub), {
      silent: !explicit,
      successToast: explicit ? 'Đã lưu nháp chấm.' : null,
      ...gradingDraftPersistOptions(),
      onPersistSuccess: acknowledgeGradingDraftPersist,
    });
    if (explicit && !ok && isGradingEditorLive(session)) {
      scoreErr.textContent = 'Không lưu được.';
    }
    return ok;
  }

  queueGradingAutosaveFromGesture = () => {
    bumpDirtyNavigationGuard();
    gradingMutating.queueAutosaveDraft(() => persistGradingDraft(false, { settleGestures: false }));
  };

  async function saveGradingDraft(showMsg) {
    if (readOnly) return;
    if (showMsg) {
      const ran = await gradingMutating.runExplicitAction(() => persistGradingDraft(true));
      if (ran.skipped) return;
      return;
    }
    gradingMutating.queueAutosaveDraft(() => persistGradingDraft(false));
  }

  async function publishGrading(needsRevision) {
    if (readOnly) return;
    if (gradingMutating.isBusy()) return;
    scoreErr.textContent = '';
    if (blockIfPendingInlineEdit()) return;
    const validated = validateScore(scoreInput.value);
    if (!validated.ok) {
      scoreErr.textContent = validated.error;
      return;
    }

    const activeSession = session;
    const publishToast = needsRevision
      ? 'Đã yêu cầu học sinh làm lại.'
      : 'Đã trả bài.';
    const ran = await gradingMutating.runExplicitAction(async () => {
      if (!isGradingEditorLive(activeSession)) return { didPublish: false };
      gestureSettlement.settleGradingGesturesIntoDraft();
      closeInlineTextEditor(true);
      draft.score = validated.value;
      draft.overallFeedback = feedbackInput.value;
      version.grading = {
        score: validated.value,
        overallFeedback: draft.overallFeedback,
        published: true,
        publishedAt: new Date().toISOString(),
        needsRevision,
        pages: draft.pages.map((p) => ({
          annotations: p.annotations.map((m) => ({ ...m })),
        })),
      };
      version.status = needsRevision ? SUBMISSION_STATUS.NEEDS_REVISION : SUBMISSION_STATUS.RETURNED;
      if (!isGradingEditorLive(activeSession)) return { didPublish: false };
      let publishCaptureToken = null;
      if (gradingDirtyTracker) {
        publishCaptureToken = gradingDirtyTracker.captureForPersist(
          draft,
          validated.value,
          feedbackInput.value,
        );
      }
      gradingMutating.clearDeferredAutosave();
      const acknowledgeGradingPublish = () => {
        if (!isGradingEditorLive(activeSession)) return;
        if (gradingDirtyTracker && publishCaptureToken) {
          gradingDirtyTracker.markAcknowledgedFromCapture(publishCaptureToken);
          bumpDirtyNavigationGuard();
        }
      };
      const ok = await persistWithStatus(async () => {
        await put('submissions', sub);
      }, {
        successToast: publishToast,
        ...gradingPublishPersistOptions(),
        onPersistSuccess: acknowledgeGradingPublish,
      });
      if (!ok) {
        if (isGradingEditorLive(activeSession)) {
          scoreErr.textContent = 'Không lưu được — thử lại.';
        }
        return { didPublish: false };
      }
      if (!isGradingEditorLive(activeSession)) return { didPublish: false };
      gradingMutating.clearDeferredAutosave();
      return { didPublish: true };
    });
    if (shouldNavigateAfterGradingPublish(ran, {
      isBusy: () => gradingMutating.isBusy(),
      isEditorLive: () => isGradingEditorLive(activeSession),
    })) {
      window.removeEventListener('keydown', gradingKeyHandler);
      navigate('#/grading');
      render();
    }
  }

  if (disposeGradingEditor) disposeGradingEditor();
  disposeGradingEditor = () => {
    gradingMutating.dispose();
    registerDirtyProbe(null);
    window.removeEventListener('keydown', gradingKeyHandler);
    applyGradingFocusMode(document, false);
    saveStatusObserver.disconnect();
    if (editorLayoutRo) editorLayoutRo.disconnect();
    if (mobileSheetMq && onMobileSheetViewportChange) {
      mobileSheetMq.removeEventListener('change', onMobileSheetViewportChange);
    }
    cancelPenGesture();
    cancelEraserGesture(true);
    closeInlineTextEditor(true);
    closeGradingTextDialog();
  };
  window.addEventListener('keydown', gradingKeyHandler);

  loadPage();
}

function openDialog(title, bodyNodes, actions, options = {}) {
  const root = document.getElementById('dialog-root');
  clear(root);
  const dialogGeneration = ++activeDialogGeneration;
  const dialogOpenEpoch = getRequestEpoch();
  const backdrop = el('div', {
    className: 'dialog-backdrop',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-labelledby': 'dlg-title',
  });
  if (options.dialogKind) {
    backdrop.dataset.dialogKind = options.dialogKind;
  }
  let disposeA11y = null;
  let skipDirtyCheck = false;
  const focusOpener = document.activeElement;
  /** @type {{ disposeA11y: () => void, onAfterClose: (() => void)|undefined, cancelOwnedWork: (() => void)|undefined }} */
  const routeHostBindings = {
    disposeA11y: () => {
      if (!disposeA11y) return;
      disposeA11y();
      disposeA11y = null;
    },
    onAfterClose: options.onAfterClose,
    cancelOwnedWork: options.cancelOwnedWork,
  };
  const isCurrentDialogHost = () => {
    if (dialogGeneration !== activeDialogGeneration) return false;
    if (isStaleEpoch(dialogOpenEpoch)) return false;
    if (!backdrop.isConnected) return false;
    if (root.firstElementChild !== backdrop) return false;
    return true;
  };
  const close = () => {
    if (!isCurrentDialogHost()) return;
    if (options.onBeforeClose && options.onBeforeClose() === false) return;
    if (!skipDirtyCheck && options.isDirty?.() && !confirmDiscard()) return;
    disposeA11y?.();
    disposeA11y = null;
    clear(root);
    if (dialogGeneration === activeDialogGeneration) activeDialogGeneration += 1;
    options.onAfterClose?.();
    clearModalRouteHost(routeHostBindings);
  };
  const closeAfterSave = () => {
    if (!isCurrentDialogHost()) return false;
    skipDirtyCheck = true;
    close();
    return true;
  };
  bindModalRouteHost(routeHostBindings);
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) close();
  });
  const dialog = el('div', { className: 'dialog' });
  dialog.appendChild(
    el('div', { className: 'dialog-header' },
      el('h2', { id: 'dlg-title' }, title),
      el('button', { type: 'button', className: 'icon-btn', 'aria-label': 'Đóng', onClick: () => close() }, '×'),
    ),
  );
  for (const n of bodyNodes) dialog.appendChild(n);
  const actionRow = el('div', { className: 'dialog-actions' });
  for (const act of actions) actionRow.appendChild(act);
  dialog.appendChild(actionRow);
  backdrop.appendChild(dialog);
  root.appendChild(backdrop);
  disposeA11y = wireDialogA11y({
    backdrop,
    dialog,
    titleId: 'dlg-title',
    onRequestClose: close,
    isDirty: options.isDirty,
    initialFocus: options.focusPrimary ? actionRow.querySelector('.btn-primary') : null,
    focusOpener,
  });
  return { close, closeAfterSave, isCurrentDialogHost };
}

function openClassDialog() {
  if (!isTeacher()) return;
  const err = el('div', { className: 'form-error', role: 'alert' });
  const name = el('input', { type: 'text', id: 'class-name', required: true, autocomplete: 'off' });
  const time = el('input', { type: 'time', id: 'class-time', value: '19:00', required: true });
  const days = ['Thứ 2', 'Thứ 3', 'Thứ 4', 'Thứ 5', 'Thứ 6', 'Thứ 7', 'Chủ nhật'];
  const dayChecks = days.map((d) => {
    const id = `day-${d}`;
    return el('label', { style: 'display:block', htmlFor: id },
      el('input', { type: 'checkbox', value: d, id }),
      ` ${d}`,
    );
  });
  let createBtn;
  const dayInputs = dayChecks.map((lab) => lab.querySelector('input'));
  const isDirty = snapshotFormDirty([name, time, ...dayInputs]);
  registerDirtyProbe(isDirty, { fields: [name, time, ...dayInputs] });
  let pendingCreateId = null;
  let pendingCreateCreatedAt = null;
  let dialogActive = true;
  const formFieldset = el('fieldset', { className: 'dialog-form-body' });
  const formLock = createFormPendingLock({
    fieldsetRoot: formFieldset,
    controls: [name, time, ...dayInputs],
  });
  const { close, closeAfterSave, isCurrentDialogHost } = openDialog(
    'Tạo lớp mới',
    [
      err,
      formFieldset,
    ],
    [
      createBtn = el('button', { type: 'button', className: 'btn btn-primary', onClick: async () => {
        const ran = await formLock.run(async () => {
          const prevLabel = createBtn.textContent;
          createBtn.textContent = 'Đang tạo…';
          createBtn.setAttribute('aria-busy', 'true');
          try {
            err.textContent = '';
            const selected = dayChecks
              .map((lab) => lab.querySelector('input'))
              .filter((i) => i.checked)
              .map((i) => i.value);
            const v = validateClassInput({ name: name.value, scheduleDays: selected, scheduleTime: time.value });
            if (!v.ok) { err.textContent = v.error; name.focus(); return false; }
            const dup = findDuplicateClassName(state.data.classes, name.value);
            if (dup && !confirm(`Đã có lớp "${dup.name}" với tên tương tự. Vẫn tạo lớp mới?`)) return false;
            if (!pendingCreateId) {
              pendingCreateId = uid();
              pendingCreateCreatedAt = new Date().toISOString();
            }
            const rec = {
              id: pendingCreateId,
              name: name.value.trim(),
              scheduleDays: selected,
              scheduleTime: time.value,
              createdAt: pendingCreateCreatedAt,
            };
            const formMatchesAcknowledgedSnapshot = captureAcknowledgedFormSnapshot(() => ({
              name: name.value,
              time: time.value,
              days: dayChecks
                .map((lab) => lab.querySelector('input'))
                .filter((i) => i.checked)
                .map((i) => i.value)
                .sort(),
            }));
            const ok = await persistWithStatus(() => put('classes', rec), {
              successToast: `Đã tạo lớp "${rec.name}".`,
              logicalKey: `class:create:${pendingCreateId}`,
              replayPayloadSignature: replayPayloadSignature(rec),
              onPersistSuccess: () => {
                pendingCreateId = null;
                pendingCreateCreatedAt = null;
                if (closePendingFormDialogAfterSuccessfulSave({
                  isDialogActive: () => dialogActive,
                  isDialogHostLive: isCurrentDialogHost,
                  formLock,
                  formMatchesAcknowledgedSnapshot,
                  onFormChangedSinceAcknowledged: () => {
                    err.textContent = 'Đã lưu bản trước trên máy chủ — form vẫn giữ thay đổi mới của bạn.';
                  },
                  onAcknowledged: () => { isDirty.markClean(); },
                  closeAfterSave,
                })) {
                  render();
                }
              },
            });
            return ok;
          } finally {
            createBtn.textContent = prevLabel;
            createBtn.removeAttribute('aria-busy');
          }
        });
        if (ran.skipped) return;
      }}, 'Tạo'),
      el('button', { type: 'button', className: 'btn btn-ghost', onClick: () => close() }, 'Hủy'),
    ],
    {
      isDirty,
      onBeforeClose: () => {
        if (formLock.isPending()) {
          err.textContent = 'Đang tạo lớp, vui lòng đợi hoàn tất.';
          return false;
        }
        return true;
      },
      onAfterClose: () => {
        dialogActive = false;
        registerDirtyProbe(null);
      },
    },
  );
  formFieldset.append(
    el('div', { className: 'form-field' },
      el('label', { htmlFor: 'class-name' }, 'Tên lớp *'),
      name,
      el('p', { className: 'form-hint' }, 'Ví dụ: IELTS 6.5 — Thứ 3, 5'),
    ),
    el('div', { className: 'form-field' },
      el('label', { htmlFor: 'class-time' }, 'Giờ học *'),
      time,
    ),
    el('div', { className: 'form-field' },
      el('label', {}, 'Buổi trong tuần *'),
      ...dayChecks,
    ),
  );
}

function openStudentDialog(defaultClassId = '') {
  if (!isTeacher()) return;
  const err = el('div', { className: 'form-error', role: 'alert' });
  const name = el('input', { type: 'text', id: 'student-name', required: true, autocomplete: 'name' });
  const cls = el('select', { id: 'student-class', required: true });
  const preferred = defaultClassId || state.classFilterId || state.route.classId || '';
  for (const c of state.data.classes) {
    const opt = el('option', { value: c.id }, c.name);
    if (c.id === preferred) opt.selected = true;
    cls.appendChild(opt);
  }
  let addBtn;
  const isDirty = snapshotFormDirty([name, cls]);
  registerDirtyProbe(isDirty, { fields: [name, cls] });
  let pendingCreateId = null;
  let dialogActive = true;
  const formFieldset = el('fieldset', { className: 'dialog-form-body' });
  const formLock = createFormPendingLock({
    fieldsetRoot: formFieldset,
    controls: [name, cls],
  });
  const { close, closeAfterSave, isCurrentDialogHost } = openDialog(
    'Thêm học sinh',
    [
      err,
      formFieldset,
    ],
    [
      addBtn = el('button', {
        type: 'button',
        className: 'btn btn-primary',
        onClick: async () => {
          const ran = await formLock.run(async () => {
            const prevLabel = addBtn.textContent;
            addBtn.textContent = 'Đang thêm…';
            addBtn.setAttribute('aria-busy', 'true');
            try {
              err.textContent = '';
              const v = validateStudentInput({ name: name.value, classId: cls.value });
              if (!v.ok) { err.textContent = v.error; name.focus(); return false; }
              const dup = findDuplicateStudentName(state.data.students, cls.value, name.value);
              if (dup && !confirm(`Trong lớp này đã có học sinh "${dup.name}" (tên giống nhau). Vẫn thêm?`)) return false;
              if (!pendingCreateId) pendingCreateId = uid();
              const st = { id: pendingCreateId, name: name.value.trim(), classId: cls.value };
              const formMatchesAcknowledgedSnapshot = captureAcknowledgedFormSnapshot(() => ({
                name: name.value,
                classId: cls.value,
              }));
              const ok = await persistWithStatus(() => put('students', st), {
                successToast: 'Đã thêm học sinh.',
                logicalKey: `student:create:${pendingCreateId}`,
                replayPayloadSignature: replayPayloadSignature(st),
                onPersistSuccess: () => {
                  pendingCreateId = null;
                  if (closePendingFormDialogAfterSuccessfulSave({
                    isDialogActive: () => dialogActive,
                    isDialogHostLive: isCurrentDialogHost,
                    formLock,
                    formMatchesAcknowledgedSnapshot,
                    onFormChangedSinceAcknowledged: () => {
                      err.textContent = 'Đã lưu bản trước trên máy chủ — form vẫn giữ thay đổi mới của bạn.';
                    },
                    onAcknowledged: () => { isDirty.markClean(); },
                    closeAfterSave,
                  })) {
                    render();
                  }
                },
              });
              return ok;
            } finally {
              addBtn.textContent = prevLabel;
              addBtn.removeAttribute('aria-busy');
            }
          });
          if (ran.skipped) return;
        },
      }, 'Thêm'),
      el('button', { type: 'button', className: 'btn btn-ghost', onClick: () => close() }, 'Hủy'),
    ],
    {
      isDirty,
      onBeforeClose: () => {
        if (formLock.isPending()) {
          err.textContent = 'Đang thêm học sinh, vui lòng đợi hoàn tất.';
          return false;
        }
        return true;
      },
      onAfterClose: () => {
        dialogActive = false;
        registerDirtyProbe(null);
      },
    },
  );
  formFieldset.append(
    el('div', { className: 'form-field' },
      el('label', { htmlFor: 'student-name' }, 'Tên học sinh *'),
      name,
    ),
    el('div', { className: 'form-field' },
      el('label', { htmlFor: 'student-class' }, 'Lớp *'),
      cls,
    ),
  );
}

function openAssignmentDialog(existing = null) {
  if (!isTeacher()) return;
  const editing = !!existing;
  const assignmentFormUid = existing?.id ?? uid();
  const err = el('div', { className: 'form-error' });
  const title = el('input', { type: 'text', id: `assignment-title-${assignmentFormUid}`, value: existing?.title || '' });
  const cls = el('select', { id: `assignment-class-${assignmentFormUid}` });
  const defaultClassId = resolveNewAssignmentClassId(state.data.classes, {
    editing,
    existingClassId: existing?.classId,
    classFilterId: state.classFilterId,
    routeClassId: state.route.classId,
  });
  for (const c of state.data.classes) {
    const opt = el('option', { value: c.id }, c.name);
    if (c.id === defaultClassId) opt.selected = true;
    cls.appendChild(opt);
  }
  const book = el('input', {
    type: 'text',
    id: `assignment-book-${assignmentFormUid}`,
    value: existing?.bookRef || '',
    placeholder: 'Tùy chọn nếu đã đính kèm tệp',
  });
  const due = el('input', { type: 'date', id: `assignment-due-${assignmentFormUid}`, value: existing?.dueDateISO || '' });
  const pages = el('input', {
    type: 'number',
    min: '1',
    id: `assignment-pages-${assignmentFormUid}`,
    value: String(existing?.requiredPageCount ?? 2),
  });
  const instr = el('textarea', { id: `assignment-instr-${assignmentFormUid}` },
    existing?.instructions
    || 'Có thể giao bài bằng tệp đính kèm (PDF, Word, ảnh) và/hoặc sách/trang. Học sinh vẫn nộp bài bằng ảnh chụp trang làm.',
  );
  const pendingIds = [...(existing?.attachmentIds || [])];
  const pendingMeta = new Map();
  for (const att of existing?.attachments || []) {
    pendingMeta.set(att.id, { ...att });
  }
  const uploadProgress = el('div', { className: 'attachment-upload-progress', hidden: true });
  const attachmentListEl = el('div', { className: 'attachment-list' });
  const fileInput = el('input', {
    type: 'file',
    multiple: true,
    id: `assignment-files-${assignmentFormUid}`,
    accept: ASSIGNMENT_ATTACHMENT_LIMITS.accept,
  });
  const attachmentDirtyBaseline = { ids: [...pendingIds] };
  let dialogActive = true;
  let assignmentSaving = false;
  const formFields = [title, cls, book, due, pages, instr];
  const reservedFingerprints = new Set();
  for (const att of pendingMeta.values()) {
    if (att.contentFingerprint) reservedFingerprints.add(att.contentFingerprint);
  }

  let uploadCtrl;
  uploadCtrl = createAttachmentUploadController({
    uploadFn: uploadTeacherAttachment,
    pendingIds,
    pendingMeta,
    isActive: () => dialogActive,
    canMutate: () => dialogActive && !assignmentSaving,
    onError: (msg) => { err.textContent = msg; },
    refreshList: () => {},
    listEl: attachmentListEl,
    reservedFingerprints,
    onBusyChange: () => syncAssignmentFormUi(),
  });

  const isDirty = snapshotFormDirty(
    formFields,
    () => probeAssignmentAttachmentsDirty(pendingIds, attachmentDirtyBaseline, uploadCtrl),
  );

  registerDirtyProbe(isDirty, {
    fields: [title, cls, book, due, pages, instr, fileInput],
    onQueueTransition: (handler) => uploadCtrl.bindQueueTransition(handler),
  });

  function syncAssignmentFormUi() {
    const uploadBusy = uploadCtrl.isBusy();
    const locked = assignmentSaving || uploadBusy;
    uploadProgress.hidden = !uploadBusy;
    if (uploadBusy) uploadProgress.textContent = 'Đang tải tệp đính kèm…';
    for (const field of formFields) {
      field.disabled = locked;
    }
    fileInput.disabled = locked;
    uploadCtrl.refreshMutability();
    if (saveBtn) {
      saveBtn.disabled = locked || uploadCtrl.hasFailed() || assignmentSaving;
    }
  }

  function onBeforeCloseAssignmentDialog() {
    if (assignmentSaving) {
      err.textContent = 'Đang lưu bài tập, vui lòng đợi hoàn tất.';
      return false;
    }
    if (uploadCtrl.isBusy()) {
      err.textContent = 'Đang tải tệp đính kèm, vui lòng đợi hoàn tất.';
      return false;
    }
    if (uploadCtrl.hasFailed()) {
      err.textContent = 'Có tệp tải lên thất bại — thử lại hoặc xóa trước khi đóng.';
      return false;
    }
    return true;
  }

  function finishAssignmentDialogClose() {
    dialogActive = false;
    registerDirtyProbe(null);
  }

  fileInput.addEventListener('change', () => {
    if (assignmentSaving) return;
    err.textContent = '';
    const files = [...(fileInput.files || [])];
    fileInput.value = '';
    uploadCtrl.enqueueFiles(files);
  });

  let saveBtn;
  let pendingCreateId = null;
  let pendingCreateCreatedAt = null;
  const { close, closeAfterSave, isCurrentDialogHost } = openDialog(
    editing ? 'Sửa bài tập' : 'Tạo bài tập',
    [
      err,
      el('div', { className: 'form-field' }, el('label', { htmlFor: `assignment-title-${assignmentFormUid}` }, 'Tiêu đề'), title),
      el('div', { className: 'form-field' }, el('label', { htmlFor: `assignment-class-${assignmentFormUid}` }, 'Lớp'), cls),
      el('div', { className: 'form-field' },
        el('label', { htmlFor: `assignment-book-${assignmentFormUid}` }, 'Sách / trang (tùy chọn nếu có tệp)'),
        book,
      ),
      el('div', { className: 'form-field' }, el('label', { htmlFor: `assignment-due-${assignmentFormUid}` }, 'Hạn nộp'), due),
      el('div', { className: 'form-field' }, el('label', { htmlFor: `assignment-pages-${assignmentFormUid}` }, 'Số trang ảnh nộp bài'), pages),
      el('div', { className: 'form-field' }, el('label', { htmlFor: `assignment-instr-${assignmentFormUid}` }, 'Hướng dẫn'), instr),
      el('div', { className: 'form-field' },
        el('label', { htmlFor: `assignment-files-${assignmentFormUid}` }, 'Tệp đính kèm (JPG, PNG, WebP, PDF, DOC, DOCX)'),
        el('p', { className: 'form-hint' }, 'Tối đa 10 tệp, 20 MB/tệp. Word chỉ tải về — không xem trong trình duyệt.'),
        fileInput,
        uploadProgress,
        attachmentListEl,
      ),
    ],
    [
      saveBtn = el('button', {
        type: 'button',
        className: 'btn btn-primary',
        onClick: async () => {
          if (assignmentSaving || saveBtn?.disabled) return;
          if (uploadCtrl.hasFailed()) {
            err.textContent = 'Có tệp tải lên thất bại — sửa hoặc xóa trước khi lưu.';
            return;
          }
          if (uploadCtrl.isBusy()) {
            err.textContent = 'Đang tải tệp đính kèm, vui lòng đợi hoàn tất.';
            return;
          }
          err.textContent = '';
          const v = validateAssignmentInput({
            title: title.value,
            classId: cls.value,
            bookRef: book.value,
            dueDateISO: due.value,
            requiredPageCount: pages.value,
            attachmentIds: pendingIds,
          });
          if (!v.ok) { err.textContent = v.error; title.focus(); return; }
          const dup = findDuplicateAssignmentTitle(
            state.data.assignments,
            cls.value,
            title.value,
            existing?.id,
          );
          if (dup && !confirm(`Trong lớp này đã có bài "${dup.title}" với tiêu đề tương tự. Vẫn lưu?`)) return;
          const recId = existing?.id || pendingCreateId || (() => {
            pendingCreateId = uid();
            pendingCreateCreatedAt = new Date().toISOString();
            return pendingCreateId;
          })();
          const rec = {
            id: recId,
            classId: cls.value,
            title: title.value.trim(),
            bookRef: book.value.trim(),
            instructions: instr.value.trim(),
            dueDateISO: due.value,
            requiredPageCount: Number(pages.value),
            attachmentIds: [...pendingIds],
            createdAt: existing?.createdAt || pendingCreateCreatedAt,
          };
          assignmentSaving = true;
          const saveLabel = saveBtn.textContent;
          syncAssignmentFormUi();
          saveBtn.textContent = editing ? 'Đang lưu…' : 'Đang tạo…';
          saveBtn.setAttribute('aria-busy', 'true');
          try {
            await uploadCtrl.waitSettled();
            if (!dialogActive) return;
            if (uploadCtrl.hasFailed()) {
              err.textContent = 'Có tệp tải lên thất bại — sửa hoặc xóa trước khi lưu.';
              return;
            }
            if (uploadCtrl.isBusy()) {
              err.textContent = 'Đang tải tệp đính kèm, vui lòng đợi hoàn tất.';
              return;
            }
            const assignmentReplayKey = editing
              ? `assignment:edit:${rec.id}`
              : `assignment:create:${rec.id}`;
            const formMatchesAcknowledgedSnapshot = captureAcknowledgedFormSnapshot(() => ({
              title: title.value,
              classId: cls.value,
              bookRef: book.value,
              dueDateISO: due.value,
              requiredPageCount: Number(pages.value),
              instructions: instr.value.trim(),
              attachmentIds: [...pendingIds].sort(),
            }));
            const ok = await persistWithStatus(() => put('assignments', rec), {
              successToast: editing ? 'Đã cập nhật bài tập.' : 'Đã tạo bài tập.',
              logicalKey: assignmentReplayKey,
              replayPayloadSignature: replayPayloadSignature(rec),
              onPersistSuccess: () => {
                if (!dialogActive) return;
                pendingCreateId = null;
                pendingCreateCreatedAt = null;
                closeAssignmentDialogAfterSuccessfulSave({
                  isDialogActive: () => dialogActive,
                  setAssignmentSaving: (value) => { assignmentSaving = value; },
                  formMatchesAcknowledgedSnapshot,
                  onFormChangedSinceAcknowledged: () => {
                    err.textContent = 'Đã lưu bản trước trên máy chủ — form vẫn giữ thay đổi mới của bạn.';
                  },
                  onAcknowledged: () => {
                    attachmentDirtyBaseline.ids = [...pendingIds];
                    isDirty.markClean();
                  },
                  closeAfterSave,
                });
                render();
              },
            });
          } finally {
            if (dialogActive && assignmentSaving) {
              assignmentSaving = false;
              saveBtn.textContent = saveLabel;
              saveBtn.removeAttribute('aria-busy');
              syncAssignmentFormUi();
            }
          }
        },
      }, editing ? 'Lưu' : 'Tạo'),
      el('button', { type: 'button', className: 'btn btn-ghost', onClick: () => close() }, 'Hủy'),
    ],
    {
      isDirty,
      onBeforeClose: onBeforeCloseAssignmentDialog,
      onAfterClose: finishAssignmentDialogClose,
      cancelOwnedWork: () => { dialogActive = false; },
    },
  );
  uploadCtrl.refresh();
  syncAssignmentFormUi();
}

function openShareDialog(assignment) {
  const link = buildAssignmentShareLink(location.origin + location.pathname, assignment.id);
  const zalo = buildZaloReminderText(assignment, className(assignment.classId), link);
  const linkP = el('p', {}, link);
  const box = el('div', { className: 'share-box' }, zalo);
  const { close } = openDialog(
    'Chia sẻ (demo)',
    [
      el('p', {}, 'Sao chép link bài tập (hash route):'),
      linkP,
      el('button', {
        type: 'button',
        className: 'btn btn-secondary',
        onClick: async () => {
          try {
            await navigator.clipboard.writeText(link);
          } catch {
            /* fallback selectable */
          }
        },
      }, 'Sao chép link'),
      el('p', { style: 'margin-top:1rem' }, 'Văn bản nhắc Zalo (demo, không gửi):'),
      box,
    ],
    [el('button', { type: 'button', className: 'btn btn-ghost', onClick: () => close() }, 'Đóng')],
  );
}

function openBackupDialog() {
  const err = el('div', { className: 'form-error' });
  openDialog(
    'Sao lưu & nhập JSON',
    [
      err,
      el('p', {}, 'Xuất JSON chỉ gồm metadata lớp/bài/nộp — không gồm ảnh nộp bài hay tệp đính kèm bài tập (PDF/Word/ảnh giáo viên). Sao lưu đầy đủ cần giữ thư mục DATA_DIR.'),
      el('input', { type: 'file', accept: 'application/json', id: 'import-file' }),
    ],
    [
      el('button', {
        type: 'button',
        className: 'btn btn-secondary',
        onClick: async () => {
          const payload = {
            schemaVersion: BACKUP_SCHEMA_VERSION,
            classes: state.data.classes,
            students: state.data.students,
            assignments: state.data.assignments,
            submissions: state.data.submissions,
            exportedAt: new Date().toISOString(),
          };
          const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = 'bai-nha-backup.json';
          a.click();
        },
      }, 'Xuất JSON'),
      el('button', {
        type: 'button',
        className: 'btn btn-primary',
        onClick: () => {
          const input = document.getElementById('import-file');
          input.onchange = async () => {
            const file = input.files?.[0];
            if (!file) return;
            try {
              const text = await file.text();
              const data = JSON.parse(text);
              const v = validateBackup(data);
              if (!v.ok) {
                err.textContent = v.error;
                return;
              }
              await persistWithStatus(async () => {
                for (const c of data.classes) await putRecord('classes', c);
                for (const s of data.students) await putRecord('students', s);
                for (const a of data.assignments) await putRecord('assignments', a);
                for (const s of data.submissions) await putRecord('submissions', s);
              }, {
                logicalKey: 'import:merge-json',
                replayPayloadSignature: replayPayloadSignature({
                  schema: data.schemaVersion,
                  counts: {
                    classes: data.classes.length,
                    students: data.students.length,
                    assignments: data.assignments.length,
                    submissions: data.submissions.length,
                  },
                }),
              });
              render();
            } catch {
              err.textContent = 'File JSON không hợp lệ.';
            }
          };
          input.click();
        },
      }, 'Nhập JSON (ghép)'),
    ],
  );
}

function initials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function renderAuthShell() {
  const root = document.getElementById('app-root');
  clear(root);
  root.className = 'content auth-screen';

  if (state.authPhase === 'setup') {
    const err = el('div', { className: 'form-error' });
    const username = el('input', { type: 'text', autocomplete: 'username' });
    const displayName = el('input', { type: 'text' });
    const password = el('input', { type: 'password', autocomplete: 'new-password' });
    const password2 = el('input', { type: 'password', autocomplete: 'new-password' });
    root.appendChild(el('h1', { className: 'page-title' }, 'Thiết lập giáo viên (một lần)'));
    root.appendChild(el('p', { className: 'subtitle' }, 'Tạo tài khoản giáo viên đầu tiên cho cài đặt cục bộ này. Không có mật khẩu mặc định.'));
    root.appendChild(err);
    root.appendChild(el('div', { className: 'form-field' }, el('label', {}, 'Tên đăng nhập'), username));
    root.appendChild(el('div', { className: 'form-field' }, el('label', {}, 'Tên hiển thị'), displayName));
    root.appendChild(el('div', { className: 'form-field' }, el('label', {}, 'Mật khẩu'), password));
    root.appendChild(el('div', { className: 'form-field' }, el('label', {}, 'Nhập lại mật khẩu'), password2));
    root.appendChild(el('button', {
      type: 'button',
      className: 'btn btn-primary',
      onClick: async () => {
        err.textContent = '';
        if (password.value !== password2.value) {
          err.textContent = 'Mật khẩu nhập lại không khớp.';
          return;
        }
        const entryEpoch = getRequestEpoch();
        try {
          const guard = await runMutationGuard('auth-setup', async () => {
            await setupTeacher({
              username: username.value,
              password: password.value,
              displayName: displayName.value || username.value,
            });
          });
          if (guard.skipped) return;
          if (isStaleEpoch(entryEpoch)) return;
          await enterAuthenticatedApp(entryEpoch);
        } catch (e) {
          if (isStaleEpoch(entryEpoch)) return;
          err.textContent = e.message || 'Không thiết lập được.';
        }
      },
    }, 'Hoàn tất thiết lập'));
    return;
  }

  const err = el('div', { className: 'form-error' });
  const username = el('input', { type: 'text', id: 'auth-login-username', autocomplete: 'username' });
  const password = el('input', { type: 'password', id: 'auth-login-password', autocomplete: 'current-password' });
  const formGeneration = ++authLoginFormGeneration;
  root.appendChild(el('h1', { className: 'page-title' }, 'Đăng nhập'));
  root.appendChild(el('p', { className: 'subtitle' }, 'Bài Nhà — phát triển cục bộ trên máy bạn (127.0.0.1).'));
  root.appendChild(err);
  root.appendChild(el('div', { className: 'form-field' }, el('label', { htmlFor: 'auth-login-username' }, 'Tên đăng nhập'), username));
  root.appendChild(el('div', { className: 'form-field' }, el('label', { htmlFor: 'auth-login-password' }, 'Mật khẩu'), password));
  const loginBtn = el('button', {
    type: 'button',
    className: 'btn btn-primary',
    onClick: async () => {
      err.textContent = '';
      const entryEpoch = getRequestEpoch();
      await withBusyButton(loginBtn, 'Đang đăng nhập…', async () => {
        try {
          const guard = await runMutationGuard('auth-login', async () => {
            await login(username.value, password.value);
          });
          if (guard.skipped) return;
          if (isStaleEpoch(entryEpoch)) return;
          if (formGeneration !== authLoginFormGeneration) return;
          await enterAuthenticatedApp(entryEpoch);
        } catch (e) {
          if (isStaleEpoch(entryEpoch)) return;
          if (formGeneration !== authLoginFormGeneration) return;
          err.textContent = e.message || 'Đăng nhập thất bại.';
        }
      });
    },
  }, 'Đăng nhập');
  root.appendChild(loginBtn);
}

async function enterAuthenticatedApp(entryEpoch = null) {
  if (entryEpoch != null && isStaleEpoch(entryEpoch)) return;
  state.user = getCurrentUser();
  if (entryEpoch != null && isStaleEpoch(entryEpoch)) return;
  syncRoleFromUser();
  state.authPhase = 'app';
  document.getElementById('app-root').className = 'content';
  if (state.user.mustChangePassword) {
    navigate('#/change-password');
    state.route = parseRoute();
    render();
    return;
  }
  await loadAllData();
  if (entryEpoch != null && isStaleEpoch(entryEpoch)) return;
  const shell = document.querySelector('.app-shell');
  if (shell) shell.hidden = false;
  if (!location.hash || location.hash === '#/' || location.hash === '#/login') {
    navigate(isTeacher() ? '#/dashboard' : '#/assignments');
  }
  state.route = parseRoute();
  render();
}

function renderChangePassword() {
  const root = document.getElementById('app-root');
  clear(root);
  const formGeneration = ++authChangePasswordFormGeneration;
  const err = el('div', { className: 'form-error' });
  const current = el('input', { type: 'password', id: 'auth-change-password-current', autocomplete: 'current-password' });
  const next = el('input', { type: 'password', id: 'auth-change-password-new', autocomplete: 'new-password' });
  const next2 = el('input', { type: 'password', id: 'auth-change-password-confirm', autocomplete: 'new-password' });
  const passwordFields = state.user?.mustChangePassword ? [next, next2] : [current, next, next2];
  const passwordFormDirty = snapshotFormDirty(passwordFields);
  registerDirtyProbe(passwordFormDirty, { fields: passwordFields });
  root.appendChild(el('h1', { className: 'page-title' }, 'Đổi mật khẩu'));
  root.appendChild(el('p', { className: 'subtitle' }, state.user?.mustChangePassword
    ? 'Đây là lần đăng nhập đầu — hãy đặt mật khẩu mới trước khi tiếp tục.'
    : 'Cập nhật mật khẩu của bạn.'));
  root.appendChild(err);
  if (!state.user?.mustChangePassword) {
    root.appendChild(el('div', { className: 'form-field' }, el('label', { htmlFor: 'auth-change-password-current' }, 'Mật khẩu hiện tại'), current));
  }
  root.appendChild(el('div', { className: 'form-field' }, el('label', { htmlFor: 'auth-change-password-new' }, 'Mật khẩu mới'), next));
  root.appendChild(el('div', { className: 'form-field' }, el('label', { htmlFor: 'auth-change-password-confirm' }, 'Nhập lại mật khẩu mới'), next2));
  root.appendChild(el('button', {
    type: 'button',
    className: 'btn btn-primary',
    onClick: async (ev) => {
      const btn = ev.currentTarget;
      err.textContent = '';
      if (next.value !== next2.value) {
        err.textContent = 'Mật khẩu mới không khớp.';
        return;
      }
      const entryEpoch = getRequestEpoch();
      try {
        const guarded = await runMutationGuard('change-password', async () => {
          await withBusyButton(btn, 'Đang lưu…', async () => {
            await changePassword({
              currentPassword: current.value,
              newPassword: next.value,
            });
          });
        });
        if (guarded.skipped) return;
        if (isStaleEpoch(entryEpoch)) return;
        if (formGeneration !== authChangePasswordFormGeneration) return;
        registerDirtyProbe(null);
        passwordFormDirty.markClean();
        state.user = getCurrentUser();
        await enterAuthenticatedApp(entryEpoch);
      } catch (e) {
        if (isStaleEpoch(entryEpoch)) return;
        if (formGeneration !== authChangePasswordFormGeneration) return;
        err.textContent = e.message || 'Không đổi được mật khẩu.';
      }
    },
  }, 'Lưu mật khẩu'));
  root.appendChild(el('button', {
    type: 'button',
    className: 'btn btn-ghost',
    style: 'margin-top:0.75rem',
    onClick: async () => {
      if (isGloballyDirty() && !confirmDiscard()) return;
      registerDirtyProbe(null);
      const r = await logout();
      clearSessionClientState();
      state.authPhase = 'login';
      if (!r.ok) {
        showErrorBanner('Không chắc đã đăng xuất trên máy chủ — phiên cục bộ đã được xóa.');
      }
      renderAuthShell();
    },
  }, 'Đăng xuất'));
}

function canRenderAccountsView() {
  return state.authPhase === 'app' && isTeacher() && state.route.view === 'accounts';
}

/** @type {{ err: HTMLElement, summaryEl: HTMLElement, actionListEl: HTMLElement, stSel: HTMLSelectElement, uname: HTMLInputElement, temp: HTMLInputElement, accountsFormDirty: ReturnType<typeof snapshotFormDirty>, viewGeneration: number, loadEpoch: number } | null} */
let accountsViewLive = null;
let studentSubmissionViewGeneration = 0;
/** @type {{ assignmentId: string, viewGeneration: number } | null} */
let studentSubmissionViewLive = null;
let authLoginFormGeneration = 0;
let authChangePasswordFormGeneration = 0;
let accountsViewGeneration = 0;

function renderAccountListDom(summaryEl, actionListEl, accounts, err, listRefresh) {
  const listHost = summaryEl.querySelector('.accounts-summary-list') || summaryEl;
  clear(listHost);
  for (const acc of accounts) {
    const main = el('div', { className: 'list-row-main' });
    main.appendChild(el('div', { className: 'account-row-title' }, acc.studentName));
    main.appendChild(el('div', { className: 'account-row-meta' }, `@${acc.username} · ${className(acc.classId)}`));
    const statusClass = acc.disabled ? 'badge badge-gray' : acc.mustChangePassword ? 'badge badge-amber' : 'badge badge-green';
    const statusText = acc.disabled ? 'Đã vô hiệu' : acc.mustChangePassword ? 'Cần đổi mật khẩu lần đầu' : 'Đang hoạt động';
    const row = el('div', { className: 'list-row account-summary-row' });
    row.appendChild(main);
    row.appendChild(el('span', { className: statusClass }, statusText));
    listHost.appendChild(row);
  }
  clear(actionListEl);
  for (const acc of accounts) {
    const actions = el('div', { className: 'btn-row account-action-buttons' });
    if (!acc.disabled) {
      let disableBtn;
      actions.appendChild(disableBtn = el('button', {
        type: 'button',
        className: 'btn btn-secondary',
        onClick: async () => {
          if (!confirm(`Vô hiệu tài khoản @${acc.username}?`)) return;
          await withBusyButton(disableBtn, 'Đang xử lý…', async () => {
            const actionEpoch = getRequestEpoch();
            try {
              const guard = await runMutationGuard(`account-disable:${acc.id}`, async () => {
                await accountAction(acc.id, 'disable');
              });
              if (guard.skipped) return;
            } catch (e) {
              if (isStaleEpoch(actionEpoch)) return;
              err.textContent = e.message || 'Không vô hiệu được.';
              return;
            }
            await listRefresh(actionEpoch);
          });
        },
      }, 'Vô hiệu'));
      let resetBtn;
      actions.appendChild(resetBtn = el('button', {
        type: 'button',
        className: 'btn btn-secondary',
        onClick: async () => {
          if (!confirm(`Đặt lại mật khẩu cho @${acc.username}? Phiên đăng nhập hiện tại sẽ hết hạn.`)) return;
          await withBusyButton(resetBtn, 'Đang đặt lại…', async () => {
            const actionEpoch = getRequestEpoch();
            let r;
            try {
              const guard = await runMutationGuard(`account-reset:${acc.id}`, async () => {
                r = await accountAction(acc.id, 'reset-password');
              });
              if (guard.skipped) return;
            } catch (e) {
              if (isStaleEpoch(actionEpoch)) return;
              err.textContent = e.message || 'Không đặt lại được.';
              return;
            }
            if (isStaleEpoch(actionEpoch)) return;
            if (r.temporaryPassword) {
              showCredentialDialog({
                accountKey: `reset:${acc.id}`,
                requestEpoch: actionEpoch,
                accountsViewGeneration: accountsViewLive?.viewGeneration ?? null,
                title: 'Mật khẩu tạm mới',
                lines: ['Mật khẩu tạm chỉ hiển thị một lần. Phiên đăng nhập cũ của học sinh đã bị thu hồi.'],
                copyValue: r.temporaryPassword,
              });
              toastSuccess('Đã đặt lại mật khẩu tạm.');
            } else if (r.replay) {
              showErrorBanner(
                r.message || 'Mật khẩu tạm đã được cấp trước đó — không thể hiển thị lại.',
                {
                  persistent: true,
                  retryLabel: 'Cấp mật khẩu tạm mới',
                  retry: async () => {
                    if (isStaleEpoch(actionEpoch)) return;
                    if (!confirm(
                      'Tạo mật khẩu tạm mới cho tài khoản này? Phiên đăng nhập hiện tại của học sinh sẽ hết hạn.',
                    )) return;
                    const freshEpoch = getRequestEpoch();
                    let fresh;
                    try {
                      const guard = await runMutationGuard(`account-reset-fresh:${acc.id}`, async () => {
                        fresh = await accountAction(acc.id, 'reset-password', { freshOperation: true });
                      });
                      if (guard.skipped) return;
                    } catch (e) {
                      if (isStaleEpoch(freshEpoch)) return;
                      err.textContent = e.message || 'Không đặt lại được.';
                      return;
                    }
                    if (isStaleEpoch(freshEpoch)) return;
                    hideErrorBanner();
                    if (fresh.temporaryPassword) {
                      showCredentialDialog({
                        accountKey: `reset:${acc.id}`,
                        requestEpoch: freshEpoch,
                        accountsViewGeneration: accountsViewLive?.viewGeneration ?? null,
                        title: 'Mật khẩu tạm mới',
                        lines: ['Mật khẩu tạm chỉ hiển thị một lần. Phiên đăng nhập cũ của học sinh đã bị thu hồi.'],
                        copyValue: fresh.temporaryPassword,
                      });
                      toastSuccess('Đã đặt lại mật khẩu tạm.');
                    }
                    await listRefresh(freshEpoch);
                  },
                },
              );
            }
            await listRefresh(actionEpoch);
          });
        },
      }, 'Đặt lại mật khẩu'));
    } else {
      actions.appendChild(el('button', {
        type: 'button',
        className: 'btn btn-ghost',
        onClick: async () => {
          const actionEpoch = getRequestEpoch();
          try {
            const guard = await runMutationGuard(`account-reactivate:${acc.id}`, async () => {
              await accountAction(acc.id, 'reactivate');
            });
            if (guard.skipped) return;
          } catch (e) {
            if (isStaleEpoch(actionEpoch)) return;
            err.textContent = e.message || 'Không kích hoạt lại được.';
            return;
          }
          await listRefresh(actionEpoch);
        },
      }, 'Kích hoạt lại'));
    }
    actionListEl.appendChild(
      el('div', { className: 'card account-action-card' },
        el('strong', {}, `@${acc.username}`),
        actions,
      ),
    );
  }
}

async function refreshAccountsListOnly(actionEpoch) {
  if (!canRenderAccountsView()) return;
  if (isStaleEpoch(actionEpoch)) return;
  if (!accountsViewLive) {
    await renderAccounts();
    return;
  }
  const hostGeneration = accountsViewLive.viewGeneration;
  let accounts = [];
  try {
    accounts = await listStudentAccounts();
  } catch (e) {
    if (isStaleEpoch(actionEpoch)) return;
    if (!accountsViewLive || accountsViewLive.viewGeneration !== hostGeneration) return;
    accountsViewLive.err.textContent = e.message || 'Không tải được danh sách.';
    return;
  }
  if (isStaleEpoch(actionEpoch)) return;
  if (!canRenderAccountsView()) return;
  if (!accountsViewLive || accountsViewLive.viewGeneration !== hostGeneration) return;
  accountsViewLive.err.textContent = '';
  renderAccountListDom(
    accountsViewLive.summaryEl,
    accountsViewLive.actionListEl,
    accounts,
    accountsViewLive.err,
    refreshAccountsListOnly,
  );
  const draftBeforeRefresh = captureCreateAccountDraft({
    username: accountsViewLive.uname.value,
    tempPassword: accountsViewLive.temp.value,
    studentId: accountsViewLive.stSel.value,
  });
  const wasCleanBeforeRefresh = !accountsViewLive.accountsFormDirty();
  rebuildStudentAccountSelect(
    accountsViewLive.stSel,
    accounts,
    state.data.students,
    className,
  );
  const draftAfterRefresh = captureCreateAccountDraft({
    username: accountsViewLive.uname.value,
    tempPassword: accountsViewLive.temp.value,
    studentId: accountsViewLive.stSel.value,
  });
  syncCleanFormBaselineAfterProgrammaticSelectRefresh(
    draftBeforeRefresh,
    draftAfterRefresh,
    wasCleanBeforeRefresh,
    accountsViewLive.accountsFormDirty,
  );
}

async function renderAccounts() {
  if (!canRenderAccountsView()) return;
  accountsViewLive = null;
  const viewGeneration = ++accountsViewGeneration;
  const loadEpoch = getRequestEpoch();
  const root = document.getElementById('app-root');
  clear(root);
  root.appendChild(el('h1', { className: 'page-title' }, 'Tài khoản học sinh'));
  const err = el('div', { className: 'form-error' });
  root.appendChild(err);
  let accounts = [];
  try {
    accounts = await listStudentAccounts();
  } catch (e) {
    if (!shouldApplyAccountsViewWork(viewGeneration, accountsViewGeneration, {
      loadEpoch,
      isStaleEpoch,
      canRender: canRenderAccountsView,
    })) return;
    err.textContent = e.message || 'Không tải được danh sách.';
    return;
  }
  if (!shouldApplyAccountsViewWork(viewGeneration, accountsViewGeneration, {
    loadEpoch,
    isStaleEpoch,
    canRender: canRenderAccountsView,
  })) return;
  const layout = el('div', { className: 'accounts-layout', 'data-ui-view': 'accounts' });
  const listPanel = el('div', { className: 'accounts-list-panel' });
  root.appendChild(layout);
  layout.appendChild(listPanel);
  const summaryEl = el('div', { className: 'card accounts-summary-card' });
  summaryEl.appendChild(el('h2', { className: 'section-heading' }, 'Danh sách tài khoản'));
  const summaryListHost = el('div', { className: 'accounts-summary-list' });
  summaryEl.appendChild(summaryListHost);
  listPanel.appendChild(summaryEl);
  const actionListEl = el('div', { id: 'accounts-action-list', className: 'accounts-action-list' });
  listPanel.appendChild(actionListEl);
  const createPanel = el('div', { className: 'accounts-create-panel' });
  layout.appendChild(createPanel);

  const accountFormFieldPrefix = `accounts-create-${viewGeneration}`;
  const stSel = el('select', { id: `${accountFormFieldPrefix}-student` });
  rebuildStudentAccountSelect(stSel, accounts, state.data.students, className);
  const uname = el('input', { type: 'text', id: `${accountFormFieldPrefix}-username`, autocomplete: 'username' });
  const temp = el('input', { type: 'text', id: `${accountFormFieldPrefix}-temp-password`, placeholder: 'Để trống để tạo ngẫu nhiên' });
  const accountsFormDirty = snapshotFormDirty([uname, temp, stSel]);
  if (!shouldApplyAccountsViewWork(viewGeneration, accountsViewGeneration, {
    loadEpoch,
    isStaleEpoch,
    canRender: canRenderAccountsView,
  })) return;
  registerDirtyProbe(accountsFormDirty, { fields: [uname, temp, stSel] });
  let createAccBtn;
  const createFormLock = createFormPendingLock({
    controls: [stSel, uname, temp],
    onSync: [(blocked) => {
      if (createAccBtn) createAccBtn.disabled = blocked;
    }],
  });
  createPanel.appendChild(el('div', { className: 'card accounts-create-card' },
    el('h2', { className: 'section-heading' }, 'Tạo tài khoản'),
    el('div', { className: 'form-field' }, el('label', { htmlFor: `${accountFormFieldPrefix}-student` }, 'Học sinh'), stSel),
    el('div', { className: 'form-field' }, el('label', { htmlFor: `${accountFormFieldPrefix}-username` }, 'Tên đăng nhập'), uname),
    el('div', { className: 'form-field' }, el('label', { htmlFor: `${accountFormFieldPrefix}-temp-password` }, 'Mật khẩu tạm (chỉ hiện một lần)'), temp),
    el('p', { className: 'form-hint' }, PASSWORD_RULES_HINT),
    createAccBtn = el('button', {
      type: 'button',
      className: 'btn btn-primary',
      onClick: async () => {
        const ran = await createFormLock.run(async () => {
          err.textContent = '';
          const actionEpoch = getRequestEpoch();
          const submittedDraft = captureCreateAccountDraft({
            username: uname.value.trim(),
            tempPassword: temp.value,
            studentId: stSel.value,
          });
          try {
            const created = await createStudentAccount({
              studentId: stSel.value,
              username: submittedDraft.username,
              temporaryPassword: submittedDraft.tempPassword || undefined,
            });
            if (isStaleEpoch(actionEpoch)) return false;
            const queuedCredential = queueCreateAccountCredentialIfValid(created, {
              actionEpoch,
              submittedUsername: submittedDraft.username,
              isStaleEpoch,
              showCredentialDialog: (entry) => showCredentialDialog({
                ...entry,
                accountsViewGeneration: viewGeneration,
              }),
            });
            if (queuedCredential) {
              toastSuccess('Đã tạo tài khoản học sinh.');
            } else if (created.replay) {
              if (!shouldApplyAccountsViewWork(viewGeneration, accountsViewGeneration, {
                canRender: canRenderAccountsView,
              })) {
                /* replay notice only when create form view is still live */
              } else {
                showErrorBanner(created.message || 'Tài khoản đã được tạo trước đó.');
              }
            }
            if (isStaleEpoch(actionEpoch)) return true;
            if (!shouldApplyAccountsViewWork(viewGeneration, accountsViewGeneration, {
              canRender: canRenderAccountsView,
            })) return true;
            const studentIdBeforeRefresh = stSel.value;
            if (studentIdBeforeRefresh !== submittedDraft.studentId) return true;
            if (!shouldApplyAccountsViewWork(viewGeneration, accountsViewGeneration, {
              canRender: canRenderAccountsView,
            })) return true;
            try {
              await refreshAccountsListOnly(actionEpoch);
            } catch {
              /* list refresh failure — account was still created */
            }
            if (!shouldApplyAccountsViewWork(viewGeneration, accountsViewGeneration, {
              canRender: canRenderAccountsView,
            })) return true;
            applyCreateAccountSuccessAck(
              { username: uname, tempPassword: temp, studentId: stSel.value },
              accountsFormDirty,
              submittedDraft,
              { studentIdBeforeRefresh },
            );
            return true;
          } catch (e) {
            if (isStaleEpoch(actionEpoch)) return false;
            if (!shouldApplyAccountsViewWork(viewGeneration, accountsViewGeneration, {
              canRender: canRenderAccountsView,
            })) return false;
            err.textContent = e.message || 'Không tạo được.';
            return false;
          }
        });
        if (ran.skipped) return;
      },
    }, 'Tạo'),
  ));

  if (!shouldApplyAccountsViewWork(viewGeneration, accountsViewGeneration, {
    loadEpoch,
    isStaleEpoch,
    canRender: canRenderAccountsView,
  })) {
    registerDirtyProbe(null);
    return;
  }

  accountsViewLive = {
    err,
    summaryEl,
    actionListEl,
    stSel,
    uname,
    temp,
    accountsFormDirty,
    viewGeneration,
    loadEpoch,
  };

  renderAccountListDom(summaryEl, actionListEl, accounts, err, refreshAccountsListOnly);
}

function renderSettingsPage() {
  const root = document.getElementById('app-root');
  clear(root);
  root.appendChild(el('h1', { className: 'page-title' }, 'Cài đặt'));
  const err = el('div', { className: 'form-error' });
  root.appendChild(err);

  if (isTeacher()) {
    const name = el('input', { type: 'text', value: state.data.settings.teacherName || '' });
    const settingsDirty = snapshotFormDirty([name]);
    registerDirtyProbe(settingsDirty, { fields: [name] });
    let saveSettingsBtn;
    const profileFieldset = el('fieldset', { className: 'settings-form-body' });
    const settingsLock = createFormPendingLock({
      fieldsetRoot: profileFieldset,
      controls: [name],
    });
    root.appendChild(el('div', { className: 'card' },
      el('h2', {}, 'Hồ sơ giáo viên'),
      profileFieldset,
      saveSettingsBtn = el('button', {
        type: 'button',
        className: 'btn btn-primary',
        onClick: async () => {
          const ran = await settingsLock.run(async () => {
            err.textContent = '';
            const viewEpoch = getRequestEpoch();
            const savedName = name.value.trim();
            saveSettingsBtn.textContent = 'Đang lưu…';
            saveSettingsBtn.setAttribute('aria-busy', 'true');
            try {
              const ok = await persistWithStatus(() => updateTeacherSettings(savedName), {
                logicalKey: 'settings:teacher-name',
                replayPayloadSignature: replayPayloadSignature({ teacherName: savedName }),
              });
              if (isStaleEpoch(viewEpoch)) return false;
              if (state.route.view !== 'settings') return false;
              if (ok) {
                settingsDirty.markClean();
                name.value = state.data.settings.teacherName || savedName;
              }
              return ok;
            } finally {
              saveSettingsBtn.textContent = 'Lưu';
              saveSettingsBtn.removeAttribute('aria-busy');
            }
          });
          if (ran.skipped) return;
        },
      }, 'Lưu'),
    ));
    profileFieldset.append(
      el('div', { className: 'form-field' }, el('label', {}, 'Tên hiển thị'), name),
    );
    root.appendChild(el('div', { className: 'card', style: 'margin-top:1rem' },
      el('h2', {}, 'Chuyển dữ liệu cũ trên máy này'),
      el('p', {}, 'Đọc IndexedDB demo cũ (nếu còn) và nhập vào máy chủ cục bộ — không ghi đè tự động.'),
      el('button', {
        type: 'button',
        className: 'btn btn-secondary',
        onClick: async () => {
          err.textContent = '';
          try {
            const pack = await readLegacyIndexedDbExport();
            if (!pack) {
              err.textContent = 'Không tìm thấy dữ liệu IndexedDB cũ trên trình duyệt này.';
              return;
            }
            if (!confirm('Nhập dữ liệu cũ lên máy chủ? Hãy chắc bạn đã sao lưu.')) return;
            await persistWithStatus(() => migrateLocalData(pack.backup, pack.images));
            render();
          } catch (e) {
            err.textContent = e.message || 'Nhập thất bại.';
          }
        },
      }, 'Chuyển dữ liệu cũ trên máy này'),
    ));
    root.appendChild(el('button', {
      type: 'button',
      className: 'btn btn-ghost',
      style: 'margin-top:1rem',
      onClick: () => openBackupDialog(),
    }, 'Sao lưu / nhập JSON (metadata)'));
  }

  root.appendChild(el('div', { className: 'card', style: 'margin-top:1rem' },
    el('h2', {}, 'Mật khẩu & phiên'),
    el('button', {
      type: 'button',
      className: 'btn btn-secondary',
      onClick: () => navigate('#/change-password'),
    }, 'Đổi mật khẩu'),
    el('button', {
      type: 'button',
      className: 'btn btn-ghost',
      style: 'margin-left:0.5rem',
      onClick: async () => {
        const r = await logout();
        clearSessionClientState();
        state.authPhase = 'login';
        if (!r.ok) {
          showErrorBanner('Không chắc đã đăng xuất trên máy chủ — phiên cục bộ đã được xóa.');
        }
        renderAuthShell();
      },
    }, 'Đăng xuất'),
  ));
}

function render() {
  if (state.authPhase !== 'app') {
    renderAuthShell();
    updateChrome();
    return;
  }
  if (disposeGradingEditor) {
    disposeGradingEditor();
    disposeGradingEditor = null;
  }
  guardStudentRoute();
  updateChrome();
  const r = state.route;
  if (r.view !== 'settings' && r.view !== 'grading-editor' && !String(r.view).startsWith('tutor') && !String(r.view).startsWith('exams')) {
    disposeActiveBaViewScope();
    registerDirtyProbe(null);
  }
  const baCtx = {
    state,
    isTeacher,
    navigate,
    renderApp: render,
    toastOk: toastSuccess,
    toastErr: (msg) => showErrorBanner(msg),
  };
  if (tryRenderBaView(baCtx, r)) return;
  if (tryRenderExamView(baCtx, r)) return;
  if (r.view === 'dashboard') renderDashboard();
  else if (r.view === 'classes') renderClasses();
  else if (r.view === 'class-detail') renderClassDetail(r.classId);
  else if (r.view === 'assignments') renderAssignments();
  else if (r.view === 'assignment-detail') renderAssignmentDetail(r.assignmentId);
  else if (r.view === 'grading') renderGrading();
  else if (r.view === 'accounts') renderAccounts();
  else if (r.view === 'settings') renderSettingsPage();
  else if (r.view === 'change-password') renderChangePassword();
  else if (r.view === 'grading-editor') {
    if (isTeacher()) {
      renderGradingEditor(r.assignmentId, r.studentId);
    } else {
      renderAssignments();
    }
  }
  else renderDashboard();
  refreshCredentialQueuePresentation();
}

async function init() {
  configureCredentialQueue({
    openCredentialsDialog,
    openDialog,
    mkEl: el,
    isStaleEpoch,
    getAccountsViewGeneration: () => accountsViewGeneration,
    isAccountsViewActive: canRenderAccountsView,
    getDialogRootFirstChild: () => document.getElementById('dialog-root')?.firstElementChild ?? null,
    showPendingNotice: ({ message, generation, onOpen }) => {
      showCredentialPendingNotice(message, { generation, onOpen });
    },
    hidePendingNotice: () => hideCredentialPendingNotice(),
    toastInfo: (message) => {
      toastSuccess(message);
    },
  });

  setUnauthorizedHandler(() => {
    disposeActiveBaViewScope();
    clearSessionClientState();
    state.authPhase = 'login';
    renderAuthShell();
  });

  const saveEl = document.getElementById('save-status');
  saveEl.addEventListener('click', async () => {
    const handle = getPersistRetryHandle();
    if (state.saveStatus === 'err' && handle) {
      if (isStaleEpoch(handle.epoch)) return;
      await persistWithStatus(handle.fn, { retrySameOperation: true });
    }
  });
  saveEl.style.cursor = 'pointer';
  saveEl.title = 'Trạng thái lưu trên máy chủ cục bộ';

  try {
    await ensureCsrf();
    const boot = await fetchBootstrap();
    if (boot.authenticated) {
      const entryEpoch = getRequestEpoch();
      await fetchMe();
      if (isStaleEpoch(entryEpoch)) return;
      await enterAuthenticatedApp(entryEpoch);
      return;
    }
    state.authPhase = boot.initialized ? 'login' : 'setup';
    renderAuthShell();
  } catch (e) {
    console.error(e);
    setSaveStatus('err', 'Không kết nối được máy chủ — chạy npm start.');
    state.authPhase = 'login';
    renderAuthShell();
  }
}

init();
   