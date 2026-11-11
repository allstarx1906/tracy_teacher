import { el } from './ba-ui-dom.js';
import { pdfJsModuleUrl, pdfJsWorkerUrl } from './exam-api.js';
import {
  marksToServerPagePayload,
  serverPageToMarks,
  mergeMarksLayers,
} from './exam-pdf-annotation-io.js';
import { createExamPdfSaveQueue } from './exam-pdf-save.js';
import { renderExamPdfAnnotationsSvg } from './exam-pdf-render.js';
import {
  exportAnnotatedExamPdf,
  compositeMarksOntoPageCanvas,
  marksForExportPage,
} from './exam-pdf-export.js';
import { createGradingGestureSettlement } from './ux-grading-gestures.js';
import { getDirtyProbe, registerDirtyProbe } from './ux-forms.js';
import {
  MARK_INK_COLORS,
  PEN_STROKE_PRESETS,
  hitTestAnnotationAt,
  hitTestDirectTextHandle,
  moveDirectTextAnnotation,
  resizeDirectTextAnnotation,
  createDirectTextMarkFromPixelAnchor,
  removePenMarksByIds,
  collectPenIdsForEraserPath,
  buildPenPathD,
  appendLivePenPixelPoint,
  layoutDirectTextBox,
  computeDirectTextWidthNormFromPixelWidth,
  validateDirectTextPlacement,
  defaultDirectTextWidthNorm,
  clampPixelToNormalized,
  isDirectTextValid,
  directTextSaveErrorMessage,
  computeInlineTextEditorLayout,
  restoreDirectTextAnnotationPosition,
  GRADING_ZOOM_FIT_PAGE,
  GRADING_ZOOM_FIT_WIDTH,
  GRADING_ZOOM_MANUAL,
  computeEditorLayoutFromImage,
  computeGradingZoomPercent,
  shouldBlockGradingUndoRedo,
  shouldBlockGradingDestructiveActions,
  gradingPendingInlineEditMessage,
} from './model.js';

const TOOLS = ['select', 'hand', 'pen', 'highlight', 'eraser', 'text'];
const DIRECT_TEXT_FONT_FAMILY = 'system-ui, "Segoe UI", sans-serif';

function toolLabel(tool) {
  const map = {
    select: 'Chọn',
    hand: 'Di chuyển',
    pen: 'Bút',
    highlight: 'Đánh dấu',
    eraser: 'Tẩy',
    text: 'Chữ',
  };
  return map[tool] || tool;
}

function svgIcon(paths, label) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '22');
  svg.setAttribute('height', '22');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'exam-pdf-tool-icon');
  const common = { fill: 'none', stroke: 'currentColor', 'stroke-width': '1.75', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' };
  for (const d of paths) {
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', d);
    for (const [k, v] of Object.entries(common)) p.setAttribute(k, String(v));
    svg.appendChild(p);
  }
  const btn = el('span', { className: 'exam-pdf-tool-inner' }, svg, el('span', { className: 'sr-only' }, label));
  return btn;
}

const TOOL_ICONS = {
  select: ['M4 4l7 7-2 9 3-3 5 5 2-10-10-2z'],
  hand: ['M7 11V6a1.5 1.5 0 013 0v4', 'M11 5V4a1.5 1.5 0 013 0v6', 'M15 9V7a1.5 1.5 0 013 0v8a5 5 0 01-5 5h-2a5 5 0 01-5-4.5'],
  pen: ['M4 20l4-1 9-9-3-3-9 9-1 4z', 'M14 6l3 3'],
  highlight: ['M4 18l8-4', 'M12 6l6-2', 'M18 4l2 2-10 4'],
  eraser: ['M4 20h10', 'M8 16l8-8 3 3-8 8z'],
  text: ['M6 6h12', 'M12 6v14', 'M8 20h8'],
  undo: ['M9 7H5v4', 'M5 11a7 7 0 101.6-4.6L5 7'],
  redo: ['M15 7h4v4', 'M19 11a7 7 0 11-3.6-4.6L19 7'],
  zoomIn: ['M12 8v8', 'M8 12h8'],
  zoomOut: ['M8 12h8'],
  fitPage: ['M5 3h14v18H5z', 'M8 7h8'],
  fitWidth: ['M4 8V6h16v2', 'M4 16v2h16v-2'],
};

function mountToolButton(parent, { tool: toolId, label, onClick, pressed = false }) {
  const paths = TOOL_ICONS[toolId] || TOOL_ICONS.select;
  const btn = el('button', {
    type: 'button',
    className: 'btn btn-ghost exam-pdf-tool-btn',
    'data-tool': toolId,
    'aria-label': label,
    'aria-pressed': pressed ? 'true' : 'false',
    title: label,
    onClick,
  });
  btn.appendChild(svgIcon(paths, label).firstChild);
  btn.appendChild(el('span', { className: 'exam-pdf-tool-label' }, label));
  parent.appendChild(btn);
  return btn;
}

/**
 * @returns {Promise<{ dispose, flushSaves, exportAnnotatedPdf, setReadOnly, getSaveQueue, renderPageToCanvas }>}
 */
export async function mountExamPdfEditor(host, options) {
  const {
    pageIds = [],
    sourcePdfUrl,
    readOnly = false,
    role = 'student',
    studentPages = {},
    teacherPages = {},
    showTeacherLayer = false,
    baseRevision = 0,
    savePage,
    onStatusChange,
    onExportError,
    onExport,
  } = options || {};

  const wrap = el('div', { className: 'exam-pdf-editor editor-wrap', tabIndex: '0' });
  const toolbar = el('div', { className: 'exam-pdf-editor-toolbar', role: 'toolbar' });
  const layout = el('div', { className: 'exam-pdf-editor-layout' });
  const rail = el('div', { className: 'exam-pdf-page-rail' });
  const stageCol = el('div', { className: 'exam-pdf-stage-col' });
  const stage = el('div', { className: 'exam-pdf-stage' });
  const viewportEl = el('div', { className: 'exam-pdf-viewport' });
  const canvas = el('canvas', { className: 'exam-pdf-page-canvas' });
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'annotation-layer interactive');
  svg.setAttribute('aria-label', 'Lớp chú thích PDF');
  const statusEl = el('p', { className: 'save-status', 'aria-live': 'polite' }, '');
  wrap.appendChild(toolbar);
  layout.appendChild(rail);
  stageCol.appendChild(stage);
  viewportEl.appendChild(canvas);
  viewportEl.appendChild(svg);
  stage.appendChild(viewportEl);
  stageCol.appendChild(statusEl);
  layout.appendChild(stageCol);
  wrap.appendChild(layout);
  host.appendChild(wrap);

  let disposed = false;
  let readOnlyNow = !!readOnly;
  let activePage = pageIds[0] != null ? String(pageIds[0]) : '1';
  let tool = readOnlyNow ? 'hand' : 'pen';
  let zoomFitMode = GRADING_ZOOM_FIT_WIDTH;
  let manualZoom = 1;
  let pdfDoc = null;
  let pdfLib = null;
  let pdfLoadingTask = null;
  let loadGen = 0;
  let renderGen = 0;
  let renderTask = null;
  let loadErrorShown = false;
  const pageMarks = new Map();
  const frozenStudentMarks = new Map();
  const teacherMarks = new Map();
  let selectedId = null;
  let basePageW = 1;
  let basePageH = 1;
  let pageRotation = 0;
  let sourcePdfBytes = null;

  const session = {
    pageIndex: 0,
    imageLoadSeq: 1,
    penGesture: null,
    eraserGesture: null,
    drag: null,
    pan: null,
    tool: 'pen',
    inlineTextEditor: null,
    gestureGeneration: 0,
    inkColor: MARK_INK_COLORS[0]?.value || '#25282D',
    textFontSize: 16,
  };
  const draft = { pages: [{ annotations: [] }], undoStacks: {} };
  const uid = () => `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

  for (const pid of pageIds) {
    const key = String(pid);
    const studentRaw = serverPageToMarks(studentPages[key] || {});
    const teacherRaw = serverPageToMarks(teacherPages[key] || {});
    frozenStudentMarks.set(key, studentRaw.slice());
    teacherMarks.set(key, teacherRaw.slice());
    if (role === 'teacher') {
      pageMarks.set(key, teacherRaw.slice());
    } else {
      pageMarks.set(key, studentRaw.slice());
    }
  }

  const saveQueue = savePage
    ? createExamPdfSaveQueue({
        savePage: async (pageKey, payload, rev) => {
          const body = {
            page: Number(pageKey),
            ...payload,
            baseRevision: rev,
          };
          const res = await savePage(body);
          const revision = res?.revision ?? res?.data?.revision;
          return revision != null ? { revision } : res;
        },
        onStatusChange: (text, kind) => {
          if (disposed) return;
          statusEl.textContent = text;
          statusEl.className = `save-status ${kind || ''}`;
          if (onStatusChange) onStatusChange(text, kind);
        },
      })
    : null;
  saveQueue?.setBaseRevision(baseRevision);

  let undoBtn;
  let redoBtn;
  let zoomPctEl;

  function layoutZoomLevel() {
    return zoomFitMode === GRADING_ZOOM_MANUAL ? manualZoom : 1;
  }

  function stackKey() {
    return String(activePage);
  }

  function getStack() {
    const key = stackKey();
    if (!draft.undoStacks[key]) draft.undoStacks[key] = { past: [], future: [] };
    return draft.undoStacks[key];
  }

  function pushUndo() {
    if (readOnlyNow) return;
    const marks = editableMarks().slice();
    draft.pages[0].annotations = marks;
    const stack = getStack();
    stack.past.push(JSON.stringify(marks));
    stack.future = [];
    refreshUndoButtons();
  }

  function refreshUndoButtons() {
    if (!undoBtn || !redoBtn) return;
    const stack = getStack();
    const blocked = shouldBlockGradingUndoRedo({ inlineTextEditing: !!session.inlineTextEditor });
    undoBtn.disabled = readOnlyNow || blocked || !stack.past.length;
    redoBtn.disabled = readOnlyNow || blocked || !stack.future.length;
  }

  function undo() {
    if (readOnlyNow || shouldBlockGradingUndoRedo({ inlineTextEditing: !!session.inlineTextEditor })) return;
    const stack = getStack();
    if (!stack.past.length) return;
    const pg = draft.pages[0];
    const current = editableMarks().slice();
    stack.future.push(JSON.stringify(current));
    const restored = JSON.parse(stack.past.pop());
    pg.annotations = Array.isArray(restored) ? restored : [];
    commitAnnotationsFromDraft();
    renderOverlay();
    queueAutosave();
    refreshUndoButtons();
  }

  function redo() {
    if (readOnlyNow || shouldBlockGradingUndoRedo({ inlineTextEditing: !!session.inlineTextEditor })) return;
    const stack = getStack();
    if (!stack.future.length) return;
    const pg = draft.pages[0];
    const current = editableMarks().slice();
    stack.past.push(JSON.stringify(current));
    const restored = JSON.parse(stack.future.pop());
    pg.annotations = Array.isArray(restored) ? restored : [];
    commitAnnotationsFromDraft();
    renderOverlay();
    queueAutosave();
    refreshUndoButtons();
  }

  function editableMarks() {
    return pageMarks.get(activePage) || [];
  }

  function marksForGestureOverlay() {
    if (session.drag || session.eraserGesture) {
      return draft.pages[0]?.annotations || [];
    }
    return editableMarks();
  }

  function displayMarks() {
    const key = activePage;
    const editable = marksForGestureOverlay();
    if (role === 'teacher') {
      const frozen = frozenStudentMarks.get(key) || [];
      return mergeMarksLayers(frozen, editable, { includeTeacher: true });
    }
    if (readOnlyNow) {
      const frozen = frozenStudentMarks.get(key) || editable;
      const teacher = showTeacherLayer ? (teacherMarks.get(key) || []) : [];
      return mergeMarksLayers(frozen, teacher, { includeTeacher: showTeacherLayer });
    }
    return editable.slice();
  }

  function syncDraftFromPage() {
    draft.pages[0].annotations = editableMarks().slice();
    if (!session.penGesture && !session.eraserGesture && !session.drag) {
      session.imageLoadSeq += 1;
    }
    refreshUndoButtons();
  }

  function commitAnnotationsFromDraft() {
    const marks = draft.pages[0]?.annotations || [];
    pageMarks.set(activePage, marks.slice());
  }

  function viewportMeta() {
    const w = wrap.__displayW || 1;
    const h = wrap.__displayH || 1;
    return {
      width: w,
      height: h,
      pageWidth: basePageW,
      pageHeight: basePageH,
      rotation: pageRotation,
    };
  }

  function queueAutosave() {
    if (readOnlyNow || !saveQueue || disposed) return;
    const payload = marksToServerPagePayload(editableMarks(), viewportMeta());
    saveQueue.enqueue(activePage, payload);
  }

  function settleAndCommit() {
    settlement.settleGradingGesturesIntoDraft?.();
    commitAnnotationsFromDraft();
  }

  const settlement = createGradingGestureSettlement({
    getSession: () => session,
    getDraft: () => draft,
    getVersionId: () => 'pdf',
    getPageIndex: () => 0,
    measureDisplaySize: () => measureViewport(),
    pushUndo,
    getUndoStack: () => getStack(),
    commitAnnotationsFromDraft,
    renderOverlay: () => renderOverlay(),
    uid,
    queueAutosave,
    releasePointerCapture: (id) => {
      try { svg.releasePointerCapture(id); } catch { /* ignore */ }
    },
  });

  function measureViewport() {
    const logicalW = wrap.__displayW || canvas.width || 1;
    const logicalH = wrap.__displayH || canvas.height || 1;
    const rect = svg.getBoundingClientRect?.() || { left: 0, top: 0, width: logicalW, height: logicalH };
    return { w: logicalW, h: logicalH, rect };
  }

  function pointerCoords(ev) {
    const { w, h, rect } = measureViewport();
    const rw = Math.max(1, rect.width || w);
    const rh = Math.max(1, rect.height || h);
    return {
      x: (ev.clientX - rect.left) * (w / rw),
      y: (ev.clientY - rect.top) * (h / rh),
      w,
      h,
    };
  }

  function textLayoutOptions() {
    return {};
  }

  function directTextHandleHitOptions() {
    return { zoom: layoutZoomLevel() };
  }

  function renderOverlay() {
    const { w, h } = measureViewport();
    const hideTextId = session.inlineTextEditor?.markId || null;
    renderExamPdfAnnotationsSvg(svg, displayMarks(), w, h, {
      selectedId: readOnlyNow ? null : selectedId,
      hideTextId,
      layoutOptions: textLayoutOptions(),
    });
    refreshUndoButtons();
    updateZoomLabel();
  }

  function penStrokeWidthNorm() {
    return tool === 'highlight'
      ? (PEN_STROKE_PRESETS.highlight?.nw || 0.02)
      : (PEN_STROKE_PRESETS.pen?.nw || 0.008);
  }

  function setTool(next) {
    if (readOnlyNow && next !== 'hand' && next !== 'select') return;
    if (session.inlineTextEditor && !blockIfPendingInline()) return;
    tool = next;
    session.tool = next === 'highlight' ? 'pen' : next;
    wrap.className = `exam-pdf-editor editor-wrap tool-${next}${session.inlineTextEditor ? ' inline-text-editing' : ''}`;
    for (const btn of toolbar.querySelectorAll('[data-tool]')) {
      btn.setAttribute('aria-pressed', btn.getAttribute('data-tool') === next ? 'true' : 'false');
    }
    stage.style.cursor = next === 'hand' ? 'grab' : '';
    svg.style.touchAction = next === 'hand' ? 'pan-x pan-y' : 'none';
  }

  function updateZoomLabel() {
    if (!zoomPctEl) return;
    const innerW = Math.max(1, stage.clientWidth || 320);
    const pct = computeGradingZoomPercent({
      naturalWidth: basePageW,
      naturalHeight: basePageH,
      containerInnerWidth: innerW,
      containerInnerHeight: Math.max(240, stage.clientHeight || 400),
      fitMode: zoomFitMode,
      manualZoom,
    });
    zoomPctEl.textContent = `${pct}%`;
  }

  function applyZoomFitMode(mode) {
    zoomFitMode = mode;
    if (mode !== GRADING_ZOOM_MANUAL) manualZoom = 1;
    renderActivePage().catch(() => {});
    for (const btn of toolbar.querySelectorAll('[data-zoom-fit]')) {
      btn.setAttribute('aria-pressed', btn.getAttribute('data-zoom-fit') === mode ? 'true' : 'false');
    }
  }

  function stepManualZoom(factor) {
    zoomFitMode = GRADING_ZOOM_MANUAL;
    manualZoom = Math.max(0.35, Math.min(4, manualZoom * factor));
    renderActivePage().catch(() => {});
  }

  function buildToolbar() {
    toolbar.replaceChildren();
    for (const t of TOOLS) {
      if (readOnlyNow && t !== 'hand' && t !== 'select') continue;
      mountToolButton(toolbar, {
        tool: t,
        label: toolLabel(t),
        pressed: t === tool,
        onClick: () => setTool(t),
      });
    }
    const sep = el('span', { className: 'exam-pdf-toolbar-sep', 'aria-hidden': 'true' });
    toolbar.appendChild(sep);
    undoBtn = el('button', {
      type: 'button',
      className: 'btn btn-ghost exam-pdf-tool-btn',
      'aria-label': 'Hoàn tác',
      title: 'Hoàn tác',
      disabled: readOnlyNow,
      onClick: undo,
    }, svgIcon(TOOL_ICONS.undo, 'Hoàn tác'));
    redoBtn = el('button', {
      type: 'button',
      className: 'btn btn-ghost exam-pdf-tool-btn',
      'aria-label': 'Làm lại',
      title: 'Làm lại',
      disabled: readOnlyNow,
      onClick: redo,
    }, svgIcon(TOOL_ICONS.redo, 'Làm lại'));
    toolbar.appendChild(undoBtn);
    toolbar.appendChild(redoBtn);

    const zoomOut = el('button', {
      type: 'button',
      className: 'btn btn-ghost exam-pdf-tool-btn',
      'aria-label': 'Thu nhỏ',
      onClick: () => stepManualZoom(0.9),
    }, svgIcon(TOOL_ICONS.zoomOut, 'Thu nhỏ'));
    const fitPage = el('button', {
      type: 'button',
      className: 'btn btn-ghost exam-pdf-tool-btn',
      'data-zoom-fit': GRADING_ZOOM_FIT_PAGE,
      'aria-label': 'Vừa trang',
      'aria-pressed': zoomFitMode === GRADING_ZOOM_FIT_PAGE ? 'true' : 'false',
      onClick: () => applyZoomFitMode(GRADING_ZOOM_FIT_PAGE),
    }, svgIcon(TOOL_ICONS.fitPage, 'Vừa trang'));
    const fitWidth = el('button', {
      type: 'button',
      className: 'btn btn-ghost exam-pdf-tool-btn',
      'data-zoom-fit': GRADING_ZOOM_FIT_WIDTH,
      'aria-label': 'Vừa chiều ngang',
      'aria-pressed': zoomFitMode === GRADING_ZOOM_FIT_WIDTH ? 'true' : 'false',
      onClick: () => applyZoomFitMode(GRADING_ZOOM_FIT_WIDTH),
    }, svgIcon(TOOL_ICONS.fitWidth, 'Vừa chiều ngang'));
    const zoomIn = el('button', {
      type: 'button',
      className: 'btn btn-ghost exam-pdf-tool-btn',
      'aria-label': 'Phóng to',
      onClick: () => stepManualZoom(1.1),
    }, svgIcon(TOOL_ICONS.zoomIn, 'Phóng to'));
    zoomPctEl = el('span', { className: 'exam-pdf-zoom-pct', 'aria-live': 'polite' }, '100%');
    toolbar.appendChild(zoomOut);
    toolbar.appendChild(fitWidth);
    toolbar.appendChild(fitPage);
    toolbar.appendChild(zoomIn);
    toolbar.appendChild(zoomPctEl);

    if (typeof onExport === 'function') {
      const exp = el('button', {
        type: 'button',
        className: 'btn btn-secondary exam-pdf-export-btn',
        'aria-label': 'Tải PDF có chú thích',
        onClick: () => onExport().catch((e) => {
          if (onExportError) onExportError(e);
          else statusEl.textContent = e.message || 'Không xuất được PDF.';
          statusEl.className = 'save-status err';
        }),
      }, 'Tải PDF');
      toolbar.appendChild(exp);
    }
    refreshUndoButtons();
  }

  function blockIfPendingInline() {
    if (session.inlineTextEditor) {
      statusEl.textContent = gradingPendingInlineEditMessage();
      statusEl.className = 'save-status err';
      return true;
    }
    return false;
  }

  function closeInlineTextEditor(cancel) {
    const ed = session.inlineTextEditor;
    if (!ed) return;
    ed.wrap?.remove();
    session.inlineTextEditor = null;
    wrap.classList.remove('inline-text-editing');
    if (cancel) {
      const pg = draft.pages[0];
      if (ed.isNew) {
        pg.annotations = pg.annotations.filter((m) => m.id !== ed.markId);
        selectedId = null;
      } else if (ed.origSnapshot) {
        const idx = pg.annotations.findIndex((m) => m.id === ed.markId);
        if (idx >= 0) pg.annotations[idx] = JSON.parse(ed.origSnapshot);
      }
      commitAnnotationsFromDraft();
    }
    renderOverlay();
  }

  function openInlineTextEditor({ markId, anchorX, anchorY, text, color, fontSizeNorm, textWidthNorm, isNew }) {
    closeInlineTextEditor(false);
    const { w, h } = measureViewport();
    const draftMark = markId
      ? (draft.pages[0].annotations.find((m) => m.id === markId) || {
          id: markId,
          type: 'text',
          nx: anchorX / w,
          ny: anchorY / h,
          text: text || '',
          color: color || session.inkColor,
          fontSizeNorm: fontSizeNorm || session.textFontSize / h,
          textWidthNorm: textWidthNorm || defaultDirectTextWidthNorm({ type: 'text', nx: anchorX / w, ny: anchorY / h }, w, h, textLayoutOptions()),
        })
      : {
          id: uid(),
          type: 'text',
          nx: clampPixelToNormalized(anchorX, anchorY, w, h).nx,
          ny: clampPixelToNormalized(anchorX, anchorY, w, h).ny,
          text: '',
          color: color || session.inkColor,
          fontSizeNorm: fontSizeNorm || session.textFontSize / h,
          textWidthNorm: textWidthNorm || defaultDirectTextWidthNorm({ type: 'text' }, w, h, textLayoutOptions()),
        };
    if (isNew) {
      draft.pages[0].annotations.push(draftMark);
      commitAnnotationsFromDraft();
    }
    const markIdFinal = draftMark.id;
    selectedId = markIdFinal;
    const box = layoutDirectTextBox(draftMark, w, h, textLayoutOptions());
    const chrome = computeInlineTextEditorLayout(box);
    const editorWrap = el('div', { className: 'grading-inline-text-editor exam-pdf-inline-text' });
    editorWrap.style.position = 'absolute';
    editorWrap.style.left = `${chrome.left}px`;
    editorWrap.style.top = `${chrome.top}px`;
    editorWrap.style.width = `${chrome.width}px`;
    editorWrap.style.minHeight = `${chrome.minHeight}px`;
    const textarea = el('textarea', {
      className: 'grading-inline-text-input',
      'aria-label': 'Sửa chữ trên PDF',
    });
    textarea.value = isNew ? '' : (draftMark.text || '');
    textarea.style.color = draftMark.color || session.inkColor;
    textarea.style.fontSize = `${box.fontSize}px`;
    textarea.style.lineHeight = `${box.lineHeight}px`;
    textarea.style.fontFamily = DIRECT_TEXT_FONT_FAMILY;
    textarea.style.width = `${chrome.textWidth}px`;
    textarea.style.minHeight = `${chrome.textMinHeight}px`;
    const err = el('div', { className: 'form-error grading-inline-text-error' });
    const actions = el('div', { className: 'grading-inline-text-actions' });
    const origSnapshot = isNew ? null : JSON.stringify(draftMark);
    const finish = () => {
      const raw = textarea.value;
      if (!isDirectTextValid(raw)) {
        err.textContent = directTextSaveErrorMessage(raw) || 'Nội dung không hợp lệ.';
        textarea.focus();
        return;
      }
      const { w: sw, h: sh } = measureViewport();
      const fsNorm = draftMark.fontSizeNorm || session.textFontSize / sh;
      const placement = validateDirectTextPlacement(
        { ...draftMark, text: raw, fontSizeNorm: fsNorm },
        sw,
        sh,
        textLayoutOptions(),
      );
      if (!placement.ok) {
        err.textContent = placement.error;
        textarea.focus();
        return;
      }
      if (!session.inlineTextEditor?.savedUndo) {
        pushUndo();
        session.inlineTextEditor.savedUndo = true;
      }
      const saveBox = layoutDirectTextBox(placement.mark, sw, sh, textLayoutOptions());
      const saved = createDirectTextMarkFromPixelAnchor({
        id: markIdFinal,
        x: saveBox.x,
        y: saveBox.y,
        w: sw,
        h: sh,
        text: raw,
        color: draftMark.color || session.inkColor,
        fontSizeNorm: fsNorm,
        textWidthNorm: placement.mark.textWidthNorm ?? draftMark.textWidthNorm,
      });
      const idx = draft.pages[0].annotations.findIndex((m) => m.id === markIdFinal);
      if (idx < 0) {
        err.textContent = 'Không tìm thấy đánh dấu.';
        return;
      }
      draft.pages[0].annotations[idx] = saved;
      closeInlineTextEditor(false);
      commitAnnotationsFromDraft();
      selectedId = markIdFinal;
      setTool('select');
      renderOverlay();
      queueAutosave();
    };
    actions.appendChild(el('button', { type: 'button', className: 'btn btn-primary btn-sm', onClick: finish }, 'Xong'));
    actions.appendChild(el('button', {
      type: 'button',
      className: 'btn btn-ghost btn-sm',
      onClick: () => closeInlineTextEditor(true),
    }, 'Hủy'));
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
    editorWrap.appendChild(textarea);
    editorWrap.appendChild(err);
    editorWrap.appendChild(actions);
    viewportEl.appendChild(editorWrap);
    session.inlineTextEditor = {
      wrap: editorWrap,
      textarea,
      markId: markIdFinal,
      isNew: !!isNew,
      savedUndo: false,
      origSnapshot,
    };
    wrap.classList.add('inline-text-editing');
    renderOverlay();
    textarea.focus();
  }

  function resolveTextHit(x, y, w, h, preferredId) {
    const list = draft.pages[0].annotations || [];
    const hitOpts = directTextHandleHitOptions();
    if (preferredId) {
      const selected = list.find((m) => m.id === preferredId && m.type === 'text');
      if (selected) {
        const handle = hitTestDirectTextHandle(selected, x, y, w, h, hitOpts);
        if (handle) return { mark: selected, handle };
      }
    }
    const hit = hitTestAnnotationAt(list, x, y, w, h, textLayoutOptions());
    if (hit?.type === 'text') {
      return { mark: hit, handle: hitTestDirectTextHandle(hit, x, y, w, h, hitOpts) };
    }
    return { mark: hit, handle: null };
  }

  function beginTextDrag(e, hit, handle, x, y, w, h) {
    if (!hit || hit.type !== 'text' || !handle) return false;
    selectedId = hit.id;
    session.gestureGeneration += 1;
    if (handle === 'resize-e' || handle === 'resize-se') {
      const box = layoutDirectTextBox(hit, w, h, textLayoutOptions());
      const nw = hit.textWidthNorm != null ? hit.textWidthNorm : computeDirectTextWidthNormFromPixelWidth(box.w, w);
      session.drag = {
        type: 'text-resize',
        mode: 'e',
        pointerId: e.pointerId,
        markId: hit.id,
        origNw: nw,
        startX: x,
        origSnapshot: JSON.stringify(hit),
        w, h,
        didUndo: false,
        generation: session.gestureGeneration,
      };
      svg.setPointerCapture?.(e.pointerId);
      return true;
    }
    if (handle === 'resize-w') {
      const nw = hit.textWidthNorm != null
        ? hit.textWidthNorm
        : computeDirectTextWidthNormFromPixelWidth(layoutDirectTextBox(hit, w, h, textLayoutOptions()).w, w);
      session.drag = {
        type: 'text-resize',
        mode: 'w',
        pointerId: e.pointerId,
        markId: hit.id,
        origNx: hit.nx,
        origNw: nw,
        origRightNx: hit.nx + nw,
        startX: x,
        w, h,
        didUndo: false,
        generation: session.gestureGeneration,
      };
      svg.setPointerCapture?.(e.pointerId);
      return true;
    }
    if (handle === 'move') {
      session.drag = {
        type: 'text-move',
        pointerId: e.pointerId,
        markId: hit.id,
        startX: x,
        startY: y,
        origNx: hit.nx,
        origNy: hit.ny,
        origSnapshot: JSON.stringify(hit),
        w, h,
        didUndo: false,
        generation: session.gestureGeneration,
      };
      svg.setPointerCapture?.(e.pointerId);
      return true;
    }
    return false;
  }

  function cancelPenGesture() {
    const g = session.penGesture;
    if (g?.livePath?.parentNode) g.livePath.parentNode.removeChild(g.livePath);
    session.penGesture = null;
  }

  function cancelEraserGesture(restore) {
    const g = session.eraserGesture;
    if (restore && g?.preSnapshot) {
      draft.pages[0].annotations = JSON.parse(g.preSnapshot);
      renderOverlay();
    }
    session.eraserGesture = null;
  }

  function cancelTextDrag() {
    const d = session.drag;
    if (d?.origSnapshot && (d.type === 'text-move' || d.type === 'text-resize')) {
      const mark = JSON.parse(d.origSnapshot);
      draft.pages[0].annotations = restoreDirectTextAnnotationPosition(
        draft.pages[0].annotations,
        mark.id,
        mark.nx,
        mark.ny,
      );
      const idx = draft.pages[0].annotations.findIndex((m) => m.id === mark.id);
      if (idx >= 0 && d.type === 'text-resize') {
        draft.pages[0].annotations[idx] = JSON.parse(d.origSnapshot);
      }
    }
    session.drag = null;
    renderOverlay();
  }

  function buildRail() {
    rail.replaceChildren();
    const toggle = el('button', {
      type: 'button',
      className: 'btn btn-ghost exam-pdf-rail-toggle',
      'aria-expanded': 'true',
    }, 'Trang');
    const list = el('div', { className: 'exam-pdf-page-list' });
    for (const pid of pageIds) {
      const key = String(pid);
      const btn = el('button', {
        type: 'button',
        className: `btn btn-ghost exam-pdf-page-btn${key === activePage ? ' active' : ''}`,
        'aria-current': key === activePage ? 'page' : undefined,
      }, `Trang ${key}`);
      btn.addEventListener('click', async () => {
        if (blockIfPendingInline()) return;
        settleAndCommit();
        if (saveQueue?.hasPending()) {
          try { await saveQueue.flush(); } catch { /* keep page */ }
        }
        activePage = key;
        selectedId = null;
        closeInlineTextEditor(true);
        await renderActivePage();
        buildRail();
      });
      list.appendChild(btn);
    }
    let railOpen = true;
    toggle.addEventListener('click', () => {
      railOpen = !railOpen;
      list.hidden = !railOpen;
      toggle.setAttribute('aria-expanded', railOpen ? 'true' : 'false');
    });
    rail.appendChild(toggle);
    rail.appendChild(list);
  }

  function tearDownPdfDoc() {
    if (renderTask?.cancel) {
      try { renderTask.cancel(); } catch { /* ignore */ }
      renderTask = null;
    }
    if (pdfLoadingTask?.destroy) {
      try { pdfLoadingTask.destroy(); } catch { /* ignore */ }
    }
    pdfLoadingTask = null;
    if (pdfDoc?.destroy) {
      try { pdfDoc.destroy(); } catch { /* ignore */ }
    }
    pdfDoc = null;
  }

  async function loadPdf() {
    const myLoadGen = ++loadGen;
    tearDownPdfDoc();
    let lib;
    if (typeof globalThis !== 'undefined' && typeof globalThis.__examPdfJsTestLib === 'function') {
      lib = await globalThis.__examPdfJsTestLib();
    } else {
      const pdfjs = await import(/* webpackIgnore: true */ pdfJsModuleUrl());
      lib = pdfjs.default || pdfjs;
    }
    if (disposed || myLoadGen !== loadGen) return;
    pdfLib = lib;
    if (lib.GlobalWorkerOptions) lib.GlobalWorkerOptions.workerSrc = pdfJsWorkerUrl();
    const res = await fetch(sourcePdfUrl, { credentials: 'include' });
    if (!res.ok) throw new Error('Không tải được PDF.');
    const data = await res.arrayBuffer();
    if (disposed || myLoadGen !== loadGen) return;
    const owned = new Uint8Array(data).slice();
    sourcePdfBytes = owned.buffer.slice(owned.byteOffset, owned.byteOffset + owned.byteLength);
    const pdfJsBytes = new Uint8Array(owned).slice().buffer;
    pdfLoadingTask = lib.getDocument({ data: pdfJsBytes });
    pdfDoc = await pdfLoadingTask.promise;
    if (disposed || myLoadGen !== loadGen) {
      tearDownPdfDoc();
      return;
    }
  }

  async function renderActivePage() {
    if (!pdfDoc || disposed) return;
    const myGen = ++renderGen;
    if (renderTask?.cancel) {
      try { renderTask.cancel(); } catch { /* ignore */ }
      renderTask = null;
    }
    const pageNum = Number(activePage);
    const page = await pdfDoc.getPage(pageNum);
    if (disposed || myGen !== renderGen) {
      page.cleanup?.();
      return;
    }
    const baseVp = page.getViewport({ scale: 1, rotation: page.rotate });
    basePageW = baseVp.width;
    basePageH = baseVp.height;
    pageRotation = page.rotate || 0;
    const innerW = Math.max(1, stage.clientWidth || 320);
    const innerH = Math.max(240, stage.clientHeight || 400);
    const layout = computeEditorLayoutFromImage({
      naturalWidth: basePageW,
      naturalHeight: basePageH,
      containerInnerWidth: innerW,
      containerInnerHeight: innerH,
      fitMode: zoomFitMode,
      zoom: layoutZoomLevel(),
    });
    const displayW = layout.stageWidth;
    const displayH = layout.stageHeight;
    wrap.__displayW = displayW;
    wrap.__displayH = displayH;
    viewportEl.style.width = `${displayW}px`;
    viewportEl.style.height = `${displayH}px`;
    canvas.style.width = `${displayW}px`;
    canvas.style.height = `${displayH}px`;
    svg.style.width = `${displayW}px`;
    svg.style.height = `${displayH}px`;
    const dpr = typeof globalThis.devicePixelRatio === 'number' ? globalThis.devicePixelRatio : 1;
    const renderScale = (displayW / basePageW) * Math.max(1, dpr);
    const pdfViewport = page.getViewport({ scale: renderScale, rotation: page.rotate });
    canvas.width = Math.floor(pdfViewport.width);
    canvas.height = Math.floor(pdfViewport.height);
    wrap.__lastViewport = viewportMeta();
    const ctx = canvas.getContext('2d');
    renderTask = page.render({ canvasContext: ctx, viewport: pdfViewport });
    await renderTask.promise;
    page.cleanup?.();
    if (disposed || myGen !== renderGen) return;
    syncDraftFromPage();
    renderOverlay();
    updateZoomLabel();
  }

  function onPointerDown(ev) {
    if (tool === 'hand') {
      session.pan = {
        pointerId: ev.pointerId,
        startX: ev.clientX,
        startY: ev.clientY,
        scrollLeft: stage.scrollLeft,
        scrollTop: stage.scrollTop,
      };
      stage.setPointerCapture?.(ev.pointerId);
      stage.style.cursor = 'grabbing';
      return;
    }
    if (readOnlyNow || session.inlineTextEditor) return;
    if (ev.button !== 0 && ev.pointerType === 'mouse') return;
    const { x, y, w, h } = pointerCoords(ev);
    const highlight = tool === 'highlight';

    if (tool === 'pen' || highlight) {
      const color = highlight ? '#FFE566' : session.inkColor;
      const livePath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      livePath.setAttribute('class', 'mark-pen mark-pen-live');
      livePath.setAttribute('fill', 'none');
      livePath.setAttribute('stroke', color);
      livePath.setAttribute('stroke-width', String(penStrokeWidthNorm() * w));
      livePath.setAttribute('stroke-linecap', 'round');
      livePath.setAttribute('stroke-linejoin', 'round');
      if (highlight) livePath.setAttribute('opacity', '0.45');
      svg.appendChild(livePath);
      session.penGesture = {
        pointerId: ev.pointerId,
        pageIndex: 0,
        versionId: 'pdf',
        imageLoadSeq: session.imageLoadSeq,
        preEditableSnapshot: JSON.stringify(editableMarks().slice()),
        w, h,
        color,
        nw: penStrokeWidthNorm(),
        points: [{ x, y }],
        livePath,
        highlight,
      };
      svg.setPointerCapture?.(ev.pointerId);
      return;
    }

    if (tool === 'eraser') {
      const pre = JSON.stringify(draft.pages[0].annotations);
      session.eraserGesture = {
        pointerId: ev.pointerId,
        pageIndex: 0,
        versionId: 'pdf',
        imageLoadSeq: session.imageLoadSeq,
        w, h,
        pathPoints: [{ x, y }],
        touchedIds: [],
        preSnapshot: pre,
      };
      svg.setPointerCapture?.(ev.pointerId);
      return;
    }

    if (tool === 'text') {
      const { mark: hit, handle } = resolveTextHit(x, y, w, h, selectedId);
      if (hit?.type === 'text') {
        if (handle && beginTextDrag(ev, hit, handle, x, y, w, h)) {
          renderOverlay();
          return;
        }
        if (!handle) {
          openInlineTextEditor({
            markId: hit.id,
            anchorX: x,
            anchorY: y,
            text: hit.text,
            isNew: false,
          });
          return;
        }
      }
      openInlineTextEditor({ anchorX: x, anchorY: y, isNew: true });
      return;
    }

    if (tool === 'select') {
      const { mark: hit, handle } = resolveTextHit(x, y, w, h, selectedId);
      if (hit?.type === 'text' && !handle && hit.id === selectedId) {
        openInlineTextEditor({
          markId: hit.id,
          anchorX: x,
          anchorY: y,
          text: hit.text,
          isNew: false,
        });
        return;
      }
      if (hit?.type === 'text' && handle) {
        if (beginTextDrag(ev, hit, handle, x, y, w, h)) {
          renderOverlay();
          return;
        }
      }
      selectedId = hit?.id || null;
      renderOverlay();
    }
  }

  function onPointerMove(ev) {
    if (session.pan?.pointerId === ev.pointerId) {
      const dx = ev.clientX - session.pan.startX;
      const dy = ev.clientY - session.pan.startY;
      stage.scrollLeft = session.pan.scrollLeft - dx;
      stage.scrollTop = session.pan.scrollTop - dy;
      return;
    }
    if (readOnlyNow) return;

    if (session.penGesture?.pointerId === ev.pointerId) {
      const g = session.penGesture;
      const { x, y, w, h } = pointerCoords(ev);
      if (Math.abs(w - g.w) > 1 || Math.abs(h - g.h) > 1) {
        cancelPenGesture();
        return;
      }
      g.points = appendLivePenPixelPoint(g.points, x, y, w, h);
      g.livePath?.setAttribute('d', buildPenPathD(g.points));
      return;
    }

    if (session.eraserGesture?.pointerId === ev.pointerId) {
      const { x, y, w, h } = pointerCoords(ev);
      const g = session.eraserGesture;
      g.pathPoints.push({ x, y });
      const ids = collectPenIdsForEraserPath(
        JSON.parse(g.preSnapshot),
        g.pathPoints,
        w,
        h,
        directTextHandleHitOptions(),
      );
      g.touchedIds = ids;
      draft.pages[0].annotations = removePenMarksByIds(JSON.parse(g.preSnapshot), ids);
      renderOverlay();
      return;
    }

    if (session.drag?.pointerId === ev.pointerId) {
      const { x, y, w, h } = pointerCoords(ev);
      const d = session.drag;
      if (d.generation !== session.gestureGeneration) return;
      const dx = x - d.startX;
      const dy = y - (d.startY ?? y);
      if (!d.didUndo && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) {
        pushUndo();
        d.didUndo = true;
      }
      if (!d.didUndo) return;
      if (d.type === 'text-move') {
        const nx = d.origNx + dx / w;
        const ny = d.origNy + dy / h;
        draft.pages[0].annotations = moveDirectTextAnnotation(
          draft.pages[0].annotations,
          d.markId,
          nx,
          ny,
          w,
          h,
          textLayoutOptions(),
        );
      } else if (d.type === 'text-resize') {
        const mark = draft.pages[0].annotations.find((m) => m.id === d.markId && m.type === 'text');
        if (!mark) return;
        if (d.mode === 'e') {
          const box = layoutDirectTextBox(mark, w, h, textLayoutOptions());
          const newW = Math.max(24, x - box.x);
          const textWidthNorm = computeDirectTextWidthNormFromPixelWidth(newW, w);
          draft.pages[0].annotations = resizeDirectTextAnnotation(
            draft.pages[0].annotations,
            d.markId,
            { textWidthNorm },
            w,
            h,
            textLayoutOptions(),
          );
        } else if (d.mode === 'w') {
          const newNx = Math.max(0, Math.min(d.origRightNx - 0.06, x / w));
          const textWidthNorm = Math.max(0.06, d.origRightNx - newNx);
          draft.pages[0].annotations = resizeDirectTextAnnotation(
            draft.pages[0].annotations,
            d.markId,
            { nx: newNx, textWidthNorm },
            w,
            h,
            textLayoutOptions(),
          );
        }
      }
      renderOverlay();
    }
  }

  function onPointerUp(ev) {
    if (session.pan?.pointerId === ev.pointerId) {
      session.pan = null;
      try { stage.releasePointerCapture?.(ev.pointerId); } catch { /* ignore */ }
      if (tool === 'hand') stage.style.cursor = 'grab';
      return;
    }
    if (session.penGesture?.pointerId === ev.pointerId) {
      settlement.finishPenPointer({ pointerId: ev.pointerId });
      commitAnnotationsFromDraft();
      settleAndCommit();
      queueAutosave();
    } else if (session.eraserGesture?.pointerId === ev.pointerId) {
      settlement.finishEraserPointer?.({ pointerId: ev.pointerId });
      settleAndCommit();
      queueAutosave();
    } else if (session.drag?.pointerId === ev.pointerId) {
      session.drag = null;
      commitAnnotationsFromDraft();
      queueAutosave();
    }
    try { svg.releasePointerCapture?.(ev.pointerId); } catch { /* ignore */ }
    refreshUndoButtons();
  }

  function onPointerCancel(ev) {
    if (session.pan?.pointerId === ev.pointerId) {
      session.pan = null;
      return;
    }
    if (session.penGesture?.pointerId === ev.pointerId) cancelPenGesture();
    else if (session.eraserGesture?.pointerId === ev.pointerId) cancelEraserGesture(true);
    else if (session.drag?.pointerId === ev.pointerId) cancelTextDrag();
    try { svg.releasePointerCapture?.(ev.pointerId); } catch { /* ignore */ }
    try { stage.releasePointerCapture?.(ev.pointerId); } catch { /* ignore */ }
  }

  function keyHandler(e) {
    if (e.target?.matches?.('textarea, input, select')) return;
    if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
    }
    if (e.key === 'Escape') {
      if (session.inlineTextEditor) return;
      if (session.penGesture) {
        e.preventDefault();
        cancelPenGesture();
      } else if (session.eraserGesture) {
        e.preventDefault();
        cancelEraserGesture(true);
      } else if (session.drag) {
        e.preventDefault();
        cancelTextDrag();
      }
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId && !session.inlineTextEditor) {
      if (shouldBlockGradingDestructiveActions({ inlineTextEditing: false })) return;
      e.preventDefault();
      pushUndo();
      draft.pages[0].annotations = draft.pages[0].annotations.filter((m) => m.id !== selectedId);
      selectedId = null;
      commitAnnotationsFromDraft();
      renderOverlay();
      queueAutosave();
    }
  }

  svg.addEventListener('pointerdown', onPointerDown);
  svg.addEventListener('pointermove', onPointerMove);
  svg.addEventListener('pointerup', onPointerUp);
  svg.addEventListener('pointercancel', onPointerCancel);
  svg.addEventListener('dblclick', (ev) => {
    if (readOnlyNow || tool === 'hand') return;
    const { x, y, w, h } = pointerCoords(ev);
    const hit = hitTestAnnotationAt(draft.pages[0].annotations, x, y, w, h, textLayoutOptions());
    if (hit?.type === 'text') {
      openInlineTextEditor({ markId: hit.id, anchorX: x, anchorY: y, text: hit.text, isNew: false });
    }
  });
  wrap.addEventListener('keydown', keyHandler);

  const priorDirtyProbe = getDirtyProbe();
  registerDirtyProbe(() => {
    try {
      if (priorDirtyProbe?.()) return true;
    } catch { /* ignore */ }
    if (readOnlyNow) return false;
    if (session.inlineTextEditor) return true;
    if (session.penGesture || session.eraserGesture || session.drag) return true;
    if (saveQueue?.hasPending() || saveQueue?.hasFailure()) return true;
    return false;
  });

  buildToolbar();
  buildRail();
  setTool(tool);

  let resizeTimer = null;
  const onResize = () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (!disposed) renderActivePage().catch(() => {});
    }, 120);
  };
  if (typeof globalThis.ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(onResize);
    ro.observe(stage);
    wrap.__pdfRo = ro;
  }

  try {
    await loadPdf();
    await renderActivePage();
  } catch (e) {
    if (!disposed && !loadErrorShown) {
      loadErrorShown = true;
      statusEl.textContent = e.message || 'Không mở được PDF.';
      statusEl.className = 'save-status err';
    }
    throw e;
  }

  async function collectExportMarks(pageKey) {
    settleAndCommit();
    const key = String(pageKey);
    if (role === 'teacher') {
      return marksForExportPage({
        role: 'teacher',
        studentMarks: frozenStudentMarks.get(key) || [],
        teacherMarks: pageMarks.get(key) || [],
        includeTeacher: true,
      });
    }
    const frozen = readOnlyNow ? (frozenStudentMarks.get(key) || pageMarks.get(key) || []) : (pageMarks.get(key) || []);
    const teacher = showTeacherLayer ? (teacherMarks.get(key) || []) : [];
    return marksForExportPage({
      role: 'student',
      studentMarks: frozen,
      teacherMarks: teacher,
      includeTeacher: showTeacherLayer,
    });
  }

  async function renderPageToCanvas(pageNum) {
    if (!pdfDoc || !pdfLib) throw new Error('PDF chưa sẵn sàng.');
    const page = await pdfDoc.getPage(Number(pageNum));
    const baseVp = page.getViewport({ scale: 1, rotation: page.rotate });
    const exportScale = Math.max(2, (typeof globalThis.devicePixelRatio === 'number' ? globalThis.devicePixelRatio : 1) * 2);
    const vp = page.getViewport({ scale: exportScale, rotation: page.rotate });
    const off = document.createElement('canvas');
    off.width = Math.floor(vp.width);
    off.height = Math.floor(vp.height);
    const ctx = off.getContext('2d');
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    page.cleanup?.();
    const logicalW = baseVp.width;
    const logicalH = baseVp.height;
    const marks = await collectExportMarks(String(pageNum));
    compositeMarksOntoPageCanvas(off, marks, logicalW, logicalH);
    return off;
  }

  return {
    getSaveQueue: () => saveQueue,
    renderPageToCanvas,
    async exportAnnotatedPdf(opts = {}) {
      settleAndCommit();
      if (saveQueue) await saveQueue.flush();
      let bytes = sourcePdfBytes;
      if (!bytes) {
        bytes = await fetch(sourcePdfUrl, { credentials: 'include' }).then((r) => {
          if (!r.ok) throw new Error('Không tải được PDF gốc.');
          return r.arrayBuffer();
        });
      }
      const exportBytes = new Uint8Array(bytes).slice().buffer;
      return exportAnnotatedExamPdf({
        sourcePdfBytes: exportBytes,
        pageIds,
        renderPageToCanvas,
        filename: opts.filename || 'exam-annotated.pdf',
      });
    },
    async flushSaves() {
      if (blockIfPendingInline()) throw new Error(gradingPendingInlineEditMessage());
      settleAndCommit();
      if (saveQueue) await saveQueue.flush();
    },
    setReadOnly(ro) {
      readOnlyNow = !!ro;
      if (readOnlyNow) {
        closeInlineTextEditor(true);
        setTool('hand');
      }
      buildToolbar();
      syncDraftFromPage();
      renderOverlay();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      loadGen += 1;
      registerDirtyProbe(priorDirtyProbe);
      clearTimeout(resizeTimer);
      wrap.__pdfRo?.disconnect?.();
      tearDownPdfDoc();
      pdfLib = null;
      sourcePdfBytes = null;
      saveQueue?.dispose();
      closeInlineTextEditor(true);
      svg.removeEventListener('pointerdown', onPointerDown);
      svg.removeEventListener('pointermove', onPointerMove);
      svg.removeEventListener('pointerup', onPointerUp);
      svg.removeEventListener('pointercancel', onPointerCancel);
      wrap.removeEventListener('keydown', keyHandler);
      wrap.remove();
    },
    getActivePage: () => activePage,
    getPageMarks: (pageKey) => pageMarks.get(String(pageKey))?.slice() || [],
    getEditableMarks: (pageKey) => pageMarks.get(String(pageKey))?.slice() || [],
    getDisplayMarks: () => displayMarks(),
    role,
  };
}
