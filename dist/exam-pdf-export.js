import { pdfLibEsmUrl } from './exam-api.js';
import { marksToServerPagePayload, serverPageToMarks } from './exam-pdf-annotation-io.js';
import { drawExamPdfMarksOnCanvas } from './exam-pdf-render.js';

async function loadPdfLib() {
  if (typeof globalThis !== 'undefined' && globalThis.PDFLib) return globalThis.PDFLib;
  try {
    const mod = await import('pdf-lib');
    return { PDFDocument: mod.PDFDocument };
  } catch {
    const mod = await import(/* webpackIgnore: true */ pdfLibEsmUrl());
    const lib = mod.default || mod;
    return lib.PDFDocument ? lib : { PDFDocument: lib.PDFDocument };
  }
}

async function canvasToPngBytes(canvas) {
  if (canvas?.__pngBytes) return canvas.__pngBytes;
  if (typeof canvas?.toBlob === 'function') {
    return new Promise((resolve, reject) => {
      canvas.toBlob(async (blob) => {
        if (!blob) reject(new Error('Không xuất được ảnh trang.'));
        else resolve(new Uint8Array(await blob.arrayBuffer()));
      }, 'image/png');
    });
  }
  if (typeof canvas?.toDataURL === 'function') {
    const dataUrl = canvas.toDataURL('image/png');
    const b64 = dataUrl.split(',')[1];
    if (!b64) throw new Error('Không xuất được ảnh trang.');
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  throw new Error('Không xuất được ảnh trang — thiếu canvas.');
}

/**
 * Build a downloadable annotated PDF (selected pages only, flattened marks).
 */
export async function exportAnnotatedExamPdf({
  sourcePdfBytes,
  pageIds,
  studentPages = {},
  teacherPages = {},
  includeTeacherLayer = false,
  renderPageToCanvas,
  filename = 'exam-annotated.pdf',
  marksForPage,
}) {
  const PDFLib = await loadPdfLib();
  const srcDoc = await PDFLib.PDFDocument.load(sourcePdfBytes);
  const outDoc = await PDFLib.PDFDocument.create();
  const pages = pageIds.map((p) => Number(p)).filter((n) => Number.isInteger(n) && n >= 1);
  if (!pages.length) throw new Error('Không có trang để xuất.');

  for (const pageNum of pages) {
    const key = String(pageNum);
    let pngBytes = null;
    let pageWidth = 0;
    let pageHeight = 0;
  if (typeof renderPageToCanvas === 'function') {
      const canvas = await renderPageToCanvas(pageNum);
      if (!canvas) {
        throw new Error(`Không render được trang ${pageNum}.`);
      }
      pngBytes = await canvasToPngBytes(canvas);
      pageWidth = canvas.__pageWidth || canvas.width || 0;
      pageHeight = canvas.__pageHeight || canvas.height || 0;
    } else if (typeof marksForPage === 'function') {
      throw new Error('Xuất PDF cần render trang có chú thích — thiếu renderPageToCanvas.');
    }
    if (!pngBytes) {
      throw new Error(
        `Không thể xuất trang ${pageNum} có chú thích. Tải lại và thử lại.`,
      );
    }
    const page = outDoc.addPage();
    const img = await outDoc.embedPng(pngBytes);
    const natural = img.scale(1);
    const w = pageWidth > 0 ? pageWidth : natural.width;
    const h = pageHeight > 0 ? pageHeight : natural.height;
    page.setSize(w, h);
    page.drawImage(img, { x: 0, y: 0, width: w, height: h });
  }

  const bytes = await outDoc.save();
  const blob = new Blob([bytes], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  return { ok: true, pageCount: pages.length, bytes };
}

export function collectPageLayersForExport(studentPages, teacherPages, pageIds, includeTeacher) {
  const out = {};
  for (const pid of pageIds) {
    const key = String(pid);
    const student = serverPageToMarks(studentPages[key] || {});
    const teacher = includeTeacher ? serverPageToMarks(teacherPages[key] || {}) : [];
    out[key] = marksToServerPagePayload([...student, ...teacher], studentPages[key]?.viewport);
  }
  return out;
}

/** Merge student + teacher mark arrays for one export page. */
export function marksForExportPage({ role, studentMarks, teacherMarks, includeTeacher }) {
  if (role === 'teacher') {
    return [...(studentMarks || []), ...(teacherMarks || [])];
  }
  const student = studentMarks || [];
  const teacher = includeTeacher ? (teacherMarks || []) : [];
  return [...student, ...teacher];
}

/**
 * Draw annotation layers onto an already-rendered PDF page canvas.
 */
export function compositeMarksOntoPageCanvas(canvas, marks, logicalW, logicalH) {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Không có ngữ cảnh canvas.');
  const cw = canvas.width || logicalW;
  const ch = canvas.height || logicalH;
  const scaleX = cw / Math.max(1, logicalW);
  const scaleY = ch / Math.max(1, logicalH);
  ctx.save();
  ctx.scale(scaleX, scaleY);
  drawExamPdfMarksOnCanvas(ctx, marks, logicalW, logicalH, {});
  ctx.restore();
  canvas.__pageWidth = logicalW;
  canvas.__pageHeight = logicalH;
  return canvas;
}
