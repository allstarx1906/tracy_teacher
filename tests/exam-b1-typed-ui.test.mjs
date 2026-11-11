import test from 'node:test';
import assert from 'node:assert/strict';
import { EXAM_QUESTION_TYPE, projectQuestionPublicForStudent } from '../dist/exam-domain.js';
import {
  mountExamTakeQuestionUi,
  countRespondableAnswers,
  openTeacherExamStudentPreview,
} from '../dist/exam-ui-student.js';
import { installBaDomEnvironment, aggregateDomTextContent } from './helper-browser-window.mjs';

const mixedExam = {
  title: 'Mixed UI',
  questions: [
    {
      id: 'q_mcq',
      displayNumber: '1',
      stemText: 'Pick one',
      options: [{ id: 'A', label: 'A', text: 'Alpha' }],
    },
    {
      id: 'q_short',
      questionType: EXAM_QUESTION_TYPE.SHORT_ANSWER,
      displayNumber: '2',
      stemText: 'City',
      maxWords: 2,
      options: [],
    },
    {
      id: 'q_tf',
      questionType: EXAM_QUESTION_TYPE.TRUE_FALSE_NOT_GIVEN,
      displayNumber: '3',
      stemText: 'Claim',
      options: [
        { id: 'T', label: 'T', text: 'True' },
        { id: 'F', label: 'F', text: 'False' },
        { id: 'NG', label: 'NG', text: 'Not Given' },
      ],
    },
    {
      id: 'q_essay',
      questionType: EXAM_QUESTION_TYPE.ESSAY,
      displayNumber: 'W',
      unnumberedActivity: true,
      stemText: 'Write',
      minWords: 10,
      essayTopics: [{ id: 'A', label: 'Topic A' }],
      options: [],
    },
    {
      id: 'q_oral',
      questionType: EXAM_QUESTION_TYPE.ORAL_ASSESSMENT,
      displayNumber: 'I',
      unnumberedActivity: true,
      stemText: 'Speak',
      options: [],
    },
  ],
  passages: [],
};

test('mixed renderer exposes typed controls without oral input', (t) => {
  installBaDomEnvironment(t);
  const host = document.createElement('div');
  const answers = {};
  mountExamTakeQuestionUi(host, mixedExam, {
    answers,
    onChoiceAnswer: (qid, oid) => { answers[qid] = oid; },
    onTextAnswer: (qid, text) => { answers[qid] = text; },
    onEssayAnswer: (qid, essay) => { answers[qid] = essay; },
  });
  const text = aggregateDomTextContent(host);
  assert.ok(text.includes('T. True'));
  assert.ok(host.querySelector('.exam-short-answer-input'));
  assert.ok(host.querySelector('.exam-essay-text'));
  assert.ok(text.includes('không nhập câu trả lời'));
  assert.equal(host.querySelectorAll('input[type="radio"]').length, 4);
});

test('countRespondableAnswers skips oral activities', () => {
  const answers = { q_mcq: 'A', q_short: 'Paris', q_oral: 'n/a' };
  assert.equal(countRespondableAnswers(mixedExam, answers), 2);
});

test('word bank dropdown does not duplicate label when label equals text', (t) => {
  installBaDomEnvironment(t);
  const host = document.createElement('div');
  const exam = {
    title: 'Bank',
    passages: [{
      id: 'p1',
      wordBankWords: [
        { id: 'w_award', text: 'award' },
        { id: 'w_style', text: 'style' },
      ],
      sourceWordBankUseOnce: true,
    }],
    questions: [{
      id: 'q21',
      displayNumber: '21',
      questionType: EXAM_QUESTION_TYPE.WORD_BANK,
      passageId: 'p1',
      groupId: 'p1',
      stemText: 'Pick',
      options: [
        { id: 'w_award', label: 'award', text: 'award' },
        { id: 'w_style', label: 'style', text: 'style' },
      ],
    }],
  };
  mountExamTakeQuestionUi(host, exam, { answers: {}, onChoiceAnswer: () => {} });
  const sel = host.querySelector('.exam-bank-select');
  assert.ok(sel);
  const labels = sel.childNodes
    .filter((n) => n.tagName === 'OPTION')
    .slice(1)
    .map((o) => o.textContent);
  assert.deepEqual(labels, ['award', 'style']);
  assert.ok(!labels.some((l) => /award\. award/.test(l)));
});

test('essay UI shows full topic prompts and student can choose topic B', (t) => {
  installBaDomEnvironment(t);
  const host = document.createElement('div');
  const topics = [
    { id: 'A', label: 'Topic A', bodyText: 'Describe life in the year 2050 at school and work.' },
    { id: 'B', label: 'Topic B', bodyText: 'Write about a famous person and their achievements.' },
  ];
  const pub = projectQuestionPublicForStudent({
    id: 'q_w',
    questionType: EXAM_QUESTION_TYPE.ESSAY,
    displayNumber: 'W',
    stemText: 'Choose one',
    essayTopics: topics,
  }, new Map());
  assert.match(pub.essayTopics[1].bodyText, /achievements/i);
  const answers = {};
  mountExamTakeQuestionUi(host, {
    title: 'Essay',
    questions: [{ id: 'q_w', questionType: EXAM_QUESTION_TYPE.ESSAY, displayNumber: 'W', stemText: 'Choose', essayTopics: pub.essayTopics }],
    passages: [],
  }, {
    answers,
    onEssayAnswer: (qid, essay) => { answers[qid] = essay; },
  });
  const text = aggregateDomTextContent(host);
  assert.match(text, /2050/);
  assert.match(text, /achievements/i);
  const sel = host.querySelector('.exam-essay-topic');
  sel.value = 'B';
  sel.dispatchEvent({ type: 'change', target: sel });
  assert.equal(answers.q_w?.topicId, 'B');
});

test('teacher preview does not call student save APIs', (t) => {
  installBaDomEnvironment(t);
  const originalFetch = globalThis.fetch;
  let fetchCount = 0;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async () => {
    fetchCount += 1;
    return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({}) };
  };
  const ctx = { toastErr: () => {}, toastOk: () => {}, navigate: () => {} };
  const exam = {
    ...mixedExam,
    assignment: { timeLimitMinutes: 30, dueAt: '2099-01-01T00:00:00.000Z' },
  };
  let dispose;
  try {
    dispose = openTeacherExamStudentPreview(ctx, exam, {});
    assert.ok(document.body.querySelector('[data-exam-teacher-preview]'));
    assert.equal(fetchCount, 0);
  } finally {
    dispose?.();
  }
});
