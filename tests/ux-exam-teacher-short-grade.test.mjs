import test from 'node:test';
import assert from 'node:assert/strict';
import { EXAM_QUESTION_TYPE } from '../dist/exam-domain.js';
import { renderExamGradeView } from '../dist/exam-ui-teacher.js';
import { installBaDomEnvironment, findDomNodes } from './helper-browser-window.mjs';

function json(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json' },
    json: async () => data,
  };
}

test('grading panel shows short-answer manual score controls and saves payload', async (t) => {
  installBaDomEnvironment(t);
  const putBodies = [];
  let putCalls = 0;
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (url, init) => {
    const method = init?.method || 'GET';
    const u = String(url);
    if (u.includes('/assignments/a1/grading') && method === 'GET') {
      return json({
        assignment: { id: 'a1', title: 'T' },
        version: {
          id: 'v1',
          title: 'V',
          questions: [{
            id: 'q_short',
            displayNumber: '2',
            questionType: EXAM_QUESTION_TYPE.SHORT_ANSWER,
            stemText: 'City?',
            acceptedAnswers: ['Paris'],
            points: 1,
            options: [],
          }],
        },
        attempts: [{ attemptId: 'att1', studentId: 'hs1' }],
        focusAttempt: {
          id: 'att1',
          gradingRevision: 0,
          answers: { q_short: 'Lyon' },
          manualGrades: {},
          detail: {
            gradingRevision: 0,
            questions: [{
              questionId: 'q_short',
              responsePreview: 'Lyon',
              manualOnly: false,
            }],
          },
        },
      });
    }
    if (u.includes('/manual-grades') && method === 'PUT') {
      putCalls += 1;
      putBodies.push(JSON.parse(init.body));
      return json({ gradingRevision: 1, gradingStatus: 'complete' });
    }
    return json({});
  };

  const root = document.createElement('div');
  document.body.appendChild(root);
  t.after(() => { root.remove(); });
  renderExamGradeView({ navigate: () => {}, toastOk: () => {}, toastErr: () => {} }, root, 'a1');
  await new Promise((r) => setTimeout(r, 40));
  const scoreInput = findDomNodes(root, (n) => n.className?.includes?.('exam-manual-score'))[0];
  const fbInput = findDomNodes(root, (n) => n.className?.includes?.('exam-manual-feedback'))[0];
  assert.ok(scoreInput, 'manual score input for short answer');
  assert.ok(fbInput, 'manual feedback for short answer');
  assert.ok(findDomNodes(root, (n) => n.className?.includes?.('exam-text-key-editor')).length, 'keeps text key editor');
  scoreInput.value = '0.5';
  scoreInput.dispatchEvent({ type: 'input', target: scoreInput });
  fbInput.value = 'partial';
  fbInput.dispatchEvent({ type: 'input', target: fbInput });
  const saveBtn = findDomNodes(root, (n) => n.tagName === 'BUTTON' && /Lưu điểm chấm tay/.test(n.textContent || ''))[0];
  assert.ok(saveBtn);
  saveBtn.dispatchEvent({ type: 'click', target: saveBtn });
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(putCalls, 1);
  assert.deepEqual(putBodies[0]?.marks, [{
    questionId: 'q_short',
    score: 0.5,
    feedback: 'partial',
  }]);
  assert.equal(putBodies[0]?.baseRevision, 0);
});
