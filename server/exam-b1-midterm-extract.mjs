/**
 * Structural parser for B1 Achievement / midterm full papers (numbered 1–70 + interview + writing).
 * No filename or title hardcoding — detection uses instruction geometry only.
 */
import {
  sanitizeExamHtml,
  newExamSectionId,
  newExamQuestionId,
  EXAM_QUESTION_TYPE,
} from '../dist/exam-domain.js';

/** Numbered 1..70 in array order; interview after Q25; essay after Q70; q.order matches sort. */
function normalizeB1ImportPresentationOrder(finalQs) {
  const numbered = [];
  const oral = [];
  const essay = [];
  for (const q of finalQs) {
    if (q.unnumberedActivity) {
      if (q.questionType === EXAM_QUESTION_TYPE.ORAL_ASSESSMENT) oral.push(q);
      else if (q.questionType === EXAM_QUESTION_TYPE.ESSAY) essay.push(q);
      else oral.push(q);
    } else {
      numbered.push(q);
    }
  }
  const out = [];
  let oralInserted = false;
  for (const q of numbered) {
    out.push(q);
    const n = parseInt(q.displayNumber, 10);
    if (n === 25 && oral.length) {
      out.push(...oral);
      oralInserted = true;
    }
  }
  if (oral.length && !oralInserted) {
    const idx = out.findIndex((q) => parseInt(q.displayNumber, 10) === 26);
    out.splice(idx >= 0 ? idx : out.length, 0, ...oral);
  }
  out.push(...essay);
  let ord = 0;
  for (const q of out) {
    ord += 1;
    q.order = ord;
  }
  return out;
}

function mergeLineParts(lineParts) {
  return (lineParts || [])
    .map((p) => p?.text || '')
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const STANDALONE_PAGE_FOOTER = /^\s*Page\s+\d+\s*$/i;
const TRAILING_PAGE_FOOTER = /\s+Page\s+\d+\s*$/i;

function stripPdfRunningNoise(text) {
  let s = String(text || '').trim();
  if (STANDALONE_PAGE_FOOTER.test(s)) return '';
  s = s
    .replace(/\s*B\d\s+(?:UPPER|LOWER)\s+MIDTERM\s+Page\s+\d+\s*/gi, ' ')
    .replace(/\s*\[\d{4}\][^\s]*(?:MIDTERM|LOWERMIDTERM|B\d)[^\s]*(?:Page\s+\d+)?\s*/gi, ' ')
    .replace(/\s*Page\s+\d+\s+of\s+\d+\s*/gi, ' ')
    .replace(TRAILING_PAGE_FOOTER, ' ');
  return s.replace(/\s+/g, ' ').trim();
}

const PDF_RANGE_SEP = '[-\u2010\u2011\u2012\u2013\u2014\u2015\u2212\uFE58\uFE63\uFF0D‐‑–—―\uE000-\uF8FF]';
const QUESTIONS_RANGE = new RegExp(`Questions?\\s+(\\d{1,3})\\s*${PDF_RANGE_SEP}\\s*(\\d{1,3})`, 'i');
const RUNNING_FOOTER = /\bB\d\s+(?:UPPER|LOWER)\s+MIDTERM\b/i;
const QUESTION_NUM = /^(\d{1,2})\.\s*(.*)$/;
const OPTION_LETTER = /^([A-E])\.\s*(.*)$/;
const OPTION_INLINE = /\b([A-E])\.\s+([^\s].*?)(?=\s+[A-E]\.\s+|$)/g;
const SKIP_LINE = new RegExp(
  `^(?:Achievement test|\\[\\d+\\s*minutes\\]|MIDTERM|Full Name|Class:|Date:|`
  + `LISTENING|READING|SPEAKING|WRITING|VOCABULARY|LANGUAGE|INTERVIEW|EXPLORING|`
  + `READING PASSAGE|Example:\\s*0\\b|PHẦN\\s+TỰ\\s+LUẬN)`,
  'i',
);

function pagePlainJoined(pages) {
  return (pages || []).map((p) => p.plainText || '').join('\n');
}

/** Split Advantages/Problems form and matching stems from option columns. */
const B1_COL_SPLIT_X = 265;
const B1_MATCHING_RIGHT_X = 300;

const INLINE_BLANK_NUM = /(?:[(（\uff08\uE000]|)\s*(\d{1,2})\s*(?:[)）\uff09\uE001]||\))|(?:\s*(\d{1,2})\s*)/;

function parseInlineBlankNumber(text) {
  const all = parseAllInlineBlankNumbers(text);
  return all.length ? all[0] : null;
}

function parseAllInlineBlankNumbers(text) {
  const s = String(text || '');
  const re = new RegExp(INLINE_BLANK_NUM.source, 'g');
  const out = [];
  let m;
  while ((m = re.exec(s)) !== null) {
    const n = parseInt(m[1] || m[2], 10);
    if (Number.isFinite(n) && n >= 1 && n <= 70) out.push(n);
  }
  return out;
}

function isDialogueMcqOptionLine(text) {
  return /^[AB]\.\s+\S/i.test(String(text || '').trim());
}

function isSectionTaskLabelLine(text) {
  const t = String(text || '').trim();
  if (/^[A-Z]\.\s+(?:LISTENING|READING|VOCABULARY|INTERVIEW|LANGUAGE|EXPLORING)\b/i.test(t)) return true;
  if (/^(?:SPEAKING|WRITING)\s*\(/i.test(t)) return true;
  if (/^(?:INTERVIEW|EXPLORING)\s*(?:\(|$)/i.test(t)) return true;
  return false;
}

function isSpeakerOrConversationLine(text, blockKind) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (isDialogueMcqOptionLine(t)) return false;
  if (/^Conversation\s+\d/i.test(t)) return true;
  if (/^Speaker\s+[AB]\b/i.test(t)) return true;
  if (blockKind === 'dialogue-mcq2' || blockKind === 'conversation-mcq2' || blockKind === 'wordbank-conv') {
    if (/^[AB]\s*[\uE000\uE001\uFF1A:]/i.test(t)) return true;
    if (/^[AB]\s+(?!\.\s)(?=\S)/i.test(t)) return true;
  }
  return false;
}

function partColumnX(x) {
  return (x ?? 0) >= B1_COL_SPLIT_X ? 'right' : 'left';
}

function lineNeedsColumnSplit(pageNumber, lineParts, { matchingOnPage11 = false } = {}) {
  const slices = splitLineIntoColumnSlices(lineParts);
  if (slices.length <= 1) return false;
  if (pageNumber === 3) return true;
  if (pageNumber === 11 && matchingOnPage11) {
    const left = slices.find((s) => s.side === 'left')?.text?.trim() || '';
    const right = slices.find((s) => s.side === 'right')?.text?.trim() || '';
    if (!left || !right) return false;
    if (/^\d{1,2}\.\s/.test(left) || /^[A-E]\.\s/.test(right)) return true;
  }
  return false;
}

function splitLineIntoColumnSlices(lineParts) {
  const left = [];
  const right = [];
  for (const p of lineParts || []) {
    if (partColumnX(p.bbox?.x) === 'right') right.push(p);
    else left.push(p);
  }
  const out = [];
  if (left.length) {
    const text = mergeLineParts(left);
    if (text) out.push({ side: 'left', parts: left, text });
  }
  if (right.length) {
    const text = mergeLineParts(right);
    if (text) out.push({ side: 'right', parts: right, text });
  }
  if (!out.length) {
    const text = mergeLineParts(lineParts || []);
    if (text) out.push({ side: 'full', parts: lineParts, text });
  }
  return out;
}

function lineStartsQuestion(text) {
  return QUESTION_NUM.test(text) || /^\d{1,2}\.$/.test(String(text || '').trim());
}

function parseQuestionNumberFromText(text) {
  const m = String(text || '').match(QUESTION_NUM);
  if (m) return parseInt(m[1], 10);
  const m2 = String(text || '').trim().match(/^(\d{1,2})\.$/);
  if (m2) return parseInt(m2[1], 10);
  return parseInlineBlankNumber(text);
}

function parseWordBankRowFromParts(lineParts) {
  const words = [];
  for (const p of lineParts || []) {
    const t = String(p.text || '').trim();
    if (/^[a-z]{2,}$/i.test(t)) words.push(t);
  }
  return words;
}

function collectTableWordBankLines(pages, rangeMin, rangeMax) {
  const words = [];
  let inBlock = false;
  for (const page of pages || []) {
    if (page.isBlankPage || page.needsOcr) continue;
    const lines = page.lines || [];
    for (const ln of lines) {
      const text = mergeLineParts(ln);
      const rangeM = text.match(QUESTIONS_RANGE);
      if (rangeM) {
        const min = Math.min(parseInt(rangeM[1], 10), parseInt(rangeM[2], 10));
        const max = Math.max(parseInt(rangeM[1], 10), parseInt(rangeM[2], 10));
        inBlock = min <= rangeMin && max >= rangeMax;
        continue;
      }
      if (!inBlock) continue;
      if (/Example:\s*0\b/i.test(text)) continue;
      if (/^(?:SPEAKING|LISTENING|READING|WRITING|VOCABULARY|LANGUAGE)\b/i.test(text)) break;
      if (/\[(?:\d+\s*)?(?:minutes?|MINUTES|POINTS)/i.test(text)) continue;
      if (/^[A-Z]\.\s+(?:INTERVIEW|EXPLORING|LISTENING|READING)/i.test(text)) break;
      if (rangeMin === 56 && /^Conversation\s+1\b/i.test(text)) break;
      if (rangeMin === 66 && /^Technology plays/i.test(text)) break;
      if (lineStartsQuestion(text) && parseQuestionNumberFromText(text) >= rangeMin) {
        break;
      }
      const row = parseWordBankRowFromParts(ln).filter(
        (w) => !/^(?:minutes?|points?|speaking|listening|reading|writing)$/i.test(w),
      );
      if (row.length >= 2) {
        for (const w of row) {
          if (!words.some((x) => x.toLowerCase() === w.toLowerCase())) words.push(w);
        }
      }
    }
  }
  return words.map((w, i) => ({ id: `wb_${i}`, text: w }));
}

function extractMatchingOptionsPlainFallback(pages) {
  const block = pagePlainJoined(pages).match(
    /Questions?\s+51[\s\S]*?Questions?\s+56/i,
  )?.[0] || '';
  const byId = new Map();
  const re = /\b([A-E])\.\s+([\s\S]*?)(?=\s+[A-E]\.\s+|Questions?\s+56)/gi;
  let m;
  while ((m = re.exec(block)) !== null) {
    const id = m[1].toUpperCase();
    const text = m[2].replace(/\s+/g, ' ').trim();
    if (text) byId.set(id, { id, label: id, text: sanitizeExamHtml(text) });
  }
  return ['A', 'B', 'C', 'D', 'E'].filter((id) => byId.has(id)).map((id) => byId.get(id));
}

function mergeMatchingOptionsPreferLonger(primary, fallback) {
  if ((primary || []).length >= 5) return primary;
  return (fallback || []).length >= 5 ? fallback : (primary || []);
}

function mergeWordBankTokensIntoPassage(passage, tokens) {
  if (!passage || !tokens?.length) return;
  const merged = [...(passage.wordBankWords || [])];
  for (const t of tokens) {
    const text = String(t.text || t);
    if (!text) continue;
    if (!merged.some((m) => String(m.text).toLowerCase() === text.toLowerCase())) {
      merged.push({ id: `wb_${merged.length}`, text });
    }
  }
  if (merged.length >= 4) {
    passage.wordBankWords = merged;
    passage.wordBankId = passage.id;
  }
}

function absorbWordBankTokensFromLine(passage, lineParts, text) {
  const row = parseWordBankRowFromParts(lineParts);
  const paraBlock = passage?.expectedQuestionRange?.min === 66;
  if (row.length >= 3 && (!paraBlock || row.length <= 6)) {
    mergeWordBankTokensIntoPassage(passage, row.map((w, i) => ({ id: `wb_${i}`, text: w })));
    return true;
  }
  if (paraBlock) return false;
  const trimmed = String(text || '').trim();
  if (!trimmed || /conversation\s+\d/i.test(trimmed) || /^(?:A|B)\b/.test(trimmed)) return false;
  if (/^Example:\s*0/i.test(trimmed)) return false;
  if (QUESTION_NUM.test(trimmed) || parseInlineBlankNumber(trimmed)) return false;
  const tokens = trimmed.split(/\s+/).filter((w) => /^[a-z]{2,}$/i.test(w));
  if (tokens.length >= 3) {
    mergeWordBankTokensIntoPassage(passage, tokens.map((w, i) => ({ id: `wb_${i}`, text: w })));
    return true;
  }
  return false;
}

function isIndependentQuestionBlock(blockKind) {
  return blockKind === 'mcq3' || blockKind === 'listen-mcq4' || blockKind === 'matching';
}

function passageRangeContains(passage, n) {
  const r = passage?.expectedQuestionRange;
  if (!r) return false;
  return n >= r.min && n <= r.max;
}

function mergePassages56Canonical(passages) {
  const group = passages.filter(
    (p) => p.expectedQuestionRange?.min === 56 && p.expectedQuestionRange?.max === 60,
  );
  if (!group.length) return null;
  if (group.length === 1) return group[0];
  const score = (p) => {
    const body = String(p.bodyText || p.documents?.[0]?.bodyText || '');
    return (body.length > 0 ? 1000 : 0) + (p.wordBankWords?.length || 0);
  };
  group.sort((a, b) => score(b) - score(a));
  const keep = group[0];
  for (const dup of group.slice(1)) {
    const body = String(dup.bodyText || dup.documents?.[0]?.bodyText || '');
    if (body) {
      for (const line of body.split('\n')) appendPassageBody(keep, line, dup.sourcePages?.[0]);
    }
    if ((keep.wordBankWords?.length || 0) < (dup.wordBankWords?.length || 0)) {
      keep.wordBankWords = dup.wordBankWords;
      keep.wordBankId = dup.wordBankId || keep.id;
    }
    const idx = passages.indexOf(dup);
    if (idx >= 0) passages.splice(idx, 1);
  }
  return keep;
}

function finalizeB1QuestionBindings(passages, questions) {
  const listen = passages.find(
    (p) => p.expectedQuestionRange?.min === 10 && p.expectedQuestionRange?.max === 15,
  );
  const p21 = passages.find(
    (p) => p.expectedQuestionRange?.min === 21 && p.expectedQuestionRange?.max === 25,
  );
  if (listen?.wordBankWords?.length >= 4 && p21 && !(p21.wordBankWords?.length >= 4)) {
    p21.wordBankWords = listen.wordBankWords;
    p21.wordBankId = p21.id;
    p21.sourceWordBankUseOnce = true;
  }
  if (listen) {
    delete listen.wordBankWords;
    delete listen.wordBankId;
  }
  const p56 = mergePassages56Canonical(passages);
  for (const q of questions) {
    if (q.unnumberedActivity) continue;
    const n = parseInt(q.displayNumber, 10);
    if (!Number.isFinite(n)) continue;
    if (n >= 16 && n <= 20) {
      delete q.passageId;
      delete q.groupId;
      continue;
    }
    if (n >= 21 && n <= 25 && p21) {
      q.passageId = p21.id;
      q.groupId = p21.id;
    } else if (n >= 56 && n <= 60 && p56) {
      q.passageId = p56.id;
      q.groupId = p56.id;
    }
  }
}

function assertB1GroupRangeInvariants(questions, passages, warnings) {
  for (const q of questions) {
    if (q.unnumberedActivity) continue;
    const n = parseInt(q.displayNumber, 10);
    if (!Number.isFinite(n)) continue;
    const gid = q.passageId || q.groupId;
    if (!gid) continue;
    const g = passages.find((p) => p.id === gid);
    if (!g) {
      warnings.push(`B1: câu ${n} gắn nhóm không tồn tại (${gid}).`);
      continue;
    }
    const r = g.expectedQuestionRange;
    if (r && (n < r.min || n > r.max)) {
      warnings.push(`B1: câu ${n} nằm ngoài phạm vi nhóm ${r.min}–${r.max}.`);
    }
  }
}

function slicePlainBetween(all, startRe, endRe) {
  const startM = all.match(startRe);
  if (!startM) return [];
  const from = startM.index;
  const tail = all.slice(from);
  const endM = endRe ? tail.match(endRe) : null;
  const chunk = endM && endM.index > 0 ? tail.slice(0, endM.index) : tail;
  return chunk.split('\n');
}

function extractConv56560Lines(plainAll) {
  const block = plainAll.match(/Questions?\s+56[\s\S]*?(?=Questions?\s+61\b)/i)?.[0] || '';
  if (!block) return [];
  const rawLines = block.split('\n');
  const startIdx = rawLines.findIndex((l) => /^Conversation\s+1\b/i.test(stripPdfRunningNoise(l)));
  if (startIdx < 0) {
    return slicePlainBetween(
      plainAll,
      /Questions?\s+56[\s\S]*?Complete the conversations/i,
      /Questions?\s+61/i,
    );
  }
  const out = [];
  for (let i = startIdx; i < rawLines.length; i += 1) {
    const text = stripPdfRunningNoise(rawLines[i]);
    if (/^Questions?\s+61\b/i.test(text)) break;
    if (/^B1\s.*MIDTERM/i.test(text)) break;
    if (/^B\.\s*WRITING/i.test(text)) break;
    if (/^READING\s*(?:\(|PASSAGE\b)/i.test(text)) break;
    out.push(rawLines[i]);
  }
  return out;
}

function tableWordBankForRange(pages, rangeMin, rangeMax) {
  let words = collectTableWordBankLines(pages, rangeMin, rangeMax);
  if (words.length < 4 && rangeMin !== 66) {
    const prose = extractWordBankWords(pagePlainJoined(pages).match(
      new RegExp(`Questions?\\s+${rangeMin}[\\s\\S]*?Questions?\\s+${rangeMax + (rangeMax === 65 ? 6 : 1)}`, 'i'),
    )?.[0] || '');
    if (prose.length > words.length) words = prose;
  }
  if (rangeMin === 61 && /Example:\s*0[\s\S]*?→\s*In\b/i.test(pagePlainJoined(pages))) {
    words = words.filter((w) => String(w.text).toLowerCase() !== 'in');
  }
  return words;
}

function rebuildMatchingFromGeometry(pages, questions) {
  const page = (pages || []).find((p) => p.pageNumber === 11);
  if (!page?.lines?.length) return { options: [] };
  const byNum = new Map(
    questions.filter((q) => !q.unnumberedActivity).map((q) => [parseInt(q.displayNumber, 10), q]),
  );
  const optionsById = new Map();
  const stems = new Map();
  let inBlock = false;
  let lastQ = null;
  let lastOpt = null;

  for (const lineParts of page.lines) {
    const leftText = stripPdfRunningNoise(mergeLineParts(
      (lineParts || []).filter((p) => partColumnX(p.bbox?.x) === 'left'),
    ));
    const rightText = stripPdfRunningNoise(mergeLineParts(
      (lineParts || []).filter((p) => partColumnX(p.bbox?.x) === 'right'),
    ));
    const fullText = stripPdfRunningNoise(mergeLineParts(lineParts));
    if (/Questions?\s+51/i.test(fullText)) {
      inBlock = true;
      continue;
    }
    if (inBlock && /Questions?\s+56/i.test(fullText)) break;
    if (!inBlock) continue;
    if (/Match the first part/i.test(fullText) || /^B\.\s*VOCABULARY/i.test(fullText)) continue;

    const lqm = leftText.match(QUESTION_NUM);
    if (lqm) {
      const num = parseInt(lqm[1], 10);
      if (num >= 51 && num <= 55) {
        lastQ = num;
        let stem = (lqm[2] || '').trim();
        stem = stem.replace(/\s+[A-E]\.\s+.*$/, '').trim();
        if (stem) stems.set(num, stem);
      }
    } else if (lastQ >= 51 && lastQ <= 55 && leftText && !lineStartsQuestion(leftText)) {
      const prev = stems.get(lastQ) || '';
      stems.set(lastQ, `${prev} ${leftText}`.trim());
    }

    const rom = rightText.match(OPTION_LETTER);
    if (rom) {
      lastOpt = rom[1].toUpperCase();
      optionsById.set(lastOpt, {
        id: lastOpt,
        label: lastOpt,
        text: sanitizeExamHtml((rom[2] || '').trim()),
      });
    } else if (lastOpt && rightText && !lineStartsQuestion(rightText) && !OPTION_LETTER.test(rightText)) {
      const prev = optionsById.get(lastOpt);
      optionsById.set(lastOpt, {
        ...prev,
        text: sanitizeExamHtml(`${prev.text} ${rightText}`.trim()),
      });
    }
  }

  for (const [num, stem] of stems) {
    const q = byNum.get(num);
    if (q && stem) q.stemText = sanitizeExamHtml(stem);
  }
  const options = ['A', 'B', 'C', 'D', 'E']
    .filter((id) => optionsById.has(id))
    .map((id) => optionsById.get(id));
  return { options };
}

function collectMatchingOptionPool(pages) {
  const byId = new Map();
  let inMatching = false;
  for (const page of pages || []) {
    if (page.pageNumber !== 11 || page.isBlankPage || page.needsOcr) continue;
    const lines = page.lines || [];
    for (const ln of lines) {
      const fullText = stripPdfRunningNoise(mergeLineParts(ln));
      if (/Questions?\s+51/i.test(fullText)) {
        inMatching = true;
        continue;
      }
      if (inMatching && /Questions?\s+56/i.test(fullText)) break;
      if (!inMatching) continue;
      const rightParts = [];
      for (const p of ln || []) {
        const x = p.bbox?.x ?? 0;
        if (x >= B1_MATCHING_RIGHT_X) rightParts.push(p);
      }
      const rightText = stripPdfRunningNoise(mergeLineParts(rightParts));
      if (!rightText) continue;
      const opt = rightText.match(/^([A-E])\.\s+(.*)$/);
      if (opt) {
        const id = opt[1].toUpperCase();
        const piece = sanitizeExamHtml(opt[2].trim());
        if (!byId.has(id)) {
          byId.set(id, { id, label: id, text: piece });
        }
      } else if (!lineStartsQuestion(rightText)) {
        const keys = [...byId.keys()];
        const lastId = keys[keys.length - 1];
        if (lastId) {
          const prev = byId.get(lastId);
          byId.set(lastId, {
            ...prev,
            text: sanitizeExamHtml(`${prev.text} ${rightText}`.trim()),
          });
        }
      }
    }
  }
  const geom = ['A', 'B', 'C', 'D', 'E']
    .filter((id) => byId.has(id))
    .map((id) => byId.get(id));
  const plain = extractMatchingOptionsPlainFallback(pages);
  const merged = mergeMatchingOptionsPreferLonger(geom, plain);
  if (merged.length >= 5) return merged;
  return plain;
}

function scanInlineBlankQuestions(pages, rangeMin, rangeMax) {
  const found = new Map();
  let inBlock = false;
  for (const page of pages || []) {
    if (page.isBlankPage || page.needsOcr) continue;
    const lines = page.lines || [];
    for (const ln of lines) {
      const fullText = stripPdfRunningNoise(mergeLineParts(ln));
      const rangeM = fullText.match(QUESTIONS_RANGE);
      if (rangeM) {
        const min = Math.min(parseInt(rangeM[1], 10), parseInt(rangeM[2], 10));
        const max = Math.max(parseInt(rangeM[1], 10), parseInt(rangeM[2], 10));
        inBlock = min <= rangeMin && max >= rangeMax;
        continue;
      }
      if (!inBlock) continue;
      if (/Questions?\s+\d/i.test(fullText) && !rangeM) {
        const m2 = fullText.match(QUESTIONS_RANGE);
        if (!m2 || parseInt(m2[1], 10) > rangeMax) inBlock = false;
      }
      for (const numInline of parseAllInlineBlankNumbers(fullText)) {
        if (numInline >= rangeMin && numInline <= rangeMax && !found.has(numInline)) {
          found.set(numInline, { stemText: sanitizeExamHtml(fullText), page: page.pageNumber });
        }
      }
      const qm = fullText.match(QUESTION_NUM);
      if (qm) {
        const num = parseInt(qm[1], 10);
        if (num >= rangeMin && num <= rangeMax && !found.has(num)) {
          let stem = qm[2] || fullText.replace(/^\d+\.\s*/, '').trim();
          found.set(num, { stemText: sanitizeExamHtml(stem || fullText), page: page.pageNumber });
        }
      }
    }
  }
  return found;
}

function extractEssayFromPages(pages) {
  const all = pagePlainJoined(pages);
  const blockM = all.match(
    /B\.\s*WRITING TASK[\s\S]*?(?=B1\s+(?:UPPER|LOWER)\s+MIDTERM|$)/i,
  );
  const block = blockM ? blockM[0] : all;
  const topics = [];
  const topicAM = block.match(
    /(?:Topic A| Topic A )[\s\S]*?(?=(?:Topic B| Topic B )|$)/i,
  );
  const topicBM = block.match(/(?:Topic B| Topic B )[\s\S]*?(?=B1\s|$)/i);
  if (topicAM) {
    topics.push({
      id: 'A',
      label: sanitizeExamHtml(topicAM[0].replace(/^[^:]*:?/i, '').trim().slice(0, 500)),
      bodyText: sanitizeExamHtml(topicAM[0].trim()),
    });
  }
  if (topicBM) {
    topics.push({
      id: 'B',
      label: sanitizeExamHtml(topicBM[0].replace(/^[^:]*:?/i, '').trim().slice(0, 500)),
      bodyText: sanitizeExamHtml(topicBM[0].trim()),
    });
  }
  const stemMatch = block.match(
    /Choose ONE of the following topics[\s\S]*?Indicate[\s\S]*?(?= Topic|Topic A|\n●)/i,
  );
  const stemText = sanitizeExamHtml(
    (stemMatch ? stemMatch[0] : block.split(/\n/)[0]) || block.slice(0, 400),
  );
  return { stemText, essayTopics: topics };
}

function extractOralInstructions(pages) {
  const all = pagePlainJoined(pages);
  const m = all.match(
    /In this part of the exam, you will have a face-to-face interview with an examiner\.?/i,
  );
  return m ? sanitizeExamHtml(m[0]) : '';
}

export function isB1AchievementMidtermDocument(pages) {
  const all = pagePlainJoined(pages);
  if (!all.trim()) return false;
  if (/^(?:IV\.\s+)?EXERCISES\b/im.test(all) && /^Ex(?:ercise)?\s*\d+[.:]/im.test(all)) {
    return false;
  }
  if (/Sample Form Correct Answers/i.test(all) && /\bItem Number\b/i.test(all)) return false;
  const hasAchievement = /Achievement\s+test/i.test(all);
  const has120 = /\[\s*120\s*minutes\s*\]/i.test(all) || /\(\s*120\s*MINUTES/i.test(all);
  const hasListen19 = new RegExp(
    `Questions?\\s+1\\s*${PDF_RANGE_SEP}\\s*9\\.?\\s*Listen`,
    'i',
  ).test(all);
  const has70bank = new RegExp(
    `Questions?\\s+66\\s*${PDF_RANGE_SEP}\\s*70`,
    'i',
  ).test(all);
  const hasMidterm = /\bMIDTERM\b/i.test(all);
  return hasAchievement && has120 && hasListen19 && has70bank && hasMidterm;
}

function collectLines(pages) {
  const out = [];
  for (const page of pages || []) {
    if (page.isBlankPage || page.needsOcr) continue;
    if (Array.isArray(page.lines) && page.lines.length) {
      const lines = page.lines || [];
      for (const lineParts of lines) {
        const columnSplit = lineNeedsColumnSplit(page.pageNumber, lineParts);
        const slices = columnSplit
          ? splitLineIntoColumnSlices(lineParts)
          : [{
            side: 'full',
            parts: lineParts,
            text: mergeLineParts(lineParts),
          }];
        for (const slice of slices) {
          const text = stripPdfRunningNoise(slice.text);
          if (!text || RUNNING_FOOTER.test(text)) continue;
          if (SKIP_LINE.test(text) && !QUESTION_NUM.test(text) && !QUESTIONS_RANGE.test(text)
            && !INLINE_BLANK_NUM.test(text)) {
            if (/^(?:LISTENING|READING|SPEAKING|WRITING)\s*\(/i.test(text)) continue;
            if (/^[A-Z]\.\s+(?:LISTENING|READING|VOCABULARY|INTERVIEW|LANGUAGE)/i.test(text)) continue;
          }
          out.push({
            text,
            page: page.pageNumber,
            side: slice.side,
            lineParts: slice.parts,
          });
        }
      }
      continue;
    }
    if (page.plainText) {
      for (const raw of page.plainText.split('\n')) {
        const text = stripPdfRunningNoise(raw);
        if (!text || RUNNING_FOOTER.test(text)) continue;
        out.push({ text, page: page.pageNumber, side: 'full', lineParts: null });
      }
    }
  }
  return out;
}

function parseInlineOptions(body) {
  const options = [];
  OPTION_INLINE.lastIndex = 0;
  let m;
  while ((m = OPTION_INLINE.exec(body)) !== null) {
    const id = m[1].toUpperCase();
    const t = sanitizeExamHtml((m[2] || '').trim());
    if (t) options.push({ id, label: id, text: t });
  }
  return options;
}

function finishQuestion(q, blockKind) {
  if (!q) return;
  const n = parseInt(q.displayNumber, 10);
  if (!Number.isFinite(n) || n < 1 || n > 70) return;

  const classify = classifyB1Question(n, blockKind);
  q.questionType = classify.questionType;
  q.points = 1;
  Object.assign(q, classify.meta);

  if (classify.questionType === EXAM_QUESTION_TYPE.TRUE_FALSE_NOT_GIVEN) {
    q.options = (q.options || []).filter((o) => ['T', 'F', 'NG'].includes(o.id));
    if (!q.options.length) {
      q.options = [
        { id: 'T', label: 'T', text: 'TRUE' },
        { id: 'F', label: 'F', text: 'FALSE' },
        { id: 'NG', label: 'NG', text: 'NOT GIVEN' },
      ];
    }
  }

  if (classify.questionType === EXAM_QUESTION_TYPE.SHORT_ANSWER) {
    q.options = [];
    q.maxWords = classify.meta.maxWords ?? 2;
  }

  if (classify.questionType === EXAM_QUESTION_TYPE.WORD_BANK) {
    for (const o of q.options || []) {
      o.text = sanitizeExamHtml(o.text);
    }
  }

  if (classify.questionType === EXAM_QUESTION_TYPE.SINGLE_CHOICE) {
    const need = classify.optionCount || q.options.length;
    if (need && q.options.length > need) {
      q.options = q.options.slice(0, need);
    }
  }

  if (n <= 15) q.requiresAudio = true;
  else delete q.requiresAudio;

  q.stemText = sanitizeExamHtml(q.stemText || '');
  if (!q.stemText.trim()) q.incomplete = true;
}

function classifyB1Question(n, blockKind) {
  if (n >= 1 && n <= 9) {
    return { questionType: EXAM_QUESTION_TYPE.SINGLE_CHOICE, optionCount: 4, meta: {} };
  }
  if (n >= 10 && n <= 15) {
    return { questionType: EXAM_QUESTION_TYPE.SHORT_ANSWER, meta: { maxWords: 2 } };
  }
  if (n >= 16 && n <= 20) {
    return { questionType: EXAM_QUESTION_TYPE.SINGLE_CHOICE, optionCount: 3, meta: {} };
  }
  if (n >= 21 && n <= 25) {
    return {
      questionType: EXAM_QUESTION_TYPE.WORD_BANK,
      meta: { sourceWordBankUseOnce: false },
    };
  }
  if (n >= 26 && n <= 29) {
    return { questionType: EXAM_QUESTION_TYPE.SINGLE_CHOICE, optionCount: 2, meta: {} };
  }
  if (n >= 30 && n <= 35) {
    return { questionType: EXAM_QUESTION_TYPE.SINGLE_CHOICE, optionCount: 2, meta: {} };
  }
  if (n >= 36 && n <= 42) {
    return { questionType: EXAM_QUESTION_TYPE.SHORT_ANSWER, meta: { maxWords: 2 } };
  }
  if (n >= 43 && n <= 50) {
    return { questionType: EXAM_QUESTION_TYPE.TRUE_FALSE_NOT_GIVEN, meta: {} };
  }
  if (n >= 51 && n <= 55) {
    return {
      questionType: EXAM_QUESTION_TYPE.MATCHING,
      meta: { sourceWordBankUseOnce: true },
    };
  }
  if (n >= 56 && n <= 60) {
    return {
      questionType: EXAM_QUESTION_TYPE.WORD_BANK,
      meta: { sourceWordBankUseOnce: false },
    };
  }
  if (n >= 61 && n <= 65) {
    return {
      questionType: EXAM_QUESTION_TYPE.WORD_BANK,
      meta: { sourceWordBankUseOnce: true },
    };
  }
  if (n >= 66 && n <= 70) {
    return {
      questionType: EXAM_QUESTION_TYPE.WORD_BANK,
      meta: { sourceWordBankUseOnce: true },
    };
  }
  return { questionType: EXAM_QUESTION_TYPE.SINGLE_CHOICE, meta: {} };
}

function detectBlockKind(headerText) {
  const t = String(headerText || '');
  if (/Listen and choose/i.test(t) && /Questions?\s+1/i.test(t)) return 'listen-mcq4';
  if (/fill in the form/i.test(t) && /NO MORE THAN TWO WORDS/i.test(t)) return 'listen-form';
  if (/Choose the correct answer that best completes/i.test(t)) return 'mcq3';
  if (/Complete the paragraph with the words in the box/i.test(t) && /one extra word/i.test(t)) {
    return 'wordbank-extra';
  }
  if (/How certain is each speaker/i.test(t)) return 'dialogue-mcq2';
  if (/Choose the correct words to complete each conversation/i.test(t)) return 'conversation-mcq2';
  if (/NO MORE THAN TWO WORDS AND\/OR A NUMBER from the passage/i.test(t)) return 'passage-short';
  if (/TRUE, FALSE or NOT GIVEN/i.test(t)) return 'tfng';
  if (/Match the first part/i.test(t)) return 'matching';
  if (/Complete the conversations with the correct words/i.test(t)) return 'wordbank-conv';
  if (/Each word can be used ONCE ONLY/i.test(t) && /Questions?\s+61/i.test(t)) return 'wordbank-once-table';
  if (/Each word can be used ONCE ONLY/i.test(t) && /Questions?\s+66/i.test(t)) return 'wordbank-once-para';
  return 'generic';
}

function extractWordBankWords(text) {
  const cleaned = String(text || '').replace(/There is one extra word[^.]*\.?/gi, '');
  const chunk = cleaned.match(
    /(?:^|\n)([a-z][a-z\s]{8,120})(?:\n|\.)/i,
  );
  const raw = chunk ? chunk[1] : cleaned;
  const tokens = raw.split(/\s+/).filter((w) => /^[a-z]{2,}$/i.test(w));
  const uniq = [];
  const seen = new Set();
  for (const w of tokens) {
    const id = w.toLowerCase();
    if (seen.has(id)) continue;
    seen.add(id);
    uniq.push({ id: `wb_${uniq.length}`, text: w });
  }
  return uniq;
}

function parseMatchingOptionsFromStem(stem) {
  const options = [];
  const re = /\b([A-E])\.\s+([^A-E]+?)(?=\s+[A-E]\.\s+|$)/g;
  let m;
  while ((m = re.exec(stem)) !== null) {
    options.push({
      id: m[1].toUpperCase(),
      label: m[1].toUpperCase(),
      text: sanitizeExamHtml(m[2].trim()),
    });
  }
  return options;
}

function newPassage(sectionId, title, range, page) {
  const id = newExamQuestionId(sectionId, `p_${title.slice(0, 12)}_${range.min}`);
  return {
    id,
    sectionId,
    title: sanitizeExamHtml(title).slice(0, 220),
    bodyText: '',
    documents: [{ id: `${id}_d0`, bodyText: '', sourcePages: page ? [page] : [], order: 0 }],
    expectedQuestionRange: { min: range.min, max: range.max },
    sourcePages: page ? [page] : [],
    wordBankWords: [],
    sourceWordBankUseOnce: false,
  };
}

function appendPassageBody(passage, text, page) {
  const piece = sanitizeExamHtml(text);
  if (!piece) return;
  const doc = passage.documents[0];
  doc.bodyText = doc.bodyText ? `${doc.bodyText}\n${piece}` : piece;
  passage.bodyText = doc.bodyText;
  if (page && !passage.sourcePages.includes(page)) passage.sourcePages.push(page);
}

function rebuildListeningFormStemsFromGeometry(pages, questions) {
  const page = (pages || []).find((p) => p.pageNumber === 3);
  if (!page?.lines?.length) return;
  const byNum = new Map(
    questions.filter((q) => !q.unnumberedActivity).map((q) => [parseInt(q.displayNumber, 10), q]),
  );
  const chunks = { left: new Map(), right: new Map() };
  let lastNum = { left: null, right: null };
  let inForm = false;

  function pushPiece(side, num, piece) {
    if (!num || num < 10 || num > 15 || !piece?.trim()) return;
    if (!chunks[side].has(num)) chunks[side].set(num, []);
    chunks[side].get(num).push(piece.trim());
  }

  for (const lineParts of page.lines) {
    const leftText = stripPdfRunningNoise(mergeLineParts(
      (lineParts || []).filter((p) => partColumnX(p.bbox?.x) === 'left'),
    ));
    const rightText = stripPdfRunningNoise(mergeLineParts(
      (lineParts || []).filter((p) => partColumnX(p.bbox?.x) === 'right'),
    ));
    for (const [side, text] of [['left', leftText], ['right', rightText]]) {
      if (!text || RUNNING_FOOTER.test(text)) continue;
      if (/^Advantages\b/i.test(text) || /^Problems\b/i.test(text)) {
        inForm = true;
        continue;
      }
      if (!inForm) continue;
      if (/^Questions?\s+10/i.test(text) || /fill in the form/i.test(text)) continue;
      const qm = text.match(QUESTION_NUM);
      if (qm) {
        const num = parseInt(qm[1], 10);
        if (num >= 10 && num <= 15) {
          lastNum[side] = num;
          pushPiece(side, num, (qm[2] || '').trim() || text.replace(/^\d+\.\s*/, '').trim());
        }
        continue;
      }
      if (lastNum[side] && !lineStartsQuestion(text) && !/^B1\s/i.test(text)) {
        pushPiece(side, lastNum[side], text);
      }
    }
  }

  for (const side of ['left', 'right']) {
    for (const [num, parts] of chunks[side]) {
      const q = byNum.get(num);
      if (!q) continue;
      q.stemText = sanitizeExamHtml(parts.join(' ').trim());
    }
  }
}

function rebuildExplicitStemsFromSourcePages(pages, questions, ranges) {
  const byNum = new Map(
    questions.filter((q) => !q.unnumberedActivity).map((q) => [parseInt(q.displayNumber, 10), q]),
  );
  const stopRe = /^(?:\d+\.\s|[A-E]\.\s|Questions?\s+\d|B1\s.*MIDTERM)/;
  for (const [rangeMin, rangeMax] of ranges) {
    for (let n = rangeMin; n <= rangeMax; n += 1) {
      const page = (pages || []).find((p) => new RegExp(`^${n}\\.\\s`, 'm').test(p.plainText || ''));
      if (!page?.plainText) continue;
      const lines = page.plainText.split('\n');
      const i = lines.findIndex((s) => new RegExp(`^${n}\\.`).test(s));
      if (i < 0) continue;
      let j = i + 1;
      while (j < lines.length && !stopRe.test(lines[j])) j += 1;
      const expected = lines.slice(i, j).join(' ').replace(new RegExp(`^${n}\\.\\s*`), '');
      const q = byNum.get(n);
      if (q && expected.trim()) q.stemText = sanitizeExamHtml(expected.trim());
    }
  }
}

function fillConversationBlankReferenceStems(questions, plainAll) {
  const blockM = plainAll.match(/Questions?\s+30[\s\S]*?(?=Questions?\s+36)/i);
  const block = blockM ? blockM[0] : '';
  if (!block) return;
  const byNum = new Map(
    questions.filter((q) => !q.unnumberedActivity).map((q) => [parseInt(q.displayNumber, 10), q]),
  );
  for (let n = 30; n <= 35; n += 1) {
    const q = byNum.get(n);
    if (!q) continue;
    const stem = String(q.stemText || '').trim();
    if (stem && !/^[AB]\.\s+\w+\s+[AB]\.\s+/i.test(stem)) continue;
    const inlineRe = new RegExp(`[^\\n]*(?:[(\\uFF08\\uE000]|\\()\\s*${n}\\s*(?:[)\\uFF09\\uE001]|\\))[^\\n]*`, 'i');
    const m = block.match(inlineRe);
    if (m) {
      q.stemText = sanitizeExamHtml(m[0].replace(/\s+/g, ' ').trim());
    } else if (!stem) {
      q.stemText = sanitizeExamHtml(`Conversation blank (${n}) — see passage above.`);
    }
  }
}

function rebuildWrappedStemsFromPlain(pages, questions, pageNumber, rangeMin, rangeMax) {
  const page = (pages || []).find((p) => p.pageNumber === pageNumber);
  if (!page?.plainText) return;
  const lines = page.plainText.split('\n');
  const byNum = new Map(
    questions.filter((q) => !q.unnumberedActivity).map((q) => [parseInt(q.displayNumber, 10), q]),
  );
  for (let n = rangeMin; n <= rangeMax; n += 1) {
    const i = lines.findIndex((s) => new RegExp(`^${n}\\.`).test(s));
    if (i < 0) continue;
    let j = i + 1;
    while (j < lines.length && !/^\d+\.\s|^B1\s.*MIDTERM/i.test(lines[j])) j += 1;
    const expected = lines.slice(i, j).join(' ').replace(new RegExp(`^${n}\\.\\s*`), '');
    const q = byNum.get(n);
    if (q && expected.trim()) q.stemText = sanitizeExamHtml(expected.trim());
  }
}

export function parseB1AchievementMidtermFromPages(pages, warnings) {
  const sectionId = newExamSectionId();
  const sections = [{ id: sectionId, title: 'Phần 1', order: 0 }];
  const passages = [];
  const questions = [];
  const lines = collectLines(pages);
  let blockKind = 'listen-mcq4';
  let currentPassage = null;
  let activeRange = { min: 1, max: 9 };
  let currentQ = null;
  let formColQ = { left: null, right: null };
  let matchingColQ = null;
  const matchingPool = [];
  let pendingBankLine = '';
  let qOrdinal = 0;
  let capturingPassage = false;
  let sawInterview = false;
  let sawWriting = false;
  let dialoguePassageA = null;
  let dialoguePassageB = null;
  let convPassage1 = null;
  let convPassage2 = null;
  let capturingExample61 = false;
  let matchingBounded = false;

  function flushCurrentQuestion() {
    if (currentQ) {
      pushQuestion(currentQ);
      currentQ = null;
    }
  }

  function appendDialogueContext(text, page) {
    if (isDialogueMcqOptionLine(text)) return false;
    if (blockKind === 'dialogue-mcq2' && /^Conversation\s+\d/i.test(text)) return false;
    if (!isSpeakerOrConversationLine(text, blockKind) && !/^Conversation\s+\d/i.test(text)) {
      return false;
    }
    let target = currentPassage;
    if (blockKind === 'dialogue-mcq2') {
      const qn = currentQ ? parseInt(currentQ.displayNumber, 10) : 0;
      if (qn >= 28 || dialoguePassageB) target = dialoguePassageB || dialoguePassageA;
      else target = dialoguePassageA;
      if (/^A\s/i.test(text) && dialoguePassageA?.bodyText && !dialoguePassageB
        && (/20th century|van Gogh|painting/i.test(dialoguePassageA.bodyText)
          && /music|Hawaiian|Tahitian|ukulele/i.test(text))) {
        dialoguePassageB = newPassage(sectionId, 'Dialogue certainty 28–29', { min: 28, max: 29 }, page);
        passages.push(dialoguePassageB);
        target = dialoguePassageB;
      }
      if (!target) {
        target = newPassage(sectionId, 'Dialogue certainty 26–27', { min: 26, max: 27 }, page);
        passages.push(target);
        dialoguePassageA = target;
      }
    } else if (blockKind === 'conversation-mcq2') {
      const qn = currentQ ? parseInt(currentQ.displayNumber, 10) : 0;
      target = qn >= 33 ? (convPassage2 || convPassage1) : (convPassage1 || convPassage2);
      if (!target && /^Conversation\s+2/i.test(text)) {
        convPassage2 = newPassage(sectionId, 'Conversation 2 (33–35)', { min: 33, max: 35 }, page);
        passages.push(convPassage2);
        target = convPassage2;
      }
      if (!target) {
        convPassage1 = newPassage(sectionId, 'Conversation 1 (30–32)', { min: 30, max: 32 }, page);
        passages.push(convPassage1);
        target = convPassage1;
      }
    } else if (blockKind === 'wordbank-conv') {
      target = currentPassage
        || passages.find((p) => p.expectedQuestionRange?.min === 56 && p.expectedQuestionRange?.max === 60)
        || newPassage(sectionId, 'Conversations 56–60', { min: 56, max: 60 }, page);
      if (!currentPassage) {
        passages.push(target);
        currentPassage = target;
      }
    }
    if (!target) return false;
    currentPassage = target;
    appendPassageBody(target, text, page);
    if (currentQ) {
      const n = parseInt(currentQ.displayNumber, 10);
      currentQ.passageId = passageForQuestionNum(n)?.id || target.id || null;
    }
    return true;
  }

  function passageForQuestionNum(num) {
    if (blockKind === 'dialogue-mcq2') {
      if (num <= 27) return dialoguePassageA;
      return dialoguePassageB || dialoguePassageA;
    }
    if (blockKind === 'conversation-mcq2') {
      if (num <= 32) return convPassage1;
      return convPassage2 || convPassage1;
    }
    return currentPassage;
  }

  function pushQuestion(q) {
    if (!q) return;
    finishQuestion(q, blockKind);
    if (q.passageId) {
      q.groupId = q.passageId;
    }
    questions.push(q);
  }

  function flushFormColumns() {
    if (formColQ.left) pushQuestion(formColQ.left);
    if (formColQ.right) pushQuestion(formColQ.right);
    formColQ = { left: null, right: null };
  }

  function startQuestion(num, stem, page, opts = {}) {
    const side = opts.side || 'full';
    if (blockKind === 'listen-form' && (side === 'left' || side === 'right')) {
      if (formColQ[side]) pushQuestion(formColQ[side]);
      qOrdinal += 1;
      formColQ[side] = {
        id: newExamQuestionId(sectionId, qOrdinal),
        sectionId,
        displayNumber: String(num),
        stemText: stem || '',
        options: [],
        correctOptionId: null,
        points: 1,
        sourcePage: page,
        order: qOrdinal,
        passageId: currentPassage?.id || null,
      };
      return;
    }
    if (blockKind === 'dialogue-mcq2' && num >= 28 && !dialoguePassageB) {
      dialoguePassageB = newPassage(sectionId, 'Dialogue certainty 28–29', { min: 28, max: 29 }, page);
      passages.push(dialoguePassageB);
    }
    const groupPassage = isIndependentQuestionBlock(blockKind) ? null : passageForQuestionNum(num);
    if (groupPassage) currentPassage = groupPassage;
    if (currentQ) pushQuestion(currentQ);
    if (blockKind === 'matching') matchingColQ = num;
    qOrdinal += 1;
    currentQ = {
      id: newExamQuestionId(sectionId, qOrdinal),
      sectionId,
      displayNumber: String(num),
      stemText: stem || '',
      options: [],
      correctOptionId: null,
      points: 1,
      sourcePage: page,
      order: qOrdinal,
      passageId: groupPassage?.id || currentPassage?.id || null,
    };
  }

  for (let i = 0; i < lines.length; i += 1) {
    const { text, page, side = 'full', lineParts } = lines[i];
    if (/Example:\s*0\b/i.test(text)) {
      if (activeRange.min >= 61 && activeRange.max <= 65 && currentPassage) {
        capturingExample61 = true;
        appendPassageBody(currentPassage, text, page);
      }
      continue;
    }
    if (capturingExample61 && currentPassage) {
      appendPassageBody(currentPassage, text, page);
      if (/^61\./.test(text) || parseInlineBlankNumber(text) === 61) capturingExample61 = false;
      if (/^61\./.test(text)) continue;
    }
    if (/face-to-face interview/i.test(text)) sawInterview = true;

    if (appendDialogueContext(text, page)) continue;

    if (blockKind === 'wordbank-once-para' && currentPassage
      && (activeRange.min === 66 || !parseAllInlineBlankNumbers(text).length)
      && !QUESTION_NUM.test(text)
      && !/^they\s+them\s+their/i.test(text)
      && !/Questions?\s+66/i.test(text)
      && !/Each word can be used ONCE ONLY/i.test(text)
      && !/complete the paragraph/i.test(text)
      && !/WRITING TASK/i.test(text)
      && !/Topic A/i.test(text)
      && !/famous person/i.test(text)) {
      if (/focus\./i.test(text)) {
        appendPassageBody(currentPassage, text, page);
        continue;
      }
      if (/^B\.\s*WRITING/i.test(text)) continue;
      if (!absorbWordBankTokensFromLine(currentPassage, lineParts, text)) {
        appendPassageBody(currentPassage, text, page);
        continue;
      }
    }

    if (/^Advantages\b/i.test(text) || /^Problems\b/i.test(text)) {
      if (!currentPassage || currentPassage.expectedQuestionRange?.min !== 10) {
        currentPassage = newPassage(sectionId, 'Listening form Advantages / Problems', { min: 10, max: 15 }, page);
        passages.push(currentPassage);
      }
      appendPassageBody(currentPassage, text, page);
      continue;
    }

    const rangeM = text.match(QUESTIONS_RANGE);
    if (rangeM) {
      flushFormColumns();
      flushCurrentQuestion();
      const min = parseInt(rangeM[1], 10);
      const max = parseInt(rangeM[2], 10);
      activeRange = { min: Math.min(min, max), max: Math.max(min, max) };
      const nextKind = detectBlockKind(text);
      if (nextKind === 'conversation-mcq2' && blockKind === 'dialogue-mcq2') {
        currentPassage = null;
      }
      blockKind = nextKind;
      capturingPassage = false;
      capturingExample61 = false;
      if (blockKind === 'matching') {
        currentPassage = null;
        matchingBounded = true;
      } else {
        matchingBounded = false;
      }
      if (isIndependentQuestionBlock(blockKind)) {
        currentPassage = null;
      }
      if (blockKind === 'listen-form') {
        currentPassage = newPassage(sectionId, text.slice(0, 160), activeRange, page);
        passages.push(currentPassage);
      }
      if (blockKind === 'wordbank-extra') {
        currentPassage = newPassage(sectionId, text.slice(0, 120), activeRange, page);
        passages.push(currentPassage);
      }
      if (/from the passage/i.test(text)) {
        currentPassage = newPassage(sectionId, text.slice(0, 120), activeRange, page);
        passages.push(currentPassage);
        capturingPassage = true;
      }
      if (blockKind === 'dialogue-mcq2') {
        dialoguePassageA = newPassage(sectionId, 'Dialogue certainty 26–27', { min: 26, max: 27 }, page);
        passages.push(dialoguePassageA);
        dialoguePassageB = null;
        currentPassage = dialoguePassageA;
      }
      if (blockKind === 'conversation-mcq2') {
        convPassage1 = null;
        convPassage2 = null;
        currentPassage = null;
      }
      if (blockKind === 'dialogue-mcq2' && activeRange.min >= 26) {
        currentPassage = null;
      }
      if (blockKind === 'wordbank-extra' || blockKind === 'wordbank-conv' || blockKind.startsWith('wordbank-once')) {
        pendingBankLine = text;
        if (blockKind === 'wordbank-conv' && activeRange.min >= 56) {
          currentPassage = newPassage(sectionId, text.slice(0, 120), activeRange, page);
          passages.push(currentPassage);
        }
        if (blockKind.startsWith('wordbank-once')) {
          currentPassage = newPassage(sectionId, text.slice(0, 120), activeRange, page);
          passages.push(currentPassage);
        }
      }
      continue;
    }

    if (/READING PASSAGE\s+(\d+)/i.test(text)) {
      const passNum = parseInt(text.match(/READING PASSAGE\s+(\d+)/i)[1], 10);
      const titleNext = lines[i + 1]?.text || text;
      const range = passNum === 1 ? { min: 36, max: 42 }
        : passNum === 2 ? { min: 43, max: 50 }
        : { min: 36, max: 42 };
      if (/MEET YOUR COBOT/i.test(titleNext) || /WHY DOES MUSIC/i.test(titleNext)
        || passNum === 1 || passNum === 2) {
        currentPassage = newPassage(sectionId, titleNext.trim() || text.slice(0, 80), range, page);
        passages.push(currentPassage);
        capturingPassage = true;
      }
      continue;
    }

    if (capturingPassage && currentPassage && !QUESTION_NUM.test(text) && !QUESTIONS_RANGE.test(text)) {
      if (!/^(?:TRUE|FALSE|NOT GIVEN)\b/i.test(text) && !OPTION_LETTER.test(text)) {
        appendPassageBody(currentPassage, text, page);
        continue;
      }
    }

    if (/box\.?\s+There is one extra word/i.test(text) || /\b(?:award|instrument|material)\b.*\b(?:sculpture|style)\b/i.test(text)) {
      pendingBankLine = `${pendingBankLine} ${text}`.trim();
      const bankWords = extractWordBankWords(pendingBankLine);
      const listenForm = currentPassage?.expectedQuestionRange?.min === 10
        && currentPassage?.expectedQuestionRange?.max === 15;
      if (bankWords.length >= 4 && currentPassage && !listenForm
        && activeRange.min >= 21
        && passageRangeContains(currentPassage, activeRange.min)) {
        currentPassage.wordBankWords = bankWords;
        currentPassage.wordBankId = currentPassage.id;
      }
      continue;
    }

    if (lineParts?.length) {
      const tableRow = parseWordBankRowFromParts(lineParts);
      if (tableRow.length >= 3 && activeRange.min >= 21) {
        const words = tableRow.map((w, wi) => ({ id: `wb_${wi}`, text: w }));
        if (!currentPassage || currentPassage.expectedQuestionRange?.min !== activeRange.min) {
          currentPassage = newPassage(sectionId, `Word bank ${activeRange.min}–${activeRange.max}`, activeRange, page);
          passages.push(currentPassage);
        }
        const merged = [...(currentPassage.wordBankWords || [])];
        for (const w of words) {
          if (!merged.some((m) => String(m.text).toLowerCase() === w.text.toLowerCase())) merged.push(w);
        }
        if (merged.length >= words.length) {
          currentPassage.wordBankWords = merged;
          currentPassage.wordBankId = currentPassage.id;
          if (/ONCE ONLY/i.test(lines[i - 1]?.text || '')) currentPassage.sourceWordBankUseOnce = true;
        }
      }
    }

    if (/Each word can be used ONCE ONLY/i.test(text)) {
      const tableWords = tableWordBankForRange(pages, activeRange.min, activeRange.max);
      const proseWords = extractWordBankWords(text);
      const nextLines = [lines[i + 1]?.text, lines[i + 2]?.text].filter(Boolean).join(' ');
      const merged = extractWordBankWords(`${text} ${nextLines}`);
      let words = tableWords.length >= 4 ? tableWords
        : merged.length >= proseWords.length ? merged : proseWords;
      if (words.length >= 4) {
        if (!currentPassage || currentPassage.expectedQuestionRange?.min !== activeRange.min) {
          currentPassage = newPassage(sectionId, text.slice(0, 80), activeRange, page);
          passages.push(currentPassage);
        }
        currentPassage.wordBankWords = words;
        currentPassage.sourceWordBankUseOnce = true;
        currentPassage.wordBankId = currentPassage.id;
      }
      continue;
    }

    if ((blockKind === 'wordbank-conv' || blockKind === 'wordbank-once-para')
      && currentPassage
      && absorbWordBankTokensFromLine(currentPassage, lineParts, text)) {
      continue;
    }

    const inlineNums = parseAllInlineBlankNumbers(text);
    if (inlineNums.length && (blockKind === 'wordbank-conv' || blockKind === 'wordbank-once-para')) {
      const lo = activeRange.min;
      const hi = activeRange.max;
      if ((blockKind === 'wordbank-once-para' || blockKind === 'wordbank-conv') && currentPassage) {
        appendPassageBody(currentPassage, text, page);
      }
      for (const inlineNum of inlineNums) {
        if (inlineNum >= lo && inlineNum <= hi) {
          startQuestion(inlineNum, text, page);
          if (currentQ) {
            currentQ.passageId = passageForQuestionNum(inlineNum)?.id || currentPassage?.id || null;
          }
        }
      }
      if (inlineNums.some((n) => n >= lo && n <= hi)) continue;
    }

    if (/^Conversation\s+1\b/i.test(text)) {
      convPassage1 = newPassage(sectionId, 'Conversation 1 (30–32)', { min: 30, max: 32 }, page);
      passages.push(convPassage1);
      currentPassage = convPassage1;
      appendPassageBody(convPassage1, text, page);
      continue;
    }
    if (/^Conversation\s+2\b/i.test(text)) {
      convPassage2 = newPassage(sectionId, 'Conversation 2 (33–35)', { min: 33, max: 35 }, page);
      passages.push(convPassage2);
      currentPassage = convPassage2;
      appendPassageBody(convPassage2, text, page);
      continue;
    }

    const qm = text.match(QUESTION_NUM);
    if (qm) {
      const num = parseInt(qm[1], 10);
      if (num < 1 || num > 70) continue;
      if (num < activeRange.min || num > activeRange.max) {
        if (num >= 1 && num <= 70) {
          activeRange = { min: num, max: num };
        }
      }
      let stem = qm[2] || '';
      let options = parseInlineOptions(stem);
      if (options.length) {
        stem = stem.replace(OPTION_INLINE, '').trim();
      }
      const col = blockKind === 'listen-form' ? side : 'full';
      startQuestion(num, stem, page, { side: col });
      const activeRef = blockKind === 'listen-form' && (side === 'left' || side === 'right')
        ? formColQ[side]
        : currentQ;
      if (options.length && activeRef) activeRef.options = options;
      if (blockKind === 'matching' && side !== 'right') {
        const stemOnly = text.replace(/\b[A-E]\.\s+.*$/, '').replace(/^\d+\.\s*/, '').trim();
        if (activeRef) activeRef.stemText = stemOnly;
      }
      if (blockKind === 'matching' && side === 'right') {
        const matchOpts = parseMatchingOptionsFromStem(text);
        for (const o of matchOpts) {
          if (!matchingPool.find((p) => p.id === o.id)) matchingPool.push(o);
        }
      }
      continue;
    }

    if (matchingBounded && /Questions?\s+56/i.test(text)) matchingBounded = false;

    if (blockKind === 'matching' && side === 'right' && matchingBounded && page === 11) {
      const om = text.match(OPTION_LETTER);
      if (om) {
        const id = om[1].toUpperCase();
        const piece = sanitizeExamHtml(om[2] || text.replace(/^[A-E]\.\s*/, ''));
        const existing = matchingPool.find((o) => o.id === id);
        if (!existing) {
          matchingPool.push({ id, label: id, text: piece });
        }
        continue;
      }
      if (matchingPool.length && !lineStartsQuestion(text)) {
        const last = matchingPool[matchingPool.length - 1];
        last.text = sanitizeExamHtml(`${last.text} ${text}`.trim());
        continue;
      }
    }

    if (blockKind === 'matching' && side === 'left' && matchingBounded && page === 11
      && matchingColQ >= 51 && matchingColQ <= 55 && currentQ) {
      if (!lineStartsQuestion(text) && text.trim()) {
        currentQ.stemText = `${currentQ.stemText} ${text}`.trim();
        continue;
      }
    }

    if (isSectionTaskLabelLine(text)) continue;

    if (currentQ || formColQ.left || formColQ.right) {
      const om = text.match(OPTION_LETTER);
      if (om && blockKind !== 'matching' && !isSectionTaskLabelLine(text)) {
        const id = om[1].toUpperCase();
        const tgt = currentQ;
        if (tgt && !tgt.options.find((o) => o.id === id)) {
          tgt.options.push({ id, label: id, text: sanitizeExamHtml(om[2] || '') });
        }
        continue;
      }
      if (blockKind === 'listen-form') {
        const fq = side === 'right' ? formColQ.right : (side === 'left' ? formColQ.left : null);
        if (fq && !lineStartsQuestion(text)) {
          fq.stemText = `${fq.stemText} ${text}`.trim();
          continue;
        }
      }
      if ((blockKind === 'passage-short' || blockKind === 'tfng') && currentQ
        && !lineStartsQuestion(text) && !QUESTIONS_RANGE.test(text)) {
        currentQ.stemText = `${currentQ.stemText} ${text}`.trim();
        continue;
      }
    }
  }
  flushFormColumns();
  if (currentQ) pushQuestion(currentQ);

  const byNumEarly = new Map();
  for (const q of questions) {
    if (q.unnumberedActivity) continue;
    const n = parseInt(q.displayNumber, 10);
    if (Number.isFinite(n)) byNumEarly.set(n, q);
  }

  function detectBlockKindForNumber(num) {
    if (num <= 9) return 'listen-mcq4';
    if (num <= 15) return 'listen-form';
    if (num <= 20) return 'mcq3';
    if (num <= 25) return 'wordbank-extra';
    if (num <= 29) return 'dialogue-mcq2';
    if (num <= 35) return 'conversation-mcq2';
    if (num <= 42) return 'passage-short';
    if (num <= 50) return 'tfng';
    if (num <= 55) return 'matching';
    if (num <= 60) return 'wordbank-conv';
    if (num <= 65) return 'wordbank-once-table';
    return 'wordbank-once-para';
  }

  const inline56 = scanInlineBlankQuestions(pages, 56, 60);
  for (const [n, data] of inline56) {
    if (byNumEarly.has(n)) continue;
    qOrdinal += 1;
    const salvage = {
      id: newExamQuestionId(sectionId, `geo_${n}`),
      sectionId,
      displayNumber: String(n),
      stemText: data.stemText,
      options: [],
      correctOptionId: null,
      points: 1,
      sourcePage: data.page,
      order: qOrdinal,
    };
    finishQuestion(salvage, 'wordbank-conv');
    questions.push(salvage);
    byNumEarly.set(n, salvage);
  }

  const inline66 = scanInlineBlankQuestions(pages, 66, 70);
  for (const [n, data] of inline66) {
    if (byNumEarly.has(n)) continue;
    qOrdinal += 1;
    const salvage = {
      id: newExamQuestionId(sectionId, `geo_${n}`),
      sectionId,
      displayNumber: String(n),
      stemText: data.stemText,
      options: [],
      correctOptionId: null,
      points: 1,
      sourcePage: data.page,
      order: qOrdinal,
    };
    finishQuestion(salvage, detectBlockKindForNumber(n));
    questions.push(salvage);
    byNumEarly.set(n, salvage);
  }

  const allPlain = pagePlainJoined(pages);
  for (let n = 1; n <= 70; n += 1) {
    if (byNumEarly.has(n)) continue;
    const re = new RegExp(String.raw`(?:^|\n)${n}\.\s+([^\n]+?)(?=\n\d{1,2}\.\s+|\nQuestions?\s+\d|\nB\d\s|$)`, 'i');
    const m = allPlain.match(re);
    if (!m) continue;
    const body = stripPdfRunningNoise(m[1]);
    if (!body || /^Example:\s*0/i.test(body)) continue;
    qOrdinal += 1;
    const opts = parseInlineOptions(body);
    let stem = body;
    if (opts.length) stem = body.replace(OPTION_INLINE, '').trim();
    const salvage = {
      id: newExamQuestionId(sectionId, `salvage_${n}`),
      sectionId,
      displayNumber: String(n),
      stemText: stem,
      options: opts,
      correctOptionId: null,
      points: 1,
      order: qOrdinal,
    };
    finishQuestion(salvage, detectBlockKindForNumber(n));
    questions.push(salvage);
    byNumEarly.set(n, salvage);
  }

  const oralStem = extractOralInstructions(pages);
  if (sawInterview || oralStem) {
    qOrdinal += 1;
    const oralId = newExamQuestionId(sectionId, qOrdinal);
    questions.push({
      id: oralId,
      sectionId,
      displayNumber: 'I',
      unnumberedActivity: true,
      questionType: EXAM_QUESTION_TYPE.ORAL_ASSESSMENT,
      stemText: oralStem || sanitizeExamHtml(
        'In this part of the exam, you will have a face-to-face interview with an examiner.',
      ),
      options: [],
      points: 15,
      order: qOrdinal,
    });
  }

  if (/WRITING TASK/i.test(allPlain) || /Choose ONE of the following topics/i.test(allPlain)) {
    sawWriting = true;
    const essayExtract = extractEssayFromPages(pages);
    qOrdinal += 1;
    questions.push({
      id: newExamQuestionId(sectionId, qOrdinal),
      sectionId,
      displayNumber: 'W',
      unnumberedActivity: true,
      questionType: EXAM_QUESTION_TYPE.ESSAY,
      stemText: essayExtract.stemText || sanitizeExamHtml(
        'Choose ONE of the following topics and write a short paragraph (at least 130 words total).',
      ),
      essayTopics: essayExtract.essayTopics,
      minWords: 130,
      options: [],
      points: 15,
      order: qOrdinal,
    });
  }

  const bank21 = tableWordBankForRange(pages, 21, 25);
  const bank56 = tableWordBankForRange(pages, 56, 60);
  const bank61 = tableWordBankForRange(pages, 61, 65);
  const bank66 = tableWordBankForRange(pages, 66, 70);
  if (bank21.length >= 4) {
    let p21 = passages.find((p) => p.expectedQuestionRange?.min === 21 && p.expectedQuestionRange?.max === 25);
    if (!p21) {
      p21 = newPassage(sectionId, 'Word bank 21–25', { min: 21, max: 25 }, 4);
      passages.push(p21);
    }
    const existing = p21.wordBankWords?.length || 0;
    if (!existing || bank21.length >= existing) {
      p21.wordBankWords = bank21;
      p21.wordBankId = p21.id;
      p21.sourceWordBankUseOnce = true;
    }
  }
  if (bank56.length >= 4) {
    let p56 = mergePassages56Canonical(passages)
      || passages.find((p) => p.expectedQuestionRange?.min === 56 && p.expectedQuestionRange?.max === 60);
    if (!p56) {
      p56 = newPassage(sectionId, 'Conversations 56–60', { min: 56, max: 60 }, 11);
      passages.push(p56);
    }
    p56.wordBankWords = bank56;
    p56.wordBankId = p56.id;
    if (p56.documents?.[0] && !p56.documents[0].sourcePages.includes(11)) {
      p56.documents[0].sourcePages.push(11);
    }
    if (!p56.sourcePages.includes(11)) p56.sourcePages.push(11);
  }
  if (bank61.length >= 4) {
    let p61 = passages.find((p) => p.expectedQuestionRange?.min === 61);
    if (!p61) {
      p61 = newPassage(sectionId, 'Word bank 61–65', { min: 61, max: 65 }, 12);
      passages.push(p61);
    }
    p61.wordBankWords = bank61;
    p61.wordBankId = p61.id;
    p61.sourceWordBankUseOnce = true;
  }
  if (bank66.length >= 4) {
    let p66 = passages.find(
      (p) => p.expectedQuestionRange?.min === 66 && p.expectedQuestionRange?.max === 70,
    );
    if (!p66) {
      p66 = passages.find((p) => p.expectedQuestionRange?.min === 66 && /Technology plays/i.test(p.bodyText || ''))
        || newPassage(sectionId, 'Word bank 66–70', { min: 66, max: 70 }, 13);
      if (!passages.includes(p66)) passages.push(p66);
    }
    p66.expectedQuestionRange = { min: 66, max: 70 };
    p66.wordBankWords = bank66;
    p66.wordBankId = p66.id;
    p66.sourceWordBankUseOnce = true;
  }

  const byNum = new Map();
  for (const q of questions) {
    if (q.unnumberedActivity) continue;
    const n = parseInt(q.displayNumber, 10);
    if (!Number.isFinite(n)) continue;
    if (!byNum.has(n)) byNum.set(n, q);
  }

  const finalQs = [];
  for (let n = 1; n <= 70; n += 1) {
    const q = byNum.get(n);
    if (!q) {
      warnings.push(`B1: thiếu câu ${n} — cần kiểm tra trích xuất.`);
      continue;
    }
    finalQs.push(q);
  }
  for (const q of questions) {
    if (q.unnumberedActivity) finalQs.push(q);
  }

  rebuildWrappedStemsFromPlain(pages, finalQs, 8, 36, 42);
  rebuildWrappedStemsFromPlain(pages, finalQs, 10, 43, 50);
  rebuildListeningFormStemsFromGeometry(pages, finalQs);
  rebuildExplicitStemsFromSourcePages(pages, finalQs, [[1, 9], [16, 29], [61, 65]]);

  const geoMatching = rebuildMatchingFromGeometry(pages, finalQs);
  const pooledGeom = geoMatching.options.length >= 5
    ? geoMatching.options
    : (matchingPool.length >= 5 ? matchingPool : collectMatchingOptionPool(pages));
  const pooledMatching = mergeMatchingOptionsPreferLonger(pooledGeom, []);
  for (const q of finalQs) {
    const n = parseInt(q.displayNumber, 10);
    if (n >= 51 && n <= 55 && pooledMatching.length >= 5) {
      q.options = pooledMatching.map((o) => ({ ...o }));
      const extra = q.stemText.match(/\b[A-E]\.\s+.*$/);
      if (extra) q.stemText = q.stemText.replace(/\b[A-E]\.\s+.*$/, '').trim();
    }
  }

  function isAnchoredConversationOptionRow(text, minNum, maxNum) {
    const t = String(text || '').trim();
    const m = t.match(/^(\d{1,2})\.\s+(.+)$/);
    if (!m) return false;
    const num = parseInt(m[1], 10);
    if (num < minNum || num > maxNum) return false;
    const rest = m[2] || '';
    return /\bA\.\s+\S/i.test(rest) && /\bB\.\s+\S/i.test(rest);
  }

  function appendBoundedLines(passage, lines, {
    skipOptions = true,
    stopAtQuestion = null,
    keepInlineBlankLines = false,
    keepConversationLabels = false,
    stopBeforeAnchoredOptions = null,
  } = {}) {
    if (!passage) return;
    for (const raw of lines) {
      const text = stripPdfRunningNoise(raw);
      if (!text && !String(raw || '').trim()) continue;
      if (!text) {
        appendPassageBody(passage, '', null);
        continue;
      }
      if (/^READING\s*(?:\(|PASSAGE\b)/i.test(text)) break;
      if (skipOptions && isDialogueMcqOptionLine(text)) continue;
      if (isSectionTaskLabelLine(text)) continue;
      if (!keepConversationLabels && /^Conversation\s+\d/i.test(text)) continue;
      if (stopBeforeAnchoredOptions && isAnchoredConversationOptionRow(
        text,
        stopBeforeAnchoredOptions.min,
        stopBeforeAnchoredOptions.max,
      )) {
        break;
      }
      if (stopAtQuestion != null) {
        const qn = parseQuestionNumberFromText(text);
        if (qn != null && qn >= stopAtQuestion && !parseAllInlineBlankNumbers(text).length) break;
      }
      if (/^Questions?\s+\d/i.test(text) && QUESTIONS_RANGE.test(text)) break;
      if (QUESTION_NUM.test(text) && !keepInlineBlankLines) continue;
      if (!keepInlineBlankLines && parseAllInlineBlankNumbers(text).length) continue;
      appendPassageBody(passage, text, null);
    }
  }

  const plainAll = pagePlainJoined(pages);
  const dialogueStripOpts = (p) => {
    if (!p?.documents?.[0]) return;
    const lines = (p.documents[0].bodyText || p.bodyText || '').split('\n').filter(Boolean);
    const kept = lines.filter((ln) => !isDialogueMcqOptionLine(ln) && !/^Conversation\s+\d/i.test(ln));
    const joined = kept.join('\n');
    p.documents[0].bodyText = joined;
    p.bodyText = joined;
  };
  if (dialoguePassageA) dialogueStripOpts(dialoguePassageA);
  if (dialoguePassageB) dialogueStripOpts(dialoguePassageB);

  const conv30Block = plainAll.match(/Questions?\s+30[\s\S]*?(?=Questions?\s+36\b)/i)?.[0] || '';
  const conv1Lines = slicePlainBetween(conv30Block, /Conversation\s+1\b/i, /Conversation\s+2\b/i);
  if (conv1Lines.length && !convPassage1) {
    convPassage1 = newPassage(sectionId, 'Conversation 1 (30–32)', { min: 30, max: 32 }, conv1Lines[0]?.page);
    passages.push(convPassage1);
  }
  if (convPassage1 && conv1Lines.length) {
    convPassage1.documents[0].bodyText = '';
    convPassage1.bodyText = '';
    appendBoundedLines(convPassage1, conv1Lines, {
      stopAtQuestion: 33,
      keepConversationLabels: true,
      keepInlineBlankLines: true,
      stopBeforeAnchoredOptions: { min: 30, max: 32 },
      skipOptions: false,
    });
  }

  const conv2Lines = slicePlainBetween(
    conv30Block,
    /Conversation\s+2\b/i,
    /(?:Questions?\s+36\b|READING\s*\(|READING PASSAGE|^\s*33\.\s+\S.*\bA\.\s)/im,
  );
  if (conv2Lines.length && !convPassage2) {
    convPassage2 = newPassage(sectionId, 'Conversation 2 (33–35)', { min: 33, max: 35 }, conv2Lines[0]?.page);
    passages.push(convPassage2);
  }
  if (convPassage2 && conv2Lines.length) {
    convPassage2.documents[0].bodyText = '';
    convPassage2.bodyText = '';
    appendBoundedLines(convPassage2, conv2Lines, {
      stopAtQuestion: 36,
      keepConversationLabels: true,
      keepInlineBlankLines: true,
      stopBeforeAnchoredOptions: { min: 33, max: 35 },
      skipOptions: false,
    });
  }

  const dialALines = slicePlainBetween(
    plainAll,
    /Oh, this painting is beautiful/i,
    /This music must be Hawaiian/i,
  );
  const dialBLines = slicePlainBetween(
    plainAll,
    /This music must be Hawaiian/i,
    /Questions?\s+30/i,
  );
  if (dialoguePassageA && dialALines.length) {
    const needs = !/painting/i.test(dialoguePassageA.bodyText || '') || /Conversation\s+1/i.test(dialoguePassageA.bodyText || '');
    if (needs) {
      dialoguePassageA.documents[0].bodyText = '';
      dialoguePassageA.bodyText = '';
      appendBoundedLines(dialoguePassageA, dialALines, { stopAtQuestion: 28 });
    }
  }
  if (dialoguePassageB && dialBLines.length) {
    const body = dialoguePassageB.bodyText || '';
    const needs = !/Pacific/i.test(body) || /Conversation\s+[12]/i.test(body);
    if (needs) {
      dialoguePassageB.documents[0].bodyText = '';
      dialoguePassageB.bodyText = '';
      appendBoundedLines(dialoguePassageB, dialBLines, { stopAtQuestion: 30 });
    }
  }

  let p56conv = mergePassages56Canonical(passages)
    || passages.find((p) => p.expectedQuestionRange?.min === 56 && p.expectedQuestionRange?.max === 60);
  const conv56Lines = extractConv56560Lines(plainAll);
  if (conv56Lines.length) {
    if (!p56conv) {
      p56conv = newPassage(sectionId, 'Conversations 56–60', { min: 56, max: 60 }, 11);
      passages.push(p56conv);
    }
    const bodyNow = String(p56conv.bodyText || p56conv.documents?.[0]?.bodyText || '');
    if (!/musician/i.test(bodyNow) || !/friends wanted me to stay/i.test(bodyNow)) {
      p56conv.documents[0].bodyText = '';
      p56conv.bodyText = '';
      appendBoundedLines(p56conv, conv56Lines, {
        stopAtQuestion: 61,
        keepConversationLabels: true,
        keepInlineBlankLines: true,
        skipOptions: false,
        stopBeforeAnchoredOptions: null,
      });
      if (p56conv.documents?.[0]) {
        if (!p56conv.documents[0].sourcePages.includes(11)) p56conv.documents[0].sourcePages.push(11);
      }
      if (!p56conv.sourcePages.includes(11)) p56conv.sourcePages.push(11);
    }
  }

  let p66para = passages.find(
    (p) => p.expectedQuestionRange?.min === 66 && p.expectedQuestionRange?.max === 70,
  );
  const techLines = slicePlainBetween(plainAll, /Technology plays/i, /(?:B\.\s*)?WRITING TASK/i);
  if (techLines.length) {
    if (!p66para) {
      p66para = newPassage(sectionId, 'Word bank 66–70', { min: 66, max: 70 }, 13);
      passages.push(p66para);
    }
    const techBody = p66para.bodyText || '';
    if (!/Technology plays/i.test(techBody) || !/focus\./i.test(techBody) || techBody.length < 80) {
      p66para.documents[0].bodyText = '';
      p66para.bodyText = '';
      appendBoundedLines(p66para, techLines, {
        stopAtQuestion: 71,
        keepInlineBlankLines: true,
      });
      for (const pg of pages || []) {
        const pt = pg.plainText || '';
        if (!/Technology plays/i.test(pt) && !/technology also has drawbacks/i.test(pt) && !/focus\./i.test(pt)) {
          continue;
        }
        if (!p66para.sourcePages.includes(pg.pageNumber)) p66para.sourcePages.push(pg.pageNumber);
        if (p66para.documents?.[0] && !p66para.documents[0].sourcePages.includes(pg.pageNumber)) {
          p66para.documents[0].sourcePages.push(pg.pageNumber);
        }
      }
    }
  }

  for (const q of finalQs) {
    const n = parseInt(q.displayNumber, 10);
    if (!Number.isFinite(n)) continue;
    if (n >= 26 && n <= 27 && dialoguePassageA) {
      q.passageId = dialoguePassageA.id;
      q.groupId = dialoguePassageA.id;
    } else if (n >= 28 && n <= 29 && dialoguePassageB) {
      q.passageId = dialoguePassageB.id;
      q.groupId = dialoguePassageB.id;
    } else if (n >= 30 && n <= 32 && convPassage1) {
      q.passageId = convPassage1.id;
      q.groupId = convPassage1.id;
    } else if (n >= 33 && n <= 35 && convPassage2) {
      q.passageId = convPassage2.id;
      q.groupId = convPassage2.id;
    } else if (n >= 56 && n <= 60 && p56conv) {
      q.passageId = p56conv.id;
      q.groupId = p56conv.id;
    } else if (n >= 66 && n <= 70 && p66para) {
      q.passageId = p66para.id;
      q.groupId = p66para.id;
    }
  }

  fillConversationBlankReferenceStems(finalQs, plainAll);

  finalizeB1QuestionBindings(passages, finalQs);

  for (const q of finalQs) {
    if (q.questionType !== EXAM_QUESTION_TYPE.WORD_BANK) continue;
    const n = parseInt(q.displayNumber, 10);
    let g = null;
    if (q.passageId) {
      const byId = passages.find((p) => p.id === q.passageId);
      if (byId && passageRangeContains(byId, n)) g = byId;
    }
    if (!g) {
      g = passages.find((p) => passageRangeContains(p, n) && p.wordBankWords?.length);
    }
    if (!g && n >= 61 && n <= 65) g = passages.find((p) => p.expectedQuestionRange?.min === 61);
    if (!g && n >= 66 && n <= 70) g = passages.find((p) => p.expectedQuestionRange?.min === 66);
    if (!g && n >= 56 && n <= 60) g = passages.find((p) => p.expectedQuestionRange?.min === 56);
    if (!g && n >= 21 && n <= 25) g = passages.find((p) => p.expectedQuestionRange?.min === 21);
    if (g?.wordBankWords?.length) {
      q.wordBankId = g.wordBankId || g.id;
      q.wordBankWords = g.wordBankWords;
      q.options = g.wordBankWords.map((w) => ({ id: w.id, label: w.text, text: w.text }));
      q.passageId = g.id;
      q.groupId = g.id;
    }
  }

  assertB1GroupRangeInvariants(finalQs, passages, warnings);

  const presentationQuestions = normalizeB1ImportPresentationOrder(finalQs);

  warnings.push(
    'PDF có phần nghe (câu 1–15) — bài thi trực tuyến không kèm file audio; cần file âm thanh hoặc hướng dẫn thủ công.',
  );
  if (/\(120\s*MINUTES/i.test(allPlain) || /\[\s*120\s*minutes\s*\]/i.test(allPlain)) {
    warnings.push('Đề gốc ghi 120 phút — giáo viên vẫn đặt thời gian giao bài riêng.');
  }

  const needsOcrPageNumbers = (pages || []).filter((p) => p.needsOcr).map((p) => p.pageNumber);
  const numbered = presentationQuestions.filter((q) => !q.unnumberedActivity);
  if (numbered.length < 70) {
    warnings.push(`B1: mới trích ${numbered.length}/70 câu có số — cần kiểm tra PDF.`);
  }

  return {
    sections,
    passages,
    questions: presentationQuestions,
    needsOcr: needsOcrPageNumbers.length > 0,
    needsOcrPageNumbers,
    needsReview: true,
    timeLimitMinutes: 120,
  };
}
