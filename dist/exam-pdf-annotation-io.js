/**
 * Convert between exam PDF API stroke/text payloads and grading model marks.
 */

import {
  MARK_INK_COLORS,
  boundPenPointsNormalized,
  clamp01,
  validateAnnotationMark,
} from './model.js';

const PDF_INK_PALETTE = new Set([
  '#25282D',
  '#FFE566',
  ...MARK_INK_COLORS.map((c) => c.value),
]);

const LEGACY_INK_PROBE = MARK_INK_COLORS[0]?.value || '#25282D';

function isPdfInkColor(color, { highlight = false } = {}) {
  if (color == null) return true;
  if (PDF_INK_PALETTE.has(color)) return true;
  if (highlight && color === '#FFE566') return true;
  return false;
}

function legacyCompatibleMarkProbe(mark) {
  if (!mark || typeof mark !== 'object') return mark;
  const probe = { ...mark };
  const c = mark.color;
  if (c != null && isPdfInkColor(c, { highlight: mark.highlight === true }) && !MARK_INK_COLORS.some((row) => row.value === c)) {
    probe.color = LEGACY_INK_PROBE;
  }
  return probe;
}

/** PDF adapter validation — preserves exam editor ink without widening legacy image validators. */
export function validatePdfAnnotationMark(mark) {
  if (!mark || typeof mark !== 'object') {
    return { ok: false, error: 'Mark không phải object.' };
  }
  if (mark.type === 'pen') {
    const highlight = mark.highlight === true;
    if (mark.color != null && !isPdfInkColor(mark.color, { highlight })) {
      return { ok: false, error: 'Màu pen không hợp lệ.' };
    }
    const base = validateAnnotationMark(legacyCompatibleMarkProbe(mark));
    if (!base.ok) return base;
    return { ok: true };
  }
  if (mark.type === 'text') {
    if (mark.color != null && !isPdfInkColor(mark.color)) {
      return { ok: false, error: 'Màu chữ không hợp lệ.' };
    }
    const base = validateAnnotationMark(legacyCompatibleMarkProbe(mark));
    if (!base.ok) return base;
    return { ok: true };
  }
  return validateAnnotationMark(mark);
}

function sanitizePdfPageAnnotations(annotations) {
  const out = [];
  for (const m of annotations || []) {
    const v = validatePdfAnnotationMark(m);
    if (v.ok) out.push(m);
  }
  return out;
}

function flatPairsToNormPoints(flat) {
  if (!Array.isArray(flat) || flat.length < 2) return [];
  const pts = [];
  for (let i = 0; i + 1 < flat.length; i += 2) {
    const nx = Number(flat[i]);
    const ny = Number(flat[i + 1]);
    if (!Number.isFinite(nx) || !Number.isFinite(ny)) continue;
    pts.push({ nx: clamp01(nx), ny: clamp01(ny) });
  }
  return boundPenPointsNormalized(pts);
}

export function serverStrokeToMark(stroke) {
  if (!stroke || typeof stroke !== 'object') return null;
  const norm = flatPairsToNormPoints(stroke.points);
  if (!norm.length) return null;
  const isHighlight = stroke.tool === 'highlight';
  return {
    id: String(stroke.id || `s-${norm.length}`),
    type: 'pen',
    points: norm,
    color: stroke.color || (isHighlight ? '#FFE566' : (MARK_INK_COLORS[0]?.value || '#25282D')),
    nw: Number(stroke.nw) > 0 ? Number(stroke.nw) : (isHighlight ? 0.02 : 0.008),
    highlight: isHighlight,
  };
}

export function markToServerStroke(mark) {
  if (!mark || mark.type !== 'pen') return null;
  const flat = [];
  for (const pt of mark.points || []) {
    if (pt?.nx == null || pt?.ny == null) continue;
    flat.push(Number(pt.nx), Number(pt.ny));
  }
  if (flat.length < 2) return null;
  const isHighlight = mark.highlight === true;
  return {
    id: mark.id,
    tool: isHighlight ? 'highlight' : 'pen',
    points: flat,
    color: mark.color,
    nw: mark.nw,
  };
}

export function serverTextToMark(text) {
  if (!text || typeof text !== 'object') return null;
  const widthNorm = Number(text.widthNorm);
  return {
    id: String(text.id || 't'),
    type: 'text',
    text: String(text.text || ''),
    nx: Number(text.nx),
    ny: Number(text.ny),
    textWidthNorm: Number.isFinite(widthNorm) && widthNorm > 0 ? widthNorm : 0.35,
    color: text.color || (MARK_INK_COLORS[0]?.value || '#25282D'),
    fontSizeNorm: Number(text.fontSizeNorm) > 0 ? Number(text.fontSizeNorm) : 0.02,
  };
}

export function markToServerText(mark) {
  if (!mark || mark.type !== 'text') return null;
  const widthNorm = mark.textWidthNorm ?? mark.widthNorm;
  return {
    id: mark.id,
    text: mark.text,
    nx: mark.nx,
    ny: mark.ny,
    widthNorm: Number.isFinite(widthNorm) && widthNorm > 0 ? widthNorm : 0.35,
    color: mark.color,
    fontSizeNorm: mark.fontSizeNorm,
  };
}

export function serverPageToMarks(pageRow) {
  const strokes = (pageRow?.strokes || []).map(serverStrokeToMark).filter(Boolean);
  const texts = (pageRow?.texts || []).map(serverTextToMark).filter(Boolean);
  return sanitizePdfPageAnnotations([...strokes, ...texts]);
}

export function marksToServerPagePayload(marks, viewport) {
  const strokes = [];
  const texts = [];
  for (const m of sanitizePdfPageAnnotations(marks || [])) {
    const v = validatePdfAnnotationMark(m);
    if (!v.ok) continue;
    if (m.type === 'pen') {
      const s = markToServerStroke(m);
      if (s) strokes.push(s);
    } else if (m.type === 'text') {
      const t = markToServerText(m);
      if (t) texts.push(t);
    }
  }
  return {
    strokes,
    texts,
    viewport: viewport ? { ...viewport } : { width: 0, height: 0, pageWidth: 0, pageHeight: 0 },
  };
}

export function mergeMarksLayers(studentMarks, teacherMarks, { includeTeacher = false } = {}) {
  const base = sanitizePdfPageAnnotations(studentMarks || []);
  if (!includeTeacher) return base;
  const teacher = sanitizePdfPageAnnotations(teacherMarks || []);
  return sanitizePdfPageAnnotations([...base, ...teacher]);
}
