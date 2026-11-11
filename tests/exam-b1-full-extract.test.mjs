import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXAM_QUESTION_TYPE, summarizeExamItems, sortExamQuestionsByOrder } from '../dist/exam-domain.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function b1FixturePath() {
  const fromEnv = process.env.B1_FULL_PAGES_JSON;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  const rel = path.resolve(
    __dirname,
    '../../.orchestration/validation/user-pdfs-20261107/file-1-pages.json',
  );
  if (fs.existsSync(rel)) return rel;
  return null;
}

const clean = (s) => String(s || '').replace(/_+/g, '___').replace(/\s+/g, ' ').replace(/\s+([,.?])/g, '$1').trim();

test('exam extract: B1 achievement midterm full paper (optional private fixture)', async (t) => {
  const fixture = b1FixturePath();
  if (!fixture) {
    t.skip('B1_FULL_PAGES_JSON or validation file-1-pages.json not available');
    return;
  }
  const pages = JSON.parse(fs.readFileSync(fixture, 'utf8'));
  const { isB1AchievementMidtermDocument, parseB1AchievementMidtermFromPages } = await import(
    '../server/exam-b1-midterm-extract.mjs'
  );
  assert.equal(isB1AchievementMidtermDocument(pages), true);
  const warnings = [];
  const draft = parseB1AchievementMidtermFromPages(pages, warnings);
  const numbered = draft.questions.filter((q) => !q.unnumberedActivity);
  const nums = numbered.map((q) => parseInt(q.displayNumber, 10)).sort((a, b) => a - b);
  assert.deepEqual(nums, [...Array(70)].map((_, i) => i + 1));

  const oral = draft.questions.find((q) => q.questionType === EXAM_QUESTION_TYPE.ORAL_ASSESSMENT);
  const essay = draft.questions.find((q) => q.questionType === EXAM_QUESTION_TYPE.ESSAY);
  assert.ok(oral?.unnumberedActivity);
  assert.ok(essay?.unnumberedActivity);
  assert.equal(oral.points, 15);
  assert.equal(essay.points, 15);

  const summary = summarizeExamItems({ questions: draft.questions });
  assert.equal(summary.numberedQuestions, 70);
  assert.equal(summary.unnumberedActivities, 2);
  assert.equal(summary.totalPoints, 100);

  const ordered = sortExamQuestionsByOrder(draft.questions);
  const orderedNums = ordered
    .filter((q) => !q.unnumberedActivity)
    .map((q) => parseInt(q.displayNumber, 10));
  assert.deepEqual(orderedNums, [...Array(70)].map((_, i) => i + 1));
  assert.ok(ordered.every((q, i) => q.order === i + 1));

  const q = (n) => numbered.find((x) => Number(x.displayNumber) === n);

  for (const [a, b, type, count] of [
    [1, 9, EXAM_QUESTION_TYPE.SINGLE_CHOICE, 4],
    [10, 15, EXAM_QUESTION_TYPE.SHORT_ANSWER, null],
    [16, 20, EXAM_QUESTION_TYPE.SINGLE_CHOICE, 3],
    [21, 25, EXAM_QUESTION_TYPE.WORD_BANK, 6],
    [26, 35, EXAM_QUESTION_TYPE.SINGLE_CHOICE, 2],
    [36, 42, EXAM_QUESTION_TYPE.SHORT_ANSWER, null],
    [43, 50, EXAM_QUESTION_TYPE.TRUE_FALSE_NOT_GIVEN, 3],
    [51, 55, EXAM_QUESTION_TYPE.MATCHING, 5],
    [56, 60, EXAM_QUESTION_TYPE.WORD_BANK, 6],
    [61, 65, EXAM_QUESTION_TYPE.WORD_BANK, 5],
    [66, 70, EXAM_QUESTION_TYPE.WORD_BANK, 5],
  ]) {
    for (let n = a; n <= b; n += 1) {
      assert.ok(q(n), `missing ${n}`);
      assert.equal(q(n).questionType, type, `type ${n}`);
      if (count) assert.equal(q(n).options?.length, count, `options ${n}`);
    }
  }

  for (let n = 1; n <= 15; n += 1) assert.equal(!!q(n)?.requiresAudio, true, `audio ${n}`);
  for (let n = 16; n <= 70; n += 1) assert.equal(!!q(n)?.requiresAudio, false, `no audio ${n}`);

  assert.ok(!draft.questions.some((x) => x.correctOptionId));
  assert.ok(!draft.questions.some((x) => x.acceptedAnswers?.length));

  assert.match(q(55)?.stemText || '', /countries/i);
  assert.deepEqual(
    (q(51)?.options || []).map((o) => clean(o.text)),
    [
      'shape the future of society.',
      'usually discuss environmental issues such as climate change.',
      'often face challenges in finding suitable jobs.',
      'compete together.',
      'ask questions and share their ideas in class.',
    ],
  );

  assert.equal(essay?.minWords, 130);
  assert.ok(essay?.essayTopics?.length >= 2);
  assert.match(JSON.stringify(essay), /achievements/i);
  assert.match(JSON.stringify(essay), /2050/);
  assert.match(JSON.stringify(essay), /school/i);
  assert.match(JSON.stringify(essay), /work/i);

  for (const [n, words] of [
    [21, ['award', 'instrument', 'material', 'piece', 'sculpture', 'style']],
    [56, ['traditional', 'encourage', 'instruments', 'stage', 'escape', 'perform']],
    [61, ['during', 'before', 'when', 'while', 'after']],
    [66, ['they', 'them', 'their', 'it', 'we']],
  ]) {
    const actual = (q(n)?.options || []).map((o) => String(o.text).trim().toLowerCase()).sort();
    assert.deepEqual(actual, words.slice().sort(), `source bank ${n}`);
  }

  assert.equal((q(25)?.options || []).length, 6, 'q25 word bank size');
  assert.ok(!(q(25)?.options || []).some((o) => /interview|exploring/i.test(o.text)), 'q25 not section labels');
  for (const n of [26, 27, 28, 29]) {
    const opts = (q(n)?.options || []).map((o) => o.text.toLowerCase());
    assert.equal(opts.length, 2, `choices ${n}`);
    assert.ok(opts.some((t) => /very certain/i.test(t)), `A very certain ${n}`);
    assert.ok(opts.some((t) => /possible/i.test(t)), `B possible ${n}`);
  }

  const group = (n) => q(n)?.passageId || q(n)?.groupId;
  assert.ok(group(26));
  assert.equal(group(26), group(27));
  assert.equal(group(28), group(29));
  assert.notEqual(group(26), group(28));
  assert.equal(group(30), group(32));
  assert.equal(group(33), group(35));
  assert.notEqual(group(30), group(33));

  const context = (n) => {
    const x = q(n);
    const g = draft.passages.find((p) => p.id === (x?.passageId || x?.groupId));
    return [g?.bodyText, ...(g?.documents || []).map((d) => d.bodyText)].filter(Boolean).join(' ');
  };

  for (const [n, patterns] of [
    [26, [/painting/i, /20th century/i]],
    [28, [/Tahitian/i, /Pacific/i]],
    [30, [/ice cream/i, /sun/i]],
    [33, [/seats/i, /subway station/i]],
    [56, [/musician/i, /friends wanted me to stay/i]],
  ]) {
    for (const pattern of patterns) {
      assert.match(context(n).replace(/\s+/g, ' '), pattern, `dialogue ${n}`);
    }
  }

  for (const [n, end] of [
    [36, /store things/i],
    [37, /dirty items/i],
    [38, /care of/i],
    [39, /pick lettuce/i],
    [40, /fields|through the/i],
    [41, /safely/i],
    [42, /heavy loads/i],
    [43, /emotionally to music/i],
    [44, /College/i],
    [46, /women/i],
    [48, /group/i],
    [49, /Dartmouth/i],
    [50, /changes in sounds/i],
  ]) {
    assert.match(q(n)?.stemText?.replace(/\s+/g, ' ') || '', end, `stem ${n}`);
  }

  const tech = context(66).replace(/\s+/g, ' ');
  assert.match(tech, /Technology plays/i);
  assert.match(tech, /focus\./i);
  assert.ok(!/Topic A|famous person/i.test(tech));
  assert.match(context(61).replace(/\s+/g, ' '), /2020.*pandemic/i);

  for (const [page, a, b] of [
    [8, 36, 42],
    [10, 43, 50],
  ]) {
    const lines = pages.find((p) => p.pageNumber === page).plainText.split('\n');
    for (let n = a; n <= b; n += 1) {
      const i = lines.findIndex((s) => new RegExp(`^${n}\\.`).test(s));
      assert.ok(i >= 0, `source line ${n}`);
      let j = i + 1;
      while (j < lines.length && !/^\d+\.\s|^B1\s.*MIDTERM/i.test(lines[j])) j += 1;
      const expected = lines.slice(i, j).join(' ').replace(new RegExp(`^${n}\\.\\s*`), '');
      assert.equal(clean(q(n)?.stemText), clean(expected), `full stem ${n}`);
    }
  }

  for (const [a, b, word] of [
    [36, 42, /COBOT/i],
    [43, 50, /Kreung/i],
  ]) {
    const gid = q(a)?.passageId;
    assert.ok(gid);
    const passage = draft.passages.find((p) => p.id === gid);
    assert.deepEqual(passage.expectedQuestionRange, { min: a, max: b });
    assert.match(context(a), word);
    for (let n = a; n <= b; n += 1) assert.equal(q(n)?.passageId, gid, `reading binding ${n}`);
  }

  const p3 = pages.find((pg) => pg.pageNumber === 3);
  assert.ok(
    p3?.lines?.some((ln) => ln.some((p) => (p.bbox?.x ?? 0) >= 265 && /^\d{1,2}\./.test(p.text))),
    'page 3 has right-column question geometry',
  );

  assert.ok(warnings.some((w) => /audio|âm thanh/i.test(w)));
  assert.ok(!draft.questions.some((x) => x.displayNumber === '71' || x.displayNumber === '72'));
  assert.ok(!draft.questions.some((x) => /Example:\s*0/i.test(x.stemText || '')));

  const expectedForm = {
    10: 'The price of a house built from bottles costs ___ compared to a brick house.',
    11: 'Bottles filled with sand are ___ than bricks.',
    12: 'The bottles keep the house ___.',
    13: 'The bottles make lovely ___.',
    14: 'Sometimes, it is hard to find ___ bottles.',
    15: 'It can be ___ to find sand.',
  };
  for (const [n, text] of Object.entries(expectedForm)) {
    assert.equal(clean(q(+n)?.stemText), clean(text), `form stem ${n}`);
  }

  const stopRe = /^(?:\d+\.\s|[A-E]\.\s|Questions?\s+\d|B1\s.*MIDTERM)/;
  for (const [a, b] of [[1, 9], [16, 29], [61, 65]]) {
    for (let n = a; n <= b; n += 1) {
      const page = pages.find((p) => new RegExp(`^${n}\\.\\s`, 'm').test(p.plainText || ''));
      assert.ok(page, `source page for ${n}`);
      const lines = page.plainText.split('\n');
      const i = lines.findIndex((s) => new RegExp(`^${n}\\.`).test(s));
      let j = i + 1;
      while (j < lines.length && !stopRe.test(lines[j])) j += 1;
      const expected = lines.slice(i, j).join(' ').replace(new RegExp(`^${n}\\.\\s*`), '');
      assert.equal(clean(q(n)?.stemText), clean(expected), `explicit stem ${n}`);
    }
  }

  for (let n = 1; n <= 70; n += 1) {
    assert.ok(q(n)?.stemText?.trim(), `non-empty stem ${n}`);
  }

  assert.ok(!/Conversation\s+1/i.test(context(28)), 'dialogue 28 free of Conversation 1 label');

  for (let n = 16; n <= 20; n += 1) {
    assert.equal(q(n)?.passageId ?? null, null, `q${n} independent mcq has no group`);
    assert.equal(q(n)?.groupId ?? null, null, `q${n} independent mcq has no groupId`);
  }

  const p21 = draft.passages.find((p) => p.expectedQuestionRange?.min === 21 && p.expectedQuestionRange?.max === 25);
  assert.ok(p21?.wordBankWords?.length >= 6, 'word bank 21–25 passage');
  assert.equal(p21.wordBankWords.length, 6, 'bank21 six source words from instruction table');
  const bank21Texts = p21.wordBankWords.map((w) => String(w.text).trim().toLowerCase()).sort();
  assert.deepEqual(
    bank21Texts,
    ['award', 'instrument', 'material', 'piece', 'sculpture', 'style'].sort(),
    'bank21 bounded source words',
  );
  const sharedBankOpts = (q(21)?.options || []).map((o) => ({ id: o.id, text: String(o.text).trim().toLowerCase() }));
  assert.equal(sharedBankOpts.length, 6, 'q21 bank options');
  for (let n = 21; n <= 25; n += 1) {
    assert.equal(q(n)?.passageId, p21.id, `q${n} word bank 21–25 binding`);
    assert.equal(q(n)?.wordBankId, p21.wordBankId || p21.id, `q${n} bank id`);
    assert.deepEqual(
      (q(n)?.options || []).map((o) => ({ id: o.id, text: String(o.text).trim().toLowerCase() })),
      sharedBankOpts,
      `q${n} shares stable bank21 option ids`,
    );
  }

  const listen = draft.passages.find((p) => p.expectedQuestionRange?.min === 10 && p.expectedQuestionRange?.max === 15);
  assert.ok(!listen?.wordBankWords?.length, 'listening form passage must not carry vocabulary bank');

  assert.match(context(56).replace(/\s+/g, ' '), /Conversation\s*1/i, 'q56 includes Conversation 1 label');
  assert.match(context(56).replace(/\s+/g, ' '), /Conversation\s*2/i, 'q56 includes Conversation 2');
  assert.doesNotMatch(context(56), /WRITING TASK/i, 'q56 body stops before writing section');

  for (const x of numbered) {
    const gid = x.passageId || x.groupId;
    if (!gid) continue;
    const g = draft.passages.find((p) => p.id === gid);
    assert.ok(g, `unknown group for q${x.displayNumber}`);
    const r = g.expectedQuestionRange;
    if (r) {
      const n = Number(x.displayNumber);
      assert.ok(n >= r.min && n <= r.max, `q${n} within group ${r.min}–${r.max}`);
    }
  }
});
