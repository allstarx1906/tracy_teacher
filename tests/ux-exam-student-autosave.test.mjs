import test from 'node:test';
import assert from 'node:assert/strict';
import { EXAM_QUESTION_TYPE } from '../dist/exam-domain.js';
import { renderExamTakeView } from '../dist/exam-ui-student.js';
import { installBaDomEnvironment, findDomNodes } from './helper-browser-window.mjs';

function jsonResponse(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json' },
    json: async () => data,
  };
}

function examPayload() {
  return {
    exam: {
      title: 'Autosave',
      assignment: { showScore: false, dueAt: '2099-01-01T00:00:00.000Z', purpose: 'exam' },
      questions: [
        {
          id: 'q_short',
          displayNumber: '1',
          questionType: EXAM_QUESTION_TYPE.SHORT_ANSWER,
          stemText: 'City',
          maxWords: 2,
          options: [],
        },
        {
          id: 'q_essay',
          displayNumber: 'W',
          unnumberedActivity: true,
          questionType: EXAM_QUESTION_TYPE.ESSAY,
          stemText: 'Write',
          minWords: 3,
          essayTopics: [{ id: 'A', label: 'Topic A' }],
          options: [],
        },
      ],
      passages: [],
      attempt: { status: 'in_progress', answers: {}, revision: 0 },
    },
  };
}

test('submit flushes debounced text before save and submit', async (t) => {
  installBaDomEnvironment(t);
  const saveBodies = [];
  let saveCalls = 0;
  let submitCalls = 0;
  let resolveSave;
  const saveGate = new Promise((r) => { resolveSave = r; });

  const originalFetch = globalThis.fetch;
  t.after(() => {
    resolveSave?.();
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async (path, init) => {
    const method = init?.method || 'GET';
    if (String(path).includes('/server-now')) {
      return jsonResponse({ now: new Date().toISOString() });
    }
    if (String(path).includes('/assignments/a1') && method === 'GET') {
      return jsonResponse(examPayload());
    }
    if (String(path).includes('/attempts/start')) {
      return jsonResponse({ attemptId: 'att1', deadlineAt: '2099-01-01T00:30:00.000Z' });
    }
    if (String(path).includes('/answers') && method === 'POST') {
      saveCalls += 1;
      saveBodies.push(JSON.parse(init.body));
      await saveGate;
      return jsonResponse({ revision: saveCalls });
    }
    if (String(path).includes('/submit')) {
      submitCalls += 1;
      return jsonResponse({ gradingLabel: 'ok' });
    }
    return jsonResponse({});
  };

  const root = document.createElement('div');
  document.body.appendChild(root);
  t.after(() => { root.__examDispose?.(); root.remove(); });
  const ctx = {
    navigate: () => {},
    toastOk: () => {},
    toastErr: () => {},
  };
  renderExamTakeView(ctx, root, 'a1');
  await new Promise((r) => setTimeout(r, 30));
  const input = findDomNodes(root, (n) => n.className?.includes?.('exam-short-answer-input'))[0];
  assert.ok(input);
  input.value = 'LatestTyped';
  input.dispatchEvent({ type: 'input', target: input });
  const submitBtn = findDomNodes(root, (n) => n.tagName === 'BUTTON' && /Nộp bài/.test(n.textContent || ''))[0];
  assert.ok(submitBtn);
  submitBtn.dispatchEvent({ type: 'click', target: submitBtn });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(saveCalls, 1, 'save started before submit');
  assert.equal(submitCalls, 0, 'submit waits for save');
  assert.equal(saveBodies[0]?.answer, 'LatestTyped');
  resolveSave();
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(submitCalls, 1);
});

test('failed save preserves newer typed answer and does not submit', async (t) => {
  installBaDomEnvironment(t);
  const saveBodies = [];
  let saveCalls = 0;
  let submitCalls = 0;
  let releaseFirst;
  const firstSave = new Promise((r) => { releaseFirst = r; });

  const originalFetch = globalThis.fetch;
  t.after(() => {
    releaseFirst?.();
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async (path, init) => {
    const method = init?.method || 'GET';
    if (String(path).includes('/server-now')) return jsonResponse({ now: new Date().toISOString() });
    if (String(path).includes('/assignments/a1') && method === 'GET') return jsonResponse(examPayload());
    if (String(path).includes('/attempts/start')) {
      return jsonResponse({ attemptId: 'att1', deadlineAt: '2099-01-01T00:30:00.000Z' });
    }
    if (String(path).includes('/answers') && method === 'POST') {
      saveCalls += 1;
      const body = JSON.parse(init.body);
      saveBodies.push(body);
      if (saveCalls === 1) {
        await firstSave;
        return jsonResponse({ error: 'fail' }, 400);
      }
      return jsonResponse({ revision: 2 });
    }
    if (String(path).includes('/submit')) {
      submitCalls += 1;
      return jsonResponse({});
    }
    return jsonResponse({});
  };

  const root = document.createElement('div');
  document.body.appendChild(root);
  t.after(() => { root.__examDispose?.(); root.remove(); });
  renderExamTakeView({ navigate: () => {}, toastOk: () => {}, toastErr: () => {} }, root, 'a1');
  await new Promise((r) => setTimeout(r, 30));
  const input = findDomNodes(root, (n) => n.className?.includes?.('exam-short-answer-input'))[0];
  input.value = 'OldSave';
  input.dispatchEvent({ type: 'input', target: input });
  await new Promise((r) => setTimeout(r, 500));
  const submitBtn = findDomNodes(root, (n) => n.tagName === 'BUTTON' && /Nộp bài/.test(n.textContent || ''))[0];
  submitBtn.dispatchEvent({ type: 'click', target: submitBtn });
  await new Promise((r) => setTimeout(r, 10));
  input.value = 'NewerWhilePending';
  input.dispatchEvent({ type: 'input', target: input });
  releaseFirst();
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(submitCalls, 0);
  assert.equal(saveBodies[0]?.answer, 'OldSave');
  assert.equal(input.value, 'NewerWhilePending');
  assert.ok(findDomNodes(root, (n) => String(n.className || '').includes('save-status')
    && String(n.className || '').includes('err')).length);
});

test('submit flushes debounced essay before save and submit', async (t) => {
  installBaDomEnvironment(t);
  const saveBodies = [];
  let saveCalls = 0;
  let submitCalls = 0;
  let resolveSave;
  const saveGate = new Promise((r) => { resolveSave = r; });

  const originalFetch = globalThis.fetch;
  t.after(() => {
    resolveSave?.();
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async (path, init) => {
    const method = init?.method || 'GET';
    if (String(path).includes('/server-now')) return jsonResponse({ now: new Date().toISOString() });
    if (String(path).includes('/assignments/a1') && method === 'GET') return jsonResponse(examPayload());
    if (String(path).includes('/attempts/start')) {
      return jsonResponse({ attemptId: 'att1', deadlineAt: '2099-01-01T00:30:00.000Z' });
    }
    if (String(path).includes('/answers') && method === 'POST') {
      saveCalls += 1;
      saveBodies.push(JSON.parse(init.body));
      await saveGate;
      return jsonResponse({ revision: saveCalls });
    }
    if (String(path).includes('/submit')) {
      submitCalls += 1;
      return jsonResponse({ gradingLabel: 'ok' });
    }
    return jsonResponse({});
  };

  const root = document.createElement('div');
  document.body.appendChild(root);
  t.after(() => { root.__examDispose?.(); root.remove(); });
  renderExamTakeView({ navigate: () => {}, toastOk: () => {}, toastErr: () => {} }, root, 'a1');
  await new Promise((r) => setTimeout(r, 30));
  const essayInput = findDomNodes(root, (n) => n.className?.includes?.('exam-essay-text'))[0];
  assert.ok(essayInput, 'essay input');
  essayInput.value = 'Essay body text';
  essayInput.dispatchEvent({ type: 'input', target: essayInput });
  const submitBtn = findDomNodes(root, (n) => n.tagName === 'BUTTON' && /Nộp bài/.test(n.textContent || ''))[0];
  submitBtn.dispatchEvent({ type: 'click', target: submitBtn });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(saveCalls, 1);
  assert.equal(submitCalls, 0);
  assert.equal(saveBodies[0]?.answer?.text, 'Essay body text');
  resolveSave();
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(submitCalls, 1);
});

test('edit during pending save ack persists newer body before submit', async (t) => {
  installBaDomEnvironment(t);
  const saveBodies = [];
  let saveCalls = 0;
  let submitCalls = 0;
  let releaseFirst;
  const firstSave = new Promise((r) => { releaseFirst = r; });

  const originalFetch = globalThis.fetch;
  t.after(() => {
    releaseFirst?.();
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async (path, init) => {
    const method = init?.method || 'GET';
    if (String(path).includes('/server-now')) return jsonResponse({ now: new Date().toISOString() });
    if (String(path).includes('/assignments/a1') && method === 'GET') return jsonResponse(examPayload());
    if (String(path).includes('/attempts/start')) {
      return jsonResponse({ attemptId: 'att1', deadlineAt: '2099-01-01T00:30:00.000Z' });
    }
    if (String(path).includes('/answers') && method === 'POST') {
      saveCalls += 1;
      const body = JSON.parse(init.body);
      saveBodies.push(body);
      if (saveCalls === 1) {
        await firstSave;
        return jsonResponse({ revision: 1 });
      }
      return jsonResponse({ revision: 2 });
    }
    if (String(path).includes('/submit')) {
      submitCalls += 1;
      return jsonResponse({ gradingLabel: 'ok' });
    }
    return jsonResponse({});
  };

  const root = document.createElement('div');
  document.body.appendChild(root);
  t.after(() => { root.__examDispose?.(); root.remove(); });
  renderExamTakeView({ navigate: () => {}, toastOk: () => {}, toastErr: () => {} }, root, 'a1');
  await new Promise((r) => setTimeout(r, 30));
  const input = findDomNodes(root, (n) => n.className?.includes?.('exam-short-answer-input'))[0];
  input.value = 'First';
  input.dispatchEvent({ type: 'input', target: input });
  await new Promise((r) => setTimeout(r, 500));
  const submitBtn = findDomNodes(root, (n) => n.tagName === 'BUTTON' && /Nộp bài/.test(n.textContent || ''))[0];
  submitBtn.dispatchEvent({ type: 'click', target: submitBtn });
  await new Promise((r) => setTimeout(r, 10));
  input.value = 'Second';
  input.dispatchEvent({ type: 'input', target: input });
  releaseFirst();
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(saveBodies[0]?.answer, 'First');
  assert.equal(saveBodies[saveBodies.length - 1]?.answer, 'Second');
  assert.ok(saveBodies.length >= 2);
  assert.equal(submitCalls, 1);
});

test('after submit rejected (400), edit saves and resubmit works without stuck flush', async (t) => {
  installBaDomEnvironment(t);
  const saveBodies = [];
  let saveCalls = 0;
  let submitCalls = 0;

  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (path, init) => {
    const method = init?.method || 'GET';
    if (String(path).includes('/server-now')) return jsonResponse({ now: new Date().toISOString() });
    if (String(path).includes('/assignments/a1') && method === 'GET') return jsonResponse(examPayload());
    if (String(path).includes('/attempts/start')) {
      return jsonResponse({ attemptId: 'att1', deadlineAt: '2099-01-01T00:30:00.000Z' });
    }
    if (String(path).includes('/answers') && method === 'POST') {
      saveCalls += 1;
      saveBodies.push(JSON.parse(init.body));
      return jsonResponse({ revision: saveCalls });
    }
    if (String(path).includes('/submit') && method === 'POST') {
      submitCalls += 1;
      if (submitCalls === 1) {
        return jsonResponse({ error: 'Hãy chọn chủ đề bài viết trước khi nộp.' }, 400);
      }
      return jsonResponse({ gradingLabel: 'ok' });
    }
    return jsonResponse({});
  };

  const root = document.createElement('div');
  document.body.appendChild(root);
  t.after(() => { root.__examDispose?.(); root.remove(); });
  const toastErr = [];
  renderExamTakeView({
    navigate: () => {},
    toastOk: () => {},
    toastErr: (m) => toastErr.push(m),
  }, root, 'a1');
  await new Promise((r) => setTimeout(r, 30));
  const input = findDomNodes(root, (n) => n.className?.includes?.('exam-short-answer-input'))[0];
  input.value = 'Paris';
  input.dispatchEvent({ type: 'input', target: input });
  await new Promise((r) => setTimeout(r, 500));
  assert.ok(saveCalls >= 1, 'initial autosave');
  const submitBtn = findDomNodes(root, (n) => n.tagName === 'BUTTON' && /Nộp bài/.test(n.textContent || ''))[0];
  submitBtn.dispatchEvent({ type: 'click', target: submitBtn });
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(submitCalls, 1);
  assert.ok(toastErr.length);
  const callsAfterReject = saveCalls;
  input.value = 'Lyon';
  input.dispatchEvent({ type: 'input', target: input });
  await new Promise((r) => setTimeout(r, 500));
  assert.ok(saveCalls > callsAfterReject, 'save after rejected submit');
  assert.equal(saveBodies[saveBodies.length - 1]?.answer, 'Lyon');
  submitBtn.dispatchEvent({ type: 'click', target: submitBtn });
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(submitCalls, 2);
  assert.ok(saveCalls <= callsAfterReject + 3, 'bounded save calls, no spin');
});

test('dispose cancels debounced writes', async (t) => {
  installBaDomEnvironment(t);
  let saveCalls = 0;
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (path, init) => {
    const method = init?.method || 'GET';
    if (String(path).includes('/server-now')) return jsonResponse({ now: new Date().toISOString() });
    if (String(path).includes('/assignments/a1') && method === 'GET') return jsonResponse(examPayload());
    if (String(path).includes('/attempts/start')) {
      return jsonResponse({ attemptId: 'att1', deadlineAt: '2099-01-01T00:30:00.000Z' });
    }
    if (String(path).includes('/answers')) {
      saveCalls += 1;
      return jsonResponse({ revision: 1 });
    }
    return jsonResponse({});
  };

  const root = document.createElement('div');
  document.body.appendChild(root);
  t.after(() => { root.__examDispose?.(); root.remove(); });
  renderExamTakeView({ navigate: () => {}, toastOk: () => {}, toastErr: () => {} }, root, 'a1');
  await new Promise((r) => setTimeout(r, 30));
  const input = findDomNodes(root, (n) => n.className?.includes?.('exam-short-answer-input'))[0];
  input.value = 'AfterDispose';
  input.dispatchEvent({ type: 'input', target: input });
  root.__examDispose?.();
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(saveCalls, 0);
});
