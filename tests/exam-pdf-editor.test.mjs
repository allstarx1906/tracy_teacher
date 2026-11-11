import test from 'node:test';
import assert from 'node:assert/strict';
import {
  serverStrokeToMark,
  markToServerStroke,
  serverPageToMarks,
  marksToServerPagePayload,
  validatePdfAnnotationMark,
} from '../dist/exam-pdf-annotation-io.js';
import { MARK_INK_COLORS } from '../dist/model.js';
import { createExamPdfSaveQueue } from '../dist/exam-pdf-save.js';
import {
  boundPenPointsNormalized,
  createPenMarkFromPixelStroke,
  moveDirectTextAnnotation,
  layoutDirectTextBox,
  directTextHandleCenters,
} from '../dist/model.js';
import { installBaDomEnvironment, createMinimalDomElement, findDomNodeByAttr } from './helper-browser-window.mjs';
import { mountExamPdfEditor } from '../dist/exam-pdf-editor.js';
import { exportAnnotatedExamPdf, marksForExportPage } from '../dist/exam-pdf-export.js';
import { drawExamPdfMarksOnCanvas, renderExamPdfAnnotationsSvg } from '../dist/exam-pdf-render.js';
import { registerDirtyProbe } from '../dist/ux-forms.js';

test('stroke round-trip normalized coordinates', () => {
  const mark = createPenMarkFromPixelStroke({
    id: 'p1',
    points: [{ x: 10, y: 20 }, { x: 40, y: 60 }],
    w: 200,
    h: 100,
    color: '#111',
    nw: 0.01,
  });
  assert.ok(mark);
  const stroke = markToServerStroke(mark);
  const back = serverStrokeToMark(stroke);
  assert.equal(back.id, mark.id);
  assert.deepEqual(back.points, mark.points);
});

test('text drag updates normalized anchor', () => {
  const mark = {
    id: 't1',
    type: 'text',
    text: 'Xin chào',
    nx: 0.2,
    ny: 0.3,
    widthNorm: 0.35,
    color: '#111',
    fontSizeNorm: 0.02,
  };
  let marks = [mark];
  marks = moveDirectTextAnnotation(marks, 't1', 0.45, 0.55, 400, 300, {});
  assert.ok(Math.abs(marks[0].nx - 0.45) < 0.001);
  assert.ok(Math.abs(marks[0].ny - 0.55) < 0.001);
  assert.ok(Math.abs((marks[0].textWidthNorm ?? 0.35) - 0.35) < 0.001);
});

test('save queue keeps newest body after failure', async () => {
  let calls = 0;
  let revision = 0;
  const q = createExamPdfSaveQueue({
    savePage: async (_page, body, baseRev) => {
      calls += 1;
      if (calls === 1) {
        const err = new Error('fail');
        err.status = 500;
        throw err;
      }
      assert.equal(body.strokes[0].id, 'newest');
      assert.equal(baseRev, revision);
      revision += 1;
      return { revision };
    },
  });
  q.setBaseRevision(0);
  q.enqueue('1', { strokes: [{ id: 'old', points: [0, 0] }], texts: [], viewport: {} });
  q.enqueue('1', { strokes: [{ id: 'newest', points: [0, 0, 1, 1] }], texts: [], viewport: {} });
  await new Promise((r) => setTimeout(r, 30));
  q.enqueue('1', { strokes: [{ id: 'newest', points: [0, 0, 1, 1] }], texts: [], viewport: {} });
  await q.flush();
  assert.ok(calls >= 2);
});

test('default pen highlight text round-trip through PDF adapter', () => {
  const penColor = MARK_INK_COLORS[0].value;
  const penMark = serverStrokeToMark({
    id: 'pen1',
    tool: 'pen',
    points: [0.1, 0.2, 0.3, 0.35],
    color: penColor,
    nw: 0.008,
  });
  assert.ok(validatePdfAnnotationMark(penMark).ok);
  const hlMark = serverStrokeToMark({
    id: 'hl1',
    tool: 'highlight',
    points: [0.4, 0.4, 0.5, 0.45],
    color: '#FFE566',
    nw: 0.02,
  });
  assert.ok(validatePdfAnnotationMark(hlMark).ok);
  const hlRoundTrip = markToServerStroke(hlMark);
  assert.equal(hlRoundTrip.tool, 'highlight');
  assert.equal(hlRoundTrip.color, '#FFE566');
  assert.equal(hlRoundTrip.nw, 0.02);
  const hlAgain = serverStrokeToMark(hlRoundTrip);
  assert.ok(validatePdfAnnotationMark(hlAgain).ok);
  const textMark = serverPageToMarks({
    strokes: [],
    texts: [{ id: 't1', nx: 0.2, ny: 0.3, widthNorm: 0.35, text: 'Ghi chú', color: penColor }],
  })[0];
  assert.ok(validatePdfAnnotationMark(textMark).ok);
  const payload = marksToServerPagePayload([penMark, hlMark, textMark], { width: 100, height: 100, pageWidth: 100, pageHeight: 100 });
  assert.equal(payload.strokes.length, 2);
  assert.equal(payload.texts.length, 1);
});

test('marksToServerPagePayload clamps pen points', () => {
  const longPts = [];
  for (let i = 0; i < 800; i++) longPts.push(i / 1000, i / 1000);
  const marks = serverPageToMarks({
    strokes: [{ id: 'big', points: longPts }],
    texts: [],
  });
  const bounded = boundPenPointsNormalized(marks[0].points);
  assert.ok(bounded.length <= 600);
  const payload = marksToServerPagePayload(marks, { width: 100, height: 100, pageWidth: 100, pageHeight: 100 });
  assert.equal(payload.strokes.length, 1);
});

function installPdfJsStub(pageW = 400, pageH = 300) {
  globalThis.__examPdfJsTestLib = async () => ({
    GlobalWorkerOptions: {},
    getDocument: () => ({
      promise: Promise.resolve({
        numPages: 2,
        getPage: async () => ({
          rotate: 0,
          getViewport: ({ scale } = {}) => ({
            width: pageW * (scale || 1),
            height: pageH * (scale || 1),
          }),
          render: () => ({ promise: Promise.resolve() }),
          cleanup: () => {},
        }),
      }),
    }),
  });
}

const MINI_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function validMiniPngBytes() {
  const bin = Buffer.from(MINI_PNG_B64, 'base64');
  return new Uint8Array(bin);
}

function canvasWithPngExport(w = 400, h = 300) {
  const pngBytes = validMiniPngBytes();
  const c = createMinimalDomElement('canvas');
  c.width = w;
  c.height = h;
  c.getBoundingClientRect = () => ({ left: 0, top: 0, width: w, height: h });
  c.toDataURL = () => `data:image/png;base64,${MINI_PNG_B64}`;
  c.toBlob = (cb) => cb(new Blob([pngBytes], { type: 'image/png' }));
  c.__pngBytes = pngBytes;
  const ctx = c.getContext('2d');
  ctx.drawImage = () => {};
  ctx.fillText = () => {};
  return c;
}

function installPdfEditorTestRuntime(t) {
  const originalFetch = globalThis.fetch;
  const originalResizeObserver = globalThis.ResizeObserver;
  installBaDomEnvironment(t);
  installPdfJsStub();
  globalThis.fetch = async () => ({
    ok: true,
    arrayBuffer: async () => new ArrayBuffer(16),
  });
  globalThis.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  t.after(() => {
    registerDirtyProbe(null);
    globalThis.fetch = originalFetch;
    globalThis.ResizeObserver = originalResizeObserver;
    delete globalThis.__examPdfJsTestLib;
  });
  return { originalFetch };
}

test('exam pdf editor: pen gesture undo and teacher layer isolation', async (t) => {
  installPdfEditorTestRuntime(t);
  const host = createMinimalDomElement('div');
  host.clientWidth = 390;
  document.body.appendChild(host);
  const editor = await mountExamPdfEditor(host, {
    pageIds: ['1', '2'],
    sourcePdfUrl: '/test.pdf',
    role: 'teacher',
    studentPages: {
      1: { strokes: [{ id: 'stu', tool: 'pen', points: [0.1, 0.1, 0.2, 0.2], color: MARK_INK_COLORS[0].value }], texts: [] },
    },
    teacherPages: { 1: { strokes: [], texts: [] } },
    savePage: async () => ({ revision: 1 }),
  });
  t.after(() => {
    editor.dispose();
    host.remove();
  });
  const display = editor.getDisplayMarks();
  assert.equal(display.length, 1);
  assert.equal(editor.getEditableMarks('1').length, 0);
  const svg = host.querySelector('.annotation-layer');
  assert.ok(svg);
  svg.getBoundingClientRect = () => ({ left: 0, top: 0, width: 320, height: 240 });
  const penBtn = host.querySelector('[data-tool="pen"]');
  penBtn?.dispatchEvent?.({ type: 'click', bubbles: true });
  svg.dispatchEvent({
    type: 'pointerdown',
    pointerId: 1,
    button: 0,
    pointerType: 'mouse',
    clientX: 40,
    clientY: 50,
    bubbles: true,
  });
  svg.dispatchEvent({
    type: 'pointermove',
    pointerId: 1,
    clientX: 80,
    clientY: 90,
    bubbles: true,
  });
  svg.dispatchEvent({
    type: 'pointerup',
    pointerId: 1,
    clientX: 80,
    clientY: 90,
    bubbles: true,
  });
  assert.equal(editor.getEditableMarks('1').length, 1);
  // The minimal selector parser splits spaces, including quoted attribute values.
  const undoBtn = findDomNodeByAttr(host, 'aria-label', 'Hoàn tác');
  assert.ok(undoBtn, 'the undo control must exist before dispatching the click');
  undoBtn.dispatchEvent({ type: 'click', bubbles: true });
  assert.equal(editor.getEditableMarks('1').length, 0);
  assert.ok(editor.getDisplayMarks().length >= 1);
});

test('exam pdf editor: inline text requires Xong and cancel restores', async (t) => {
  installPdfEditorTestRuntime(t);
  const host = createMinimalDomElement('div');
  host.clientWidth = 320;
  document.body.appendChild(host);
  const editor = await mountExamPdfEditor(host, {
    pageIds: ['1'],
    sourcePdfUrl: '/test.pdf',
    role: 'student',
    savePage: async () => ({ revision: 1 }),
  });
  t.after(() => {
    editor.dispose();
    host.remove();
  });
  const svg = host.querySelector('.annotation-layer');
  svg.getBoundingClientRect = () => ({ left: 0, top: 0, width: 300, height: 220 });
  const textBtn = host.querySelector('[data-tool="text"]');
  textBtn?.dispatchEvent?.({ type: 'click', bubbles: true });
  svg.dispatchEvent({
    type: 'pointerdown',
    pointerId: 2,
    button: 0,
    pointerType: 'mouse',
    clientX: 60,
    clientY: 70,
    bubbles: true,
  });
  const textarea = host.querySelector('.grading-inline-text-input');
  assert.ok(textarea);
  textarea.value = 'Tiếng Việt';
  textarea.dispatchEvent({ type: 'input', bubbles: true });
  const cancel = [...host.querySelectorAll('button')].find((b) => (b.textContent || '').includes('Hủy'));
  cancel?.dispatchEvent?.({ type: 'click', bubbles: true });
  assert.equal(editor.getEditableMarks('1').length, 0);
});

test('export annotated pdf uses render callback and selected page count', async (t) => {
  installBaDomEnvironment(t);
  const { PDFDocument } = await import('pdf-lib');
  const src = await PDFDocument.create();
  src.addPage([400, 300]);
  src.addPage([400, 300]);
  const sourcePdfBytes = await src.save();
  const renderPageToCanvas = async (pageNum) => {
    const canvas = canvasWithPngExport(400, 300);
    const marks = marksForExportPage({
      role: 'student',
      studentMarks: [{
        id: `m-${pageNum}`,
        type: 'text',
        text: `Trang ${pageNum}`,
        nx: 0.2,
        ny: 0.2,
        textWidthNorm: 0.4,
        fontSizeNorm: 0.04,
        color: MARK_INK_COLORS[0].value,
      }],
      teacherMarks: [],
      includeTeacher: false,
    });
    drawExamPdfMarksOnCanvas(canvas.getContext('2d'), marks, 400, 300, {});
    canvas.__pageWidth = 400;
    canvas.__pageHeight = 300;
    return canvas;
  };
  const result = await exportAnnotatedExamPdf({
    sourcePdfBytes,
    pageIds: ['1'],
    renderPageToCanvas,
    filename: 'test-out.pdf',
  });
  assert.equal(result.pageCount, 1);
  const out = await PDFDocument.load(result.bytes);
  assert.equal(out.getPageCount(), 1);
  await assert.rejects(
    () => exportAnnotatedExamPdf({ sourcePdfBytes, pageIds: ['1'] }),
    /renderPageToCanvas|chú thích/i,
  );
});

test('direct text Vietnamese renders finite SVG text nodes', (t) => {
  installBaDomEnvironment(t);
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const mark = {
    id: 'vn',
    type: 'text',
    text: 'Em đã hoàn thành bài.',
    nx: 0.15,
    ny: 0.2,
    textWidthNorm: 0.4,
    fontSizeNorm: 0.04,
    color: '#25282D',
  };
  renderExamPdfAnnotationsSvg(svg, [mark], 400, 300, {});
  const texts = svg.querySelectorAll('text');
  assert.ok(texts.length >= 1);
  assert.match(texts[0].textContent || '', /hoàn thành/);
  const y = Number(texts[0].getAttribute('y'));
  assert.ok(Number.isFinite(y) && y > 0);
});

test('export uses independent copy after simulated PDF.js detach', async (t) => {
  installBaDomEnvironment(t);
  const { PDFDocument } = await import('pdf-lib');
  const src = await PDFDocument.create();
  src.addPage([300, 200]);
  const sourcePdfBytes = await src.save();
  const work = new Uint8Array(sourcePdfBytes);
  if (typeof globalThis.structuredClone === 'function') {
    try {
      structuredClone(work, { transfer: [work.buffer] });
    } catch {
      /* node may not transfer */
    }
  }
  const renderPageToCanvas = async () => canvasWithPngExport(300, 200);
  const result = await exportAnnotatedExamPdf({
    sourcePdfBytes: new Uint8Array(sourcePdfBytes).slice().buffer,
    pageIds: ['1'],
    renderPageToCanvas,
  });
  assert.equal(result.pageCount, 1);
});

test('pointercancel only clears matching gesture', async (t) => {
  installPdfEditorTestRuntime(t);
  const host = createMinimalDomElement('div');
  host.clientWidth = 320;
  document.body.appendChild(host);
  const editor = await mountExamPdfEditor(host, {
    pageIds: ['1'],
    sourcePdfUrl: '/t.pdf',
    role: 'student',
  });
  t.after(() => {
    editor.dispose();
    host.remove();
  });
  const svg = host.querySelector('.annotation-layer');
  svg.getBoundingClientRect = () => ({ left: 0, top: 0, width: 300, height: 220 });
  const penBtn = host.querySelector('[data-tool="pen"]');
  penBtn?.dispatchEvent?.({ type: 'click', bubbles: true });
  svg.dispatchEvent({
    type: 'pointerdown',
    pointerId: 9,
    button: 0,
    pointerType: 'mouse',
    clientX: 10,
    clientY: 10,
    bubbles: true,
  });
  svg.dispatchEvent({ type: 'pointercancel', pointerId: 99, bubbles: true });
  svg.dispatchEvent({
    type: 'pointerup',
    pointerId: 9,
    clientX: 20,
    clientY: 20,
    bubbles: true,
  });
  assert.equal(editor.getEditableMarks('1').length, 1);
});

test('editor exportAnnotatedPdf uses owned source bytes through mount path', async (t) => {
  const { originalFetch } = installPdfEditorTestRuntime(t);
  const testDocument = document;
  const originalCreateElement = testDocument.createElement;
  testDocument.createElement = function (tag, ...args) {
    return String(tag).toLowerCase() === 'canvas'
      ? canvasWithPngExport(320, 240)
      : originalCreateElement.call(this, tag, ...args);
  };
  t.after(() => { testDocument.createElement = originalCreateElement; });
  const { PDFDocument } = await import('pdf-lib');
  const src = await PDFDocument.create();
  src.addPage([320, 240]);
  const pdfBytes = await src.save();
  const pageW = 320;
  const pageH = 240;
  globalThis.__examPdfJsTestLib = async () => ({
    GlobalWorkerOptions: {},
    getDocument: (opts) => {
      if (opts?.data) {
        try {
          const u8 = new Uint8Array(opts.data);
          if (typeof globalThis.structuredClone === 'function') {
            structuredClone(u8, { transfer: [u8.buffer] });
          }
        } catch { /* node may not transfer */ }
      }
      return {
        destroy: () => {},
        promise: Promise.resolve({
          numPages: 1,
          getPage: async () => ({
            rotate: 0,
            getViewport: ({ scale } = {}) => ({
              width: pageW * (scale || 1),
              height: pageH * (scale || 1),
            }),
            render: () => ({ promise: Promise.resolve() }),
            cleanup: () => {},
          }),
        }),
      };
    },
  });
  globalThis.fetch = async (url) => {
    if (String(url).includes('.pdf')) {
      return { ok: true, arrayBuffer: async () => pdfBytes.slice().buffer };
    }
    return originalFetch(url);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const host = createMinimalDomElement('div');
  host.clientWidth = 320;
  document.body.appendChild(host);
  const editor = await mountExamPdfEditor(host, {
    pageIds: ['1'],
    sourcePdfUrl: '/owned.pdf',
    role: 'student',
    savePage: async () => ({ revision: 1 }),
  });
  t.after(() => {
    editor.dispose();
    host.remove();
  });
  const result = await editor.exportAnnotatedPdf({ filename: 'mount-path.pdf' });
  assert.equal(result.pageCount, 1);
  const out = await PDFDocument.load(result.bytes);
  assert.equal(out.getPageCount(), 1);
});

test('select tool moves direct text mark in the DOM overlay', async (t) => {
  installPdfEditorTestRuntime(t);
  const host = createMinimalDomElement('div');
  host.clientWidth = 320;
  document.body.appendChild(host);
  const penColor = MARK_INK_COLORS[0].value;
  const editor = await mountExamPdfEditor(host, {
    pageIds: ['1'],
    sourcePdfUrl: '/test.pdf',
    role: 'student',
    studentPages: {
      1: {
        strokes: [],
        texts: [{
          id: 't-move',
          nx: 0.25,
          ny: 0.35,
          widthNorm: 0.35,
          text: 'Kéo tôi',
          color: penColor,
          fontSizeNorm: 0.04,
        }],
      },
    },
    savePage: async () => ({ revision: 1 }),
  });
  t.after(() => {
    editor.dispose();
    host.remove();
  });
  const svg = host.querySelector('.annotation-layer');
  const w = 300;
  const h = 220;
  svg.getBoundingClientRect = () => ({ left: 0, top: 0, width: w, height: h });
  const before = editor.getEditableMarks('1')[0];
  const mark = { ...before, type: 'text' };
  const box = layoutDirectTextBox(mark, w, h, {});
  const move = directTextHandleCenters(box).move;
  const selectBtn = host.querySelector('[data-tool="select"]');
  selectBtn?.dispatchEvent?.({ type: 'click', bubbles: true });
  svg.dispatchEvent({
    type: 'pointerdown',
    pointerId: 7,
    button: 0,
    pointerType: 'mouse',
    clientX: move.x,
    clientY: move.y,
    bubbles: true,
  });
  svg.dispatchEvent({
    type: 'pointermove',
    pointerId: 7,
    clientX: move.x + 40,
    clientY: move.y + 30,
    bubbles: true,
  });
  svg.dispatchEvent({
    type: 'pointerup',
    pointerId: 7,
    clientX: move.x + 40,
    clientY: move.y + 30,
    bubbles: true,
  });
  const after = editor.getEditableMarks('1')[0];
  assert.ok(after.nx > before.nx + 0.05);
  assert.ok(after.ny > before.ny + 0.05);
});
