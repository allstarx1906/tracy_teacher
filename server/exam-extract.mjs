import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import {
  sanitizeExamHtml,
  newExamSectionId,
  newExamQuestionId,
  defaultOptionIds,
} from '../dist/exam-domain.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PDFJS_ROOT = path.join(__dirname, '..', 'node_modules', 'pdfjs-dist', 'legacy', 'build');

let pdfjsModulePromise = null;

async function getPdfJs() {
  if (!pdfjsModulePromise) {
    pdfjsModulePromise = import(pathToFileURL(path.join(PDFJS_ROOT, 'pdf.mjs')).href).then((mod) => {
      const lib = mod.default || mod;
      if (lib.GlobalWorkerOptions) {
        lib.GlobalWorkerOptions.workerSrc = pathToFileURL(
          path.join(PDFJS_ROOT, 'pdf.worker.mjs'),
        ).href;
      }
      return lib;
    });
  }
  return pdfjsModulePromise;
}

export function examContentDigest(buffer, options = {}) {
  const h = createHash('sha256');
  h.update(buffer);
  h.update(JSON.stringify({
    questionPages: options.questionPages || null,
    keyPages: options.keyPages || null,
  }));
  return h.digest('hex');
}

function transformY(transform) {
  if (!transform || transform.length < 6) return 0;
  return transform[5];
}

function transformX(transform) {
  if (!transform || transform.length < 6) return 0;
  return transform[4];
}

function sortReadingOrder(items) {
  return [...items].sort((a, b) => {
    const dy = transformY(b.transform) - transformY(a.transform);
    if (Math.abs(dy) > 2) return dy;
    return transformX(a.transform) - transformX(b.transform);
  });
}

const DEFAULT_PAGE_WIDTH = 612;
const MIN_COLUMN_GAP = 40;

function buildLinesFromItems(items) {
  const sorted = sortReadingOrder(items);
  const lines = [];
  let line = [];
  let lastY = null;
  for (const it of sorted) {
    const t = itemText(it);
    if (!t) continue;
    const y = transformY(it.transform);
    if (lastY != null && Math.abs(lastY - y) > 14) {
      if (line.length) lines.push(line);
      line = [];
    }
    line.push({ text: t, bbox: bboxFromItem(it), fontName: it.fontName || '' });
    lastY = y;
  }
  if (line.length) lines.push(line);
  return lines;
}

function detectColumnSplit(items) {
  if (items.length < 2) return null;
  const xs = items.map((it) => transformX(it.transform)).sort((a, b) => a - b);
  let bestGap = 0;
  let split = null;
  for (let i = 1; i < xs.length; i++) {
    const gap = xs[i] - xs[i - 1];
    if (gap > bestGap && gap >= MIN_COLUMN_GAP) {
      bestGap = gap;
      split = (xs[i] + xs[i - 1]) / 2;
    }
  }
  return split;
}

function isFullWidthTextItem(item, splitX, pageWidth) {
  const x = transformX(item.transform);
  const w = item.width || 0;
  if (w >= pageWidth * 0.45) return true;
  if (splitX == null) return false;
  return x < splitX - 8 && x + w > splitX + 8;
}

function pageLinesFromRawItems(rawItems, pageWidth = DEFAULT_PAGE_WIDTH) {
  const withText = rawItems.filter((it) => itemText(it));
  if (!withText.length) return [];

  const splitX = detectColumnSplit(withText);
  if (splitX == null) {
    return buildLinesFromItems(withText);
  }

  const full = [];
  const left = [];
  const right = [];
  for (const it of withText) {
    if (isFullWidthTextItem(it, splitX, pageWidth)) {
      full.push(it);
      continue;
    }
    const x = transformX(it.transform);
    if (x >= splitX) right.push(it);
    else left.push(it);
  }

  return [
    ...buildLinesFromItems(full),
    ...buildLinesFromItems(left),
    ...buildLinesFromItems(right),
  ];
}

function itemText(item) {
  return String(item.str || '').replace(/\s+/g, ' ').trim();
}

function bboxFromItem(item) {
  const x = transformX(item.transform);
  const y = transformY(item.transform);
  const w = item.width || 0;
  const h = item.height || 12;
  return { x, y: y - h, w, h, page: item.pageNumber };
}

async function releasePdfResources(pdf, loadingTask) {
  try {
    pdf?.cleanup?.();
  } catch (_) {
    /* ignore */
  }
  if (loadingTask && typeof loadingTask.destroy === 'function') {
    await loadingTask.destroy();
  }
}

export async function extractPdfPages(buffer, pageNumbers, { pageTimeoutMs = 60_000 } = {}) {
  const pdfjs = await getPdfJs();
  const loadingTask = pdfjs.getDocument({ data: new Uint8Array(buffer), useSystemFonts: true });
  const pdf = await loadingTask.promise;
  const pages = [];
  try {
    for (const pageNum of pageNumbers) {
      if (pageNum < 1 || pageNum > pdf.numPages) {
        throw new Error('page-out-of-range');
      }
      const page = await pdf.getPage(pageNum);
      let timedOut = false;
      const textPromise = page.getTextContent();
      let timeoutId;
      const timeout = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          timedOut = true;
          reject(new Error('page-timeout'));
        }, pageTimeoutMs);
      });
      let content;
      try {
        content = await Promise.race([textPromise, timeout]);
      } finally {
        clearTimeout(timeoutId);
      }
      if (timedOut) {
        page.cleanup?.();
        throw new Error('page-timeout');
      }
      const rawItems = (content.items || []).map((it) => ({
        ...it,
        pageNumber: pageNum,
      }));
      const lines = pageLinesFromRawItems(rawItems);
      const sorted = sortReadingOrder(rawItems);
      const plain = lines.map((ln) => ln.map((x) => x.text).join(' ')).join('\n');
      pages.push({
        pageNumber: pageNum,
        needsOcr: rawItems.length === 0,
        lines,
        plainText: plain,
        items: sorted.map((it) => ({
          text: itemText(it),
          bbox: bboxFromItem(it),
          fontName: it.fontName || '',
        })),
      });
      page.cleanup?.();
    }
  } finally {
    try {
      await releasePdfResources(pdf, loadingTask);
    } catch (_) {
      /* preserve parse errors from try; cleanup must not mask successful extraction */
    }
  }
  return pages;
}

const QUESTION_START = /^(?:Question\s*)?(\d+)\s*[.)]\s*(.*)$/i;
const OPTION_LINE = /^(?:\(([A-F])\)|([A-F])[.)])\s*(.+)$/i;
const PASSAGE_HEADER = /^(Reading|Passage)\b/i;
const QUESTIONS_RANGE = /Questions?\s+(\d+)\s*[-–]\s*(\d+)/i;

function parseQuestionsFromPages(pages, warnings) {
  const sectionId = newExamSectionId();
  const sections = [{ id: sectionId, title: 'Phần 1', order: 0 }];
  const passages = [];
  let currentPassageId = null;
  const questions = [];
  let qOrdinal = 0;

  for (const page of pages) {
    if (page.needsOcr) {
      warnings.push(`Trang ${page.pageNumber}: không trích được chữ — cần OCR.`);
      continue;
    }
    for (const lineParts of page.lines) {
      const lineText = lineParts.map((p) => p.text).join(' ').trim();
      if (!lineText) continue;
      if (PASSAGE_HEADER.test(lineText) || QUESTIONS_RANGE.test(lineText)) {
        currentPassageId = `pass_${page.pageNumber}_${passages.length}`;
        passages.push({
          id: currentPassageId,
          sectionId,
          title: sanitizeExamHtml(lineText.slice(0, 120)),
          bodyText: '',
          sourcePage: page.pageNumber,
          bbox: lineParts[0]?.bbox || null,
        });
        continue;
      }
      const qm = lineText.match(QUESTION_START);
      if (qm) {
        qOrdinal += 1;
        const displayNumber = qm[1];
        const stem = qm[2] || lineText;
        const qid = newExamQuestionId(sectionId, qOrdinal);
        questions.push({
          id: qid,
          sectionId,
          groupId: currentPassageId,
          passageId: currentPassageId,
          displayNumber,
          stemText: sanitizeExamHtml(stem),
          options: [],
          correctOptionId: null,
          points: 1,
          sourcePage: page.pageNumber,
          bbox: lineParts[0]?.bbox || null,
          order: qOrdinal,
        });
        continue;
      }
      const om = lineText.match(OPTION_LINE);
      if (om && questions.length) {
        const label = (om[1] || om[2]).toUpperCase();
        const text = sanitizeExamHtml(om[3]);
        const q = questions[questions.length - 1];
        if (!q.options.find((o) => o.id === label)) {
          q.options.push({ id: label, label, text });
        }
        continue;
      }
      if (currentPassageId) {
        const p = passages.find((x) => x.id === currentPassageId);
        if (p) {
          p.bodyText = p.bodyText ? `${p.bodyText}\n${sanitizeExamHtml(lineText)}` : sanitizeExamHtml(lineText);
        }
      }
    }
  }

  for (const q of questions) {
    if (q.options.length < 2) {
      warnings.push(`Câu ${q.displayNumber}: thiếu lựa chọn — cần rà soát.`);
      const ids = defaultOptionIds(4);
      q.options = ids.map((id) => ({ id, label: id, text: '' }));
    }
  }

  if (!questions.length) {
    warnings.push('Không phát hiện câu hỏi — cần rà soát hoặc OCR.');
  }

  return {
    sections,
    passages,
    questions,
    needsOcr: pages.some((p) => p.needsOcr),
    needsReview: true,
  };
}

export function parseAnswerKeyFromPages(keyPages, sections, questions, warnings) {
  const keyMap = {};
  const lines = keyPages.flatMap((p) => p.plainText.split('\n'));
  const reLine = /^\s*(\d+)\s*[.:)\-]?\s*([A-Fa-f])\s*$/;
  const rePair = /(\d+)\s*[:\s]\s*([A-Fa-f])/g;
  for (const line of lines) {
    let m = line.match(reLine);
    if (m) {
      keyMap[m[1]] = m[2].toUpperCase();
      continue;
    }
    for (const match of line.matchAll(rePair)) {
      keyMap[match[1]] = match[2].toUpperCase();
    }
  }
  const dup = {};
  for (const q of questions) {
    const k = keyMap[q.displayNumber];
    if (!k) continue;
    if (dup[q.displayNumber]) warnings.push(`Khóa trùng số câu ${q.displayNumber}.`);
    dup[q.displayNumber] = true;
    if (!q.options.some((o) => o.id === k)) {
      warnings.push(`Khóa câu ${q.displayNumber}: đáp án ${k} không khớp lựa chọn.`);
      continue;
    }
    q.correctOptionId = k;
  }
  return keyMap;
}

export async function buildDraftFromPdf(buffer, options = {}) {
  const warnings = [];
  const allPages = options.allPages || [];
  const questionPages = options.questionPages?.length ? options.questionPages : allPages;
  const keyPages = options.keyPages?.length
    ? await extractPdfPages(buffer, options.keyPages, options)
    : [];
  const qPages = await extractPdfPages(buffer, questionPages, options);
  const parsed = parseQuestionsFromPages(qPages, warnings);
  if (keyPages.length) {
    parseAnswerKeyFromPages(keyPages, parsed.sections, parsed.questions, warnings);
  } else {
    warnings.push('Chưa có trang khóa — cần nhập khóa thủ công trước khi xuất bản.');
  }
  return {
    title: options.title || 'Bài thi nhập từ PDF',
    sections: parsed.sections,
    passages: parsed.passages,
    questions: parsed.questions,
    warnings,
    needsOcr: parsed.needsOcr,
    needsReview: parsed.needsReview,
    teacherConfirmedReview: false,
    manuallyEdited: false,
  };
}
