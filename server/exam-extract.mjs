import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import {
  sanitizeExamHtml,
  newExamSectionId,
  newExamQuestionId,
  buildContaminationImportWarning,
} from '../dist/exam-domain.js';
import {
  isB1AchievementMidtermDocument,
  parseB1AchievementMidtermFromPages,
} from './exam-b1-midterm-extract.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const requireFromHere = createRequire(import.meta.url);
const PDFJS_ROOT = path.join(__dirname, '..', 'node_modules', 'pdfjs-dist', 'legacy', 'build');

/** Max longest edge when raster-checking an empty text layer flagged for OCR. */
export const VISIBLE_BLANK_RENDER_MAX_EDGE_PX = 432;
export const VISIBLE_BLANK_RENDER_TIMEOUT_MS = 12_000;

let nodeCreateCanvas = null;

function getNodeCreateCanvas() {
  if (!nodeCreateCanvas) {
    nodeCreateCanvas = requireFromHere('@napi-rs/canvas').createCanvas;
  }
  return nodeCreateCanvas;
}

let pdfjsModulePromise = null;

async function getPdfJs() {
  if (!pdfjsModulePromise) {
    pdfjsModulePromise = import(pathToFileURL(path.join(PDFJS_ROOT, 'pdf.mjs')).href).then((mod) => {
      const { getDocument, OPS, GlobalWorkerOptions } = mod;
      if (GlobalWorkerOptions) {
        GlobalWorkerOptions.workerSrc = pathToFileURL(
          path.join(PDFJS_ROOT, 'pdf.worker.mjs'),
        ).href;
      }
      return { getDocument, OPS, GlobalWorkerOptions };
    });
  }
  return pdfjsModulePromise;
}

/** Bump when PDF question extraction logic changes (invalidates import job reuse). */
export const EXAM_EXTRACT_PARSER_VERSION = 28;

function buildOperatorPaintSets(OPS) {
  return {
    image: new Set([
      OPS.paintImageXObject,
      OPS.paintInlineImageXObject,
      OPS.paintImageXObjectRepeat,
      OPS.paintInlineImageXObjectGroup,
      OPS.paintImageMaskXObject,
      OPS.paintImageMaskXObjectGroup,
      OPS.paintSolidColorImageMask,
      OPS.beginInlineImage,
      OPS.endInlineImage,
      OPS.paintXObject,
      OPS.paintFormXObjectBegin,
    ]),
    text: new Set([
      OPS.showText,
      OPS.showSpacedText,
      OPS.nextLineShowText,
      OPS.nextLineSetSpacingShowText,
    ]),
    path: new Set([
      OPS.stroke,
      OPS.closeStroke,
      OPS.fill,
      OPS.eoFill,
      OPS.fillStroke,
      OPS.eoFillStroke,
      OPS.closeFillStroke,
      OPS.closeEOFillStroke,
      OPS.constructPath,
      OPS.shadingFill,
      OPS.rawFillPath,
    ]),
  };
}

/**
 * When getTextContent is empty, use pdf.js operator list to tell blank pages from raster/vector content.
 */
export function classifyPageContentLayer(rawItemCount, fnArray, paintSets) {
  if (rawItemCount > 0) {
    return { isBlankPage: false, needsOcr: false };
  }
  const fn = fnArray || [];
  if (!fn.length) {
    return { isBlankPage: true, needsOcr: false };
  }
  let hasImage = false;
  let hasTextPaint = false;
  let hasPath = false;
  for (const code of fn) {
    if (paintSets.image.has(code)) hasImage = true;
    if (paintSets.text.has(code)) hasTextPaint = true;
    if (paintSets.path.has(code)) hasPath = true;
  }
  if (!hasImage && !hasTextPaint && !hasPath) {
    return { isBlankPage: true, needsOcr: false };
  }
  return { isBlankPage: false, needsOcr: true };
}

export function operatorListHasImagePaint(fnArray, paintSets) {
  const fn = fnArray || [];
  for (const code of fn) {
    if (paintSets.image.has(code)) return true;
  }
  return false;
}

/** OCR was flagged from operators but there is no extractable text (image-only pages excluded). */
export function shouldApplyVisibleBlankRasterFallback(rawItemCount, layer, fnArray, paintSets) {
  if (rawItemCount > 0) return false;
  if (layer.isBlankPage || !layer.needsOcr) return false;
  return !operatorListHasImagePaint(fnArray, paintSets);
}

export function viewportImageDataIsStrictlyWhite(imageData) {
  const data = imageData?.data;
  if (!data?.length) return false;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] !== 255 || data[i + 1] !== 255 || data[i + 2] !== 255) {
      return false;
    }
  }
  return true;
}

/**
 * Render the page viewport (clipped crop box) and return true only if every pixel is white.
 * Returns null on render/module/timeout failure — callers should keep OCR in that case.
 */
export async function isPageViewportVisuallyBlank(page, options = {}) {
  const maxEdge = options.maxEdgePx ?? VISIBLE_BLANK_RENDER_MAX_EDGE_PX;
  const timeoutMs = options.timeoutMs ?? VISIBLE_BLANK_RENDER_TIMEOUT_MS;
  let createCanvas;
  try {
    createCanvas = getNodeCreateCanvas();
  } catch (_) {
    return null;
  }
  const baseViewport = page.getViewport({ scale: 1 });
  const longest = Math.max(baseViewport.width, baseViewport.height, 1);
  const scale = Math.min(1, maxEdge / longest);
  const viewport = page.getViewport({ scale });
  const width = Math.max(1, Math.floor(viewport.width));
  const height = Math.max(1, Math.floor(viewport.height));
  if (width * height > maxEdge * maxEdge) {
    return null;
  }
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  let timeoutId;
  try {
    const renderTask = page.render({
      canvasContext: ctx,
      viewport,
      background: '#ffffff',
    });
    await Promise.race([
      renderTask.promise,
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          try {
            renderTask.cancel?.();
          } catch (_) {
            /* ignore */
          }
          reject(new Error('visible-blank-render-timeout'));
        }, timeoutMs);
      }),
    ]);
    return viewportImageDataIsStrictlyWhite(ctx.getImageData(0, 0, width, height));
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function classifyPageContentLayerWithVisibleFallback(
  page,
  rawItemCount,
  fnArray,
  paintSets,
  options = {},
) {
  const layer = classifyPageContentLayer(rawItemCount, fnArray, paintSets);
  if (!shouldApplyVisibleBlankRasterFallback(rawItemCount, layer, fnArray, paintSets)) {
    return layer;
  }
  const visuallyBlank = await isPageViewportVisuallyBlank(page, options);
  if (visuallyBlank === true) {
    return { isBlankPage: true, needsOcr: false };
  }
  return layer;
}

export const MAX_PDF_PAGES_FOR_IMPORT = 200;

export function examContentDigest(buffer, options = {}) {
  const h = createHash('sha256');
  h.update(buffer);
  h.update(JSON.stringify({
    parserVersion: options.parserVersion ?? EXAM_EXTRACT_PARSER_VERSION,
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
const LABEL_CLUSTER_TOL = 8;
const COLUMN_SEPARATION_FRAC = 0.22;
const GUTTER_BEFORE_RIGHT_COL = 12;
const OPTION_A_MAX_DX = 60;
const OPTION_A_MAX_DY = 110;
const DEFAULT_MARGIN_TOL = 32;

const QUESTION_START = /^(?:Question\s*)?(\d{1,3})\s*[.)]\s+(.+)$/i;
const QUESTION_WORD_PREFIX = /^Question\s+(\d{1,3})\s*[.)]\s*(.*)$/i;
const QUESTION_INLINE_OPTION = /^(?:Question\s*)?(\d{1,3})\s*[.)]\s*(?:\(([A-F])\)|([A-F])[.)])\s*(.*)$/i;
const OPTION_LINE_START = /^(?:\(([A-D])\)|([A-D])[.)])\s*(.*)$/;
const PDF_RANGE_SEP = '[-\u2010\u2011\u2012\u2013\u2014\u2015\u2212\uFE58\uFE63\uFF0D‐‑–—―\uE000-\uF8FF]';
const PASSAGE_HEADER = new RegExp(
  `^(?:READING TEST|Questions?\\s+\\d+\\s*${PDF_RANGE_SEP}\\s*\\d+(?:\\s+refer\\b|\\s*$)|Questions?\\s+\\d+\\s*${PDF_RANGE_SEP}\\s*\\d+\\s+refer\\b|Questions?\\s+\\d+\\s+and\\s+\\d+)`,
  'i',
);
const QUESTIONS_RANGE = new RegExp(`Questions?\\s+(\\d+)\\s*${PDF_RANGE_SEP}\\s*(\\d+)`, 'i');
const SCHOOL_EXAM_SECTION = /^(?:[A-Z]\.\s*)?(?:LISTENING|VOCABULARY|GRAMMAR|READING|WRITING|PHONETICS|USE OF ENGLISH)\b/i;
const SCHOOL_STRUCTURAL_READ_LINE = /^Read the following\s+(?:passage|announcement|text|advice|e-mail|email|letter|notice|article|message)\b/i;
const SCOPED_EXERCISE_DISPLAY_RE = /^(ex\d+|sample)-\d+$/i;

function nextExpectedMcqOptionLabel(question) {
  if (!question?.options) return 'A';
  const labels = ['A', 'B', 'C', 'D', 'E', 'F'];
  const used = new Set(question.options.map((o) => String(o.id).toUpperCase()));
  for (const label of labels) {
    if (!used.has(label)) return label;
  }
  return null;
}

function lineIsActiveMcqOptionContinuation(lineText, ctx) {
  if (!ctx?.lastQuestion || ctx.pendingDisplayNumber || ctx.unsupportedBlockActive) return false;
  const opt = lineText.match(OPTION_LINE_START);
  if (opt) {
    const label = String(opt[1] || opt[2]).toUpperCase();
    const expected = nextExpectedMcqOptionLabel(ctx.lastQuestion);
    if (expected && label === expected) return true;
    const filled = ctx.lastQuestion.options.filter((o) => String(o.text || '').trim()).length;
    const need = Number.isFinite(ctx.declaredMcqOptionCount) ? ctx.declaredMcqOptionCount : 4;
    if (filled > 0 && filled < need && /^[A-D]$/.test(label)) return true;
  }
  const bareSkill = lineText.match(/^([A-D])\s+(WRITING|READING|LISTENING|VOCABULARY|GRAMMAR)\s*$/i);
  if (bareSkill) {
    const expected = nextExpectedMcqOptionLabel(ctx.lastQuestion);
    if (expected && bareSkill[1].toUpperCase() === expected) return true;
  }
  return false;
}

function isUnambiguousSchoolTaskSectionHeader(lineText, ctx) {
  if (!SCHOOL_EXAM_SECTION.test(lineText)) return false;
  if (SCHOOL_LISTENING_BLOCK.test(lineText)) return false;
  if (lineIsActiveMcqOptionContinuation(lineText, ctx)) return false;
  if (/\b(?:minutes?|points?|PHẦN\s|TỰ\s+LUẬN|PART\s+\d)\b/i.test(lineText)) return true;
  if (/^(?:[IVXLC]+\.\s*)(?:LISTENING|VOCABULARY|GRAMMAR|READING|WRITING|PHONETICS)\b/i.test(lineText)) return true;
  if (/^(?:LISTENING|VOCABULARY|GRAMMAR|READING|WRITING|PHONETICS|USE OF ENGLISH)\b/i.test(lineText)
    && !/^[A-Z]\.\s*(?:LISTENING|VOCABULARY|GRAMMAR|READING|WRITING|PHONETICS)\b/i.test(lineText)) {
    return true;
  }
  if (!ctx?.lastQuestion) return true;
  const stemDone = /[?？]\s*$/.test(String(ctx.lastQuestion.stemText || '').trim());
  const filled = ctx.lastQuestion.options.filter((o) => String(o.text || '').trim()).length;
  if (stemDone && filled >= 2) return true;
  return false;
}

function schoolPassageTextCaptureAllowed(ctx) {
  return !!ctx?.currentPassageId && !ctx.unsupportedBlockActive;
}

function displayNumberHasExerciseScope(displayNumber) {
  return SCOPED_EXERCISE_DISPLAY_RE.test(String(displayNumber || ''));
}
const SCHOOL_LISTENING_BLOCK = /^(?:[A-Z]\.\s*)?LISTENING\b|^LISTENING\s*\(/i;
const THEORY_OUTLINE_SECTION = /^(?:I{1,3}|IV)\.\s+(?:VOCABULARY|GRAMMAR|PHONETICS)\b|^II\.\s+GRAMMAR\b|Grammar\s*-\s*Ng[\s\u00a0]*ữ?\s*pháp/i;
const EXERCISE_BLOCK_HEADER = /^(?:IV\.\s+)?EXERCISES\b|^Exercises?\s*$/i;
const EXERCISE_SUBHEADER = /^Ex(?:ercise)?\s*(\d+)[.:]\s*(.*)$/i;
const INLINE_OPTION_ROW_UPPER = /(?:^|\s)([A-D])\.\s+((?:\S(?:(?!\s+[A-D]\.\s).)*?)?)(?=\s+[A-D]\.\s|$)/g;
/** Legacy whole-line matchers — prefer parseNumberedInlineMcqFromLine for school rows. */
const NUMBERED_INLINE_MCQ_ROW = /^(\d{1,3})\.\s+((?:[A-F]\.\s+\S(?:.*?\s)?)+)$/i;
const NUMBERED_INLINE_MCQ_WORD = /^(\d{1,3})\.\s+((?:[A-F]\.\s*\S+)(?:\s+[A-F]\.\s*\S+){1,5})\s*$/i;
const NUMBERED_UNDOTTED_INLINE_MCQ_ROW = /^(\d{1,3})\s+((?:[A-D]\.\s*\S+(?:\s+|$)){2,4})\s*$/;
const VIET_WORD_SECTION_END = '(?:\\s|$|[,.:;!)])';
const SCHOOL_OPTION_CONTINUATION_BOUNDARY = new RegExp(
  `\\b(?:MORE THAN TWO WORDS|Questions?\\s+\\d+\\s*[-\u2010\u2011\u2012\u2013\u2014\u2015\u2212]|Questions?\\s+\\d{1,3}\\s*\\.|PHẦN\\s+TỰ\\s+LUẬN${VIET_WORD_SECTION_END}|Give the correct form|Rearrange the words|Rewrite these following|box\\.\\s+There is one extra word|In this part of the exam,\\s*you will have a face-to-face)`,
  'i',
);
const SCHOOL_UNSUPPORTED_SECTION_LINE = new RegExp(
  `^(?:B\\.\\s*)?PHẦN\\s+TỰ\\s+LUẬN${VIET_WORD_SECTION_END}|Give the correct form of the verbs`,
  'i',
);
const INSTRUCTION_ORDINAL_STEM = /^(?:Listen\b|Listen again\b|Read\b|Mark the letter|Complete the|Fill in|Choose the word|Find a mistake|Rearrange|Rewrite|Write |Look at the sign|Topic:|One example|Choose the best (?:word or phrase|answer that best completes)|Choose the correct answer that best completes)/i;
const SAMPLE_EXAM_TASK_INSTRUCTION = /^Mark the letter A,\s*B,\s*C or D on your answer sheet\b/i;
const FREE_TEXT_TASK_LINE = /\b(?:fill in the form|NO MORE THAN|sentence completion|Rearrange the words|Find a mistake in each sentence|Rewrite these following sentences|Write a paragraph|complete the (?:sentences|paragraph) with the words in the)\b/i;
const WRAPPED_TASK_BLOCK_BOUNDARY = /\b(?:box\.\s+There is one extra word|SPEAKING\s*\(|WRITE\b|READING\s+PART|Questions?\s+\d+\s*[-\u2013–]\s*\d+\.\s+Complete|Questions?\s+\d+\s*[-\u2013–]\s*\d+\.\s+Match|Questions?\s+\d+\s*[-\u2013–]\s*\d+\.\s+Read the passage|A\.\s+LANGUAGE|each word can be used ONCE ONLY)\b/i;
const SCHOOL_GRAMMAR_HEADING = /^\d{1,2}\.\s+(?:WHO|THAT|HAVE(?:\s*\+\s*EVER|\s+NEVER)|PAST|PRESENT|FUTURE|POSSESSIVE)\b/i;
const SAMPLE_TEST_SECTION = /^SAMPLE\s+TEST\b/i;
const GRADE_CLOZE_PASSAGE_HEAD = /^Put the verbs\b/i;
const QUESTIONS_AND_PAIR = /Questions?\s+(\d+)\s+and\s+(\d+)/i;
const PART_HEADER = /^PART\s+[567]\b/i;
/** TOEIC kit uses uppercase PART; school/Cambridge "Part 3" must not flip listening state. */
const TOEIC_PART_HEADER = /^PART\s+(\d+)\b/;
const LISTENING_TEST_MARK = /^LISTENING TEST\b/i;
const READING_TEST_MARK = /^READING TEST\b/i;
const DIRECTIONS_LINE = /^Directions:/i;
const QUESTION_NUM_ONLY = /^(\d{1,3})\.\s*$/;
const QUESTION_BARE_NUM = /^(\d{1,3})\s+(\S.+)$/;
const QUESTION_BARE_LETTER = /^([A-F])\s+(\S.+)$/i;
const CHOOSE_TWO_MARK = /choose\s+(?:TWO|two)\b/i;
const TFNG_MARK = /\bTRUE\b.*\bFALSE\b.*\bNOT\s+GIVEN\b/i;
const YNNG_MARK = /\bYes\b.*\bNo\b.*\bNot\s+Given\b/i;
const MATCHING_MARK = /\b(?:match|matching)\b.*\b(?:heading|sentence|feature)\b/i;
const DOC_TYPE_HEADER = /(?:the following|following)\s+(advertisement|e-mail|email|article|memo|letter|notice|form)/i;
const MULTI_DOC_TITLE = /^(?:\*+\s*)?(Advertisement|Shopping\s+Cart|E-mail|Email|Memo|Letter|Notice)\b/i;
const READING_SECTION_RESET = /^READING TEST\s+\d+/i;

/** Anchored backmatter / non-question region markers (ETS TOEIC sample layout). */
const TEST_END_DIRECTIVE = /^Stop!\s*This is the end of the test/i;
const NO_TEST_MATERIAL_LINE = /^NO TEST MATERIAL ON THIS PAGE/i;
const BACKMATTER_SECTION_HEAD = /^(?:Test of English for International Communication\s+General Directions|General Directions\s+This test is designed|SCRIPT FOR THE LISTENING COMPREHENSION SECTION|TOEIC Sample Form Script\b|Sample Form Correct Answers|LISTENING COMPREHENSION SECTION\s*$)/i;
const ANSWER_KEY_TABLE_HEAD = /^Item Number\s+Key(?:\s+Item Number\s+Key)?/i;
const LISTENING_SCRIPT_PAGE = /SCRIPT FOR THE LISTENING COMPREHENSION SECTION/i;
const ANSWER_KEY_PAGE = /Sample Form Correct Answers/i;

function createPageBackmatterFence() {
  return { leftMaxY: null, rightMaxY: null, fullPage: false };
}

function applyBackmatterFenceCutoff(fence, lineParts, geo, lineText) {
  if (!fence || !lineParts?.length) return;
  const y = lineTopY(lineParts);
  if (NO_TEST_MATERIAL_LINE.test(lineText)) {
    const side = xColumnSide(lineStartX(lineParts), geo);
    if (side === 'right') {
      fence.rightMaxY = fence.rightMaxY == null ? y : Math.max(fence.rightMaxY, y);
    } else {
      fence.leftMaxY = fence.leftMaxY == null ? y : Math.max(fence.leftMaxY, y);
    }
    return;
  }
  const side = xColumnSide(lineStartX(lineParts), geo);
  if (side === 'right') {
    fence.rightMaxY = fence.rightMaxY == null ? y : Math.max(fence.rightMaxY, y);
  } else {
    fence.leftMaxY = fence.leftMaxY == null ? y : Math.max(fence.leftMaxY, y);
  }
}

function isLineInBackmatterFence(lineParts, geo, fence) {
  if (!fence || fence.fullPage) return !!fence?.fullPage;
  const y = lineTopY(lineParts);
  const side = xColumnSide(lineStartX(lineParts), geo);
  const maxY = side === 'right' ? fence.rightMaxY : fence.leftMaxY;
  if (maxY != null && y <= maxY + 1.5) return true;
  return false;
}

function isAnchoredBackmatterBoundaryLine(lineText) {
  if (!lineText) return false;
  if (TEST_END_DIRECTIVE.test(lineText)) return true;
  if (NO_TEST_MATERIAL_LINE.test(lineText)) return true;
  if (BACKMATTER_SECTION_HEAD.test(lineText)) return true;
  if (ANSWER_KEY_TABLE_HEAD.test(lineText)) return true;
  return false;
}

function lineCarriesBackmatterPoison(lineText) {
  if (!lineText) return false;
  if (isAnchoredBackmatterBoundaryLine(lineText)) return true;
  if (/^Sample Form Correct Answers/i.test(lineText)) return true;
  if (/^\d{1,3}\s+[A-D]\s+\d{1,3}\s+[A-D]\s+\d{1,3}\s+[A-D]/i.test(lineText)) return true;
  if (/\[\d{4}\].*(?:MIDTERM|LOWERMIDTERM|PRIVATE|Page\s+\d+)/i.test(lineText)) return true;
  if (/[\uE080-\uE08F]/.test(lineText) && /PRIVATE|Page\s+\d+|MIDTERM/i.test(lineText)) return true;
  return false;
}

function lineHasValidQuestionOrOptionAnchor(lineText) {
  if (!lineText) return false;
  if (OPTION_LINE_START.test(lineText)) return true;
  if (QUESTION_INLINE_OPTION.test(lineText)) return true;
  if (QUESTION_NUM_ONLY.test(lineText)) return true;
  if (NUMBERED_UNDOTTED_INLINE_MCQ_ROW.test(lineText)) return true;
  if (parseNumberedInlineMcqFromLine(lineText)) return true;
  if (NUMBERED_INLINE_MCQ_ROW.test(lineText) || NUMBERED_INLINE_MCQ_WORD.test(lineText)) return true;
  if (/^[A-D]\.\s+\S.*\s[A-D]\.\s+\S/i.test(lineText)) return true;
  const qm = lineText.match(QUESTION_START);
  if (qm && (qm[2]?.trim().length >= 2 || lineLooksLikeMcqStem(lineText))) return true;
  return false;
}

function isSchoolTheoryHeadingSkipLine(lineText, ctx) {
  if (!lineText || lineHasValidQuestionOrOptionAnchor(lineText)) return false;
  const schoolCtx = ctx.schoolOutlineActive
    || ctx.inTheoryBlock
    || ctx.activeExerciseKey
    || SCHOOL_EXAM_SECTION.test(lineText)
    || EXERCISE_BLOCK_HEADER.test(lineText)
    || EXERCISE_SUBHEADER.test(lineText);
  if (!schoolCtx) return false;
  if (THEORY_OUTLINE_SECTION.test(lineText)) return true;
  if (/^\*?\s*Cách dùng\b/i.test(lineText)) return true;
  if (SCHOOL_GRAMMAR_HEADING.test(lineText)) return true;
  if (/^\d{1,2}\.\s+(?:PAST|PRESENT|FUTURE|POSSESSIVE|WHERE|WHEN)\b/i.test(lineText)) return true;
  if (/^\d{1,2}\.\s+[A-Z][A-Z\s,+]+\s*\(\s*PAGE\s*\d+/i.test(lineText)) return true;
  if (/^\d{1,2}\.\s+HAVE\b/i.test(lineText) && /\+/.test(lineText)) return true;
  return false;
}

function lineIsStemContinuationFragment(lineText) {
  const t = String(lineText || '').trim();
  if (!t || OPTION_LINE_START.test(t) || QUESTION_INLINE_OPTION.test(t)) return false;
  if (QUESTION_START.test(t) || QUESTION_NUM_ONLY.test(t)) return false;
  if (/^\(?[A-F]\)?\s*$/i.test(t)) return false;
  if (/^[A-D]\.\s+\S/.test(t) || /^[A-D]\s+\S/.test(t)) return false;
  return /[?？]\s*$/.test(t)
    || /^(?:within|after|before|to|for|in|on|at|the|a|an)\b/i.test(t);
}

function isLowercaseSentenceOrderingLine(lineText) {
  const t = String(lineText || '').trim();
  if (!t) return false;
  if (/^[A-D]\.\s+\S/.test(t)) return false;
  return /^(?:[a-d]\.|[\-–]\s*[a-d]\.)\s+/i.test(t);
}

function splitSchoolFooterFromOptionTail(text) {
  let raw = stripPdfRunningNoise(String(text || ''));
  const cutPatterns = [
    /\bB\d\s+(?:UPPER|LOWER)\s+MIDTERM\b[\s\S]*/i,
    /\bMORE THAN TWO WORDS\b[\s\S]*/i,
    /\bbox\.\s+There is one extra word\b[\s\S]*/i,
    /\bQuestions?\s+\d{1,3}\s*\.\s*(?:The word|Give the correct form|PHẦN)/i,
    /\bQuestions?\s+\d+\s*[-\u2010\u2011\u2012\u2013\u2014\u2015\u2212]\s*\d+\b[\s\S]*/i,
    /\b(?:PHẦN\s+TỰ\s+LUẬN|Give the correct form of the verbs|Rearrange the words|Rewrite these following)\b[\s\S]*/i,
    /\bIn this part of the exam,\b[\s\S]*/i,
    /\b(?:award|instrument|material)\b.*\b(?:sculpture|style)\b[\s\S]*/i,
  ];
  for (const re of cutPatterns) {
    const idx = raw.search(re);
    if (idx > 4) {
      raw = raw.slice(0, idx).trim();
      break;
    }
  }
  return sanitizeExamHtml(raw);
}

function lineBeginsNextQuestionInRange(lineText, ctx) {
  const qm = lineText.match(QUESTION_START);
  if (!qm || !ctx.currentQuestionRange) return false;
  const n = parseInt(qm[1], 10);
  if (!Number.isFinite(n)) return false;
  if (!isWithinDeclaredRange(String(n), ctx.currentQuestionRange)) return false;
  if (!ctx.lastQuestion) return false;
  const cur = parseInt(ctx.lastQuestion.displayNumber, 10);
  return Number.isFinite(cur) && n > cur;
}

function scopedQuestionLabel(ctx, displayNumber) {
  return ctx.activeExerciseKey
    ? `${ctx.activeExerciseKey}-${displayNumber}`
    : String(displayNumber);
}

function lineBeginsNewScopedExerciseQuestion(lineText, ctx, lineParts, geo, page) {
  if (!ctx.activeExerciseKey || !ctx.lastQuestion) return false;
  const numberedInline = parseNumberedInlineMcqFromLine(lineText);
  const m = lineText.match(QUESTION_START)
    || lineText.match(QUESTION_WORD_PREFIX)
    || (numberedInline ? [null, numberedInline.number] : null)
    || lineText.match(NUMBERED_UNDOTTED_INLINE_MCQ_ROW);
  if (!m) return false;
  if (!lineStartsQuestionCandidate(lineText, ctx, lineParts, geo, page)) return false;
  const scoped = scopedQuestionLabel(ctx, m[1]);
  return scoped !== ctx.lastQuestion.displayNumber;
}

function passageHeaderMarksUnsupportedTask(lineText) {
  if (!lineText) return false;
  const combined = String(lineText);
  if (FREE_TEXT_TASK_LINE.test(combined)) return true;
  if (/\bTRUE\b.*\bFALSE\b.*\bNOT\s+GIVEN\b/i.test(combined)) return true;
  if (/\bMatch the first part\b/i.test(combined)) return true;
  if (/\bComplete the conversations\b/i.test(combined)) return true;
  if (/\bHow certain is each speaker\b/i.test(combined)) return true;
  return false;
}

function isInstructionOrdinalLine(lineText) {
  const m = String(lineText || '').match(/^(?:Question\s*)?(\d{1,3})\s*[.)]\s*(.+)$/i);
  if (!m) return false;
  return INSTRUCTION_ORDINAL_STEM.test(m[2]);
}

function parseDeclaredMcqOptionCount(lineText) {
  const t = String(lineText || '');
  if (/(?:\(|^|\s)A\s*,\s*B\s*,\s*C(?:\s+or\s+|\s*,\s*)D/i.test(t)) return 4;
  if (/(?:\(|^|\s)A\s*,\s*B\s*,\s*C(?![\s\S]*\bD\b)/i.test(t)) return 3;
  if (/(?:\(|^|\s)A\s*,\s*B(?![\s\S]*\bC\b)/i.test(t)) return 2;
  return null;
}

function lineLooksLikeMcqStem(lineText) {
  const t = String(lineText || '');
  if (/_+/.test(t)) return true;
  if (/[?？]\s*$/.test(t.trim())) return true;
  if (QUESTION_INLINE_OPTION.test(t)) return true;
  return false;
}

function resetSchoolExamBlockContext(ctx, pendingContext, page = null) {
  if (ctx.lastQuestion) {
    if (page) finishActiveQuestion(ctx, page);
    ctx.lastQuestion = null;
  }
  ctx.currentPassageId = null;
  ctx.currentQuestionRange = null;
  ctx.pendingDisplayNumber = null;
  ctx.pendingUnsupported = null;
  ctx.pendingTaskLabel = '';
  ctx.inSchoolListeningBlock = false;
  ctx.inListeningSection = false;
  ctx.inTheoryBlock = false;
  ctx.activeExerciseKey = null;
  ctx.unsupportedBlockActive = false;
  ctx.part6QuestionsStarted = false;
  ctx.part6QuestionRange = null;
  ctx.part6PassageId = null;
  ctx.inPart6Passage = false;
  pendingContext.length = 0;
}

/** Mixed image/text worksheet pages: header/footer text only, exercise body is raster. */
export function classifySparseHeaderFooterWithImages(rawItemCount, plainText, fnArray, paintSets) {
  if (rawItemCount < 1) return null;
  if (!operatorListHasImagePaint(fnArray, paintSets)) return null;
  const compact = String(plainText || '').replace(/\s+/g, ' ').trim();
  if (!compact) return null;
  const tokens = compact.split(/\s+/).filter((w) => w.length > 0);
  if (tokens.length > 12) return null;
  if (/^(?:\d+|Exercises?|Unit\b|PB\b|Revision\b)/i.test(compact) || /^Exercises?\s+\d+$/i.test(compact)) {
    return { isBlankPage: false, needsOcr: true };
  }
  return null;
}

function pageHasReadingQuestionAnchors(page) {
  const plain = page.plainText || '';
  if (/\bQuestions?\s+\d+/i.test(plain)) return true;
  if (/\b(?:1[0-9]{2}|[1-9]\d?)\.\s*\(?[A-D]\)?/i.test(plain)) return true;
  if (/\b(?:1[0-9]{2}|[1-9]\d?)\.\s+(?!\()[\S"]/i.test(plain)) return true;

  const lines = page.lines || [];
  if (!lines.length) return false;
  const pageWidth = page.pageWidth || DEFAULT_PAGE_WIDTH;
  const geo = page.columnGeometry || inferColumnGeometryFromLineParts(lines, pageWidth);
  for (const lineParts of lines) {
    if (!lineLooksLikeQuestion(lineParts, geo)) continue;
    const lineText = mergeLineText(lineParts);
    if (lineCarriesBackmatterPoison(lineText)) continue;
    return true;
  }
  return false;
}

function shouldSkipEntirePageForQuestions(page) {
  const plain = page.plainText || '';
  if (!plain.trim()) return false;
  if (NO_TEST_MATERIAL_LINE.test(plain) && !pageHasReadingQuestionAnchors(page)) return true;
  if (LISTENING_SCRIPT_PAGE.test(plain) && !pageHasReadingQuestionAnchors(page)) return true;
  if (ANSWER_KEY_PAGE.test(plain) && /\bItem Number\b/i.test(plain)) return true;
  if (/TOEIC Sample Form Script\s*-\s*\d+\s*-/i.test(plain) && !pageHasReadingQuestionAnchors(page)) {
    return true;
  }
  if (/General Directions\s+This test is designed/i.test(plain) && !pageHasReadingQuestionAnchors(page)) {
    return true;
  }
  return false;
}

function resetQuestionParseContinuation(ctx, page, pendingContext) {
  finishActiveQuestion(ctx, page);
  ctx.lastQuestion = null;
  ctx.pendingDisplayNumber = null;
  pendingContext.length = 0;
}

function isExplicitRealTestSectionLine(lineText) {
  if (!lineText) return false;
  if (READING_TEST_MARK.test(lineText)) return true;
  if (READING_SECTION_RESET.test(lineText)) return true;
  if (PASSAGE_HEADER.test(lineText)) return true;
  if (QUESTIONS_RANGE.test(lineText)) return true;
  if (QUESTIONS_AND_PAIR.test(lineText)) return true;
  if (TOEIC_PART_HEADER.test(lineText)) {
    const partNum = parseInt(lineText.match(TOEIC_PART_HEADER)[1], 10);
    return Number.isFinite(partNum) && partNum >= 5;
  }
  return false;
}

function enterBackmatterRegion(ctx, page, pendingContext) {
  resetQuestionParseContinuation(ctx, page, pendingContext);
  ctx.currentPassageId = null;
  ctx.currentQuestionRange = null;
  ctx.inPart6Passage = false;
  ctx.part6PassageId = null;
  ctx.part6QuestionRange = null;
  ctx.part6QuestionsStarted = false;
  ctx.pendingUnsupported = null;
  ctx.pendingTaskLabel = '';
  ctx.inBackmatterRegion = true;
}

function exitBackmatterRegion(ctx) {
  ctx.inBackmatterRegion = false;
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

function lineTopY(lineParts) {
  if (!lineParts?.length) return 0;
  return Math.max(...lineParts.map((p) => (p.bbox?.y ?? 0) + (p.bbox?.h ?? 0)));
}

function medianItemHeight(items) {
  const hs = items
    .map((it) => (it.height > 0 ? it.height : 12))
    .filter((h) => h > 0)
    .sort((a, b) => a - b);
  return hs[Math.floor(hs.length / 2)] || 12;
}

function baselineTolerance(items) {
  return Math.max(2.5, medianItemHeight(items) * 0.42);
}

function clusterItemsByBaseline(items, tol) {
  const sorted = sortReadingOrder(items);
  const clusters = [];
  let cur = [];
  let lastY = null;
  for (const it of sorted) {
    const y = transformY(it.transform);
    if (lastY != null && Math.abs(y - lastY) > tol) {
      if (cur.length) clusters.push(cur);
      cur = [];
    }
    cur.push(it);
    lastY = y;
  }
  if (cur.length) clusters.push(cur);
  return clusters;
}

export function buildLinesFromItems(items) {
  if (!items.length) return [];
  const tol = baselineTolerance(items);
  const clusters = clusterItemsByBaseline(items, tol);
  return clusters
    .map((cluster) => {
      const parts = [...cluster].sort((a, b) => transformX(a.transform) - transformX(b.transform));
      return parts
        .map((it) => ({
          text: itemText(it),
          bbox: bboxFromItem(it),
          fontName: it.fontName || '',
        }))
        .filter((p) => p.text);
    })
    .filter((ln) => ln.length);
}

function lineStartX(lineParts) {
  return lineParts?.[0]?.bbox?.x ?? 0;
}

function itemStartX(item) {
  return transformX(item.transform);
}

function isQuestionLabelItem(item) {
  const t = itemText(item);
  if (/^\d{1,3}\./.test(t)) return true;
  if (/^\d{1,3}\s+\S/.test(t)) return true;
  if (/^\d{1,3}$/.test(t)) return true;
  return false;
}

function rawItemOptionLetter(it) {
  return String(it.str || '').trim();
}

function isOptionMarkerItem(it) {
  const t = rawItemOptionLetter(it);
  return /^\([A-F]\)$/i.test(t) || /^[A-F]$/i.test(t);
}

function findNearbyOptionMarker(labelItem, withText) {
  const lx = itemStartX(labelItem);
  const ly = transformY(labelItem.transform);
  let optionA = null;
  const letters = [];
  for (const it of withText) {
    if (!isOptionMarkerItem(it)) continue;
    const ax = itemStartX(it);
    const ay = transformY(it.transform);
    const dx = ax - lx;
    const dy = ly - ay;
    if (dx >= -2 && dx <= OPTION_A_MAX_DX && dy >= -8 && dy <= OPTION_A_MAX_DY) {
      const t = rawItemOptionLetter(it);
      if (/^\(A\)$/i.test(t) || /^A$/i.test(t)) optionA = it;
      letters.push(it);
    }
  }
  if (optionA) return optionA;
  if (letters.length >= 2) {
    const ids = letters.map((it) => rawItemOptionLetter(it).replace(/[()]/g, '').toUpperCase());
    if (ids.includes('A') && (ids.includes('B') || ids.includes('C'))) return letters[0];
  }
  return null;
}

function findNearbyOptionMarkerBbox(labelBbox, items) {
  if (!labelBbox || !items?.length) return null;
  const lx = labelBbox.x;
  const ly = labelBbox.y + (labelBbox.h || 12);
  let optionA = null;
  const letters = [];
  for (const it of items) {
    const t = String(it.text || '').trim();
    if (!/^\([A-F]\)$/i.test(t) && !/^[A-F]$/i.test(t)) continue;
    const ax = it.bbox.x;
    const ay = it.bbox.y + (it.bbox.h || 12);
    const dx = ax - lx;
    const dy = ly - ay;
    if (dx >= -2 && dx <= OPTION_A_MAX_DX && dy >= -8 && dy <= OPTION_A_MAX_DY) {
      if (/^\(A\)$/i.test(t) || /^A$/i.test(t)) optionA = it;
      letters.push(it);
    }
  }
  if (optionA) return optionA;
  if (letters.length >= 2) {
    const ids = letters.map((it) => String(it.text || '').replace(/[()]/g, '').toUpperCase());
    if (ids.includes('A') && (ids.includes('B') || ids.includes('C'))) return letters[0];
  }
  return null;
}

function hasBareOptionLetterBelow(labelBbox, items) {
  if (!labelBbox || !items?.length) return false;
  const lx = labelBbox.x;
  const ly = labelBbox.y;
  return items.some((it) => {
    const t = String(it.text || '').trim();
    if (!/^[A-F]$/i.test(t)) return false;
    const dy = ly - it.bbox.y;
    if (dy < 5 || dy > OPTION_A_MAX_DY + 20) return false;
    return Math.abs(it.bbox.x - lx) <= 40;
  });
}

function lineHasQuestionOptionGeometry(lineParts, page, geo) {
  const lineText = mergeLineText(lineParts);
  if (QUESTION_INLINE_OPTION.test(lineText)) return true;
  const labelBbox = lineParts[0]?.bbox;
  const items = page?.items || [];
  if (labelBbox && items.length) {
    if (findNearbyOptionMarkerBbox(labelBbox, items)) return true;
    if (hasBareOptionLetterBelow(labelBbox, items)) return true;
  }
  const qm = lineText.match(QUESTION_START);
  if (qm && qm[2]?.trim().length >= 2) return false;
  if (QUESTION_BARE_NUM.test(lineText) && labelBbox && items.length) {
    return hasBareOptionLetterBelow(labelBbox, items)
      || !!findNearbyOptionMarkerBbox(labelBbox, items);
  }
  return false;
}

function findNearbyOptionA(labelItem, withText) {
  return findNearbyOptionMarker(labelItem, withText);
}

function isValidatedQuestionAnchor(item, withText) {
  const t = itemText(item);
  if (!isQuestionLabelItem(item)) return false;
  if (isInstructionOrdinalLine(t)) return false;
  if (QUESTION_INLINE_OPTION.test(t)) return true;
  if (QUESTION_BARE_NUM.test(t)) return !!findNearbyOptionMarker(item, withText);
  const bare = t.match(/^\d{1,3}\.\s*$/);
  if (bare && findNearbyOptionMarker(item, withText)) return true;
  const stem = t.match(/^\d{1,3}\.\s+(.+)/);
  if (stem && stem[1].trim().length >= 2) {
    if (isInstructionOrdinalLine(t)) return false;
    if (findNearbyOptionMarker(item, withText)) return true;
    if (lineLooksLikeMcqStem(t)) return true;
    return true;
  }
  if (/^\d{1,3}\s+\S/.test(t) && findNearbyOptionMarker(item, withText)) return true;
  if (findNearbyOptionMarker(item, withText)) return true;
  return false;
}

function clusterAnchorXs(xs, tol = LABEL_CLUSTER_TOL) {
  const sorted = [...xs].sort((a, b) => a - b);
  const clusters = [];
  for (const x of sorted) {
    let cluster = clusters.find((c) => Math.abs(c.x - x) <= tol);
    if (!cluster) {
      cluster = { x, count: 0 };
      clusters.push(cluster);
    } else {
      cluster.x = (cluster.x * cluster.count + x) / (cluster.count + 1);
    }
    cluster.count += 1;
  }
  return clusters.sort((a, b) => a.x - b.x);
}

function nearColumnAnchor(x, anchorX, tol) {
  return anchorX != null && Math.abs(x - anchorX) <= tol;
}

function optionMarkerStartXs(withText) {
  const xs = [];
  for (const it of withText) {
    if (isOptionMarkerItem(it)) {
      xs.push(itemStartX(it));
      continue;
    }
    const t = itemText(it);
    if (/^\([A-F]\)/i.test(t)) xs.push(itemStartX(it));
  }
  return xs;
}

/**
 * One question anchor on the right plus a separated left option band (continuation from prior page).
 */
function tryDualColumnFromLoneAnchorAndLeftOptions(anchorX, anchors, withText, pageWidth, out) {
  const minSep = pageWidth * COLUMN_SEPARATION_FRAC;
  const optClusters = clusterAnchorXs(optionMarkerStartXs(withText));
  const leftOpt = optClusters.find((c) => anchorX - c.x >= minSep);
  if (!leftOpt) return false;

  out.rightAnchorX = anchorX;
  let gutter = GUTTER_BEFORE_RIGHT_COL;
  const indents = [];
  for (const it of anchors) {
    const optA = findNearbyOptionA(it, withText);
    if (optA) indents.push(itemStartX(optA) - anchorX);
  }
  let optionIndent = indents.length
    ? indents.reduce((a, b) => a + b, 0) / indents.length
    : null;
  if (optionIndent == null) {
    const rightOpt = optClusters.find((c) => c.x > anchorX && c.x - anchorX <= OPTION_A_MAX_DX);
    if (rightOpt) optionIndent = rightOpt.x - anchorX;
  }
  if (optionIndent == null || optionIndent < 4) {
    optionIndent = Math.max(8, Math.min(32, leftOpt.x * 0.2));
  }
  out.leftAnchorX = Math.max(0, leftOpt.x - optionIndent);
  if (indents.length) {
    const avg = indents.reduce((a, b) => a + b, 0) / indents.length;
    gutter = Math.max(8, Math.min(24, avg));
    out.marginTol = Math.max(DEFAULT_MARGIN_TOL, Math.ceil(gutter + LABEL_CLUSTER_TOL));
  }
  out.splitX = out.rightAnchorX - gutter;
  return true;
}

function reusePriorDualColumnGeometry(anchorX, priorGeo, out) {
  if (!priorGeo?.dualColumn || priorGeo.rightAnchorX == null || priorGeo.leftAnchorX == null) {
    return false;
  }
  const tol = priorGeo.marginTol ?? DEFAULT_MARGIN_TOL;
  if (Math.abs(anchorX - priorGeo.rightAnchorX) > tol) return false;
  out.leftAnchorX = priorGeo.leftAnchorX;
  out.rightAnchorX = priorGeo.rightAnchorX;
  out.splitX = priorGeo.splitX;
  out.marginTol = tol;
  return true;
}

/** Left/right column from anchor clusters; splitX alone mis-bands right-column labels left of the gutter. */
function xColumnSide(x, geo) {
  if (geo?.splitX == null) return 'left';
  const tol = geo.marginTol ?? DEFAULT_MARGIN_TOL;
  const nearRight = geo.rightAnchorX != null && nearColumnAnchor(x, geo.rightAnchorX, tol);
  const nearLeft = geo.leftAnchorX != null && nearColumnAnchor(x, geo.leftAnchorX, tol);
  if (nearRight && !nearLeft) return 'right';
  if (nearLeft && !nearRight) return 'left';
  if (nearRight && nearLeft) {
    return Math.abs(x - geo.rightAnchorX) <= Math.abs(x - geo.leftAnchorX) ? 'right' : 'left';
  }
  return x >= geo.splitX - 10 ? 'right' : 'left';
}

export function inferPageColumnGeometry(
  withText,
  pageWidth = DEFAULT_PAGE_WIDTH,
  priorColumnGeometry = null,
) {
  const anchors = withText.filter((it) => isValidatedQuestionAnchor(it, withText));
  const clusters = clusterAnchorXs(anchors.map((it) => itemStartX(it)));
  let leftAnchorX = null;
  let rightAnchorX = null;
  let splitX = null;
  let marginTol = DEFAULT_MARGIN_TOL;

  if (clusters.length >= 2) {
    const left = clusters[0];
    const right = clusters[clusters.length - 1];
    if (right.x - left.x >= pageWidth * COLUMN_SEPARATION_FRAC) {
      leftAnchorX = left.x;
      rightAnchorX = right.x;
      let gutter = GUTTER_BEFORE_RIGHT_COL;
      const indents = [];
      for (const it of anchors) {
        const lx = itemStartX(it);
        const nearLeft = Math.abs(lx - leftAnchorX);
        const nearRight = Math.abs(lx - rightAnchorX);
        const colX = nearLeft <= nearRight ? leftAnchorX : rightAnchorX;
        const optA = findNearbyOptionA(it, withText);
        if (optA) indents.push(itemStartX(optA) - colX);
      }
      if (indents.length) {
        const avg = indents.reduce((a, b) => a + b, 0) / indents.length;
        gutter = Math.max(8, Math.min(24, avg));
        marginTol = Math.max(DEFAULT_MARGIN_TOL, Math.ceil(gutter + LABEL_CLUSTER_TOL));
      }
      splitX = rightAnchorX - gutter;
    }
  } else if (clusters.length === 1) {
    const anchorX = clusters[0].x;
    const dualOut = { leftAnchorX: anchorX, rightAnchorX: null, splitX: null, marginTol };
    if (
      tryDualColumnFromLoneAnchorAndLeftOptions(anchorX, anchors, withText, pageWidth, dualOut)
      || reusePriorDualColumnGeometry(anchorX, priorColumnGeometry, dualOut)
    ) {
      leftAnchorX = dualOut.leftAnchorX;
      rightAnchorX = dualOut.rightAnchorX;
      splitX = dualOut.splitX;
      marginTol = dualOut.marginTol;
    } else {
      leftAnchorX = anchorX;
    }
  }

  let questionBlockTopY = null;
  if (anchors.length) {
    questionBlockTopY = Math.max(...anchors.map((it) => transformY(it.transform)));
  }

  return {
    splitX,
    leftAnchorX,
    rightAnchorX,
    marginTol,
    questionBlockTopY,
    dualColumn: splitX != null,
  };
}

function classifyItemBand(item, geo, pageWidth) {
  if (geo.splitX == null) return 'left';
  const startX = itemStartX(item);
  const y = transformY(item.transform);

  if (geo.questionBlockTopY != null && y > geo.questionBlockTopY + 3) {
    return 'full';
  }

  return xColumnSide(startX, geo);
}

function lineLooksLikeQuestion(lineParts, geo) {
  const text = mergeLineText(lineParts);
  const x = lineStartX(lineParts);
  if (!/^\d{1,3}\s*[.)]/.test(text)) return false;
  const tol = geo?.marginTol ?? DEFAULT_MARGIN_TOL;
  const nearLeft = nearColumnAnchor(x, geo?.leftAnchorX, tol);
  const nearRight = nearColumnAnchor(x, geo?.rightAnchorX, tol);
  if (!nearLeft && !nearRight) return false;
  if (QUESTION_INLINE_OPTION.test(text)) return true;
  const m = text.match(QUESTION_START);
  if (m && m[2] && m[2].trim().length >= 2) return true;
  if (/^\d{1,3}\.\s*$/.test(text.trim())) return true;
  if (/^\d{1,3}\s+\S/.test(text)) return true;
  return false;
}

function isFooterOrHeaderNoise(it) {
  const y = transformY(it.transform);
  const t = itemText(it);
  if (!t) return true;
  if (/^Unauthorized copying/i.test(t)) return true;
  if (y < 26 && /^\d{1,2}$/.test(t)) return true;
  if (y < 26 && /^\d{1,2}\s+Turn over/i.test(t)) return true;
  if (/^Page\s+\d+\s+of\s+\d+$/i.test(t)) return true;
  if (/^IELTS\.org$/i.test(t)) return true;
  if (/^Turn over\s*[►▶]?$/i.test(t)) return true;
  if (/[\uE080-\uE08F]/.test(t) && /PRIVATE|Page\s+\d+|MIDTERM/i.test(t)) return true;
  if (/^Sở GD&ĐT|^UBND\s|^PHÒNG GD|^Trường THCS/i.test(t)) return true;
  return false;
}

export function stripPdfRunningNoise(text) {
  return String(text || '')
    .replace(/\s*\[\d{4}\][^\s]*(?:MIDTERM|LOWERMIDTERM|B\d)[^\s]*(?:Page\s+\d+)?\s*/gi, ' ')
    .replace(/\s*[\uE080-\uE08F]\s*\d{4}\s*[\uE080-\uE08F][^\s]*(?:PRIVATE\s+USE|Page\s+\d+)?\s*/gi, ' ')
    .replace(/\s*Page\s+\d+\s+of\s+\d+\s*/gi, ' ')
    .replace(/\s*IELTS\.org\s*/gi, ' ')
    .replace(/\s*\d{1,3}\s+Turn over\s*[►▶]?\s*/gi, ' ')
    .replace(/\s*Turn over\s*[►▶]?\s*/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function orderDualColumnTaggedLines(tagged, geo) {
  const byBand = (band) =>
    tagged
      .filter((t) => t.band === band)
      .sort((a, b) => {
        if (Math.abs(b.y - a.y) > 1.5) return b.y - a.y;
        return lineStartX(a.line) - lineStartX(b.line);
      })
      .map((t) => t.line);
  return [...byBand('left'), ...byBand('right')];
}

function linePartHasQuestionLabel(part) {
  return /^\d{1,3}\./.test(String(part?.text || '').trim());
}

function linePartsAreSpreadMcqOptionRow(lineParts) {
  if (!lineParts || lineParts.length < 3) return false;
  const texts = lineParts.map((p) => String(p.text || '').trim()).filter(Boolean);
  const hasQnum = texts.some((t) => /^\d{1,3}\.$/.test(t));
  const letterOpts = texts.filter((t) => /^[A-D]\.\s/.test(t)).length;
  return hasQnum && letterOpts >= 2;
}

function splitDualColumnQuestionLine(lineParts, geo) {
  if (linePartsAreSpreadMcqOptionRow(lineParts)) return [lineParts];
  if (!geo?.splitX || lineParts.length < 2) return [lineParts];
  const left = lineParts.filter((p) => xColumnSide(p.bbox?.x ?? 0, geo) === 'left');
  const right = lineParts.filter((p) => xColumnSide(p.bbox?.x ?? 0, geo) === 'right');
  if (!left.length || !right.length) return [lineParts];
  const leftHasQ = left.some((p) => linePartHasQuestionLabel(p));
  const rightHasQ = right.some((p) => linePartHasQuestionLabel(p));
  if (leftHasQ && rightHasQ) return [left, right].filter((ln) => ln.length);
  return [lineParts];
}

function expandLinesForDualColumn(lines, geo) {
  if (!geo?.dualColumn) return lines;
  const expanded = [];
  for (const ln of lines) {
    for (const sub of splitDualColumnQuestionLine(ln, geo)) {
      expanded.push(sub);
    }
  }
  return expanded;
}

function dualColumnQuestionCounts(lines, geo) {
  let leftQ = 0;
  let rightQ = 0;
  for (const ln of lines) {
    if (!lineLooksLikeQuestion(ln, geo)) continue;
    if (xColumnSide(lineStartX(ln), geo) === 'right') rightQ += 1;
    else leftQ += 1;
  }
  return { leftQ, rightQ };
}

function linesNeedColumnMajorReorder(lines, geo) {
  const { leftQ, rightQ } = dualColumnQuestionCounts(lines, geo);
  if (leftQ < 1 || rightQ < 1) return false;
  let seenRightQuestion = false;
  for (const ln of lines) {
    if (!lineLooksLikeQuestion(ln, geo)) continue;
    const side = xColumnSide(lineStartX(ln), geo);
    if (side === 'right') seenRightQuestion = true;
    else if (seenRightQuestion) return true;
  }
  return false;
}

function orderLinesDualColumnMajor(lines, geo) {
  const tagged = lines.map((line) => ({
    line,
    band: xColumnSide(lineStartX(line), geo),
    y: lineTopY(line),
  }));
  const isFullBand = (t) =>
    geo.questionBlockTopY != null && t.y > geo.questionBlockTopY + 3;
  const full = tagged.filter(isFullBand);
  const rest = tagged.filter((t) => !isFullBand(t));
  const sortBand = (band) =>
    rest
      .filter((t) => t.band === band)
      .sort((a, b) => {
        if (Math.abs(b.y - a.y) > 1.5) return b.y - a.y;
        return lineStartX(a.line) - lineStartX(b.line);
      })
      .map((t) => t.line);
  const colTopY = rest.reduce((m, t) => Math.max(m, t.y), 0);
  const topFull = full.filter((t) => t.y >= colTopY - 6).sort((a, b) => b.y - a.y).map((t) => t.line);
  const bottomFull = full.filter((t) => t.y < colTopY - 6).sort((a, b) => b.y - a.y).map((t) => t.line);
  return [...topFull, ...sortBand('left'), ...sortBand('right'), ...bottomFull];
}

function inferColumnGeometryFromLineParts(lines, pageWidth = DEFAULT_PAGE_WIDTH, priorColumnGeometry = null) {
  const pseudoItems = (lines || []).flat().map((p) => ({
    str: p.text,
    transform: [1, 0, 0, 1, p.bbox?.x ?? 0, p.bbox?.y ?? 0],
    width: p.bbox?.w ?? 0,
    height: p.bbox?.h ?? 12,
  }));
  return inferPageColumnGeometry(pseudoItems, pageWidth, priorColumnGeometry);
}

export function pageLinesForQuestionParse(page) {
  const pageWidth = page.pageWidth || DEFAULT_PAGE_WIDTH;
  const geo = page.columnGeometry || inferColumnGeometryFromLineParts(page.lines, pageWidth);
  let lines = [...(page.lines || [])];
  if (geo.dualColumn) {
    lines = expandLinesForDualColumn(lines, geo);
    if (linesNeedColumnMajorReorder(lines, geo)) {
      lines = orderLinesDualColumnMajor(lines, geo);
    }
  }
  return { geo, lines };
}

function mergeTaggedLines(tagged, geo) {
  if (!tagged.length) return [];
  const full = tagged.filter((t) => t.band === 'full').sort((a, b) => b.y - a.y);
  const left = tagged.filter((t) => t.band === 'left').sort((a, b) => b.y - a.y);
  const right = tagged.filter((t) => t.band === 'right').sort((a, b) => b.y - a.y);

  if (!geo.dualColumn || !left.length || !right.length) {
    const flat = [...tagged].sort((a, b) => b.y - a.y).map((t) => t.line);
    return expandLinesForDualColumn(flat, geo);
  }

  const leftQ = left.filter((t) => lineLooksLikeQuestion(t.line, geo)).length;
  const rightQ = right.filter((t) => lineLooksLikeQuestion(t.line, geo)).length;
  const dualQuestionColumns = leftQ >= 1 && rightQ >= 1;
  const leftPassageHeavy = left.length > right.length * 2 && leftQ <= 1;
  const leftContinuationBand =
    rightQ >= 1 && leftQ === 0 && left.length > 0 && !leftPassageHeavy;

  if ((dualQuestionColumns || leftContinuationBand) && !leftPassageHeavy) {
    const colTopY = Math.max(left[0]?.y ?? 0, right[0]?.y ?? 0);
    const topFull = full.filter((t) => t.y >= colTopY - 6);
    const bottomFull = full.filter((t) => t.y < colTopY - 6);
    const columnLines = orderDualColumnTaggedLines([...left, ...right], geo);
    return expandLinesForDualColumn(
      [...topFull.map((t) => t.line), ...columnLines, ...bottomFull.map((t) => t.line)],
      geo,
    );
  }

  const bandOrder = { full: 0, left: 1, right: 2 };
  const flat = [...tagged]
    .sort((a, b) => {
      if (Math.abs(b.y - a.y) > 1.5) return b.y - a.y;
      return (bandOrder[a.band] ?? 1) - (bandOrder[b.band] ?? 1);
    })
    .map((t) => t.line);
  return expandLinesForDualColumn(flat, geo);
}

export function pageLinesFromRawItems(
  rawItems,
  pageWidth = DEFAULT_PAGE_WIDTH,
  priorColumnGeometry = null,
) {
  const withText = rawItems.filter((it) => itemText(it) && !isFooterOrHeaderNoise(it));
  if (!withText.length) {
    return { lines: [], columnGeometry: inferPageColumnGeometry([], pageWidth) };
  }

  const columnGeometry = inferPageColumnGeometry(withText, pageWidth, priorColumnGeometry);
  const buckets = { full: [], left: [], right: [] };

  for (const it of withText) {
    const band = classifyItemBand(it, columnGeometry, pageWidth);
    buckets[band].push(it);
  }

  const tagged = [];
  for (const band of ['full', 'left', 'right']) {
    for (const ln of buildLinesFromItems(buckets[band])) {
      tagged.push({ line: ln, band, y: lineTopY(ln) });
    }
  }
  return { lines: mergeTaggedLines(tagged, columnGeometry), columnGeometry };
}

export function mergeLineText(lineParts) {
  return stripPdfRunningNoise(lineParts.map((p) => p.text).join(' ').replace(/\s+/g, ' ').trim());
}

function pagePlainTextForSchoolDetect(page) {
  const direct = String(page?.plainText || '').trim();
  if (direct) return direct;
  const lines = page?.lines || [];
  return lines.map((ln) => mergeLineText(ln)).join('\n');
}

/** Collapse OCR-split question numbers like "Question 3 0 ." → "Question 30." */
function normalizeSpacedQuestionAnchors(lineText) {
  return String(lineText || '').replace(
    /\b(Questions?)\s+((?:\d(?:\s+\d){1,3}))\s*\./gi,
    (_full, word, digits) => {
      const combined = digits.replace(/\s+/g, '');
      if (!/^\d{1,3}$/.test(combined)) return _full;
      return `${word} ${combined}.`;
    },
  );
}

function parseFromToQuestionRange(lineText) {
  const t = String(lineText || '');
  const m = t.match(/\bfrom\s+(\d{1,3})\s+to\s+(\d{1,3})\b/i)
    || t.match(/\bfollowing\s+questions?\s+(\d{1,3})\s+to\s+(\d{1,3})\b/i);
  if (!m) return null;
  const a = parseInt(m[1], 10);
  const b = parseInt(m[2], 10);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return { min: Math.min(a, b), max: Math.max(a, b) };
}

function deriveStrictExerciseScopeKey(displayNumber) {
  const m = String(displayNumber || '').match(/^(ex\d+|sample)-/i);
  return m ? m[1].toLowerCase() : null;
}

function tryConsumeSchoolInlineMcqRow(lineText, lineParts, questions, ctx, page, geo, finish) {
  if (ctx.inTheoryBlock || ctx.unsupportedBlockActive) return false;
  const parsed = parseNumberedInlineMcqFromLine(lineText);
  if (!parsed) return false;
  const inScope = ctx.activeExerciseKey
    || questionAllowedByRange(parsed.number, ctx);
  if (!inScope) return false;
  if (!ctx.activeExerciseKey && !lineNearQuestionColumn(lineStartX(lineParts), geo)) return false;
  finish(ctx, page);
  const q = startQuestion(questions, ctx, parsed.number, '', page, lineParts);
  for (const opt of parsed.options) {
    addOption(q, opt.label, opt.text);
  }
  return true;
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
  const paintSets = buildOperatorPaintSets(pdfjs.OPS);
  const loadingTask = pdfjs.getDocument({ data: new Uint8Array(buffer), useSystemFonts: true });
  const pdf = await loadingTask.promise;
  const pages = [];
  let priorColumnGeometry = null;
  try {
    for (const pageNum of pageNumbers) {
      if (pageNum < 1 || pageNum > pdf.numPages) {
        throw new Error('page-out-of-range');
      }
      const page = await pdf.getPage(pageNum);
      const viewport = page.getViewport({ scale: 1 });
      const pageWidth = viewport.width || DEFAULT_PAGE_WIDTH;
      const textPromise = page.getTextContent();
      const operatorPromise = page.getOperatorList();
      let timeoutId;
      const timeout = new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error('page-timeout')), pageTimeoutMs);
      });
      let content;
      let operatorList;
      try {
        [content, operatorList] = await Promise.race([
          Promise.all([textPromise, operatorPromise]),
          timeout,
        ]);
      } catch (err) {
        page.cleanup?.();
        throw err;
      } finally {
        clearTimeout(timeoutId);
      }
      const rawItems = (content.items || []).map((it) => ({
        ...it,
        pageNumber: pageNum,
      }));
      let layer = await classifyPageContentLayerWithVisibleFallback(
        page,
        rawItems.length,
        operatorList?.fnArray,
        paintSets,
        {
          timeoutMs: Math.min(pageTimeoutMs, VISIBLE_BLANK_RENDER_TIMEOUT_MS),
        },
      );
      const { lines, columnGeometry } = pageLinesFromRawItems(
        rawItems,
        pageWidth,
        priorColumnGeometry,
      );
      if (columnGeometry.dualColumn) {
        priorColumnGeometry = columnGeometry;
      }
      const sorted = sortReadingOrder(rawItems);
      const plain = lines.map((ln) => mergeLineText(ln)).join('\n');
      if (!layer.needsOcr && !layer.isBlankPage) {
        const sparse = classifySparseHeaderFooterWithImages(
          rawItems.length,
          plain,
          operatorList?.fnArray,
          paintSets,
        );
        if (sparse?.needsOcr) layer = sparse;
      }
      pages.push({
        pageNumber: pageNum,
        needsOcr: layer.needsOcr,
        isBlankPage: layer.isBlankPage,
        pageWidth,
        lines,
        columnGeometry,
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

function isSkipLine(lineText) {
  if (!lineText) return true;
  if (TOEIC_PART_HEADER.test(lineText)) return true;
  if (DIRECTIONS_LINE.test(lineText)) return true;
  if (LISTENING_TEST_MARK.test(lineText)) return true;
  if (/^Unauthorized copying/i.test(lineText)) return true;
  if (/^\d{1,2}$/.test(lineText)) return true;
  if (/^In the Reading test,/i.test(lineText)) return true;
  if (/^Reading Test\b/i.test(lineText)) return true;
  if (/^You must mark your answers/i.test(lineText)) return true;
  if (/^A word or phrase is missing/i.test(lineText)) return true;
  if (/^given below each sentence/i.test(lineText)) return true;
  if (/^\([A-D]\),\s*\([A-D]\),\s*\([A-D]\), or/i.test(lineText)) return true;
  if (/^Read the texts that follow/i.test(lineText)) return true;
  if (/^In this part you will read/i.test(lineText)) return true;
  if (/^In the Listening test,/i.test(lineText)) return true;
  if (/^The entire Listening test/i.test(lineText)) return true;
  if (/^Do not write your answers in your test book/i.test(lineText)) return true;
  if (/^Statement\s*\([A-D]\)/i.test(lineText)) return true;
  if (/^Mark your answer on your answer sheet/i.test(lineText)) return true;
  if (/^Select the best answer/i.test(lineText) && lineText.length > 80) return true;
  if (/^Select the best response to the question/i.test(lineText)) return true;
  if (/^Then mark the letter/i.test(lineText)) return true;
  if (/spoken only one time/i.test(lineText) && lineText.length > 40) return true;
  if (/not be printed in your test book/i.test(lineText)) return true;
  if (/^Page\s+\d+\s+of\s+\d+$/i.test(lineText)) return true;
  if (/^IELTS\.org$/i.test(lineText)) return true;
  if (/^Turn over\s*[►▶]?$/i.test(lineText)) return true;
  if (/^\d{1,3}\s+Turn over\s*[►▶]?$/i.test(lineText)) return true;
  return false;
}

function addOption(question, label, rawText) {
  const id = String(label).toUpperCase();
  const text = splitSchoolFooterFromOptionTail(rawText);
  if (!text) return;
  if (question.options.find((o) => o.id === id)) return;
  question.options.push({ id, label: id, text });
}

function lineHasMultipleInlineLetterDotOptions(lineText) {
  if (!lineText) return false;
  const hits = lineText.match(/\s[A-D]\.\s+\S/g) || [];
  return hits.length >= 2 || /^[A-D]\.\s+\S.*\s[A-D]\.\s+\S/.test(lineText);
}

function parseDisplayQuestionNumber(displayNumber) {
  const m = String(displayNumber || '').match(/(?:^|-)(\d{1,3})$/);
  if (m) return parseInt(m[1], 10);
  const v = parseInt(displayNumber, 10);
  return Number.isFinite(v) ? v : NaN;
}

function schoolPassageBlockAllowsOutOfDeclaredRange(ctx) {
  if (!ctx?.clozePassageKeys) return false;
  if (ctx.readPassageCaptureActive && ctx.currentPassageId) return true;
  if (ctx.schoolReadPassageId && ctx.currentPassageId === ctx.schoolReadPassageId) return true;
  if (ctx.activeExerciseKey && ctx.clozePassageKeys.has(ctx.activeExerciseKey) && ctx.currentPassageId) {
    return true;
  }
  return false;
}

function questionAllowedByRange(num, ctx) {
  if (!ctx?.currentQuestionRange) return true;
  if (schoolPassageBlockAllowsOutOfDeclaredRange(ctx)) return true;
  return isWithinDeclaredRange(String(num), ctx.currentQuestionRange);
}

function parseNumberedInlineMcqFromLine(lineText) {
  const raw = String(lineText || '').trim();
  if (!raw) return null;
  let number;
  let body;
  const dotted = raw.match(/^(\d{1,3})\.\s+(.+)$/);
  if (dotted) {
    number = dotted[1];
    body = dotted[2];
  } else {
    const undotted = raw.match(/^(\d{1,3})\s+((?:[A-D]\.\s*\S+(?:\s+|$)){2,})\s*$/i);
    if (!undotted) return null;
    number = undotted[1];
    body = undotted[2];
  }
  if (!/^[A-D]\.\s+/i.test(body)) return null;
  const options = [];
  INLINE_OPTION_ROW_UPPER.lastIndex = 0;
  let m;
  while ((m = INLINE_OPTION_ROW_UPPER.exec(body)) !== null) {
    const label = String(m[1]).toUpperCase();
    const chunk = (m[2] || '').trim();
    if (!chunk) continue;
    options.push({ label, text: chunk });
  }
  if (options.length < 2 || options[0].label !== 'A') return null;
  return { number, options };
}

function noteObservedQuestionOnPassage(passages, ctx, displayNumber) {
  if (!ctx?.currentPassageId || !passages?.length) return;
  const v = parseDisplayQuestionNumber(displayNumber);
  if (!Number.isFinite(v)) return;
  const g = passages.find((x) => x.id === ctx.currentPassageId);
  if (!g) return;
  if (!g.observedQuestionNumbers) g.observedQuestionNumbers = [];
  if (!g.observedQuestionNumbers.includes(v)) g.observedQuestionNumbers.push(v);
}

function warnSchoolPassageRangeMismatches(passages, warnings) {
  for (const g of passages) {
    const declared = g.expectedQuestionRange;
    const observed = g.observedQuestionNumbers;
    if (!declared || !observed?.length) continue;
    const outside = observed.filter((n) => n < declared.min || n > declared.max);
    if (!outside.length) continue;
    const pg = g.sourcePage || g.sourcePages?.[0] || '?';
    warnings.push(
      `Trang ${pg}: tiêu đề ghi câu ${declared.min}-${declared.max} nhưng phát hiện câu ${outside.sort((a, b) => a - b).join(', ')} — cần giáo viên đối chiếu với PDF.`,
    );
  }
}

function ensureUnsupportedFormatWarnings(passages, questions, warnings) {
  const hasSupportedMcq = questions.some(
    (q) => q.options?.filter((o) => o.text?.trim()).length >= 2 && String(q.stemText || '').trim(),
  );
  if (hasSupportedMcq) return;
  for (const g of passages || []) {
    const unsupported = g.unsupportedTaskType
      || passageHeaderMarksUnsupportedTask(g.title)
      || /NO MORE THAN/i.test(`${g.title} ${g.instructions}`);
    if (!unsupported) continue;
    if (warnings.some((w) => /chưa hỗ trợ|điền từ/i.test(w))) return;
    const pg = g.sourcePage || g.sourcePages?.[0] || '?';
    const reason = g.unsupportedReason || 'Dạng bài điền từ/tự luận/ghi chép';
    warnings.push(
      `Trang ${pg}: ${reason} — đã đọc được chữ nhưng chưa hỗ trợ nhập tự động.`,
    );
  }
}

function parseInlineLetterDotOptions(lineText, question) {
  if (!question) return false;
  if (!/\b[A-D]\.\s+\S/.test(lineText)) return false;
  const priorIds = new Set(question.options.map((o) => o.id));
  INLINE_OPTION_ROW_UPPER.lastIndex = 0;
  let matched = 0;
  let m;
  while ((m = INLINE_OPTION_ROW_UPPER.exec(lineText)) !== null) {
    const label = m[1];
    const chunk = (m[2] || '').trim();
    if (!chunk) continue;
    if (priorIds.has(String(label).toUpperCase())) continue;
    addOption(question, label, chunk);
    priorIds.add(String(label).toUpperCase());
    matched += 1;
  }
  return matched >= 2 || (matched >= 1 && question.options.length >= 2);
}

function parseOptionsFromLine(lineText, question) {
  if (parseInlineLetterDotOptions(lineText, question)) return true;
  const markers = [...lineText.matchAll(/\(([A-F])\)/gi)];
  if (markers.length >= 2) {
    for (let i = 0; i < markers.length; i += 1) {
      const label = markers[i][1];
      const start = markers[i].index + markers[i][0].length;
      const end = i + 1 < markers.length ? markers[i].index : lineText.length;
      const chunk = lineText.slice(start, end).trim();
      addOption(question, label, chunk);
    }
    return markers.length > 0;
  }
  const om = lineText.match(OPTION_LINE_START);
  if (om) {
    addOption(question, om[1] || om[2], om[3]);
    return true;
  }
  return false;
}

function appendStem(question, fragment) {
  const piece = sanitizeExamHtml(fragment);
  if (!piece) return;
  question.stemText = question.stemText
    ? `${question.stemText} ${piece}`.trim()
    : piece;
}

function splitEmbeddedOptionsFromStem(question) {
  if (!question?.stemText || question.options.length) return;
  const idx = question.stemText.search(/\([A-F]\)/i);
  if (idx <= 0) return;
  const stemPart = question.stemText.slice(0, idx).trim();
  const optPart = question.stemText.slice(idx);
  question.stemText = stemPart;
  parseOptionsFromLine(optPart, question);
}

function markPart6Question(ctx, displayNumber) {
  if (!ctx.part6QuestionRange) return;
  const v = parseInt(displayNumber, 10);
  const { min, max } = ctx.part6QuestionRange;
  if (v >= min && v <= max) ctx.part6QuestionsStarted = true;
}

function startQuestion(questions, ctx, displayNumber, stemFragment, page, lineParts) {
  if (ctx.pageSawTestEndThisPage) {
    ctx.questionsStartedAfterPageTestEnd = true;
  }
  ctx.qOrdinal += 1;
  const qid = newExamQuestionId(ctx.sectionId, ctx.qOrdinal);
  const scopedNumber = ctx.activeExerciseKey
    ? `${ctx.activeExerciseKey}-${displayNumber}`
    : String(displayNumber);
  const exerciseScopeKey = ctx.activeExerciseKey || null;
  let exerciseInstructionSnapshot = null;
  if (exerciseScopeKey && ctx.exerciseInstructions?.has(exerciseScopeKey)) {
    exerciseInstructionSnapshot = ctx.exerciseInstructions.get(exerciseScopeKey);
  }
  const q = {
    id: qid,
    sectionId: ctx.sectionId,
    groupId: ctx.currentPassageId || null,
    passageId: ctx.currentPassageId,
    displayNumber: scopedNumber,
    exerciseScopeKey,
    exerciseInstructionSnapshot,
    stemText: sanitizeExamHtml(stemFragment || ''),
    options: [],
    correctOptionId: null,
    points: 1,
    sourcePage: page.pageNumber,
    bbox: lineParts[0]?.bbox || null,
    order: ctx.qOrdinal,
    incomplete: false,
    declaredOptionCount: ctx.declaredMcqOptionCount,
  };
  questions.push(q);
  ctx.lastQuestion = q;
  if (ctx.passages) noteObservedQuestionOnPassage(ctx.passages, ctx, displayNumber);
  if (ctx.readPassageCaptureActive) {
    ctx.readPassageCaptureActive = false;
  }
  markPart6Question(ctx, displayNumber);
  if (ctx.part6QuestionRange) {
    const v = parseInt(displayNumber, 10);
    const { min, max } = ctx.part6QuestionRange;
    if (v >= min && v <= max && !q.stemText.trim()) {
      q.stemText = PART6_BLANK_STEM;
    }
  }
  if (ctx.activeExerciseKey === 'ex5' && /_{2,}/.test(String(stemFragment || '')) && !q.stemText.trim()) {
    q.stemText = PART6_BLANK_STEM;
  }
  splitEmbeddedOptionsFromStem(q);
  return q;
}

const PART6_BLANK_STEM = 'Chọn từ/câu phù hợp cho ô trống trong đoạn văn.';

function lineNearQuestionColumn(x, geo) {
  const tol = geo?.marginTol ?? DEFAULT_MARGIN_TOL;
  if (geo?.leftAnchorX != null && nearColumnAnchor(x, geo.leftAnchorX, tol)) return true;
  if (geo?.rightAnchorX != null && nearColumnAnchor(x, geo.rightAnchorX, tol)) return true;
  if (geo?.splitX != null && x >= geo.splitX - Math.max(10, tol * 0.25)) return true;
  if (geo?.leftAnchorX == null && geo?.rightAnchorX == null) return true;
  return false;
}

function lineMatchesQuestionColumn(lineParts, question, geo) {
  if (!geo?.splitX || !question?.bbox) return true;
  const qx = question.bbox.x ?? lineStartX([{ bbox: question.bbox }]);
  const lx = lineStartX(lineParts);
  return xColumnSide(qx, geo) === xColumnSide(lx, geo);
}

function parseExpectedRangeFromHeader(lineText) {
  const range = lineText.match(QUESTIONS_RANGE);
  if (range) {
    return { min: parseInt(range[1], 10), max: parseInt(range[2], 10) };
  }
  const andPair = lineText.match(QUESTIONS_AND_PAIR);
  if (andPair) {
    const a = parseInt(andPair[1], 10);
    const b = parseInt(andPair[2], 10);
    return { min: Math.min(a, b), max: Math.max(a, b) };
  }
  const followingTo = String(lineText || '').match(
    /\bfollowing\s+questions?\s+(\d{1,3})\s+to\s+(\d{1,3})\b/i,
  );
  if (followingTo) {
    const a = parseInt(followingTo[1], 10);
    const b = parseInt(followingTo[2], 10);
    return { min: Math.min(a, b), max: Math.max(a, b) };
  }
  return null;
}

const DECLARED_DOC_TYPE_RE = /(?:advertisement|online\s+shopping\s+cart|e-mail|email|article|memo|letter|notice|form)/gi;

function normalizeDeclaredDocType(raw) {
  const t = String(raw || '').toLowerCase().replace(/\s+/g, '-').replace('e-mail', 'email');
  if (t.includes('shopping') && t.includes('cart')) return 'shopping-cart';
  return t;
}

function parseDeclaredDocTypes(title) {
  const types = [];
  const seen = new Set();
  let m;
  DECLARED_DOC_TYPE_RE.lastIndex = 0;
  while ((m = DECLARED_DOC_TYPE_RE.exec(title))) {
    const norm = normalizeDeclaredDocType(m[0]);
    if (seen.has(norm)) continue;
    seen.add(norm);
    types.push(norm);
  }
  return types;
}

function initializeGroupDocumentsFromHeader(group, pageNumber) {
  const types = parseDeclaredDocTypes(group.title);
  if (types.length < 2) return;
  group.documents = types.map((type, order) => ({
    id: `${group.id}_doc_${order}`,
    title: type.replace(/-/g, ' '),
    type,
    bodyText: '',
    sourcePages: order === 0 && pageNumber ? [pageNumber] : [],
    order,
    requiresReview: true,
  }));
  if (pageNumber) {
    group.sourcePages = [...new Set([...(group.sourcePages || []), pageNumber])];
  }
}

function isEmailHeaderLine(lineText) {
  return /^(From|To|Subject|Date|Cc|Sent):/i.test(String(lineText || '').trim());
}

function resolveDocumentForBodyLine(group, lineText, pageNumber) {
  const docs = group.documents || [];
  if (docs.length <= 1) return ensurePrimaryDocument(group, pageNumber);
  const emailDoc = docs.find((d) => d.type === 'email');
  if (emailDoc && (isEmailHeaderLine(lineText) || group._emailBodyActive)) {
    group._emailBodyActive = true;
    return emailDoc;
  }
  const cartDoc = docs.find((d) => d.type === 'shopping-cart');
  if (cartDoc && group._cartBodyActive && !group._emailBodyActive) return cartDoc;
  if (/^Shopping\s+Cart/i.test(lineText) || /^Online\s+Shopping/i.test(lineText)) {
    group._cartBodyActive = true;
    if (cartDoc) return cartDoc;
  }
  const adDoc = docs.find((d) => d.type === 'advertisement') || docs[0];
  return adDoc;
}

function detectUnsupportedReadingTask(text, pendingLabel = '') {
  const t = `${pendingLabel} ${String(text || '')}`.replace(/\s+/g, ' ').trim();
  if (CHOOSE_TWO_MARK.test(t)) {
    return {
      type: 'choose-two',
      reason: 'Dạng bài chọn hai đáp án (choose TWO) chưa được hỗ trợ — cần soạn thủ công.',
    };
  }
  if (TFNG_MARK.test(t) || YNNG_MARK.test(t)) {
    return {
      type: 'tfng',
      reason: 'Dạng bài TRUE/FALSE/NOT GIVEN (hoặc Yes/No/Not Given) chưa được hỗ trợ — cần soạn thủ công.',
    };
  }
  if (MATCHING_MARK.test(t)) {
    return {
      type: 'matching',
      reason: 'Dạng bài nối/matching chưa được hỗ trợ — cần soạn thủ công.',
    };
  }
  return null;
}

function inferDocumentType(title) {
  const m = String(title || '').match(DOC_TYPE_HEADER);
  if (!m) return 'passage';
  return m[1].toLowerCase().replace('e-mail', 'email');
}

function isWithinDeclaredRange(displayNumber, range) {
  if (!range) return true;
  const v = parseInt(displayNumber, 10);
  if (!Number.isFinite(v)) return true;
  return v >= range.min && v <= range.max;
}

function ensurePrimaryDocument(group, pageNumber) {
  if (!group.documents) group.documents = [];
  if (!group.documents.length) {
    group.documents.push({
      id: `${group.id}_doc_0`,
      title: '',
      type: inferDocumentType(group.title),
      bodyText: '',
      sourcePages: pageNumber ? [pageNumber] : [],
      order: 0,
      requiresReview: false,
    });
  }
  return group.documents[group.documents.length - 1];
}

function appendDocumentText(group, text, pageNumber, lineTextForRouting = null) {
  const doc = resolveDocumentForBodyLine(group, lineTextForRouting ?? text, pageNumber);
  const piece = sanitizeExamHtml(text);
  if (!piece) return;
  if (pageNumber && !doc.sourcePages.includes(pageNumber)) doc.sourcePages.push(pageNumber);
  if (pageNumber && group.sourcePages && !group.sourcePages.includes(pageNumber)) {
    group.sourcePages.push(pageNumber);
  }
  doc.bodyText = doc.bodyText ? `${doc.bodyText}\n${piece}` : piece;
  group.bodyText = doc.bodyText;
}

function consumePendingContextIntoGroup(group, pendingContext) {
  if (!pendingContext?.length) return;
  const pages = [...new Set(pendingContext.map((e) => e.page.pageNumber))];
  group.sourcePages = [...new Set([...(group.sourcePages || []), ...pages])];
  const body = pendingContext.map((e) => e.text).join('\n');
  const sanitized = sanitizeExamHtml(body);
  if (group.documents?.length >= 2) {
    const target = group.documents.find((d) => d.type === 'advertisement') || group.documents[0];
    target.bodyText = sanitized;
    target.sourcePages = [...new Set([...(target.sourcePages || []), ...pages])];
    if (sanitized.trim().length < 48 && /refer to the following/i.test(group.title)) {
      target.requiresReview = true;
    }
    group.bodyText = group.documents.map((d) => d.bodyText).filter(Boolean).join('\n\n');
  } else {
    const doc = {
      id: `${group.id}_doc_0`,
      title: '',
      type: inferDocumentType(group.title),
      bodyText: sanitized,
      sourcePages: pages,
      order: 0,
      requiresReview: body.trim().length < 48 && /refer to the following/i.test(group.title),
    };
    group.documents = [doc];
    group.bodyText = doc.bodyText;
  }
  pendingContext.length = 0;
}

function maybeStartSubDocument(group, lineText, pageNumber) {
  if ((group.documents?.length || 0) >= 2) return false;
  const m = lineText.match(MULTI_DOC_TITLE);
  if (!m) return false;
  if (!group.documents) group.documents = [];
  const order = group.documents.length;
  group.documents.push({
    id: `${group.id}_doc_${order}`,
    title: sanitizeExamHtml(m[1]),
    type: m[1].toLowerCase().replace(/\s+/g, '-').replace('e-mail', 'email'),
    bodyText: '',
    sourcePages: pageNumber ? [pageNumber] : [],
    order,
    requiresReview: false,
  });
  return true;
}

function applyClozeBlankStemsFromPassage(questions, passages) {
  for (const q of questions) {
    if (!/^(?:ex\d+|sample)-\d+$/i.test(String(q.displayNumber))) continue;
    if (String(q.stemText || '').trim()) continue;
    const blankNum = parseInt(String(q.displayNumber).replace(/^(?:ex\d+|sample)-/i, ''), 10);
    if (!Number.isFinite(blankNum)) continue;
    const g = passages.find((p) => p.id === q.passageId);
    const body = g?.bodyText || g?.documents?.[0]?.bodyText || '';
    if (!body) continue;
    const blankRe = new RegExp(
      String.raw`(?:\(${blankNum}\)|${blankNum})\s*[.)]?\s*_{3,}[^.!?\n]{0,220}`,
      'i',
    );
    const hit = body.match(blankRe);
    if (hit) {
      q.stemText = sanitizeExamHtml(hit[0].trim());
    } else {
      const ctxRe = new RegExp(
        String.raw`.{0,90}(?:\(${blankNum}\)|${blankNum})\s*[.)]?\s*_{3,}.{0,90}`,
        'i',
      );
      const ctxHit = body.match(ctxRe);
      if (ctxHit) q.stemText = sanitizeExamHtml(ctxHit[0].trim());
    }
  }
}

function beginSchoolReadPassageGroup(passages, ctx, page, headerText, warnings) {
  finishActiveQuestion(ctx, page);
  const expectedQuestionRange = parseExpectedRangeFromHeader(headerText)
    || parseFromToQuestionRange(headerText);
  const scopeKey = ctx.activeExerciseKey || 'read';
  ctx.currentPassageId = `pass_read_${scopeKey}_${page.pageNumber}_${passages.length}`;
  const group = {
    id: ctx.currentPassageId,
    sectionId: ctx.sectionId,
    title: sanitizeExamHtml(String(headerText || '').slice(0, 200)),
    instructions: '',
    expectedQuestionRange,
    sourcePages: [page.pageNumber],
    documents: [{
      id: `${ctx.currentPassageId}_doc_0`,
      title: '',
      type: 'passage',
      bodyText: '',
      sourcePages: [page.pageNumber],
      order: 0,
      requiresReview: false,
    }],
    bodyText: '',
    requiresContext: true,
    contextConfirmed: false,
    unsupportedTaskType: null,
    unsupportedReason: null,
    sourcePage: page.pageNumber,
    bbox: null,
  };
  passages.push(group);
  ctx.schoolReadPassageId = ctx.currentPassageId;
  ctx.schoolReadDeclaredRange = expectedQuestionRange;
  ctx.currentQuestionRange = null;
  ctx.readPassageCaptureActive = true;
  ctx.lastQuestion = null;
  if (expectedQuestionRange && /from\s+\d+\s+to\s+\d+/i.test(headerText)) {
    warnings.push(
      `Trang ${page.pageNumber}: tiêu đề đoạn đọc ghi câu ${expectedQuestionRange.min}-${expectedQuestionRange.max} — cần giáo viên đối chiếu với PDF.`,
    );
  }
}

function ensureSchoolExercisePassage(passages, ctx, page, label) {
  if (ctx.currentPassageId) return;
  ctx.currentPassageId = `pass_ex_${ctx.activeExerciseKey || 'cloze'}_${page.pageNumber}`;
  const group = {
    id: ctx.currentPassageId,
    sectionId: ctx.sectionId,
    title: sanitizeExamHtml(label.slice(0, 160)),
    instructions: '',
    expectedQuestionRange: null,
    sourcePages: [page.pageNumber],
    documents: [{
      id: `${ctx.currentPassageId}_doc_0`,
      title: '',
      type: 'passage',
      bodyText: '',
      sourcePages: [page.pageNumber],
      order: 0,
      requiresReview: false,
    }],
    bodyText: '',
    requiresContext: true,
    contextConfirmed: false,
    unsupportedTaskType: null,
    unsupportedReason: null,
    sourcePage: page.pageNumber,
    bbox: null,
  };
  passages.push(group);
}

function createReadingGroup(passages, ctx, lineText, page, lineParts) {
  ctx.currentPassageId = `pass_${page.pageNumber}_${passages.length}`;
  const expectedQuestionRange = parseExpectedRangeFromHeader(lineText);
  ctx.currentQuestionRange = expectedQuestionRange;
  if (expectedQuestionRange && ctx.inPart6Passage) {
    ctx.part6QuestionRange = expectedQuestionRange;
    ctx.part6PassageId = ctx.currentPassageId;
    ctx.part6QuestionsStarted = false;
  } else if (expectedQuestionRange && /refer to the following/i.test(lineText)) {
    ctx.part6PassageId = ctx.currentPassageId;
    ctx.part6QuestionRange = expectedQuestionRange;
    ctx.part6QuestionsStarted = false;
  }
  const group = {
    id: ctx.currentPassageId,
    sectionId: ctx.sectionId,
    title: sanitizeExamHtml(lineText.slice(0, 160)),
    instructions: '',
    expectedQuestionRange,
    sourcePages: [],
    documents: [],
    bodyText: '',
    requiresContext: /refer to the following/i.test(lineText),
    contextConfirmed: false,
    unsupportedTaskType: null,
    unsupportedReason: null,
    sourcePage: page.pageNumber,
    bbox: lineParts[0]?.bbox || null,
  };
  initializeGroupDocumentsFromHeader(group, page.pageNumber);
  const unsupported = ctx.pendingUnsupported || detectUnsupportedReadingTask(lineText);
  if (unsupported) {
    group.unsupportedTaskType = unsupported.type;
    group.unsupportedReason = unsupported.reason;
  }
  ctx.pendingUnsupported = null;
  if (passageHeaderMarksUnsupportedTask(lineText)) {
    group.unsupportedTaskType = group.unsupportedTaskType || 'free-text';
    group.unsupportedReason = group.unsupportedReason
      || 'Dạng bài điền từ/tự luận/ghi chép — không tạo câu trắc nghiệm tự động.';
    ctx.unsupportedBlockActive = true;
    if (Array.isArray(ctx.unsupportedBlockPages) && !ctx.unsupportedBlockPages.includes(page.pageNumber)) {
      ctx.unsupportedBlockPages.push(page.pageNumber);
    }
  }
  passages.push(group);
  return group;
}

function lineStartsQuestionCandidate(lineText, ctx, lineParts, geo, page) {
  if (ctx.inListeningSection) return false;
  if (ctx.inTheoryBlock) return false;
  if (ctx.unsupportedBlockActive) return false;
  if (ctx.activeExerciseKey) {
    if (parseNumberedInlineMcqFromLine(lineText) || NUMBERED_UNDOTTED_INLINE_MCQ_ROW.test(lineText)) {
      return lineNearQuestionColumn(lineStartX(lineParts), geo);
    }
    const exQm = lineText.match(QUESTION_START);
    if (exQm && !isInstructionOrdinalLine(lineText)) {
      return lineNearQuestionColumn(lineStartX(lineParts), geo);
    }
  }
  if (isInstructionOrdinalLine(lineText)) return false;
  if (QUESTION_INLINE_OPTION.test(lineText)) {
    const num = lineText.match(QUESTION_INLINE_OPTION)[1];
    return questionAllowedByRange(num, ctx)
      && lineNearQuestionColumn(lineStartX(lineParts), geo);
  }
  const qw = lineText.match(QUESTION_WORD_PREFIX);
  if (qw) {
    if (!questionAllowedByRange(qw[1], ctx)) return false;
    if (!lineNearQuestionColumn(lineStartX(lineParts), geo)) return false;
    if (qw[2]?.trim()) return true;
    return !!page && lineHasQuestionOptionGeometry(lineParts, page, geo);
  }
  const qm = lineText.match(QUESTION_START);
  if (qm && !questionAllowedByRange(qm[1], ctx)) return false;
  if (qm) {
    if (!lineNearQuestionColumn(lineStartX(lineParts), geo)) return false;
    if (qm[2] && qm[2].trim().length >= 2) return true;
    if (QUESTION_INLINE_OPTION.test(lineText)) return true;
    if (/^\d{1,3}\.\s*$/.test(lineText.trim())) return true;
    return true;
  }
  if (QUESTION_NUM_ONLY.test(lineText)) {
    const num = lineText.match(QUESTION_NUM_ONLY)[1];
    return questionAllowedByRange(num, ctx)
      && lineNearQuestionColumn(lineStartX(lineParts), geo);
  }
  if (ctx.currentQuestionRange && QUESTION_BARE_NUM.test(lineText)) {
    const num = lineText.match(QUESTION_BARE_NUM)[1];
    if (!questionAllowedByRange(num, ctx)) return false;
    return lineNearQuestionColumn(lineStartX(lineParts), geo);
  }
  if (QUESTION_BARE_NUM.test(lineText)) {
    return false;
  }
  if (ctx.currentQuestionRange && QUESTION_BARE_LETTER.test(lineText)) {
    if (!lineNearQuestionColumn(lineStartX(lineParts), geo)) return false;
    return true;
  }
  return false;
}

function lineIsGridOptionMarkerRow(lineText, lineParts) {
  const parts = lineParts.map((p) => p.text.trim()).filter(Boolean);
  if (parts.length >= 2 && parts.every((p) => /^[A-D]$/i.test(p))) return true;
  return /^(?:[A-D]\s+){2,4}$/i.test(lineText.trim());
}

function clusterItemsByY(items, yTol = 8) {
  const sorted = [...items].sort((a, b) => b.bbox.y - a.bbox.y);
  const rows = [];
  for (const it of sorted) {
    const cy = it.bbox.y + (it.bbox.h || 12) / 2;
    let row = rows.find((r) => Math.abs(r.y - cy) <= yTol);
    if (!row) {
      row = { y: cy, items: [] };
      rows.push(row);
    }
    row.items.push(it);
  }
  return rows.sort((a, b) => b.y - a.y);
}

function trimStemAfterGridAbsorption(question) {
  if (!question?.stemText) return;
  const qm = question.stemText.match(/^(.+?\?)/);
  if (qm) {
    question.stemText = qm[1].trim();
    return;
  }
  const cut = question.stemText.search(/\s[A-D]\s+[A-D]\s+/);
  if (cut > 12) question.stemText = question.stemText.slice(0, cut).trim();
}

function recoverBoxedGridOptions(question, page) {
  if (!question || !page?.items?.length || !question.bbox) return;
  const filled = question.options.filter((o) => o.text.trim()).length;
  if (filled >= 2) return;

  const pageWidth = page.pageWidth || DEFAULT_PAGE_WIDTH;
  const splitMid = pageWidth * 0.52;
  const qTopY = question.bbox.y;
  const markers = page.items.filter(
    (it) => /^[A-D]$/i.test(String(it.text || '').trim()) && it.bbox.y < qTopY - 6,
  );
  if (markers.length < 4) return;

  const rows = clusterItemsByY(markers, 10);
  if (rows.length < 2) return;
  const topRow = rows[0].items.sort((a, b) => a.bbox.x - b.bbox.x);
  const bottomRow = rows[rows.length - 1].items.sort((a, b) => a.bbox.x - b.bbox.x);
  if (topRow.length < 2 || bottomRow.length < 2) return;

  const letterMarkers = {
    A: topRow[0],
    B: topRow[topRow.length - 1],
    C: bottomRow[0],
    D: bottomRow[bottomRow.length - 1],
  };

  const rowBounds = (marker, nextMarkerY) => ({
    colMin: marker.bbox.x < splitMid ? marker.bbox.x + 18 : marker.bbox.x + 18,
    colMax: marker.bbox.x < splitMid ? splitMid - 12 : pageWidth - 24,
    topY: marker.bbox.y + 8,
    bottomY: nextMarkerY != null ? nextMarkerY + 6 : 36,
  });

  const bottomAnchorY = bottomRow[0].bbox.y;
  for (const [letter, marker] of Object.entries(letterMarkers)) {
    if (!marker) continue;
    const nextY = letter === 'A' || letter === 'B' ? bottomAnchorY : null;
    const { colMin, colMax, topY, bottomY } = rowBounds(marker, nextY);
    const chunks = page.items
      .filter((it) => {
        const t = String(it.text || '').trim();
        if (!t || /^[A-D]$/i.test(t)) return false;
        if (/^\d{1,3}$/.test(t)) return false;
        const cx = it.bbox.x;
        if (cx < colMin || cx > colMax) return false;
        const cy = it.bbox.y + (it.bbox.h || 12) / 2;
        if (cy > topY) return false;
        if (cy < bottomY) return false;
        return true;
      })
      .sort((a, b) => b.bbox.y - a.bbox.y || a.bbox.x - b.bbox.x)
      .map((it) => it.text.trim());
    const text = stripPdfRunningNoise(chunks.join(' '));
    if (text) addOption(question, letter, text);
  }
  trimStemAfterGridAbsorption(question);
}

function finishActiveQuestion(ctx, page) {
  if (!ctx.lastQuestion || !page) return;
  recoverBoxedGridOptions(ctx.lastQuestion, page);
}

function dropOutOfRangeOrphanQuestions(questions, passages) {
  if (!passages.length) return questions;
  return questions.filter((q) => {
    if (!q.passageId) return true;
    const g = passages.find((x) => x.id === q.passageId);
    if (!g?.expectedQuestionRange) return true;
    const v = parseDisplayQuestionNumber(q.displayNumber);
    if (!Number.isFinite(v)) return true;
    if (isWithinDeclaredRange(String(v), g.expectedQuestionRange)) return true;
    const opts = q.options?.filter((o) => o.text?.trim()).length || 0;
    const stem = String(q.stemText || '').trim();
    if (opts >= 2 && stem) return true;
    if (g.observedQuestionNumbers?.includes(v)) return true;
    return false;
  });
}

function isGrammarTheoryPseudoQuestion(q) {
  const stem = String(q.stemText || '');
  if (SCHOOL_GRAMMAR_HEADING.test(stem)) return true;
  if (/^\d{1,2}\.\s+HAVE\b/i.test(stem) && /\+/.test(stem)) return true;
  if (/\(\s*PAGE\s*\d+\s*\)/i.test(stem) && stem.length > 80) return true;
  if (stem.length < 400 && !/\b(?:Cách dùng|Quy tắc|Ví dụ|Eg\s*\d|Grammar\s*-)\b/i.test(stem)) {
    return false;
  }
  if (/\b(?:Cách dùng|Quy tắc|Verbs of liking|possessive pronoun|PAST CONTINUOUS|WHERE,\s*WHEN|WHO,\s*THAT|HAVE\s+NEVER|HAVE\s*\+\s*EVER)\b/i.test(stem)) {
    return true;
  }
  const filled = q.options.filter((o) => o.text.trim()).length;
  if (stem.length > 520 && filled <= 3) return true;
  return false;
}

function rejectGrammarTheoryQuestions(questions, warnings) {
  const kept = [];
  for (const q of questions) {
    if (isGrammarTheoryPseudoQuestion(q)) {
      warnings.push(
        `Trang ${q.sourcePage}: bỏ qua nội dung lý thuyết/ngữ pháp — không phải câu trắc nghiệm.`,
      );
      continue;
    }
    kept.push(q);
  }
  return kept;
}

function isUnsupportedPassageMcq(q, passages) {
  if (!q.passageId) return false;
  const g = passages.find((x) => x.id === q.passageId);
  if (!g) return false;
  if (g.unsupportedTaskType) return true;
  if (passageHeaderMarksUnsupportedTask(g.title)) return true;
  const optFilled = q.options.filter((o) => o.text.trim()).length;
  const stem = String(q.stemText || '');
  if (optFilled < 2 && /_{3,}/.test(stem)) return true;
  if (optFilled < 2 && /NO MORE THAN/i.test(`${g.title} ${stem}`)) return true;
  return false;
}

function rejectUnsupportedPassageQuestions(questions, passages, warnings) {
  const kept = [];
  for (const q of questions) {
    if (isUnsupportedPassageMcq(q, passages)) {
      warnings.push(
        `Câu ${q.displayNumber}: bỏ qua — dạng bài chưa hỗ trợ (điền từ/đúng-sai/ghi chép), không tạo trắc nghiệm giả.`,
      );
      continue;
    }
    kept.push(q);
  }
  return kept;
}

function rejectUnsupportedExerciseQuestions(questions, unsupportedExerciseKeys, warnings) {
  if (!unsupportedExerciseKeys?.size) return questions;
  return questions.filter((q) => {
    const m = String(q.displayNumber || '').match(/^(ex\d+)-/i);
    if (m && unsupportedExerciseKeys.has(m[1].toLowerCase())) {
      warnings.push(
        `Câu ${q.displayNumber}: bỏ qua — dạng bài tự luận/sửa lỗi chưa hỗ trợ nhập tự động.`,
      );
      return false;
    }
    return true;
  });
}

function rejectEmptyPlaceholderMcqs(questions, warnings) {
  const kept = [];
  for (const q of questions) {
    const opts = q.options.filter((o) => o.text.trim()).length;
    const stem = String(q.stemText || '').trim();
    if (!stem && opts === 0) {
      continue;
    }
    if (!stem && opts > 0) {
      warnings.push(
        `Câu ${q.displayNumber}: bỏ qua — thiếu đề câu hỏi (cần đoạn văn điền từ hoặc kiểm tra PDF).`,
      );
      continue;
    }
    if (stem && opts === 0 && !q.incomplete) {
      warnings.push(`Câu ${q.displayNumber}: thiếu lựa chọn — cần kiểm tra.`);
    }
    kept.push(q);
  }
  return kept;
}

function exerciseAllowsSharedInstructionStem(instruction) {
  const t = String(instruction || '');
  return /\b(?:stress|pronunciation|underlined part|differs from the other three)\b/i.test(t)
    || /\bChoose the word\b.*\b(?:stress|underlined|pronunciation)\b/i.test(t)
    || SAMPLE_EXAM_TASK_INSTRUCTION.test(t);
}

const SCHOOL_VISUAL_CONTEXT_TASK_CUE = /\bLook at the (?:sign|picture|photo|chart|graph|diagram|cartoon|poster)\b/i;
const SCHOOL_VISUAL_REFERENT_IN_STEM = /\b(?:in\s+(?:the|his|her|this)|from\s+the|following|above|below)\s+(?:message|e-mail|email|letter|notice|sign|picture|photo|chart|graph|diagram|cartoon|advertisement|poster)\b/i;

function schoolExerciseExpectsUnderlinedPart(instruction) {
  return /\bunderlined part\b/i.test(String(instruction || ''))
    || /\bword whose underlined\b/i.test(String(instruction || ''));
}

function schoolQuestionNeedsReadableVisualContext(stem, exerciseInstruction) {
  const stemText = String(stem || '');
  const instr = String(exerciseInstruction || '');
  if (SCHOOL_VISUAL_CONTEXT_TASK_CUE.test(instr)) return true;
  if (/\bRead the following\s+(?:message|letter|e-mail|email|notice|sign)\b/i.test(instr)) return true;
  if (SCHOOL_VISUAL_REFERENT_IN_STEM.test(stemText)) return true;
  return false;
}

function schoolPassageReadableBody(passage) {
  if (!passage) return false;
  const docs = passage.documents || [];
  if (docs.length) {
    const body = docs.map((d) => String(d.bodyText || '').trim()).filter(Boolean).join('\n');
    return body.length >= 48;
  }
  return String(passage.bodyText || '').trim().length >= 48;
}

function rejectSchoolVisualContextQuestions(questions, passages, exerciseInstructions, warnings) {
  const passageById = new Map(passages.map((p) => [p.id, p]));
  return questions.filter((q) => {
    const scopeKey = deriveStrictExerciseScopeKey(q.displayNumber);
    const instr = scopeKey && exerciseInstructions?.has(scopeKey)
      ? exerciseInstructions.get(scopeKey)
      : '';
    if (!schoolQuestionNeedsReadableVisualContext(q.stemText, instr)) return true;
    const group = (q.passageId || q.groupId) ? passageById.get(q.passageId || q.groupId) : null;
    if (schoolPassageReadableBody(group)) return true;
    const page = q.sourcePage ?? '?';
    warnings.push(
      `Trang ${page}: Câu ${q.displayNumber}: bỏ qua — thiếu ngữ cảnh hình/ảnh đọc được (tin nhắn, biển báo, đồ thị…) — giáo viên cần bổ sung thủ công.`,
    );
    return false;
  });
}

function flagSchoolPhoneticUnderlineReview(questions, exerciseInstructions, warnings) {
  if (!exerciseInstructions?.size) return questions;
  for (const q of questions) {
    const scopeKey = deriveStrictExerciseScopeKey(q.displayNumber);
    if (!scopeKey || !exerciseInstructions.has(scopeKey)) continue;
    const instr = exerciseInstructions.get(scopeKey);
    if (!schoolExerciseExpectsUnderlinedPart(instr)) continue;
    if (q.options.filter((o) => String(o.text || '').trim()).length < 2) continue;
    q.sourceReview = { needsTeacherCheck: true, kind: 'phonetic-underline' };
    warnings.push(
      `Câu ${q.displayNumber}: phần gạch chân trong PDF không được giữ khi nhập — cần đối chiếu PDF và sửa nếu cần.`,
    );
  }
  return questions;
}

function resolveExerciseInstructionForQuestion(q, ctxExerciseStems) {
  if (q.exerciseInstructionSnapshot) {
    return q.exerciseInstructionSnapshot;
  }
  const key = q.exerciseScopeKey || deriveStrictExerciseScopeKey(q.displayNumber);
  if (!key || !ctxExerciseStems?.has(key)) return null;
  return ctxExerciseStems.get(key);
}

function applyExerciseInstructionStems(questions, ctxExerciseStems) {
  if (!ctxExerciseStems?.size) return questions;
  for (const q of questions) {
    if (String(q.stemText || '').trim()) continue;
    const instr = resolveExerciseInstructionForQuestion(q, ctxExerciseStems);
    if (!instr) continue;
    const hasOpts = q.options.some((o) => o.text.trim());
    if (hasOpts && !exerciseAllowsSharedInstructionStem(instr)) continue;
    q.stemText = sanitizeExamHtml(instr);
  }
  return questions;
}

function trimEmbeddedTaskBlockPollution(text) {
  const raw = String(text || '');
  const idx = raw.search(WRAPPED_TASK_BLOCK_BOUNDARY);
  if (idx <= 8) return sanitizeExamHtml(raw);
  return sanitizeExamHtml(raw.slice(0, idx).trim());
}

function sanitizeQuestionOptionPollution(question) {
  if (!question?.options?.length) return;
  for (const opt of question.options) {
    if (!opt.text) continue;
    opt.text = trimEmbeddedTaskBlockPollution(opt.text);
  }
}

function shouldTreatDottedLineAsProse(lineText, lineParts, page, geo, ctx, pendingContext) {
  const qm = lineText.match(QUESTION_START);
  if (!qm) return false;
  if (ctx.activeExerciseKey) return false;
  if (ctx.currentQuestionRange && isWithinDeclaredRange(qm[1], ctx.currentQuestionRange)) {
    return false;
  }
  if (ctx.currentQuestionRange && !isWithinDeclaredRange(qm[1], ctx.currentQuestionRange)) {
    return true;
  }
  if (pendingContext?.length) {
    return !lineHasQuestionOptionGeometry(lineParts, page, geo);
  }
  return false;
}

function isListeningInstructionPseudoQuestion(q) {
  const stem = String(q.stemText || '');
  const n = parseInt(q.displayNumber, 10);
  if (!Number.isFinite(n) || n > 31) return false;
  if (/PART\s+[1-4]\b/i.test(stem)) return true;
  if (/spoken only one time/i.test(stem)) return true;
  if (/not be printed in your test book/i.test(stem)) return true;
  if (/Select the best response to the question/i.test(stem) && /PART/i.test(stem)) return true;
  if (/Mark your answer on your answer sheet/i.test(stem)) return true;
  if (/^PART\s+[1-4]\b/i.test(stem.trim())) return true;
  return false;
}

function filterListeningPseudoQuestions(questions, warnings) {
  const kept = [];
  for (const q of questions) {
    if (isListeningInstructionPseudoQuestion(q)) {
      warnings.push(
        `Câu ${q.displayNumber}: bỏ qua — trông giống hướng dẫn phần nghe, không phải câu Reading.`,
      );
      continue;
    }
    kept.push(q);
  }
  return kept;
}

function dedupeAndRejectFakeQuestions(questions) {
  const dropIds = new Set();
  for (let i = 0; i < questions.length; i += 1) {
    for (let j = i + 1; j < questions.length; j += 1) {
      const a = questions[i];
      const b = questions[j];
      if (a.displayNumber !== b.displayNumber) continue;
      if (a.sectionId !== b.sectionId) continue;
      const groupA = a.groupId || a.passageId || '';
      const groupB = b.groupId || b.passageId || '';
      if (groupA !== groupB) continue;
      const aOpts = a.options.filter((o) => o.text.trim()).length;
      const bOpts = b.options.filter((o) => o.text.trim()).length;
      if (aOpts === 0 && bOpts > 0) dropIds.add(a.id);
      else if (bOpts === 0 && aOpts > 0) dropIds.add(b.id);
    }
  }
  return questions.filter((q) => !dropIds.has(q.id));
}

function continueActiveQuestion(lineText, ctx, lineParts, geo, page, fence) {
  if (!ctx.lastQuestion || ctx.pendingDisplayNumber) return false;
  if (fence && isLineInBackmatterFence(lineParts, geo, fence)) return false;
  if (lineCarriesBackmatterPoison(lineText)) return false;
  const sameCol = lineMatchesQuestionColumn(lineParts, ctx.lastQuestion, geo);

  if (sameCol && parseOptionsFromLine(lineText, ctx.lastQuestion)) return true;

  const bareOpt = lineText.match(/^([A-F])\s+(\S.+)$/i);
  if (bareOpt && sameCol && ctx.lastQuestion.options.length < 6) {
    addOption(ctx.lastQuestion, bareOpt[1], bareOpt[2]);
    return true;
  }

  if (!ctx.lastQuestion.options.length) {
    if (lineIsGridOptionMarkerRow(lineText, lineParts)) return true;
    if (lineIsGridOptionBodyRow(lineParts, page?.pageWidth)) return true;
  }

  if (
    QUESTION_BARE_NUM.test(lineText)
    && ctx.currentQuestionRange
    && lineMatchesQuestionColumn(lineParts, ctx.lastQuestion, geo)
  ) {
    const bareNum = lineText.match(QUESTION_BARE_NUM)[1];
    if (
      !isWithinDeclaredRange(bareNum, ctx.currentQuestionRange)
      && isWithinDeclaredRange(ctx.lastQuestion.displayNumber, ctx.currentQuestionRange)
    ) {
      const stemDone = /[?？]\s*$/.test(String(ctx.lastQuestion.stemText || '').trim());
      if (!ctx.lastQuestion.options.length || !stemDone) {
        appendStem(ctx.lastQuestion, lineText);
        splitEmbeddedOptionsFromStem(ctx.lastQuestion);
        return true;
      }
    }
  }

  if (
    !ctx.lastQuestion.options.length
    && !OPTION_LINE_START.test(lineText)
    && !QUESTION_START.test(lineText)
    && !PASSAGE_HEADER.test(lineText)
    && !lineStartsQuestionCandidate(lineText, ctx, lineParts, geo, page)
    && lineMatchesQuestionColumn(lineParts, ctx.lastQuestion, geo)
  ) {
    appendStem(ctx.lastQuestion, lineText);
    splitEmbeddedOptionsFromStem(ctx.lastQuestion);
    return true;
  }

  if (ctx.lastQuestion.options.length) {
    const lastOpt = ctx.lastQuestion.options[ctx.lastQuestion.options.length - 1];
    if (
      lastOpt
      && !OPTION_LINE_START.test(lineText)
      && !QUESTION_START.test(lineText)
      && !lineStartsQuestionCandidate(lineText, ctx, lineParts, geo, page)
      && lineMatchesQuestionColumn(lineParts, ctx.lastQuestion, geo)
    ) {
      const extra = sanitizeExamHtml(lineText);
      if (extra) lastOpt.text = `${lastOpt.text} ${extra}`.trim();
      return true;
    }
  }
  return false;
}

function continueSchoolActiveQuestion(lineText, ctx, lineParts, geo, page, fence) {
  if (!ctx.lastQuestion || ctx.pendingDisplayNumber) return false;
  if (fence && isLineInBackmatterFence(lineParts, geo, fence)) return false;

  if (lineBeginsNewScopedExerciseQuestion(lineText, ctx, lineParts, geo, page)) {
    return false;
  }

  const sameCol = lineMatchesQuestionColumn(lineParts, ctx.lastQuestion, geo);

  if (
    isLowercaseSentenceOrderingLine(lineText)
    && lineMatchesQuestionColumn(lineParts, ctx.lastQuestion, geo)
  ) {
    appendStem(ctx.lastQuestion, lineText);
    return true;
  }

  if (sameCol && parseOptionsFromLine(lineText, ctx.lastQuestion)) {
    if (ctx.pageSawTestEndThisPage) ctx.questionsStartedAfterPageTestEnd = true;
    return true;
  }

  if (lineCarriesBackmatterPoison(lineText) && !lineHasValidQuestionOrOptionAnchor(lineText)) {
    return false;
  }

  const bareOpt = lineText.match(/^([A-F])\s+(\S.+)$/i);
  if (bareOpt && sameCol && ctx.lastQuestion.options.length < 6) {
    addOption(ctx.lastQuestion, bareOpt[1], bareOpt[2]);
    return true;
  }

  if (!ctx.lastQuestion.options.length) {
    if (lineIsGridOptionMarkerRow(lineText, lineParts)) return true;
    if (lineIsGridOptionBodyRow(lineParts, page?.pageWidth)) return true;
  }

  if (
    QUESTION_BARE_NUM.test(lineText)
    && ctx.currentQuestionRange
    && lineMatchesQuestionColumn(lineParts, ctx.lastQuestion, geo)
  ) {
    const bareNum = lineText.match(QUESTION_BARE_NUM)[1];
    if (
      !isWithinDeclaredRange(bareNum, ctx.currentQuestionRange)
      && isWithinDeclaredRange(ctx.lastQuestion.displayNumber, ctx.currentQuestionRange)
    ) {
      const stemDone = /[?？]\s*$/.test(String(ctx.lastQuestion.stemText || '').trim());
      if (!ctx.lastQuestion.options.length || !stemDone) {
        appendStem(ctx.lastQuestion, lineText);
        splitEmbeddedOptionsFromStem(ctx.lastQuestion);
        return true;
      }
    }
  }

  if (
    lineIsStemContinuationFragment(lineText)
    && lineMatchesQuestionColumn(lineParts, ctx.lastQuestion, geo)
    && !lineStartsQuestionCandidate(lineText, ctx, lineParts, geo, page)
  ) {
    appendStem(ctx.lastQuestion, lineText);
    splitEmbeddedOptionsFromStem(ctx.lastQuestion);
    return true;
  }

  if (
    !ctx.lastQuestion.options.length
    && !OPTION_LINE_START.test(lineText)
    && !QUESTION_START.test(lineText)
    && !PASSAGE_HEADER.test(lineText)
    && !lineStartsQuestionCandidate(lineText, ctx, lineParts, geo, page)
    && lineMatchesQuestionColumn(lineParts, ctx.lastQuestion, geo)
  ) {
    appendStem(ctx.lastQuestion, lineText);
    splitEmbeddedOptionsFromStem(ctx.lastQuestion);
    return true;
  }

  if (ctx.lastQuestion.options.length) {
    const lastOpt = ctx.lastQuestion.options[ctx.lastQuestion.options.length - 1];
    if (/^Question\s+\d{1,3}\./i.test(lineText) || SCHOOL_OPTION_CONTINUATION_BOUNDARY.test(lineText)) {
      const tail = splitSchoolFooterFromOptionTail(lastOpt.text);
      if (tail !== lastOpt.text) lastOpt.text = tail;
      return false;
    }
    if (
      lastOpt
      && !OPTION_LINE_START.test(lineText)
      && !QUESTION_START.test(lineText)
      && !QUESTION_NUM_ONLY.test(lineText)
      && !SCHOOL_EXAM_SECTION.test(lineText)
      && !QUESTIONS_RANGE.test(lineText)
      && !lineBeginsNextQuestionInRange(lineText, ctx)
      && !lineCarriesBackmatterPoison(lineText)
      && !WRAPPED_TASK_BLOCK_BOUNDARY.test(lineText)
      && !SCHOOL_OPTION_CONTINUATION_BOUNDARY.test(lineText)
      && !SCHOOL_UNSUPPORTED_SECTION_LINE.test(lineText)
      && !lineStartsQuestionCandidate(lineText, ctx, lineParts, geo, page)
      && lineMatchesQuestionColumn(lineParts, ctx.lastQuestion, geo)
    ) {
      const extra = splitSchoolFooterFromOptionTail(lineText);
      if (extra) lastOpt.text = splitSchoolFooterFromOptionTail(`${lastOpt.text} ${extra}`);
      return true;
    }
  }
  return false;
}

function lineIsGridOptionBodyRow(lineParts, pageWidth = DEFAULT_PAGE_WIDTH) {
  if (!lineParts || lineParts.length < 2) return false;
  const xs = lineParts.map((p) => p.bbox?.x ?? 0);
  if (Math.max(...xs) - Math.min(...xs) < pageWidth * 0.28) return false;
  return !lineParts.some((p) => /^\d{1,3}$/.test(String(p.text || '').trim()));
}

function shouldBufferAsPendingContext(ctx, lineText, lineParts, geo, page) {
  if (ctx.currentPassageId) return false;
  if (ctx.lastQuestion) return false;
  if (ctx.pendingDisplayNumber) return false;
  if (OPTION_LINE_START.test(lineText)) return false;
  if (lineStartsQuestionCandidate(lineText, ctx, lineParts, geo, page)) return false;
  return true;
}

function bindQuestionsToReadingGroups(passages, questions) {
  for (const g of passages) {
    const range = g.expectedQuestionRange;
    if (!range) continue;
    for (const q of questions) {
      if (q.passageId || q.groupId) continue;
      if (displayNumberHasExerciseScope(q.displayNumber)) continue;
      if (q.sectionId && g.sectionId && q.sectionId !== g.sectionId) continue;
      const v = parseInt(q.displayNumber, 10);
      if (!Number.isFinite(v)) continue;
      if (v >= range.min && v <= range.max) {
        q.passageId = g.id;
        q.groupId = g.id;
      }
    }
  }
}

function finalizeReadingGroups(passages, questions, warnings) {
  for (const g of passages) {
    if (!g.documents?.length && g.bodyText?.trim()) {
      g.documents = [{
        id: `${g.id}_doc_0`,
        title: '',
        type: inferDocumentType(g.title),
        bodyText: g.bodyText,
        sourcePages: g.sourcePages?.length ? g.sourcePages : (g.sourcePage ? [g.sourcePage] : []),
        order: 0,
        requiresReview: false,
      }];
    }
    if (g.documents?.length >= 2) {
      for (const d of g.documents) {
        if (!String(d.bodyText || '').trim()) d.requiresReview = true;
      }
    }
    if (g.requiresContext && /refer to the following/i.test(g.title)) {
      const docs = g.documents || [];
      const short = docs.every((d) => String(d.bodyText || '').trim().length < 48);
      if (short && docs.length) {
        for (const d of docs) d.requiresReview = true;
        warnings.push(
          `Đoạn đọc (trang ${g.sourcePage}): có thể thiếu nội dung — đồ họa hoặc bố cục chưa trích được đủ.`,
        );
      }
    }
  }
  bindQuestionsToReadingGroups(passages, questions);
}

function isGapMarkerInPassageLine(lineText, ctx, lineParts, geo) {
  if (!ctx.inPart6Passage && !ctx.part6QuestionRange) return false;
  const inPart6 = ctx.inPart6Passage || ctx.part6PassageId;
  if (!inPart6) return false;
  if (ctx.part6QuestionsStarted) return false;
  const x = lineStartX(lineParts);
  const tol = geo?.marginTol ?? DEFAULT_MARGIN_TOL;
  const nearQuestionMargin = nearColumnAnchor(x, geo?.leftAnchorX, tol)
    || nearColumnAnchor(x, geo?.rightAnchorX, tol);
  if (nearQuestionMargin && QUESTION_INLINE_OPTION.test(lineText)) return false;
  if (nearQuestionMargin && /^\d{1,3}\.\s*\([A-F]\)/i.test(lineText)) return false;
  if (QUESTION_INLINE_OPTION.test(lineText)) return false;
  if (QUESTION_START.test(lineText) && !/\([A-F]\)/i.test(lineText)) {
    const m = lineText.match(QUESTION_START);
    if (m && m[2].length < 3) return true;
  }
  if (nearQuestionMargin) return false;
  if (/^\d{1,3}\.\s*$/.test(lineText.trim())) return true;
  if (/\b\d{1,3}\.\s*$/.test(lineText) && !OPTION_LINE_START.test(lineText)) return true;
  const numMatch = lineText.match(/^(\d{1,3})\./);
  if (numMatch && ctx.part6QuestionRange) {
    const v = parseInt(numMatch[1], 10);
    if (v >= ctx.part6QuestionRange.min && v <= ctx.part6QuestionRange.max) return true;
  }
  return false;
}

export function isSchoolStructuredExamDocument(pages) {
  const all = (pages || []).map(pagePlainTextForSchoolDetect).join('\n');
  if (!all.trim()) return false;
  if (/Test of English for International Communication/i.test(all)) return false;
  if (/TOEIC Sample Form/i.test(all)) return false;
  if (/Sample Form Correct Answers/i.test(all) && /\bItem Number\b/i.test(all)) return false;
  if (/^PART\s+[1-7]\b/im.test(all) && /LISTENING TEST\b/i.test(all) && /READING TEST\b/i.test(all)) {
    return false;
  }
  if (/(?:^|\n)PART\s+[567]\b/m.test(all) && /(?:^|\n)READING TEST\b/m.test(all) && !/\bMIDTERM\b/i.test(all)) {
    return false;
  }
  return (
    /\bMIDTERM\s+TEST\b/i.test(all)
    || /\bSAMPLE\s+TEST\b/i.test(all)
    || /^(?:IV\.\s+)?EXERCISES\b/im.test(all)
    || /^Ex(?:ercise)?\s*\d+[.:]/im.test(all)
    || /^(?:I{1,3}|IV)\.\s+(?:VOCABULARY|GRAMMAR|PHONETICS)\b/im.test(all)
    || /^II\.\s+GRAMMAR\b/im.test(all)
    || /Grammar\s*-\s*Ng/i.test(all)
    || /^PB\s+\d/i.test(all)
    || /^Revision\b/im.test(all)
  );
}

function schoolPageLinesForParse(page) {
  const pageWidth = page.pageWidth || DEFAULT_PAGE_WIDTH;
  const lines = [...(page.lines || [])];
  const geo = page.columnGeometry || inferColumnGeometryFromLineParts(lines, pageWidth);
  return { geo, lines };
}

function exerciseNeedsSharedPassage(instr) {
  const t = String(instr || '');
  return /Read the passage.*(?:fill in the blanks|choose the correct answer)/i.test(t)
    || /^Put the verbs\b/i.test(t)
    || /Put the verbs.*correct form/i.test(t);
}

function schoolExerciseHeaderMarksUnsupported(instr, lineText) {
  const t = `${instr || ''} ${lineText || ''}`;
  if (/Find a mistake in each sentence/i.test(t)) return true;
  if (/Using the given words to complete/i.test(t)) return true;
  if (/Rewrite the following sentences without changing/i.test(t)) return true;
  if (/Put the sentences in the correct order/i.test(t)) return true;
  return false;
}

function lineEndsSchoolReadingPassage(lineText, ctx) {
  if (!lineText) return false;
  if (SCHOOL_UNSUPPORTED_SECTION_LINE.test(lineText)) return true;
  if (EXERCISE_SUBHEADER.test(lineText) || EXERCISE_BLOCK_HEADER.test(lineText)) return true;
  if (SAMPLE_TEST_SECTION.test(lineText)) return true;
  if (THEORY_OUTLINE_SECTION.test(lineText)) return true;
  if (isUnambiguousSchoolTaskSectionHeader(lineText, ctx)) return true;
  if (FREE_TEXT_TASK_LINE.test(lineText)) return true;
  if (WRAPPED_TASK_BLOCK_BOUNDARY.test(lineText)) return true;
  const range = lineText.match(QUESTIONS_RANGE);
  if (range && (FREE_TEXT_TASK_LINE.test(lineText) || MATCHING_MARK.test(lineText))) return true;
  return false;
}

export function parseSchoolQuestionsFromPages(pages, warnings) {
  if (isB1AchievementMidtermDocument(pages)) {
    return parseB1AchievementMidtermFromPages(pages, warnings);
  }
  const sectionId = newExamSectionId();
  const sections = [{ id: sectionId, title: 'Phần 1', order: 0 }];
  const passages = [];
  const questions = [];
  const pendingContext = [];
  const ctx = {
    sectionId,
    currentPassageId: null,
    currentQuestionRange: null,
    qOrdinal: 0,
    lastQuestion: null,
    inPart6Passage: false,
    part6PassageId: null,
    part6QuestionRange: null,
    pendingDisplayNumber: null,
    part6QuestionsStarted: false,
    pendingUnsupported: null,
    pendingTaskLabel: '',
    inListeningSection: false,
    sawListeningContent: false,
    listeningTestActive: false,
    inSchoolListeningBlock: false,
    inTheoryBlock: false,
    activeExerciseKey: null,
    exerciseInstructions: new Map(),
    clozePassageKeys: new Set(),
    declaredMcqOptionCount: null,
    unsupportedBlockActive: false,
    unsupportedBlockPages: [],
    inBackmatterRegion: false,
    pageSawTestEndThisPage: false,
    questionsStartedAfterPageTestEnd: false,
    schoolOutlineActive: false,
    readPassageCaptureActive: false,
    pendingSchoolReadPassageHeader: '',
    unsupportedExerciseKeys: new Set(),
    schoolReadPassageId: null,
    schoolReadDeclaredRange: null,
    pendingSampleMarkInstruction: '',
    passages,
  };

  for (const page of pages) {
    if (page.isBlankPage) {
      warnings.push(`Trang ${page.pageNumber}: trang trắng (không có nội dung) — bỏ qua khi trích câu hỏi.`);
      continue;
    }
    if (page.needsOcr) {
      warnings.push(
        `Trang ${page.pageNumber}: có hình/ảnh hoặc nội dung không trích được lớp chữ — cần nhận dạng chữ hoặc bổ sung văn bản.`,
      );
      continue;
    }
    if (ctx.inBackmatterRegion && !pageHasReadingQuestionAnchors(page)) {
      continue;
    }
    const { geo, lines: pageQuestionLines } = schoolPageLinesForParse(page);

    if (shouldSkipEntirePageForQuestions(page)) {
      enterBackmatterRegion(ctx, page, pendingContext);
      warnings.push(
        `Trang ${page.pageNumber}: phần đuôi PDF (script/hướng dẫn/đáp án) — bỏ qua khi trích câu hỏi.`,
      );
      continue;
    }

    ctx.pageSawTestEndThisPage = false;
    ctx.questionsStartedAfterPageTestEnd = false;

    const fence = createPageBackmatterFence();

    for (const lineParts of pageQuestionLines) {
      let lineText = normalizeSpacedQuestionAnchors(mergeLineText(lineParts));
      if (!lineText) continue;

      if (SCHOOL_UNSUPPORTED_SECTION_LINE.test(lineText)) {
        finishActiveQuestion(ctx, page);
        ctx.lastQuestion = null;
        ctx.currentPassageId = null;
        ctx.currentQuestionRange = null;
        ctx.readPassageCaptureActive = false;
        ctx.unsupportedBlockActive = true;
        if (!ctx.unsupportedBlockPages.includes(page.pageNumber)) {
          ctx.unsupportedBlockPages.push(page.pageNumber);
        }
        warnings.push(
          `Trang ${page.pageNumber}: phần tự luận/ghi đáp án — đã đọc được chữ nhưng chưa hỗ trợ nhập tự động.`,
        );
        continue;
      }

      if (isAnchoredBackmatterBoundaryLine(lineText)) {
        applyBackmatterFenceCutoff(fence, lineParts, geo, lineText);
        resetQuestionParseContinuation(ctx, page, pendingContext);
        if (TEST_END_DIRECTIVE.test(lineText)) {
          ctx.pageSawTestEndThisPage = true;
        }
        continue;
      }
      if (isLineInBackmatterFence(lineParts, geo, fence)) {
        continue;
      }

      if (ctx.inBackmatterRegion) {
        if (isExplicitRealTestSectionLine(lineText)) {
          exitBackmatterRegion(ctx);
        } else {
          continue;
        }
      }

      const combinedTask = `${ctx.pendingTaskLabel} ${lineText}`.replace(/\s+/g, ' ').trim();
      const instrUnsupported = detectUnsupportedReadingTask(lineText, ctx.pendingTaskLabel);
      if (CHOOSE_TWO_MARK.test(lineText) || TFNG_MARK.test(lineText) || YNNG_MARK.test(lineText)) {
        ctx.pendingTaskLabel = combinedTask.slice(0, 320);
      } else if (ctx.pendingTaskLabel && !TFNG_MARK.test(combinedTask) && !YNNG_MARK.test(combinedTask)) {
        ctx.pendingTaskLabel = '';
      }
      if (instrUnsupported) {
        if (ctx.currentPassageId) {
          const g = passages.find((x) => x.id === ctx.currentPassageId);
          if (g && !g.unsupportedTaskType) {
            g.unsupportedTaskType = instrUnsupported.type;
            g.unsupportedReason = instrUnsupported.reason;
          }
        } else {
          ctx.pendingUnsupported = instrUnsupported;
        }
      }

      if (TOEIC_PART_HEADER.test(lineText)) {
        ctx.pendingUnsupported = null;
        ctx.pendingTaskLabel = '';
        const partNum = parseInt(lineText.match(TOEIC_PART_HEADER)[1], 10);
        if (ctx.listeningTestActive && partNum >= 1 && partNum <= 4) {
          ctx.inListeningSection = true;
          pendingContext.length = 0;
        } else {
          ctx.inListeningSection = false;
        }
        if (partNum >= 5) {
          ctx.sectionId = newExamSectionId();
          sections.push({
            id: ctx.sectionId,
            title: `Part ${partNum}`,
            order: sections.length,
          });
          ctx.currentPassageId = null;
          ctx.currentQuestionRange = null;
          ctx.lastQuestion = null;
          ctx.inListeningSection = false;
        }
        ctx.inPart6Passage = /^PART\s+6\b/i.test(lineText);
        if (/^PART\s+[57]\b/i.test(lineText)) {
          ctx.inPart6Passage = false;
          ctx.part6QuestionsStarted = false;
          ctx.part6QuestionRange = null;
          ctx.part6PassageId = null;
        }
        continue;
      }

      if (LISTENING_TEST_MARK.test(lineText)) {
        ctx.listeningTestActive = true;
        ctx.inListeningSection = true;
        ctx.sawListeningContent = true;
        ctx.pendingTaskLabel = '';
        pendingContext.length = 0;
        continue;
      }

      if (READING_TEST_MARK.test(lineText)) {
        ctx.listeningTestActive = false;
        ctx.inListeningSection = false;
        pendingContext.length = 0;
        ctx.currentPassageId = null;
        ctx.currentQuestionRange = null;
        ctx.pendingUnsupported = null;
        ctx.pendingTaskLabel = '';
        continue;
      }

      if (THEORY_OUTLINE_SECTION.test(lineText) || /^II\.\s+GRAMMAR\b/i.test(lineText)) {
        ctx.schoolOutlineActive = true;
      }
      if (/Grammar\s*-\s*Ng/i.test(lineText)) {
        ctx.schoolOutlineActive = true;
        ctx.inTheoryBlock = true;
        ctx.activeExerciseKey = null;
        continue;
      }
      if (isSchoolTheoryHeadingSkipLine(lineText, ctx)) {
        ctx.inTheoryBlock = true;
        ctx.activeExerciseKey = null;
        continue;
      }
      if (SAMPLE_TEST_SECTION.test(lineText)) {
        finishActiveQuestion(ctx, page);
        ctx.lastQuestion = null;
        ctx.activeExerciseKey = 'sample';
        ctx.inTheoryBlock = false;
        ctx.currentPassageId = null;
        ctx.currentQuestionRange = null;
        ctx.pendingTaskLabel = '';
        ctx.unsupportedBlockActive = false;
        ctx.pendingDisplayNumber = null;
        ctx.exerciseInstructions.delete('ex10');
        pendingContext.length = 0;
        continue;
      }
      if (ctx.activeExerciseKey === 'sample' && SAMPLE_EXAM_TASK_INSTRUCTION.test(lineText)) {
        finishActiveQuestion(ctx, page);
        ctx.lastQuestion = null;
        ctx.currentPassageId = null;
        ctx.currentQuestionRange = null;
        ctx.readPassageCaptureActive = false;
        ctx.schoolReadPassageId = null;
        ctx.pendingSampleMarkInstruction = lineText.trim();
        const prior = ctx.exerciseInstructions.get('sample') || '';
        const merged = `${prior} ${lineText}`.replace(/\s+/g, ' ').trim();
        ctx.exerciseInstructions.set('sample', merged.slice(0, 480));
        continue;
      }
      if (ctx.pendingSampleMarkInstruction) {
        const merged = `${ctx.pendingSampleMarkInstruction} ${lineText}`.replace(/\s+/g, ' ').trim();
        const wrappedClozeRange = merged.match(
          /\bfollowing\s+questions?\s+(\d{1,3})\s+to\s+(\d{1,3})\b/i,
        );
        if (wrappedClozeRange) {
          beginSchoolReadPassageGroup(passages, ctx, page, merged, warnings);
          ctx.pendingSampleMarkInstruction = '';
          ctx.exerciseInstructions.set('sample', merged.slice(0, 480));
          continue;
        }
        const readyForQuestions = QUESTION_START.test(lineText)
          || /^Question\s+\d{1,3}\b/i.test(lineText)
          || (parseNumberedInlineMcqFromLine(lineText) && !/\bfollowing\s+questions?\b/i.test(merged));
        if (readyForQuestions) {
          ctx.exerciseInstructions.set('sample', merged.slice(0, 480));
          ctx.pendingSampleMarkInstruction = '';
        } else {
          ctx.pendingSampleMarkInstruction = merged.slice(0, 480);
          if (/\bpronunciation\b.*\bquestions?\b/i.test(merged) || SAMPLE_EXAM_TASK_INSTRUCTION.test(merged)) {
            ctx.exerciseInstructions.set('sample', merged.slice(0, 480));
          }
          continue;
        }
      }
      if (ctx.activeExerciseKey === 'sample' && /\bpronunciation\b.*\bquestions?\b/i.test(lineText)) {
        const prior = ctx.exerciseInstructions.get('sample') || '';
        const merged = `${prior} ${lineText}`.replace(/\s+/g, ' ').trim();
        ctx.exerciseInstructions.set('sample', merged.slice(0, 480));
        continue;
      }
      if (SCHOOL_STRUCTURAL_READ_LINE.test(lineText)) {
        if (QUESTIONS_RANGE.test(lineText) || /\bfrom\s+\d+\s+to\s+\d+\b/i.test(lineText)) {
          beginSchoolReadPassageGroup(passages, ctx, page, lineText, warnings);
          ctx.pendingSchoolReadPassageHeader = '';
        } else if (!/\bfrom\s+\d+\s+to\s+\d+\b/i.test(lineText) && !QUESTIONS_RANGE.test(lineText)) {
          beginSchoolReadPassageGroup(passages, ctx, page, lineText, warnings);
          ctx.pendingSchoolReadPassageHeader = '';
        } else {
          ctx.pendingSchoolReadPassageHeader = lineText.slice(0, 480);
        }
        continue;
      }
      if (ctx.pendingSchoolReadPassageHeader) {
        const mergedHeader = `${ctx.pendingSchoolReadPassageHeader} ${lineText}`.replace(/\s+/g, ' ').trim();
        if (SCHOOL_STRUCTURAL_READ_LINE.test(mergedHeader)
          && (/\bfrom\s+\d+\s+to\s+\d+\b/i.test(mergedHeader) || QUESTIONS_RANGE.test(mergedHeader))) {
          beginSchoolReadPassageGroup(passages, ctx, page, mergedHeader, warnings);
          ctx.pendingSchoolReadPassageHeader = '';
          continue;
        }
        ctx.pendingSchoolReadPassageHeader = mergedHeader.slice(0, 480);
        if (!SCHOOL_STRUCTURAL_READ_LINE.test(mergedHeader)) {
          ctx.pendingSchoolReadPassageHeader = lineText.slice(0, 480);
        }
        continue;
      }

      if (EXERCISE_BLOCK_HEADER.test(lineText) || EXERCISE_SUBHEADER.test(lineText)) {
        ctx.inTheoryBlock = false;
        const sub = lineText.match(EXERCISE_SUBHEADER);
        if (sub) {
          pendingContext.length = 0;
          ctx.activeExerciseKey = `ex${sub[1]}`;
          finishActiveQuestion(ctx, page);
          ctx.lastQuestion = null;
          ctx.currentQuestionRange = null;
          ctx.readPassageCaptureActive = false;
          ctx.pendingSchoolReadPassageHeader = '';
          const instr = (sub[2] || '').trim();
          if (schoolExerciseHeaderMarksUnsupported(instr, lineText)) {
            ctx.unsupportedExerciseKeys.add(`ex${sub[1]}`);
            ctx.unsupportedBlockActive = true;
            if (!ctx.unsupportedBlockPages.includes(page.pageNumber)) {
              ctx.unsupportedBlockPages.push(page.pageNumber);
            }
            warnings.push(
              `Trang ${page.pageNumber}: bài ex${sub[1]} — sửa lỗi/tự luận; không tạo trắc nghiệm tự động.`,
            );
          } else {
            ctx.unsupportedBlockActive = false;
          }
          if (!ctx.clozePassageKeys.has(`ex${sub[1]}`) && !ctx.unsupportedExerciseKeys.has(`ex${sub[1]}`)) {
            ctx.currentPassageId = null;
          }
          if (instr) {
            ctx.exerciseInstructions.set(ctx.activeExerciseKey, instr);
          }
          const embeddedReadHeader = instr.match(/Read the following[\s\S]+/i);
          if (
            embeddedReadHeader
            && (/\bfrom\s+\d+\s+to\s+\d+\b/i.test(embeddedReadHeader[0])
              || QUESTIONS_RANGE.test(embeddedReadHeader[0]))
          ) {
            beginSchoolReadPassageGroup(passages, ctx, page, embeddedReadHeader[0], warnings);
          }
          if (exerciseNeedsSharedPassage(instr || lineText)) {
            ctx.clozePassageKeys.add(ctx.activeExerciseKey);
          }
          if (ctx.clozePassageKeys.has(ctx.activeExerciseKey) && !ctx.currentPassageId) {
            ensureSchoolExercisePassage(passages, ctx, page, instr || lineText);
          }
          const optN = parseDeclaredMcqOptionCount(instr || lineText);
          ctx.declaredMcqOptionCount = optN;
          if (optN) {
            warnings.push(
              `Trang ${page.pageNumber}: bài ${ctx.activeExerciseKey} — trắc nghiệm ${optN} lựa chọn.`,
            );
          }
        } else if (EXERCISE_BLOCK_HEADER.test(lineText)) {
          finishActiveQuestion(ctx, page);
          ctx.activeExerciseKey = null;
          pendingContext.length = 0;
        }
        const decl = parseDeclaredMcqOptionCount(lineText);
        if (decl) ctx.declaredMcqOptionCount = decl;
        continue;
      }

      if (SCHOOL_LISTENING_BLOCK.test(lineText)) {
        ctx.sawListeningContent = true;
        ctx.inSchoolListeningBlock = true;
        resetSchoolExamBlockContext(ctx, pendingContext, page);
        continue;
      }

      if (isUnambiguousSchoolTaskSectionHeader(lineText, ctx)) {
        ctx.inSchoolListeningBlock = false;
        ctx.inListeningSection = false;
        if (/^(?:[A-Z]\.\s*)?(?:VOCABULARY|READING|GRAMMAR|PHONETICS|WRITING)\b/i.test(lineText)) {
          resetSchoolExamBlockContext(ctx, pendingContext, page);
        }
        continue;
      }

      if (
        ctx.lastQuestion
        && !ctx.pendingDisplayNumber
        && !ctx.inSchoolListeningBlock
        && continueSchoolActiveQuestion(lineText, ctx, lineParts, geo, page, fence)
      ) {
        continue;
      }

      const combinedInstruction = `${ctx.pendingTaskLabel} ${lineText}`.replace(/\s+/g, ' ').trim();
      if (
        QUESTIONS_RANGE.test(lineText)
        && !FREE_TEXT_TASK_LINE.test(lineText)
        && !TFNG_MARK.test(lineText)
        && !MATCHING_MARK.test(lineText)
      ) {
        finishActiveQuestion(ctx, page);
        ctx.lastQuestion = null;
        ctx.pendingTaskLabel = lineText.slice(0, 320);
      }
      if (
        FREE_TEXT_TASK_LINE.test(lineText)
        || FREE_TEXT_TASK_LINE.test(combinedInstruction)
        || passageHeaderMarksUnsupportedTask(lineText)
        || passageHeaderMarksUnsupportedTask(combinedInstruction)
        || (QUESTIONS_RANGE.test(lineText) && (TFNG_MARK.test(combinedInstruction) || MATCHING_MARK.test(combinedInstruction)))
      ) {
        finishActiveQuestion(ctx, page);
        ctx.lastQuestion = null;
        ctx.unsupportedBlockActive = true;
        ctx.readPassageCaptureActive = false;
        ctx.pendingTaskLabel = '';
        if (!ctx.unsupportedBlockPages.includes(page.pageNumber)) {
          ctx.unsupportedBlockPages.push(page.pageNumber);
        }
        warnings.push(
          `Trang ${page.pageNumber}: dạng bài tự luận/điền từ/ghi chép — đã đọc được chữ nhưng chưa hỗ trợ nhập tự động.`,
        );
      }

      const rangeOptDecl = parseDeclaredMcqOptionCount(lineText);
      if (rangeOptDecl) ctx.declaredMcqOptionCount = rangeOptDecl;

      if (isSkipLine(lineText)) continue;

      if (ctx.inListeningSection) continue;

      if (READING_SECTION_RESET.test(lineText)) {
        ctx.listeningTestActive = false;
        ctx.inListeningSection = false;
        pendingContext.length = 0;
        ctx.currentPassageId = null;
        ctx.currentQuestionRange = null;
        ctx.pendingUnsupported = null;
        ctx.pendingTaskLabel = '';
        continue;
      }

      if (
        QUESTIONS_RANGE.test(lineText)
        && ctx.currentPassageId
        && (ctx.readPassageCaptureActive
          || (ctx.activeExerciseKey && ctx.clozePassageKeys.has(ctx.activeExerciseKey)))
        && !FREE_TEXT_TASK_LINE.test(lineText)
      ) {
        const g = passages.find((x) => x.id === ctx.currentPassageId);
        if (g) {
          const range = parseExpectedRangeFromHeader(lineText);
          if (range) {
            g.expectedQuestionRange = range;
            ctx.currentQuestionRange = range;
          }
          finishActiveQuestion(ctx, page);
          ctx.lastQuestion = null;
          ctx.readPassageCaptureActive = false;
          continue;
        }
      }

      if (
        PASSAGE_HEADER.test(lineText)
        || QUESTIONS_RANGE.test(lineText)
        || QUESTIONS_AND_PAIR.test(lineText)
      ) {
        if (ctx.unsupportedBlockActive) {
          continue;
        }
        finishActiveQuestion(ctx, page);
        if (ctx.inSchoolListeningBlock && SCHOOL_LISTENING_BLOCK.test(lineText)) {
          continue;
        }
        if (FREE_TEXT_TASK_LINE.test(lineText)) {
          ctx.unsupportedBlockActive = true;
          ctx.readPassageCaptureActive = false;
          if (!ctx.unsupportedBlockPages.includes(page.pageNumber)) {
            ctx.unsupportedBlockPages.push(page.pageNumber);
          }
          warnings.push(
            `Trang ${page.pageNumber}: dạng bài nghe + điền biểu mẫu/tự luận — cần audio và chưa hỗ trợ nhập tự động.`,
          );
          continue;
        }
        ctx.readPassageCaptureActive = false;
        ctx.schoolReadPassageId = null;
        const group = createReadingGroup(passages, ctx, lineText, page, lineParts);
        if (
          ctx.activeExerciseKey === 'sample'
          && group.expectedQuestionRange
          && !group.unsupportedTaskType
        ) {
          ctx.readPassageCaptureActive = true;
        }
        consumePendingContextIntoGroup(group, pendingContext);
        ctx.lastQuestion = null;
        if (QUESTIONS_RANGE.test(lineText) && /refer to the following|Read the following/i.test(lineText)) {
          const prevPage = page.pageNumber > 1 ? page.pageNumber - 1 : null;
          if (prevPage && !group.sourcePages.includes(prevPage)) {
            group.sourcePages = [...new Set([prevPage, ...(group.sourcePages || [])])];
          }
        }
        if (!group.unsupportedTaskType && !FREE_TEXT_TASK_LINE.test(lineText)) {
          ctx.unsupportedBlockActive = false;
        }
        continue;
      }

      if (
        ctx.activeExerciseKey
        && (ctx.clozePassageKeys.has(ctx.activeExerciseKey)
          || GRADE_CLOZE_PASSAGE_HEAD.test(lineText))
        && !ctx.currentPassageId
        && GRADE_CLOZE_PASSAGE_HEAD.test(lineText)
      ) {
        ctx.clozePassageKeys.add(ctx.activeExerciseKey);
        ensureSchoolExercisePassage(passages, ctx, page, lineText);
      }

      if (tryConsumeSchoolInlineMcqRow(lineText, lineParts, questions, ctx, page, geo, finishActiveQuestion)) {
        ctx.readPassageCaptureActive = false;
        continue;
      }

      if (
        schoolPassageTextCaptureAllowed(ctx)
        && (!ctx.activeExerciseKey || ctx.clozePassageKeys.has(ctx.activeExerciseKey) || ctx.readPassageCaptureActive)
        && !lineHasValidQuestionOrOptionAnchor(lineText)
        && !EXERCISE_SUBHEADER.test(lineText)
        && !SAMPLE_TEST_SECTION.test(lineText)
        && !/^Question\s+\d+/i.test(lineText)
        && !lineEndsSchoolReadingPassage(lineText, ctx)
      ) {
        const g = passages.find((x) => x.id === ctx.currentPassageId);
        if (g) appendDocumentText(g, lineText, page.pageNumber, lineText);
        continue;
      }

      if (schoolPassageTextCaptureAllowed(ctx)) {
        const g = passages.find((x) => x.id === ctx.currentPassageId);
        if (g && maybeStartSubDocument(g, lineText, page.pageNumber)) {
          continue;
        }
      }

      if (isGapMarkerInPassageLine(lineText, ctx, lineParts, geo)) {
        if (schoolPassageTextCaptureAllowed(ctx)) {
          const p = passages.find((x) => x.id === ctx.currentPassageId);
          if (p) appendDocumentText(p, lineText, page.pageNumber, lineText);
        } else if (ctx.part6PassageId) {
          const p = passages.find((x) => x.id === ctx.part6PassageId);
          if (p) appendDocumentText(p, lineText, page.pageNumber, lineText);
        }
        continue;
      }

      if (continueSchoolActiveQuestion(lineText, ctx, lineParts, geo, page, fence)) {
        continue;
      }

      if (shouldBufferAsPendingContext(ctx, lineText, lineParts, geo, page)) {
        pendingContext.push({ text: lineText, page, lineParts });
        continue;
      }

      if (QUESTION_NUM_ONLY.test(lineText)) {
        const numOnly = lineText.match(QUESTION_NUM_ONLY)[1];
        if (!questionAllowedByRange(numOnly, ctx)) {
          if (schoolPassageTextCaptureAllowed(ctx)) {
            const p = passages.find((x) => x.id === ctx.currentPassageId);
            if (p) appendDocumentText(p, lineText, page.pageNumber, lineText);
          } else {
            pendingContext.push({ text: lineText, page, lineParts });
          }
          continue;
        }
        if (ctx.inPart6Passage && ctx.part6PassageId && !ctx.part6QuestionsStarted) {
          const p = passages.find((x) => x.id === ctx.part6PassageId);
          if (p) appendDocumentText(p, lineText, page.pageNumber, lineText);
          continue;
        }
        ctx.pendingDisplayNumber = numOnly;
        continue;
      }

      if (ctx.pendingDisplayNumber) {
        if (OPTION_LINE_START.test(lineText) || QUESTION_INLINE_OPTION.test(lineText)) {
          finishActiveQuestion(ctx, page);
          const q = startQuestion(questions, ctx, ctx.pendingDisplayNumber, '', page, lineParts);
          ctx.pendingDisplayNumber = null;
          parseOptionsFromLine(lineText, q);
          continue;
        }
        finishActiveQuestion(ctx, page);
        startQuestion(questions, ctx, ctx.pendingDisplayNumber, lineText, page, lineParts);
        ctx.pendingDisplayNumber = null;
        continue;
      }

      const questionOneOptionRow = lineText.match(/^Question\s+(\d{1,3})\.\s+((?:[A-F]\.\s*.+)+)$/i);
      if (questionOneOptionRow && ctx.activeExerciseKey && !ctx.inTheoryBlock && !ctx.unsupportedBlockActive) {
        finishActiveQuestion(ctx, page);
        const q = startQuestion(questions, ctx, questionOneOptionRow[1], '', page, lineParts);
        parseInlineLetterDotOptions(questionOneOptionRow[2], q);
        continue;
      }

      const inline = lineText.match(QUESTION_INLINE_OPTION);
      if (inline && !ctx.unsupportedBlockActive && questionAllowedByRange(inline[1], ctx)
        && lineStartsQuestionCandidate(lineText, ctx, lineParts, geo, page)) {
        finishActiveQuestion(ctx, page);
        const remainder = (inline[4] || '').trim();
        if (lineHasMultipleInlineLetterDotOptions(remainder) || lineHasMultipleInlineLetterDotOptions(lineText)) {
          const q = startQuestion(questions, ctx, inline[1], '', page, lineParts);
          if (parseInlineLetterDotOptions(remainder, q)) {
            continue;
          }
        }
        const q = startQuestion(questions, ctx, inline[1], '', page, lineParts);
        addOption(q, inline[2] || inline[3], inline[4] || '');
        continue;
      }

      const bareNum = lineText.match(QUESTION_BARE_NUM);
      if (bareNum && !ctx.unsupportedBlockActive && questionAllowedByRange(bareNum[1], ctx)
        && lineStartsQuestionCandidate(lineText, ctx, lineParts, geo, page)) {
        finishActiveQuestion(ctx, page);
        startQuestion(questions, ctx, bareNum[1], bareNum[2] || '', page, lineParts);
        continue;
      }

      const qWord = lineText.match(QUESTION_WORD_PREFIX);
      if (qWord && !ctx.unsupportedBlockActive && questionAllowedByRange(qWord[1], ctx)
        && lineStartsQuestionCandidate(lineText, ctx, lineParts, geo, page)) {
        finishActiveQuestion(ctx, page);
        startQuestion(questions, ctx, qWord[1], qWord[2] || '', page, lineParts);
        continue;
      }

      const qm = lineText.match(QUESTION_START);
      if (qm && shouldTreatDottedLineAsProse(lineText, lineParts, page, geo, ctx, pendingContext)) {
        if (schoolPassageTextCaptureAllowed(ctx)) {
          const p = passages.find((x) => x.id === ctx.currentPassageId);
          if (p) appendDocumentText(p, lineText, page.pageNumber, lineText);
        } else {
          pendingContext.push({ text: lineText, page, lineParts });
        }
        continue;
      }

      if (qm && !ctx.unsupportedBlockActive && questionAllowedByRange(qm[1], ctx)
        && lineStartsQuestionCandidate(lineText, ctx, lineParts, geo, page)) {
        finishActiveQuestion(ctx, page);
        startQuestion(questions, ctx, qm[1], qm[2] || '', page, lineParts);
        continue;
      }

      if (qm && !questionAllowedByRange(qm[1], ctx)) {
        if (schoolPassageTextCaptureAllowed(ctx)) {
          const p = passages.find((x) => x.id === ctx.currentPassageId);
          if (p) appendDocumentText(p, lineText, page.pageNumber, lineText);
        } else {
          pendingContext.push({ text: lineText, page, lineParts });
        }
        continue;
      }

      if (ctx.inBackmatterRegion) {
        continue;
      }

      if (schoolPassageTextCaptureAllowed(ctx)) {
        const p = passages.find((x) => x.id === ctx.currentPassageId);
        if (p) appendDocumentText(p, lineText, page.pageNumber, lineText);
      } else {
        pendingContext.push({ text: lineText, page, lineParts });
      }
    }
    finishActiveQuestion(ctx, page);
  }

  let finalQuestions = dedupeAndRejectFakeQuestions(questions);
  finalQuestions = filterListeningPseudoQuestions(finalQuestions, warnings);
  finalQuestions = rejectGrammarTheoryQuestions(finalQuestions, warnings);
  finalQuestions = rejectUnsupportedExerciseQuestions(finalQuestions, ctx.unsupportedExerciseKeys, warnings);
  finalQuestions = rejectUnsupportedPassageQuestions(finalQuestions, passages, warnings);
  finalQuestions = dropOutOfRangeOrphanQuestions(finalQuestions, passages);
  applyClozeBlankStemsFromPassage(finalQuestions, passages);
  finalQuestions = applyExerciseInstructionStems(finalQuestions, ctx.exerciseInstructions);
  finalQuestions = rejectEmptyPlaceholderMcqs(finalQuestions, warnings);
  finalQuestions = bindClozeQuestionsToActivePassage(finalQuestions, passages);
  finalQuestions = rejectSchoolVisualContextQuestions(
    finalQuestions,
    passages,
    ctx.exerciseInstructions,
    warnings,
  );
  finalQuestions = flagSchoolPhoneticUnderlineReview(finalQuestions, ctx.exerciseInstructions, warnings);
  finalQuestions = finalQuestions.sort((a, b) => a.order - b.order);

  for (const q of finalQuestions) {
    splitEmbeddedOptionsFromStem(q);
    sanitizeQuestionOptionPollution(q);
    if (!q.options.length && q.stemText) parseInlineLetterDotOptions(q.stemText, q);
    const optCount = q.options.filter((o) => o.text.trim()).length;
    const need = Number.isFinite(q.declaredOptionCount) ? q.declaredOptionCount : null;
    if (optCount < 2) {
      q.incomplete = true;
      warnings.push(`Câu ${q.displayNumber}: thiếu lựa chọn — cần kiểm tra.`);
    } else if (need != null && optCount < need) {
      if (need >= 4) {
        warnings.push(`Câu ${q.displayNumber}: chưa đủ 4 lựa chọn — cần kiểm tra.`);
      } else if (need === 3) {
        warnings.push(`Câu ${q.displayNumber}: chưa đủ 3 lựa chọn — cần kiểm tra.`);
      } else {
        warnings.push(`Câu ${q.displayNumber}: thiếu lựa chọn — cần kiểm tra.`);
      }
    }
    delete q.declaredOptionCount;
    delete q.exerciseScopeKey;
    delete q.exerciseInstructionSnapshot;
    if (!q.stemText || !String(q.stemText).trim()) {
      q.incomplete = true;
      warnings.push(`Câu ${q.displayNumber}: thiếu nội dung câu hỏi — cần kiểm tra.`);
    }
  }

  finalizeReadingGroups(passages, finalQuestions, warnings);
  warnSchoolPassageRangeMismatches(passages, warnings);
  ensureUnsupportedFormatWarnings(passages, finalQuestions, warnings);

  const usedPassageIds = new Set();
  for (const q of finalQuestions) {
    if (q.passageId) usedPassageIds.add(q.passageId);
    if (q.groupId) usedPassageIds.add(q.groupId);
  }
  for (let i = passages.length - 1; i >= 0; i -= 1) {
    if (!usedPassageIds.has(passages[i].id)) {
      passages.splice(i, 1);
    }
  }

  const contaminationMsg = buildContaminationImportWarning({
    questions: finalQuestions,
    passages,
  });
  if (contaminationMsg) warnings.push(contaminationMsg);

  if (ctx.sawListeningContent) {
    warnings.push(
      'PDF có phần nghe (Listening) — bài thi trực tuyến không kèm file audio; phần nghe cần file âm thanh hoặc soạn thủ công.',
    );
  }

  if (ctx.unsupportedBlockPages.length) {
    const pset = [...new Set(ctx.unsupportedBlockPages)].sort((a, b) => a - b);
    warnings.push(
      `Trang ${pset.join(', ')}: có dạng bài chưa hỗ trợ (điền từ/tự luận/ghi chép) — không tạo câu trắc nghiệm giả.`,
    );
  }

  const parsedDigitalPages = pages.filter((p) => !p.isBlankPage && !p.needsOcr).length;
  const ocrPages = pages.filter((p) => p.needsOcr).map((p) => p.pageNumber);
  if (!finalQuestions.length && parsedDigitalPages > 0 && !ocrPages.length) {
    warnings.push(
      'Không phát hiện câu hỏi trắc nghiệm trong phạm vi đã chọn — kiểm tra phạm vi trang hoặc dạng bài chưa hỗ trợ.',
    );
  } else if (!finalQuestions.length && ocrPages.length) {
    warnings.push(
      `Không trích được câu hỏi — trang ${ocrPages.join(', ')} cần nhận dạng chữ (OCR) hoặc soạn thủ công.`,
    );
  } else if (!finalQuestions.length) {
    warnings.push('Không phát hiện câu hỏi — kiểm tra phạm vi trang hoặc bổ sung nội dung.');
  }

  const needsOcrPageNumbers = pages.filter((p) => p.needsOcr).map((p) => p.pageNumber);

  return {
    sections,
    passages,
    questions: finalQuestions,
    needsOcr: needsOcrPageNumbers.length > 0,
    needsOcrPageNumbers,
    needsReview: true,
  };
}

function bindClozeQuestionsToActivePassage(questions, passages) {
  const passageIds = new Set(passages.map((g) => g.id));
  for (const q of questions) {
    if (q.passageId) {
      if (!q.groupId) q.groupId = q.passageId;
      continue;
    }
    if (q.groupId && passageIds.has(q.groupId)) {
      q.passageId = q.groupId;
    }
  }
  return questions;
}

export function parseQuestionsFromPages(pages, warnings) {
  if (isSchoolStructuredExamDocument(pages)) {
    return parseSchoolQuestionsFromPages(pages, warnings);
  }
  return parseGenericQuestionsFromPages(pages, warnings);
}

export { isB1AchievementMidtermDocument, parseB1AchievementMidtermFromPages };

function parseGenericQuestionsFromPages(pages, warnings) {
  const sectionId = newExamSectionId();
  const sections = [{ id: sectionId, title: 'Phần 1', order: 0 }];
  const passages = [];
  const questions = [];
  const pendingContext = [];
  const ctx = {
    sectionId,
    currentPassageId: null,
    currentQuestionRange: null,
    qOrdinal: 0,
    lastQuestion: null,
    inPart6Passage: false,
    part6PassageId: null,
    part6QuestionRange: null,
    pendingDisplayNumber: null,
    part6QuestionsStarted: false,
    pendingUnsupported: null,
    pendingTaskLabel: '',
    inListeningSection: false,
    sawListeningContent: false,
    listeningTestActive: false,
    inBackmatterRegion: false,
    pageSawTestEndThisPage: false,
    questionsStartedAfterPageTestEnd: false,
    unsupportedBlockActive: false,
    unsupportedBlockPages: [],
  };

  for (const page of pages) {
    if (page.isBlankPage) {
      warnings.push(`Trang ${page.pageNumber}: trang trắng (không có nội dung) — bỏ qua khi trích câu hỏi.`);
      continue;
    }
    if (page.needsOcr) {
      warnings.push(
        `Trang ${page.pageNumber}: có hình/ảnh hoặc nội dung không trích được lớp chữ — cần nhận dạng chữ hoặc bổ sung văn bản.`,
      );
      continue;
    }
    const { geo, lines: pageQuestionLines } = pageLinesForQuestionParse(page);

    if (shouldSkipEntirePageForQuestions(page)) {
      enterBackmatterRegion(ctx, page, pendingContext);
      warnings.push(
        `Trang ${page.pageNumber}: phần đuôi PDF (script/hướng dẫn/đáp án) — bỏ qua khi trích câu hỏi.`,
      );
      continue;
    }

    ctx.pageSawTestEndThisPage = false;
    ctx.questionsStartedAfterPageTestEnd = false;

    const fence = createPageBackmatterFence();

    for (const lineParts of pageQuestionLines) {
      const lineText = mergeLineText(lineParts);
      if (!lineText) continue;

      if (isAnchoredBackmatterBoundaryLine(lineText)) {
        applyBackmatterFenceCutoff(fence, lineParts, geo, lineText);
        resetQuestionParseContinuation(ctx, page, pendingContext);
        if (TEST_END_DIRECTIVE.test(lineText)) {
          ctx.pageSawTestEndThisPage = true;
        }
        continue;
      }
      if (isLineInBackmatterFence(lineParts, geo, fence)) {
        continue;
      }

      if (ctx.inBackmatterRegion) {
        if (isExplicitRealTestSectionLine(lineText)) {
          exitBackmatterRegion(ctx);
        } else {
          continue;
        }
      }

      const combinedTask = `${ctx.pendingTaskLabel} ${lineText}`.replace(/\s+/g, ' ').trim();
      const instrUnsupported = detectUnsupportedReadingTask(lineText, ctx.pendingTaskLabel);
      if (CHOOSE_TWO_MARK.test(lineText) || TFNG_MARK.test(lineText) || YNNG_MARK.test(lineText)) {
        ctx.pendingTaskLabel = combinedTask.slice(0, 320);
      } else if (ctx.pendingTaskLabel && !TFNG_MARK.test(combinedTask) && !YNNG_MARK.test(combinedTask)) {
        ctx.pendingTaskLabel = '';
      }
      if (instrUnsupported) {
        if (ctx.currentPassageId) {
          const g = passages.find((x) => x.id === ctx.currentPassageId);
          if (g && !g.unsupportedTaskType) {
            g.unsupportedTaskType = instrUnsupported.type;
            g.unsupportedReason = instrUnsupported.reason;
          }
        } else {
          ctx.pendingUnsupported = instrUnsupported;
        }
      }

      if (TOEIC_PART_HEADER.test(lineText)) {
        ctx.pendingUnsupported = null;
        ctx.pendingTaskLabel = '';
        const partNum = parseInt(lineText.match(TOEIC_PART_HEADER)[1], 10);
        if (ctx.listeningTestActive && partNum >= 1 && partNum <= 4) {
          ctx.inListeningSection = true;
          pendingContext.length = 0;
        } else {
          ctx.inListeningSection = false;
        }
        if (partNum >= 5) {
          ctx.sectionId = newExamSectionId();
          sections.push({
            id: ctx.sectionId,
            title: `Part ${partNum}`,
            order: sections.length,
          });
          ctx.currentPassageId = null;
          ctx.currentQuestionRange = null;
          ctx.lastQuestion = null;
          ctx.inListeningSection = false;
        }
        ctx.inPart6Passage = /^PART\s+6\b/i.test(lineText);
        if (/^PART\s+[57]\b/i.test(lineText)) {
          ctx.inPart6Passage = false;
          ctx.part6QuestionsStarted = false;
          ctx.part6QuestionRange = null;
          ctx.part6PassageId = null;
        }
        continue;
      }

      if (LISTENING_TEST_MARK.test(lineText)) {
        ctx.listeningTestActive = true;
        ctx.inListeningSection = true;
        ctx.sawListeningContent = true;
        ctx.pendingTaskLabel = '';
        pendingContext.length = 0;
        continue;
      }

      if (READING_TEST_MARK.test(lineText)) {
        ctx.listeningTestActive = false;
        ctx.inListeningSection = false;
        pendingContext.length = 0;
        ctx.currentPassageId = null;
        ctx.currentQuestionRange = null;
        ctx.pendingUnsupported = null;
        ctx.pendingTaskLabel = '';
        continue;
      }

      if (isSkipLine(lineText)) continue;

      if (ctx.inListeningSection) continue;

      if (READING_SECTION_RESET.test(lineText)) {
        ctx.listeningTestActive = false;
        ctx.inListeningSection = false;
        pendingContext.length = 0;
        ctx.currentPassageId = null;
        ctx.currentQuestionRange = null;
        ctx.pendingUnsupported = null;
        ctx.pendingTaskLabel = '';
        continue;
      }

      if (
        FREE_TEXT_TASK_LINE.test(lineText)
        || (QUESTIONS_RANGE.test(lineText) && FREE_TEXT_TASK_LINE.test(`${ctx.pendingTaskLabel} ${lineText}`))
      ) {
        ctx.unsupportedBlockActive = true;
        if (!ctx.unsupportedBlockPages.includes(page.pageNumber)) {
          ctx.unsupportedBlockPages.push(page.pageNumber);
        }
        warnings.push(
          `Trang ${page.pageNumber}: dạng bài tự luận/điền từ/ghi chép — đã đọc được chữ nhưng chưa hỗ trợ nhập tự động.`,
        );
      }

      if (
        PASSAGE_HEADER.test(lineText)
        || QUESTIONS_RANGE.test(lineText)
        || QUESTIONS_AND_PAIR.test(lineText)
      ) {
        const group = createReadingGroup(passages, ctx, lineText, page, lineParts);
        consumePendingContextIntoGroup(group, pendingContext);
        ctx.lastQuestion = null;
        if (group.unsupportedTaskType || passageHeaderMarksUnsupportedTask(lineText)) {
          ctx.unsupportedBlockActive = true;
          if (!ctx.unsupportedBlockPages.includes(page.pageNumber)) {
            ctx.unsupportedBlockPages.push(page.pageNumber);
          }
        }
        continue;
      }

      if (ctx.currentPassageId) {
        const g = passages.find((x) => x.id === ctx.currentPassageId);
        if (g && maybeStartSubDocument(g, lineText, page.pageNumber)) {
          continue;
        }
      }

      if (isGapMarkerInPassageLine(lineText, ctx, lineParts, geo)) {
        if (ctx.currentPassageId) {
          const p = passages.find((x) => x.id === ctx.currentPassageId);
          if (p) appendDocumentText(p, lineText, page.pageNumber, lineText);
        } else if (ctx.part6PassageId) {
          const p = passages.find((x) => x.id === ctx.part6PassageId);
          if (p) appendDocumentText(p, lineText, page.pageNumber, lineText);
        }
        continue;
      }

      if (continueActiveQuestion(lineText, ctx, lineParts, geo, page, fence)) {
        continue;
      }

      if (shouldBufferAsPendingContext(ctx, lineText, lineParts, geo, page)) {
        pendingContext.push({ text: lineText, page, lineParts });
        continue;
      }

      if (ctx.unsupportedBlockActive) {
        if (ctx.currentPassageId) {
          const p = passages.find((x) => x.id === ctx.currentPassageId);
          if (p) appendDocumentText(p, lineText, page.pageNumber, lineText);
        }
        continue;
      }

      if (QUESTION_NUM_ONLY.test(lineText)) {
        const numOnly = lineText.match(QUESTION_NUM_ONLY)[1];
        if (!isWithinDeclaredRange(numOnly, ctx.currentQuestionRange)) {
          if (ctx.currentPassageId) {
            const p = passages.find((x) => x.id === ctx.currentPassageId);
            if (p) appendDocumentText(p, lineText, page.pageNumber, lineText);
          } else {
            pendingContext.push({ text: lineText, page, lineParts });
          }
          continue;
        }
        if (ctx.inPart6Passage && ctx.part6PassageId && !ctx.part6QuestionsStarted) {
          const p = passages.find((x) => x.id === ctx.part6PassageId);
          if (p) appendDocumentText(p, lineText, page.pageNumber, lineText);
          continue;
        }
        ctx.pendingDisplayNumber = numOnly;
        continue;
      }

      if (ctx.pendingDisplayNumber) {
        if (OPTION_LINE_START.test(lineText) || QUESTION_INLINE_OPTION.test(lineText)) {
          finishActiveQuestion(ctx, page);
          const q = startQuestion(questions, ctx, ctx.pendingDisplayNumber, '', page, lineParts);
          ctx.pendingDisplayNumber = null;
          parseOptionsFromLine(lineText, q);
          continue;
        }
        finishActiveQuestion(ctx, page);
        startQuestion(questions, ctx, ctx.pendingDisplayNumber, lineText, page, lineParts);
        ctx.pendingDisplayNumber = null;
        continue;
      }

      const inline = lineText.match(QUESTION_INLINE_OPTION);
      if (inline && isWithinDeclaredRange(inline[1], ctx.currentQuestionRange)
        && lineStartsQuestionCandidate(lineText, ctx, lineParts, geo, page)) {
        finishActiveQuestion(ctx, page);
        const q = startQuestion(questions, ctx, inline[1], '', page, lineParts);
        addOption(q, inline[2] || inline[3], inline[4] || '');
        continue;
      }

      const bareNum = lineText.match(QUESTION_BARE_NUM);
      if (bareNum && isWithinDeclaredRange(bareNum[1], ctx.currentQuestionRange)
        && lineStartsQuestionCandidate(lineText, ctx, lineParts, geo, page)) {
        finishActiveQuestion(ctx, page);
        startQuestion(questions, ctx, bareNum[1], bareNum[2] || '', page, lineParts);
        continue;
      }

      const qm = lineText.match(QUESTION_START);
      if (qm && shouldTreatDottedLineAsProse(lineText, lineParts, page, geo, ctx, pendingContext)) {
        if (ctx.currentPassageId) {
          const p = passages.find((x) => x.id === ctx.currentPassageId);
          if (p) appendDocumentText(p, lineText, page.pageNumber, lineText);
        } else {
          pendingContext.push({ text: lineText, page, lineParts });
        }
        continue;
      }

      if (qm && isWithinDeclaredRange(qm[1], ctx.currentQuestionRange)
        && lineStartsQuestionCandidate(lineText, ctx, lineParts, geo, page)) {
        finishActiveQuestion(ctx, page);
        startQuestion(questions, ctx, qm[1], qm[2] || '', page, lineParts);
        continue;
      }

      if (qm && !isWithinDeclaredRange(qm[1], ctx.currentQuestionRange)) {
        if (ctx.currentPassageId) {
          const p = passages.find((x) => x.id === ctx.currentPassageId);
          if (p) appendDocumentText(p, lineText, page.pageNumber, lineText);
        } else {
          pendingContext.push({ text: lineText, page, lineParts });
        }
        continue;
      }

      if (ctx.inBackmatterRegion) {
        continue;
      }

      if (ctx.currentPassageId) {
        const p = passages.find((x) => x.id === ctx.currentPassageId);
        if (p) appendDocumentText(p, lineText, page.pageNumber, lineText);
      } else {
        pendingContext.push({ text: lineText, page, lineParts });
      }
    }
    if (ctx.pageSawTestEndThisPage && !ctx.questionsStartedAfterPageTestEnd) {
      enterBackmatterRegion(ctx, page, pendingContext);
    }
    finishActiveQuestion(ctx, page);
  }

  let finalQuestions = dedupeAndRejectFakeQuestions(questions);
  finalQuestions = filterListeningPseudoQuestions(finalQuestions, warnings);
  finalQuestions = rejectUnsupportedPassageQuestions(finalQuestions, passages, warnings);
  finalQuestions = dropOutOfRangeOrphanQuestions(finalQuestions, passages);
  finalQuestions = finalQuestions.sort((a, b) => a.order - b.order);

  for (const q of finalQuestions) {
    splitEmbeddedOptionsFromStem(q);
    const optCount = q.options.filter((o) => o.text.trim()).length;
    if (optCount < 2) {
      q.incomplete = true;
      warnings.push(`Câu ${q.displayNumber}: thiếu lựa chọn — cần kiểm tra.`);
    } else if (optCount < 4) {
      warnings.push(`Câu ${q.displayNumber}: chưa đủ 4 lựa chọn — cần kiểm tra.`);
    }
    if (!q.stemText || !String(q.stemText).trim()) {
      q.incomplete = true;
      warnings.push(`Câu ${q.displayNumber}: thiếu nội dung câu hỏi — cần kiểm tra.`);
    }
  }

  finalizeReadingGroups(passages, finalQuestions, warnings);
  ensureUnsupportedFormatWarnings(passages, finalQuestions, warnings);

  const contaminationMsg = buildContaminationImportWarning({
    questions: finalQuestions,
    passages,
  });
  if (contaminationMsg) warnings.push(contaminationMsg);

  if (ctx.sawListeningContent) {
    warnings.push(
      'PDF có phần nghe (Listening) — bài thi trực tuyến không kèm file audio; câu Listening không thể làm tự động như Reading.',
    );
  }

  if (!finalQuestions.length) {
    warnings.push('Không phát hiện câu hỏi — kiểm tra phạm vi trang hoặc bổ sung nội dung.');
  }

  const needsOcrPageNumbers = pages.filter((p) => p.needsOcr).map((p) => p.pageNumber);

  return {
    sections,
    passages,
    questions: finalQuestions,
    needsOcr: needsOcrPageNumbers.length > 0,
    needsOcrPageNumbers,
    needsReview: true,
  };
}

function clusterKeyRows(items, yTol = 4) {
  const sorted = [...items].sort((a, b) => {
    const ay = a.bbox.y + a.bbox.h / 2;
    const by = b.bbox.y + b.bbox.h / 2;
    return by - ay;
  });
  const rows = [];
  for (const it of sorted) {
    const cy = it.bbox.y + it.bbox.h / 2;
    let row = rows.find((r) => Math.abs(r.y - cy) <= yTol);
    if (!row) {
      row = { y: cy, items: [] };
      rows.push(row);
    }
    row.items.push(it);
  }
  return rows;
}

function keyColumnBand(x) {
  if (x >= 380) return 'reading-key';
  if (x >= 318) return 'reading-num';
  if (x >= 268) return 'listening-key';
  if (x >= 200) return 'listening-num';
  return 'other';
}

function parseKeyPageGeometry(page, keyMap, warnings) {
  const items = (page.items || []).filter((it) => it.text);
  if (!items.length) return;
  const rows = clusterKeyRows(items);
  for (const row of rows) {
    const sorted = [...row.items].sort((a, b) => a.bbox.x - b.bbox.x);
    const numbers = sorted.filter((it) => /^\d{1,3}$/.test(it.text));
    const letters = sorted.filter((it) => /^[A-F]$/i.test(it.text));
    for (const num of numbers) {
      const nx = num.bbox.x + num.bbox.w / 2;
      const ny = num.bbox.y + num.bbox.h / 2;
      const numBand = keyColumnBand(nx);
      if (numBand !== 'reading-num' && numBand !== 'listening-num') continue;
      const wantKeyBand = numBand === 'reading-num' ? 'reading-key' : 'listening-key';
      let bestLetter = null;
      let bestScore = Infinity;
      for (const letter of letters) {
        if (keyColumnBand(letter.bbox.x) !== wantKeyBand) continue;
        const lx = letter.bbox.x;
        const ly = letter.bbox.y + letter.bbox.h / 2;
        if (lx <= nx + 8) continue;
        const dy = Math.abs(ly - ny);
        if (dy > 6) continue;
        const score = lx - nx + dy * 10;
        if (score < bestScore) {
          bestScore = score;
          bestLetter = letter;
        }
      }
      if (!bestLetter) continue;
      const key = bestLetter.text.toUpperCase();
      if (keyMap[num.text] && keyMap[num.text] !== key) {
        warnings.push(`Đáp án mơ hồ/trùng số câu ${num.text} (${keyMap[num.text]} vs ${key}).`);
        continue;
      }
      keyMap[num.text] = key;
    }
  }
}

export function parseAnswerKeyFromPages(keyPages, sections, questions, warnings) {
  const keyMap = {};
  for (const page of keyPages) {
    parseKeyPageGeometry(page, keyMap, warnings);
  }
  const lines = keyPages.flatMap((p) => p.plainText.split('\n'));
  const reLine = /^\s*(\d+)\s*[.:)\-]?\s*([A-Fa-f])\s*$/;
  const rePair = /(\d+)\s*[:\s]\s*([A-Fa-f])/g;
  for (const line of lines) {
    let m = line.match(reLine);
    if (m) {
      if (!keyMap[m[1]]) keyMap[m[1]] = m[2].toUpperCase();
      continue;
    }
    for (const match of line.matchAll(rePair)) {
      if (!keyMap[match[1]]) keyMap[match[1]] = match[2].toUpperCase();
    }
  }
  const dup = {};
  for (const q of questions) {
    const k = keyMap[q.displayNumber];
    if (!k) continue;
    if (dup[q.displayNumber]) warnings.push(`Đáp án trùng số câu ${q.displayNumber}.`);
    dup[q.displayNumber] = true;
    if (!q.options.some((o) => o.id === k)) {
      warnings.push(`Đáp án câu ${q.displayNumber}: đáp án ${k} không khớp lựa chọn.`);
      continue;
    }
    q.correctOptionId = k;
  }
  return keyMap;
}

export function parsePhysicalPageRangeInput(input, numPages) {
  if (input == null || input === '') return null;
  if (Array.isArray(input)) {
    return [...new Set(input.map((x) => Number(x)).filter((n) => Number.isInteger(n) && n >= 1))].sort(
      (a, b) => a - b,
    );
  }
  const spec = String(input).trim();
  if (!spec) return null;
  const pages = new Set();
  for (const chunk of spec.split(/[,;\s]+/)) {
    const part = chunk.trim();
    if (!part) continue;
    const range = part.match(/^(\d+)\s*-\s*(\d+)$/);
    if (range) {
      let a = Number(range[1]);
      let b = Number(range[2]);
      if (!Number.isInteger(a) || !Number.isInteger(b)) throw new Error('invalid-page-range');
      if (a > b) [a, b] = [b, a];
      for (let p = a; p <= b; p += 1) pages.add(p);
      continue;
    }
    if (!/^\d+$/.test(part)) throw new Error('invalid-page-range');
    pages.add(Number(part));
  }
  const list = [...pages].sort((a, b) => a - b);
  if (!list.length) throw new Error('invalid-page-range');
  for (const p of list) {
    if (p < 1 || p > numPages) throw new Error('page-out-of-range');
  }
  return list;
}

export async function getPdfPageCount(buffer, { maxPages = MAX_PDF_PAGES_FOR_IMPORT } = {}) {
  const pdfjs = await getPdfJs();
  const loadingTask = pdfjs.getDocument({ data: new Uint8Array(buffer), useSystemFonts: true });
  const pdf = await loadingTask.promise;
  const count = pdf.numPages;
  await releasePdfResources(pdf, loadingTask);
  if (!Number.isInteger(count) || count < 1) throw new Error('invalid-pdf');
  if (count > maxPages) throw new Error('pdf-too-many-pages');
  return count;
}

export function resolveImportQuestionPages({
  numPages,
  questionPages,
  questionPageRange,
  allPages,
  keyPages,
}) {
  const keys = new Set((keyPages || []).map(Number).filter(Boolean));
  let explicit = null;
  if (Array.isArray(questionPages) && questionPages.length) {
    explicit = questionPages.map(Number);
  } else if (questionPageRange != null && String(questionPageRange).trim()) {
    explicit = parsePhysicalPageRangeInput(questionPageRange, numPages);
  } else if (Array.isArray(allPages) && allPages.length) {
    explicit = allPages.map(Number).filter((p) => !keys.has(p));
  }
  const pages = explicit ?? [...Array(numPages)].map((_, i) => i + 1).filter((p) => !keys.has(p));
  const unique = [...new Set(pages)].sort((a, b) => a - b);
  if (!unique.length) throw new Error('no-question-pages');
  for (const p of unique) {
    if (!Number.isInteger(p) || p < 1 || p > numPages) throw new Error('page-out-of-range');
    if (keys.has(p)) throw new Error('page-overlap');
  }
  return unique;
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
    warnings.push('Chưa có trang đáp án — bổ sung đáp án thủ công hoặc chọn giáo viên chấm sau.');
  }
  return {
    title: options.title || 'Bài thi nhập từ PDF',
    sections: parsed.sections,
    passages: parsed.passages,
    questions: parsed.questions,
    warnings,
    needsOcr: parsed.needsOcr,
    needsOcrPageNumbers: parsed.needsOcrPageNumbers || [],
    needsReview: parsed.needsReview,
    teacherConfirmedReview: false,
    manuallyEdited: false,
  };
}
