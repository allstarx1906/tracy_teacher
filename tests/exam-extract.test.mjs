import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildSampleExamPdf,
  buildBlankDigitalPdf,
  buildTwoColumnExamPdf,
  buildDualColumnPart5Pdf,
  buildWrappedStemOptionsPdf,
  buildInlineFirstOptionPdf,
  buildPassageWithSideQuestionsPdf,
  buildSmallBaselineFontPdf,
  buildSingleRightColumnQuestionPdf,
  buildFullWidthPassageDualQuestionsPdf,
  buildPreviousPageContextPdf,
  buildBareNumberRangePdf,
  buildPart6FourQuestionPdf,
  buildChooseTwoUnsupportedPdf,
  buildProseSixtyNextPageRangeOneToFourPdf,
  buildGridBoxOptionsQuestionPdf,
  buildRasterImageOnlyPdf,
  buildListeningPart2InstructionBleedPdf,
  buildCambridgeReadingPart3Pdf,
  buildExplicitListeningHeaderOnlyPdf,
  buildDualColumnStaggeredStemPdf,
  buildQuestionPageWithBlankPagePdf,
  buildOffViewportTextOnlyPdf,
  buildOffViewportPathOnlyPdf,
  buildVisiblePathInkPdf,
  buildTrailingBackmatterDualColumnPdf,
  buildTerminalBackcoverAfterTestEndPdf,
  buildSchoolMidtermVocabularyPdf,
  buildGrade7ExerciseScopedPdf,
  buildGrammarTheoryOutlinePdf,
  buildUnsupportedGapFillBlockPdf,
  buildGrade7UndottedInlineRowPdf,
  buildSampleTestResetsExerciseScopePdf,
  buildGrade7Ex3AfterTheoryProsePdf,
  buildGrade7Ex5ClozeSuriPdf,
  buildRevisionHaveEverTheoryPdf,
  buildSentenceOrderingLowercaseStemPdf,
  buildHealthyDietPassageBindingPdf,
  buildHealthyDietMismatchedDeclaredRangePdf,
  buildGrade7Ex5MultiWordInlineOptionPdf,
  buildSchoolOrphanUnsupportedPassagePdf,
  buildSchoolMessageVisualContextMissingPdf,
  buildSchoolMessageVisualContextWithTextPdf,
  buildSampleTestAdjacentReadGroupsPdf,
  buildSampleTestMarkWrappedCloze1718Pdf,
  buildSampleTestExplicitStemCloze1718Pdf,
} from './exam-fixtures.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function loadExtract() {
  return import('../server/exam-extract.mjs');
}

async function loadDomain() {
  return import('../dist/exam-domain.js');
}

async function assertReadingContentClean(draft, label = '') {
  const { scanExamContentContamination } = await loadDomain();
  const hits = scanExamContentContamination(draft);
  assert.equal(hits.length, 0, `${label} contamination: ${JSON.stringify(hits)}`);
  for (const q of draft.questions) {
    for (const o of q.options || []) {
      assert.ok(!/Item Number\s+Key/i.test(o.text || ''), `${label} q${q.displayNumber} opt ${o.id}`);
      assert.ok(!/Sample Form Correct Answers/i.test(o.text || ''), `${label} q${q.displayNumber} opt ${o.id}`);
    }
    assert.ok(!/Stop!\s*This is the end/i.test(q.stemText || ''), `${label} q${q.displayNumber} stem`);
  }
  for (const raw of draft.passages || []) {
    const body = raw.bodyText
      || (raw.documents || []).map((d) => d.bodyText).join(' ');
    assert.ok(!/SCRIPT FOR THE LISTENING/i.test(body || ''), `${label} passage body`);
  }
}

test('exam extract: sample PDF still parses', async () => {
  const { buildDraftFromPdf } = await loadExtract();
  const draft = await buildDraftFromPdf(buildSampleExamPdf(), {
    allPages: [1],
    keyPages: [2],
  });
  assert.ok(draft.questions.length >= 2);
  assert.equal(draft.needsOcr, false);
  assert.ok(draft.questions[0].options.filter((o) => o.text.trim()).length >= 2);
});

test('exam extract: genuinely blank page is not treated as OCR', async () => {
  const { buildDraftFromPdf } = await loadExtract();
  const draft = await buildDraftFromPdf(buildBlankDigitalPdf(), { allPages: [1] });
  assert.equal(draft.needsOcr, false);
  assert.ok(draft.warnings.some((w) => /trang trắng/i.test(w)));
});

test('exam extract: raster image-only page needs OCR', async () => {
  const { buildDraftFromPdf } = await loadExtract();
  const draft = await buildDraftFromPdf(buildRasterImageOnlyPdf(), { allPages: [1] });
  assert.equal(draft.needsOcr, true);
  assert.deepEqual(draft.needsOcrPageNumbers, [1]);
  assert.ok(draft.warnings.some((w) => /hình\/ảnh/i.test(w)));
});

test('exam extract: blank pages in selection do not block when questions parse', async () => {
  const { buildDraftFromPdf } = await loadExtract();
  const draft = await buildDraftFromPdf(buildQuestionPageWithBlankPagePdf(), {
    allPages: [1, 2],
    keyPages: [3],
  });
  assert.equal(draft.needsOcr, false);
  assert.equal(draft.questions.length, 1);
  assert.ok(draft.warnings.some((w) => /Trang 2.*trang trắng/i.test(w)));
});

test('exam extract: extractPdfPages classifies blank vs raster', async () => {
  const { extractPdfPages } = await loadExtract();
  const blank = await extractPdfPages(buildBlankDigitalPdf(), [1]);
  assert.equal(blank[0].isBlankPage, true);
  assert.equal(blank[0].needsOcr, false);
  const raster = await extractPdfPages(buildRasterImageOnlyPdf(), [1]);
  assert.equal(raster[0].isBlankPage, false);
  assert.equal(raster[0].needsOcr, true);
});

test('exam extract: off-viewport paint operators raster-check as blank', async () => {
  const { extractPdfPages } = await loadExtract();
  for (const build of [buildOffViewportTextOnlyPdf, buildOffViewportPathOnlyPdf]) {
    const pages = await extractPdfPages(build(), [1]);
    assert.equal(pages[0].isBlankPage, true, build.name);
    assert.equal(pages[0].needsOcr, false, build.name);
  }
});

test('exam extract: visible viewport ink stays OCR without text layer', async () => {
  const { extractPdfPages } = await loadExtract();
  const pages = await extractPdfPages(buildVisiblePathInkPdf(), [1]);
  assert.equal(pages[0].isBlankPage, false);
  assert.equal(pages[0].needsOcr, true);
});

test('exam extract: viewportImageDataIsStrictlyWhite rejects any non-white channel', async () => {
  const { viewportImageDataIsStrictlyWhite } = await loadExtract();
  assert.equal(viewportImageDataIsStrictlyWhite({ data: new Uint8ClampedArray([255, 255, 255, 255]) }), true);
  assert.equal(viewportImageDataIsStrictlyWhite({ data: new Uint8ClampedArray([254, 255, 255, 255]) }), false);
});

test('exam extract: two-column fixture', async () => {
  const { buildDraftFromPdf } = await loadExtract();
  const draft = await buildDraftFromPdf(buildTwoColumnExamPdf(), { allPages: [1], keyPages: [2] });
  assert.equal(draft.questions.length, 2);
  assert.equal(draft.questions[0].correctOptionId, 'A');
  assert.equal(draft.questions[0].options.find((o) => o.id === 'A')?.text, 'one');
  assert.equal(draft.questions[1].correctOptionId, 'B');
});

test('exam extract: dual column part 5 ordering and options', async () => {
  const { buildDraftFromPdf } = await loadExtract();
  const draft = await buildDraftFromPdf(buildDualColumnPart5Pdf(), { allPages: [1], keyPages: [2] });
  assert.equal(draft.questions.length, 4);
  assert.deepEqual(
    draft.questions.map((q) => q.displayNumber),
    ['101', '102', '103', '104'],
  );
  for (const q of draft.questions) {
    assert.equal(q.options.filter((o) => o.text.trim()).length, 4, q.displayNumber);
  }
  assert.equal(draft.questions[0].correctOptionId, 'A');
  assert.equal(draft.questions[1].correctOptionId, 'B');
  assert.equal(draft.questions[2].correctOptionId, 'C');
  assert.equal(draft.questions[3].correctOptionId, 'D');
});

test('exam extract: wrapped stem and options', async () => {
  const { buildDraftFromPdf } = await loadExtract();
  const draft = await buildDraftFromPdf(buildWrappedStemOptionsPdf(), { allPages: [1], keyPages: [2] });
  assert.equal(draft.questions.length, 1);
  assert.match(draft.questions[0].stemText, /First line/);
  assert.match(draft.questions[0].stemText, /second line/);
  assert.equal(draft.questions[0].correctOptionId, 'C');
});

test('exam extract: inline first option line', async () => {
  const { buildDraftFromPdf } = await loadExtract();
  const draft = await buildDraftFromPdf(buildInlineFirstOptionPdf(), { allPages: [1], keyPages: [2] });
  const q = draft.questions.find((x) => x.displayNumber === '131');
  assert.ok(q, 'question 131');
  assert.equal(q.options.find((o) => o.id === 'A')?.text, 'choice-one');
  assert.equal(q.correctOptionId, 'A');
  assert.match(q.stemText, /Chọn từ\/câu phù hợp/);
  assert.ok(draft.passages.some((p) => /131-134/.test(p.title)));
});

test('exam extract: single right-column question with left sibling', async () => {
  const { buildDraftFromPdf } = await loadExtract();
  const draft = await buildDraftFromPdf(buildSingleRightColumnQuestionPdf(), { allPages: [1], keyPages: [2] });
  assert.equal(draft.questions.length, 2);
  const q151 = draft.questions.find((x) => x.displayNumber === '151');
  assert.ok(q151, '151');
  assert.equal(q151.options.filter((o) => o.text.trim()).length, 4);
  assert.equal(q151.correctOptionId, 'C');
});

test('exam extract: full-width passage above dual questions', async () => {
  const { buildDraftFromPdf } = await loadExtract();
  const draft = await buildDraftFromPdf(buildFullWidthPassageDualQuestionsPdf(), { allPages: [1], keyPages: [2] });
  assert.equal(draft.questions.length, 2);
  const p = draft.passages.find((x) => /196-200/.test(x.title));
  assert.ok(p?.bodyText.includes('Please review'));
  const q196 = draft.questions.find((x) => x.displayNumber === '196');
  assert.ok(q196);
  assert.ok(!q196.options.some((o) => /Please review/i.test(o.text)));
});

test('exam extract: resolveImportQuestionPages default excludes key pages', async () => {
  const { resolveImportQuestionPages } = await loadExtract();
  const pages = resolveImportQuestionPages({ numPages: 4, keyPages: [2, 4], questionPages: null });
  assert.deepEqual(pages, [1, 3]);
});

test('exam extract: allPages selection excludes key pages instead of overlap error', async () => {
  const { resolveImportQuestionPages } = await loadExtract();
  const pages = resolveImportQuestionPages({
    numPages: 34,
    allPages: [...Array(34)].map((_, i) => i + 1),
    keyPages: [32],
  });
  assert.ok(!pages.includes(32));
  assert.equal(pages.length, 33);
});

test('exam extract: trailing backmatter and script pages do not poison options', async () => {
  const { buildDraftFromPdf } = await loadExtract();
  const draft = await buildDraftFromPdf(buildTrailingBackmatterDualColumnPdf(), {
    allPages: [1, 2, 3, 4],
    keyPages: [4],
  });
  assert.deepEqual(
    draft.questions.map((q) => q.displayNumber).sort((a, b) => Number(a) - Number(b)),
    ['9', '10', '11'],
  );
  const q10 = draft.questions.find((q) => q.displayNumber === '10');
  assert.equal(q10.options.find((o) => o.id === 'D')?.text, 'Thursday exact');
  const q11 = draft.questions.find((q) => q.displayNumber === '11');
  assert.equal(q11.options.find((o) => o.id === 'D')?.text, 'The instructions were too confusing.');
  await assertReadingContentClean(draft, 'backmatter-fixture');
  assert.ok(!draft.warnings.some((w) => /Phát hiện nội dung đuôi PDF/.test(w)));
});

test('exam extract: terminal test-end then back-cover page does not append prose', async () => {
  const { buildDraftFromPdf } = await loadExtract();
  const draft = await buildDraftFromPdf(buildTerminalBackcoverAfterTestEndPdf(), {
    allPages: [1, 2, 3],
    keyPages: [],
  });
  assert.deepEqual(
    draft.questions.map((q) => q.displayNumber).sort((a, b) => Number(a) - Number(b)),
    ['1', '2'],
  );
  const body = draft.passages[0]?.bodyText
    || draft.passages[0]?.documents?.[0]?.bodyText
    || '';
  assert.ok(!/International English assessment programs/i.test(body));
  assert.ok(!/Copyright notice/i.test(body));
  await assertReadingContentClean(draft, 'terminal-backcover');
});

test('exam extract: resolveImportQuestionPages honors questionPageRange', async () => {
  const { resolveImportQuestionPages } = await loadExtract();
  const pages = resolveImportQuestionPages({
    numPages: 40,
    keyPages: [32],
    questionPageRange: '12-15',
  });
  assert.deepEqual(pages, [12, 13, 14, 15]);
});

test('exam extract: content digest includes parser version', async () => {
  const { examContentDigest, EXAM_EXTRACT_PARSER_VERSION } = await loadExtract();
  const buf = Buffer.from('pdf-bytes');
  const a = examContentDigest(buf, { questionPages: [1], keyPages: [2] });
  const b = examContentDigest(buf, {
    questionPages: [1],
    keyPages: [2],
    parserVersion: EXAM_EXTRACT_PARSER_VERSION,
  });
  assert.equal(a, b);
  const legacy = examContentDigest(buf, {
    questionPages: [1],
    keyPages: [2],
    parserVersion: 1,
  });
  assert.notEqual(a, legacy);
});

test('exam extract: passage header with side-by-side questions', async () => {
  const { buildDraftFromPdf } = await loadExtract();
  const draft = await buildDraftFromPdf(buildPassageWithSideQuestionsPdf(), { allPages: [1], keyPages: [2] });
  assert.equal(draft.questions.length, 2);
  assert.ok(draft.passages.some((p) => p.bodyText.includes('Shared passage')));
});

test('exam extract: small baseline font does not merge options into stems', async () => {
  const { buildDraftFromPdf } = await loadExtract();
  const draft = await buildDraftFromPdf(buildSmallBaselineFontPdf(), { allPages: [1], keyPages: [2] });
  assert.equal(draft.questions.length, 2);
  assert.equal(draft.questions[0].options.length, 2);
  assert.equal(draft.questions[0].correctOptionId, 'A');
});

test('exam extract: does not pad blank options when incomplete', async () => {
  const { parseQuestionsFromPages } = await loadExtract();
  const warnings = [];
  const parsed = parseQuestionsFromPages([{
    pageNumber: 1,
    needsOcr: false,
    lines: [[{ text: '1. Broken question?', bbox: { x: 0, y: 0, w: 1, h: 10, page: 1 } }]],
  }], warnings);
  assert.equal(parsed.questions.length, 1);
  assert.equal(parsed.questions[0].options.length, 0);
  assert.equal(parsed.questions[0].incomplete, true);
});

test('exam extract: previous-page passage buffers into one reading group', async () => {
  const { buildDraftFromPdf } = await loadExtract();
  const draft = await buildDraftFromPdf(buildPreviousPageContextPdf(), {
    allPages: [1, 2],
    keyPages: [3],
  });
  assert.equal(draft.questions.length, 2);
  assert.ok(!draft.questions.some((q) => q.displayNumber === '60'));
  const g = draft.passages[0];
  assert.ok(g.documents?.length >= 1);
  assert.match(g.documents[0].bodyText, /David Storey/);
  assert.equal(draft.questions[0].passageId, g.id);
  assert.equal(draft.questions[1].passageId, g.id);
});

test('exam extract: bare-number labels within declared range', async () => {
  const { buildDraftFromPdf } = await loadExtract();
  const draft = await buildDraftFromPdf(buildBareNumberRangePdf(), { allPages: [1], keyPages: [2] });
  assert.deepEqual(draft.questions.map((q) => q.displayNumber), ['11', '12']);
  assert.equal(draft.passages.length, 1);
});

test('exam extract: part 6 produces four questions without gap duplicates', async () => {
  const { buildDraftFromPdf } = await loadExtract();
  const draft = await buildDraftFromPdf(buildPart6FourQuestionPdf(), { allPages: [1], keyPages: [2] });
  assert.deepEqual(
    draft.questions.map((q) => q.displayNumber).sort(),
    ['131', '132', '133', '134'],
  );
  const nums = draft.questions.map((q) => q.displayNumber);
  assert.equal(nums.length, new Set(nums).size);
  for (const q of draft.questions) {
    assert.equal(q.options.filter((o) => o.text.trim()).length, 4, q.displayNumber);
  }
  assert.match(draft.passages[0].bodyText, /gap 131/);
});

test('exam extract: choose TWO marks group unsupported', async () => {
  const { buildDraftFromPdf } = await loadExtract();
  const draft = await buildDraftFromPdf(buildChooseTwoUnsupportedPdf(), { allPages: [1] });
  assert.ok(draft.passages.some((p) => p.unsupportedTaskType === 'choose-two'));
  assert.match(draft.passages[0].documents?.[0]?.bodyText || draft.passages[0].bodyText || '', /Shared context/);
});

test('exam extract: skips listening PART 2 instruction pseudo question on all pages', async () => {
  const { buildDraftFromPdf } = await loadExtract();
  const draft = await buildDraftFromPdf(buildListeningPart2InstructionBleedPdf(), {
    allPages: [1, 2],
    keyPages: [3],
  });
  assert.ok(!draft.questions.some((q) => q.displayNumber === '2'));
  assert.equal(draft.questions.length, 1);
  assert.equal(draft.questions[0].displayNumber, '101');
  assert.ok(draft.warnings.some((w) => /Listening/i.test(w)));
});

test('exam extract: Cambridge Reading Part 3 is not treated as Listening', async () => {
  const { buildDraftFromPdf } = await loadExtract();
  const draft = await buildDraftFromPdf(buildCambridgeReadingPart3Pdf(), {
    allPages: [1],
    keyPages: [2],
  });
  assert.deepEqual(
    draft.questions.map((q) => q.displayNumber).sort(),
    ['19', '20'],
  );
  assert.equal(draft.passages.length, 1);
  assert.ok(draft.passages[0].bodyText.includes('transport'));
  assert.ok(!draft.warnings.some((w) => /Listening/i.test(w)));
  for (const q of draft.questions) {
    assert.equal(q.options.filter((o) => o.text.trim()).length, 4, q.displayNumber);
  }
});

test('exam extract: explicit LISTENING TEST header warns without inferring from Part labels alone', async () => {
  const { buildDraftFromPdf } = await loadExtract();
  const draft = await buildDraftFromPdf(buildExplicitListeningHeaderOnlyPdf(), { allPages: [1] });
  assert.equal(draft.questions.length, 0);
  assert.equal(draft.passages.length, 0);
  assert.ok(draft.warnings.some((w) => /Listening/i.test(w)));
});

test('exam extract: dual column fixtures regression (column-major order)', async () => {
  const { buildDraftFromPdf } = await loadExtract();
  const cases = [
    {
      name: 'two-column',
      pdf: buildTwoColumnExamPdf(),
      numbers: ['1', '2'],
    },
    {
      name: 'part5-dual',
      pdf: buildDualColumnPart5Pdf(),
      numbers: ['101', '102', '103', '104'],
    },
    {
      name: 'right-column-sibling',
      pdf: buildSingleRightColumnQuestionPdf(),
      numbers: ['150', '151'],
    },
    {
      name: 'full-width-passage-dual',
      pdf: buildFullWidthPassageDualQuestionsPdf(),
      numbers: ['196', '197'],
    },
    {
      name: 'staggered-176-180',
      pdf: buildDualColumnStaggeredStemPdf(),
      numbers: ['176', '177', '178', '179', '180'],
    },
  ];
  for (const c of cases) {
    const draft = await buildDraftFromPdf(c.pdf, { allPages: [1], keyPages: [2] });
    assert.deepEqual(
      draft.questions.map((q) => q.displayNumber).sort(),
      c.numbers.sort(),
      c.name,
    );
    const minOpts = c.name === 'two-column' ? 2 : 4;
    for (const q of draft.questions) {
      assert.ok(
        q.options.filter((o) => o.text.trim()).length >= minOpts,
        `${c.name} q${q.displayNumber}`,
      );
    }
  }
  const staggered = await buildDraftFromPdf(buildDualColumnStaggeredStemPdf(), {
    allPages: [1],
    keyPages: [2],
  });
  const q176 = staggered.questions.find((q) => q.displayNumber === '176');
  const q179 = staggered.questions.find((q) => q.displayNumber === '179');
  assert.ok(q176?.stemText.includes('Why visit'));
  assert.ok(q179?.stemText.includes('NOT offered'));
  const q180 = staggered.questions.find((q) => q.displayNumber === '180');
  assert.match(q180.stemText, /within 24 hours\?/i);
});

test('exam extract: dual column staggered stem completes question 180 with four options', async () => {
  const { buildDraftFromPdf } = await loadExtract();
  const draft = await buildDraftFromPdf(buildDualColumnStaggeredStemPdf(), { allPages: [1], keyPages: [2] });
  const nums = draft.questions.map((q) => q.displayNumber).sort();
  assert.deepEqual(nums, ['176', '177', '178', '179', '180']);
  const q180 = draft.questions.find((q) => q.displayNumber === '180');
  assert.ok(q180, '180');
  assert.match(q180.stemText, /24 hours\?/);
  assert.equal(q180.options.filter((o) => o.text.trim()).length, 4);
  assert.equal(q180.correctOptionId, 'D');
  const q179 = draft.questions.find((q) => q.displayNumber === '179');
  assert.ok(q179);
  assert.equal(q179.options.filter((o) => o.text.trim()).length, 4);
  assert.equal(q179.correctOptionId, 'B');
});

test('exam extract: empty key pages yields Chưa có trang đáp án warning', async () => {
  const { buildDraftFromPdf } = await loadExtract();
  const draft = await buildDraftFromPdf(buildSampleExamPdf(), { allPages: [1], keyPages: [] });
  assert.ok(draft.warnings.some((w) => /Chưa có trang (?:khóa|đáp án)/i.test(w)));
  assert.equal(draft.questions.every((q) => !q.correctOptionId), true);
});

test('ETS page 19 dual column pages (opt-in EXAM_ETS_PAGES919_FIXTURE)', async (t) => {
  const fixturePath = process.env.EXAM_ETS_PAGES919_FIXTURE;
  if (!fixturePath) {
    t.skip('Set EXAM_ETS_PAGES919_FIXTURE to ets-18-19-32.private.json path');
    return;
  }
  if (!fs.existsSync(fixturePath)) {
    t.skip('Missing EXAM_ETS_PAGES919_FIXTURE file');
    return;
  }
  const pages = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  const { parseQuestionsFromPages, parseAnswerKeyFromPages } = await loadExtract();
  const warnings = [];
  const parsed = parseQuestionsFromPages(pages, warnings);
  const keyPage = pages.find((p) => p.pageNumber === 32);
  if (keyPage) {
    parseAnswerKeyFromPages([keyPage], parsed.sections, parsed.questions, warnings);
  }
  const group = parsed.passages.find((p) => p.expectedQuestionRange?.min === 176);
  assert.ok(group, 'group 176-180');
  assert.equal(group.documents?.length, 2);
  assert.ok(group.documents.every((d) => d.requiresReview === true));
  const nums = parsed.questions.map((q) => q.displayNumber).sort();
  assert.deepEqual(nums, ['176', '177', '178', '179', '180']);
  const q180 = parsed.questions.find((q) => q.displayNumber === '180');
  assert.match(q180.stemText, /24 hours\?/);
  assert.equal(q180.options.filter((o) => o.text.trim()).length, 4);
  assert.equal(q180.correctOptionId, 'D');
});

test('exam extract: prose line 60. on passage page is not a question', async () => {
  const { buildDraftFromPdf } = await loadExtract();
  const draft = await buildDraftFromPdf(buildProseSixtyNextPageRangeOneToFourPdf(), {
    allPages: [1, 2],
    keyPages: [3],
  });
  assert.ok(!draft.questions.some((q) => q.displayNumber === '60'));
  assert.deepEqual(
    draft.questions.map((q) => q.displayNumber),
    ['1', '2', '3', '4'],
  );
  const body = draft.passages[0].documents?.[0]?.bodyText || draft.passages[0].bodyText || '';
  assert.match(body, /Skill Team/);
  assert.match(body, /David Storey/);
  assert.match(body, /60\. An employee/);
});

test('exam extract: 2x2 boxed options split by geometry', async () => {
  const { buildDraftFromPdf } = await loadExtract();
  const draft = await buildDraftFromPdf(buildGridBoxOptionsQuestionPdf(), { allPages: [1], keyPages: [2] });
  const q = draft.questions.find((x) => x.displayNumber === '15');
  assert.ok(q, 'question 15');
  assert.equal(q.options.filter((o) => o.text.trim()).length, 4);
  assert.equal(q.correctOptionId, 'B');
  assert.match(q.options.find((o) => o.id === 'A')?.text || '', /alpha/);
  assert.match(q.options.find((o) => o.id === 'B')?.text || '', /beta/);
  assert.ok(!/Turn over/i.test(q.stemText));
  assert.ok(!/alpha text/i.test(q.stemText));
});

test('reading group corpus (opt-in EXAM_READING_GROUP_SPECS)', async (t) => {
  const specsPath = process.env.EXAM_READING_GROUP_SPECS;
  if (!specsPath) {
    t.skip('Set EXAM_READING_GROUP_SPECS to private specs.json path');
    return;
  }
  const specsDir = path.dirname(specsPath);
  const specs = JSON.parse(fs.readFileSync(specsPath, 'utf8'));
  const { buildDraftFromPdf } = await loadExtract();
  for (const spec of specs) {
    if (spec.unsupported) continue;
    const pdfPath = path.resolve(specsDir, spec.file);
    if (!fs.existsSync(pdfPath)) {
      t.skip(`Missing private PDF for ${spec.id}`);
      continue;
    }
    const buffer = fs.readFileSync(pdfPath);
    const draft = await buildDraftFromPdf(buffer, {
      allPages: spec.pages,
      questionPages: spec.pages,
      keyPages: spec.key || [],
      title: spec.id,
    });
    const nums = draft.questions.map((q) => q.displayNumber);
    for (const n of spec.expectedNumbers || []) {
      assert.ok(nums.includes(String(n)), `${spec.id}: missing ${n}`);
    }
    if (spec.expectedGroups?.length === 1) {
      const eg = spec.expectedGroups[0];
      assert.equal(draft.passages.length, 1, spec.id);
      assert.equal(draft.passages[0].documents?.length || 0, eg.documents, spec.id);
    }
  }
});

test('official ETS PDF integration (opt-in via EXAM_OFFICIAL_PDF_PATH)', async (t) => {
  const pdfPath = process.env.EXAM_OFFICIAL_PDF_PATH;
  if (!pdfPath) {
    t.skip('Set EXAM_OFFICIAL_PDF_PATH to run official PDF regression');
    return;
  }
  const baselinePath = process.env.EXAM_OFFICIAL_BASELINE_JSON
    || path.join(__dirname, 'exam-official-expected.json');
  if (!fs.existsSync(baselinePath)) {
    t.skip('Set EXAM_OFFICIAL_BASELINE_JSON to expected counts/keys JSON');
    return;
  }
  const expected = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
  const buffer = fs.readFileSync(pdfPath);
  const { buildDraftFromPdf } = await loadExtract();
  const draft = await buildDraftFromPdf(buffer, {
    allPages: expected.questionPages,
    questionPages: expected.questionPages,
    keyPages: expected.keyPages,
    title: 'Official integration',
  });
  assert.equal(draft.needsOcr, false);
  assert.equal(draft.questions.length, expected.expectedQuestions);
  const nums = draft.questions.map((q) => q.displayNumber);
  const dup = nums.filter((n, i) => nums.indexOf(n) !== i);
  assert.equal(dup.length, 0, `duplicate numbers: ${dup.join(',')}`);
  for (const n of expected.expectedQuestionNumbers || Object.keys(expected.expectedKeys || {})) {
    assert.ok(nums.includes(String(n)), `missing question ${n}`);
  }
  const badOpts = draft.questions.filter(
    (q) => q.options.length !== 4 || q.options.some((o) => !o.text.trim()),
  );
  assert.equal(badOpts.length, 0, `bad options: ${badOpts.map((q) => q.displayNumber).join(',')}`);
  if (expected.expectedKeys) {
    for (const [num, key] of Object.entries(expected.expectedKeys)) {
      const q = draft.questions.find((x) => x.displayNumber === String(num));
      assert.equal(q?.correctOptionId, key, `key ${num}`);
    }
  }
  await assertReadingContentClean(draft, 'official-12-21');
  const q200 = draft.questions.find((q) => q.displayNumber === '200');
  assert.equal(q200?.options.find((o) => o.id === 'D')?.text, 'The instructions were too confusing.');
  const q198 = draft.questions.find((q) => q.displayNumber === '198');
  assert.ok(q198?.options.find((o) => o.id === 'D')?.text);
  assert.ok(!/Stop!\s*This is the end/i.test(q198.options.find((o) => o.id === 'D')?.text || ''));
  const withBlankSeparators = await buildDraftFromPdf(buffer, {
    questionPages: [2, ...expected.questionPages, 33],
    keyPages: expected.keyPages,
    title: 'Official with blank pages',
  });
  assert.equal(withBlankSeparators.needsOcr, false, 'ETS blank pages 2/33 must not force OCR');
  assert.ok(
    withBlankSeparators.warnings.some((w) => /Trang 2.*trang trắng/i.test(w)),
    'blank page 2 warning',
  );

  const fullReadingPages = [...Array(34)].map((_, i) => i + 1);
  const fullNoKey = await buildDraftFromPdf(buffer, {
    allPages: fullReadingPages,
    keyPages: [],
    title: 'Official full selection no key',
  });
  assert.equal(fullNoKey.questions.length, expected.expectedQuestions);
  await assertReadingContentClean(fullNoKey, 'official-full-34-no-key');
  const fullQ200 = fullNoKey.questions.find((q) => q.displayNumber === '200');
  assert.equal(fullQ200?.options.find((o) => o.id === 'D')?.text, 'The instructions were too confusing.');
});

test('exam extract: parser version bumped for user PDF import cache bust', async () => {
  const { EXAM_EXTRACT_PARSER_VERSION } = await loadExtract();
  assert.equal(EXAM_EXTRACT_PARSER_VERSION, 28);
});

test('exam extract: school midterm vocabulary parses q16 with three options', async () => {
  const { buildDraftFromPdf } = await loadExtract();
  const draft = await buildDraftFromPdf(buildSchoolMidtermVocabularyPdf(), { allPages: [1, 2] });
  const q16 = draft.questions.find((q) => q.displayNumber === '16');
  assert.ok(q16, 'question 16');
  assert.match(q16.stemText, /public transportation/i);
  assert.equal(q16.options.filter((o) => o.text.trim()).length, 3);
  assert.ok(q16.options.find((o) => o.id === 'A')?.text.includes('buses'));
  assert.ok(!draft.warnings.some((w) => /chưa đủ 4 lựa chọn.*16/.test(w)));
});

test('exam extract: grade7 exercise scoped numbering and inline options', async () => {
  const { buildDraftFromPdf } = await loadExtract();
  const draft = await buildDraftFromPdf(buildGrade7ExerciseScopedPdf(), { allPages: [1] });
  const ex1q1 = draft.questions.find((q) => q.displayNumber === 'ex1-1');
  const ex2q2 = draft.questions.find((q) => q.displayNumber === 'ex2-2');
  assert.ok(ex1q1, 'ex1-1');
  assert.ok(ex2q2, 'ex2-2');
  assert.match(ex1q1.stemText || '', /stress is different/i);
  assert.match(ex2q2.stemText || '', /pronunciation/i);
  assert.equal(ex1q1.options.filter((o) => o.text.trim()).length, 4);
  assert.match(ex1q1.options.find((o) => o.id === 'A')?.text || '', /dollhouse/i);
  assert.match(ex2q2.options.find((o) => o.id === 'D')?.text || '', /guess/i);
  assert.ok(!draft.questions.some((q) => /Cách dùng/.test(q.stemText || '')));
  assert.equal(ex1q1.groupId, null);
  assert.equal(ex1q1.passageId, null);
  assert.equal(ex2q2.groupId, null);
});

test('exam extract: grammar theory pages do not become fake MCQs', async () => {
  const { buildDraftFromPdf } = await loadExtract();
  const draft = await buildDraftFromPdf(buildGrammarTheoryOutlinePdf(), { allPages: [1, 2] });
  assert.equal(draft.questions.length, 0);
  assert.ok(draft.warnings.some((w) => /Không phát hiện|lý thuyết|ngữ pháp/i.test(w)));
});

test('exam extract: unsupported gap-fill block warns without fake MCQs', async () => {
  const { buildDraftFromPdf } = await loadExtract();
  const draft = await buildDraftFromPdf(buildUnsupportedGapFillBlockPdf(), { allPages: [1] });
  assert.equal(draft.questions.length, 0);
  assert.ok(draft.warnings.some((w) => /chưa hỗ trợ/i.test(w)));
});

test('exam extract: NO MORE THAN gap-fill range does not materialize numbered stems', async () => {
  const { parseQuestionsFromPages } = await loadExtract();
  const warnings = [];
  const pages = [{
    pageNumber: 1,
    needsOcr: false,
    isBlankPage: false,
    pageWidth: 612,
    lines: [
      [{ text: 'Questions 36 - 42. Complete the sentences using NO MORE THAN', bbox: { x: 72, y: 700, w: 1, h: 12, page: 1 } }],
      [{ text: 'TWO WORDS from the passage.', bbox: { x: 72, y: 680, w: 1, h: 12, page: 1 } }],
      [{ text: '36. Moxi carries a smiling face and a large drawer for storage.', bbox: { x: 81, y: 640, w: 1, h: 12, page: 1 } }],
    ],
    plainText: '',
    items: [],
  }];
  const parsed = parseQuestionsFromPages(pages, warnings);
  assert.ok(!parsed.questions.some((q) => q.displayNumber === '36'));
  assert.ok(warnings.some((w) => /chưa hỗ trợ|điền từ/i.test(w)));
});

test('exam extract: grade7 undotted inline row is separate from prior question option D', async () => {
  const { buildDraftFromPdf } = await loadExtract();
  const draft = await buildDraftFromPdf(buildGrade7UndottedInlineRowPdf(), { allPages: [1] });
  const q5 = draft.questions.find((q) => q.displayNumber === 'ex2-5');
  assert.ok(q5, 'ex2-5');
  assert.equal(q5.options.find((o) => o.id === 'D')?.text, 'of');
  const q4 = draft.questions.find((q) => q.displayNumber === 'ex2-4');
  const q6 = draft.questions.find((q) => q.displayNumber === 'ex2-6');
  assert.ok(q4, 'ex2-4');
  assert.ok(q6, 'ex2-6');
  assert.equal(q4.options.find((o) => o.id === 'D')?.text, 'person');
  assert.equal(q6.options.find((o) => o.id === 'D')?.text, 'about');
});

test('exam extract: SAMPLE TEST clears prior ex10 instruction from later questions', async () => {
  const { buildDraftFromPdf } = await loadExtract();
  const draft = await buildDraftFromPdf(buildSampleTestResetsExerciseScopePdf(), { allPages: [1] });
  const sampleQ = draft.questions.find((q) => q.displayNumber === 'sample-1');
  assert.ok(sampleQ, 'sample-1');
  assert.ok(!/Reading signs/i.test(sampleQ.stemText || ''), 'stale ex10 instruction');
  assert.ok(String(sampleQ.stemText || '').trim(), 'sample pronunciation stem');
  assert.equal(sampleQ.options.filter((o) => o.text.trim()).length, 4);
});

test('exam extract: grade7 ex3 sentence MCQs survive theory prose and prior exercise', async () => {
  const { buildDraftFromPdf } = await loadExtract();
  const draft = await buildDraftFromPdf(buildGrade7Ex3AfterTheoryProsePdf(), { allPages: [1, 2] });
  const q1 = draft.questions.find((q) => q.displayNumber === 'ex3-1');
  const q4 = draft.questions.find((q) => q.displayNumber === 'ex3-4');
  assert.ok(q1, 'ex3-1');
  assert.match(q1.stemText || '', /train usually/i);
  assert.deepEqual(q1.options.map((o) => o.id), ['A', 'B', 'C', 'D']);
  assert.ok(q4, 'ex3-4');
  assert.match(q4.stemText || '', /advice from doctors/i);
  assert.equal(q4.options.length, 4);
  assert.equal(q4.options.find((o) => o.id === 'A')?.text, 'people');
});

test('exam extract: numbered inline row keeps multi-word option D', async () => {
  const { buildDraftFromPdf } = await loadExtract();
  const draft = await buildDraftFromPdf(buildGrade7Ex5MultiWordInlineOptionPdf(), { allPages: [1] });
  const q1 = draft.questions.find((q) => q.displayNumber === 'ex5-1');
  assert.ok(q1);
  assert.deepEqual(q1.options.map((o) => o.id), ['A', 'B', 'C', 'D']);
  assert.equal(q1.options.find((o) => o.id === 'A')?.text, 'making');
  assert.equal(q1.options.find((o) => o.id === 'D')?.text, 'is making');
});

test('exam extract: grade7 ex5 cloze rows keep all options and blank stems from passage', async () => {
  const { buildDraftFromPdf } = await loadExtract();
  const draft = await buildDraftFromPdf(buildGrade7Ex5ClozeSuriPdf(), { allPages: [1] });
  const xs = [1, 2].map((n) => draft.questions.find((q) => q.displayNumber === `ex5-${n}`));
  assert.ok(xs.every(Boolean));
  const id = xs[0].passageId;
  assert.ok(id);
  assert.ok(xs.every((x) => x.passageId === id && x.stemText.trim() && x.options.length === 4));
  assert.deepEqual(xs[0].options.map((o) => o.id), ['A', 'B', 'C', 'D']);
  const g = draft.passages.find((p) => p.id === id);
  assert.match(g?.bodyText || '', /Suri/);
  assert.match(xs[0].stemText || '', /\(1\)/);
});

test('exam extract: revision HAVE + EVER theory page does not become MCQ', async () => {
  const { buildDraftFromPdf } = await loadExtract();
  const draft = await buildDraftFromPdf(buildRevisionHaveEverTheoryPdf(), { allPages: [1] });
  assert.equal(draft.questions.length, 0);
});

test('exam extract: sentence ordering keeps lowercase stems and four uppercase answers', async () => {
  const { buildDraftFromPdf } = await loadExtract();
  const draft = await buildDraftFromPdf(buildSentenceOrderingLowercaseStemPdf(), { allPages: [1] });
  const q = draft.questions.find((x) => /Put the sentences \(a-c\)/i.test(x.stemText || ''));
  assert.ok(q);
  assert.deepEqual(q.options.map((o) => o.id), ['A', 'B', 'C', 'D']);
  assert.match(q.stemText || '', /\ba\.\s+It also helps/i);
  assert.ok(q.options.every((o) => !/It also helps/i.test(o.text)));
  assert.equal(q.options.find((o) => o.id === 'D')?.text, 'c-a-b');
});

test('exam extract: HEALTHY DIET retains questions when declared range mismatches anchors', async () => {
  const { buildDraftFromPdf } = await loadExtract();
  const draft = await buildDraftFromPdf(buildHealthyDietMismatchedDeclaredRangePdf(), { allPages: [1] });
  const xs = [27, 28, 29].map((n) => draft.questions.find((x) => x.displayNumber === `ex10-${n}`));
  assert.ok(xs.every(Boolean), 'expected ex10-27..29');
  const pid = xs[0].passageId;
  assert.ok(pid);
  assert.ok(xs.every((x) => x.passageId === pid));
  assert.ok(draft.warnings.some((w) => /31-36|31.*36|đối chiếu/i.test(w)));
});

test('exam extract: HEALTHY DIET passage binds questions 27-29', async () => {
  const { buildDraftFromPdf } = await loadExtract();
  const draft = await buildDraftFromPdf(buildHealthyDietPassageBindingPdf(), { allPages: [1] });
  const xs = [27, 28, 29].map((n) => draft.questions.find((x) => x.displayNumber === `ex10-${n}`));
  assert.ok(xs.every(Boolean));
  const pid = xs[0].passageId;
  assert.ok(pid);
  assert.ok(xs.every((x) => x.passageId === pid));
  assert.ok(xs.every((x) => x.stemText?.trim() && x.options.length === 4));
  const q28 = draft.questions.find((q) => q.displayNumber === 'ex10-28');
  assert.deepEqual(q28.options.map((o) => o.id), ['A', 'B', 'C', 'D']);
  assert.equal(q28.options.find((o) => o.id === 'B')?.text, 'Writing');
  assert.equal(q28.options.find((o) => o.id === 'C')?.text, 'Reading');
  assert.equal(q28.options.find((o) => o.id === 'D')?.text, 'Drawing');
  const q29 = draft.questions.find((q) => q.displayNumber === 'ex10-29');
  assert.deepEqual(q29.options.map((o) => o.id), ['A', 'B', 'C', 'D']);
  const g = draft.passages.find((p) => p.id === pid);
  assert.match(g?.bodyText || '', /important matters/i);
  assert.doesNotMatch(g?.bodyText || '', /writing task should not/i);
  assert.doesNotMatch(g?.bodyText || '', /Questions 30/i);
  assert.ok(!draft.questions.some((q) => q.displayNumber === 'ex10-30'));
});

test('exam extract: school output prunes orphan unsupported passages', async () => {
  const { buildDraftFromPdf } = await loadExtract();
  const draft = await buildDraftFromPdf(buildSchoolOrphanUnsupportedPassagePdf(), { allPages: [1] });
  assert.equal(draft.questions.length, 2);
  assert.ok(draft.questions.every((q) => /^ex1-/.test(q.displayNumber)));
  assert.match(draft.questions[0].stemText || '', /underlined part/i);
  assert.equal(draft.passages.length, 0);
});

test('exam extract: school omits message MCQ without readable visual context', async () => {
  const { buildDraftFromPdf } = await loadExtract();
  const draft = await buildDraftFromPdf(buildSchoolMessageVisualContextMissingPdf(), { allPages: [1] });
  assert.equal(draft.questions.find((q) => q.displayNumber === 'ex10-2'), undefined);
  assert.ok(draft.warnings.some((w) => /ex10-2.*thiếu ngữ cảnh hình/i.test(w)));
});

test('exam extract: school retains message MCQ when passage text was extracted', async () => {
  const { buildDraftFromPdf } = await loadExtract();
  const draft = await buildDraftFromPdf(buildSchoolMessageVisualContextWithTextPdf(), { allPages: [1] });
  const q1 = draft.questions.find((q) => q.displayNumber === 'ex10-1');
  assert.ok(q1);
  assert.ok(q1.passageId);
  assert.match(draft.passages.find((p) => p.id === q1.passageId)?.bodyText || '', /English book/i);
  assert.ok(!draft.warnings.some((w) => /ex10-1.*bỏ qua/i.test(w)));
});

test('exam extract: phonetic underline exercises flag sourceReview with Vietnamese warning', async () => {
  const { buildDraftFromPdf } = await loadExtract();
  const draft = await buildDraftFromPdf(buildGrade7UndottedInlineRowPdf(), { allPages: [1] });
  const q5 = draft.questions.find((q) => q.displayNumber === 'ex2-5');
  assert.ok(q5?.sourceReview?.needsTeacherCheck);
  assert.equal(q5.sourceReview.kind, 'phonetic-underline');
  assert.ok(draft.warnings.some((w) => /ex2-5.*gạch chân trong PDF/i.test(w)));
});

test('exam extract: cloze passage blanks do not replace explicit sample 17/18 stems', async () => {
  const { buildDraftFromPdf } = await loadExtract();
  const draft = await buildDraftFromPdf(buildSampleTestExplicitStemCloze1718Pdf(), { allPages: [1] });
  const q17 = draft.questions.find((q) => q.displayNumber === 'sample-17');
  const q18 = draft.questions.find((q) => q.displayNumber === 'sample-18');
  assert.ok(q17 && q18);
  assert.ok(q17.passageId && q17.passageId === q18.passageId);
  assert.match(q17.stemText || '', /TOPIC SENTENCE/i);
  assert.doesNotMatch(q17.stemText || '', /stay strong and avoid illness/i);
  assert.match(q18.stemText || '', /Put the sentences \(a-c\)/i);
  assert.doesNotMatch(q18.stemText || '', /doing regular exercise/i);
  assert.deepEqual(q17.options.map((o) => o.id), ['A', 'B', 'C', 'D']);
  assert.deepEqual(q18.options.map((o) => o.id), ['A', 'B', 'C', 'D']);
  assert.equal(q18.options.find((o) => o.id === 'D')?.text, 'c-a-b');
  const g = draft.passages.find((p) => p.id === q17.passageId);
  assert.match(g?.bodyText || '', /\(17\)/);
  assert.match(g?.bodyText || '', /\(18\)/);
});

test('exam extract: wrapped Mark header opens sample cloze group 17-18', async () => {
  const { buildDraftFromPdf } = await loadExtract();
  const draft = await buildDraftFromPdf(buildSampleTestMarkWrappedCloze1718Pdf(), { allPages: [1] });
  const q13 = draft.questions.find((q) => q.displayNumber === 'sample-13');
  const q17 = draft.questions.find((q) => q.displayNumber === 'sample-17');
  const q18 = draft.questions.find((q) => q.displayNumber === 'sample-18');
  const q19 = draft.questions.find((q) => q.displayNumber === 'sample-19');
  assert.ok(q13 && q17 && q18 && q19);
  assert.ok(q13.passageId);
  assert.ok(q17.passageId && q17.passageId === q18.passageId);
  assert.notEqual(q13.passageId, q17.passageId);
  assert.ok(q19.passageId);
  assert.notEqual(q17.passageId, q19.passageId);
  const gAnn = draft.passages.find((p) => p.id === q13.passageId);
  assert.match(gAnn?.bodyText || '', /SCHOOL HEALTH WEEK/i);
  const gCloze = draft.passages.find((p) => p.id === q17.passageId);
  assert.match(gCloze?.bodyText || '', /stay strong and avoid illness/i);
  assert.doesNotMatch(gCloze?.bodyText || '', /SCHOOL HEALTH WEEK/i);
  const gSleep = draft.passages.find((p) => p.id === q19.passageId);
  assert.match(gSleep?.bodyText || '', /eight to ten hours/i);
});

test('exam extract: sample test keeps distinct adjacent reading groups', async () => {
  const { buildDraftFromPdf } = await loadExtract();
  const draft = await buildDraftFromPdf(buildSampleTestAdjacentReadGroupsPdf(), { allPages: [1] });
  const q13 = draft.questions.find((q) => q.displayNumber === 'sample-13');
  const q17 = draft.questions.find((q) => q.displayNumber === 'sample-17');
  const q18 = draft.questions.find((q) => q.displayNumber === 'sample-18');
  const q19 = draft.questions.find((q) => q.displayNumber === 'sample-19');
  assert.ok(q13 && q17 && q18 && q19);
  assert.ok(q13.passageId);
  assert.ok(q17.passageId && q17.passageId === q18.passageId);
  assert.notEqual(q13.passageId, q17.passageId);
  assert.ok(q19.passageId);
  assert.notEqual(q17.passageId, q19.passageId);
  const gAnn = draft.passages.find((p) => p.id === q13.passageId);
  assert.match(gAnn?.bodyText || '', /SCHOOL HEALTH WEEK/i);
  const gCloze = draft.passages.find((p) => p.id === q17.passageId);
  assert.match(gCloze?.bodyText || '', /\(17\)/);
  const gSleep = draft.passages.find((p) => p.id === q19.passageId);
  assert.match(gSleep?.bodyText || '', /eight to ten hours/i);
});

test('exam extract: option text stops before next wrapped task block header', async () => {
  const { parseQuestionsFromPages } = await loadExtract();
  const warnings = [];
  const pages = [{
    pageNumber: 4,
    needsOcr: false,
    isBlankPage: false,
    pageWidth: 612,
    lines: [
      [{ text: 'Questions 16 - 20. Choose the correct answer.', bbox: { x: 72, y: 700, w: 1, h: 12, page: 4 } }],
      [{ text: '20. The verb phrase look like means to _________', bbox: { x: 81, y: 500, w: 1, h: 12, page: 4 } }],
      [{ text: '(A) search', bbox: { x: 126, y: 480, w: 1, h: 12, page: 4 } }],
      [{ text: '(B) appear similar', bbox: { x: 126, y: 460, w: 1, h: 12, page: 4 } }],
      [{ text: '(C) stay on top. box. There is one extra word that you do not need.', bbox: { x: 126, y: 440, w: 1, h: 12, page: 4 } }],
    ],
    plainText: '',
    items: [],
  }];
  const parsed = parseQuestionsFromPages(pages, warnings);
  const q20 = parsed.questions.find((q) => q.displayNumber === '20');
  assert.ok(q20);
  const c = q20.options.find((o) => o.id === 'C');
  assert.ok(c);
  assert.ok(!/box\.\s+There is one extra/i.test(c.text));
});

test('exam extract: user PDF diagnostics JSON regression (opt-in EXAM_USER_PDF_PAGES_JSON)', async (t) => {
  const jsonPath = process.env.EXAM_USER_PDF_PAGES_JSON;
  if (!jsonPath) {
    t.skip('Set EXAM_USER_PDF_PAGES_JSON to validation file-N-pages.json');
    return;
  }
  if (!fs.existsSync(jsonPath)) {
    t.skip('Missing EXAM_USER_PDF_PAGES_JSON file');
    return;
  }
  const { parseQuestionsFromPages, EXAM_EXTRACT_PARSER_VERSION } = await loadExtract();
  const pages = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  const warnings = [];
  const parsed = parseQuestionsFromPages(pages, warnings);
  assert.equal(EXAM_EXTRACT_PARSER_VERSION, 28);
  const expectMin = Number(process.env.EXAM_USER_PDF_MIN_QUESTIONS || '0');
  if (expectMin > 0) {
    assert.ok(parsed.questions.length >= expectMin, `expected >= ${expectMin} questions`);
  }
  const mustInclude = (process.env.EXAM_USER_PDF_MUST_INCLUDE || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const num of mustInclude) {
    assert.ok(parsed.questions.some((q) => q.displayNumber === num), `missing ${num}`);
  }
});
