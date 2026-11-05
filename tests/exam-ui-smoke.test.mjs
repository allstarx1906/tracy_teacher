import test from 'node:test';
import assert from 'node:assert/strict';
import { installBaDomEnvironment, findDomNodes } from './helper-browser-window.mjs';
import { tryRenderExamView, EXAM_NAV_ITEM } from '../dist/exam-ui.js';

test('exam UI smoke: teacher hub renders title', (t) => {
  installBaDomEnvironment(t);
  const root = document.getElementById('app-root');
  assert.ok(root);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    headers: { get: () => 'application/json' },
    json: async () => ({ ok: true, drafts: [], versions: [], assignments: [] }),
  });
  try {
    const ctx = {
      isTeacher: () => true,
      navigate: () => {},
      toastOk: () => {},
      toastErr: () => {},
      state: { data: { classes: [] } },
    };
    const handled = tryRenderExamView(ctx, { view: 'exams-hub' });
    assert.equal(handled, true);
    const text = root.textContent || '';
    assert.ok(text.includes('Bài thi online'));
    assert.equal(EXAM_NAV_ITEM.label, 'Bài thi online');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('exam UI: import upload button invokes start import API', async (t) => {
  installBaDomEnvironment(t, { cookie: 'bn_csrf=ui-test-csrf' });
  const root = document.getElementById('app-root');
  const calls = [];
  let navigatedTo = null;
  let workflowDone;
  const workflowDonePromise = new Promise((resolve) => {
    workflowDone = resolve;
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), method: init?.method || 'GET', body: init?.body });
    if (String(url).includes('/auth/csrf')) {
      return {
        ok: true,
        headers: { get: () => 'application/json' },
        json: async () => ({ ok: true }),
      };
    }
    if (String(url).includes('/teacher/attachments') && init?.method === 'POST') {
      return {
        ok: true,
        headers: { get: () => 'application/json' },
        json: async () => ({ ok: true, id: 'att1' }),
      };
    }
    if (String(url).includes('/imports') && init?.method === 'POST') {
      return {
        ok: true,
        headers: { get: () => 'application/json' },
        json: async () => ({ ok: true, jobId: 'job1', reused: false }),
      };
    }
    if (String(url).includes('/imports/job1')) {
      return {
        ok: true,
        headers: { get: () => 'application/json' },
        json: async () => ({ ok: true, job: { id: 'job1', status: 'ready', progress: 1, draftId: 'd1' } }),
      };
    }
    return {
      ok: true,
      headers: { get: () => 'application/json' },
      json: async () => ({ ok: true, id: 'att1' }),
    };
  };
  try {
    const ctx = {
      isTeacher: () => true,
      navigate: (hash) => {
        navigatedTo = hash;
        workflowDone();
      },
      toastOk: () => {},
      toastErr: (m) => { throw new Error(m); },
      state: { data: { classes: [] } },
    };
    tryRenderExamView(ctx, { view: 'exams-import' });
    const fileInput = root.querySelector('input[type="file"]')
      || findDomNodes(root, (n) => n.tagName === 'INPUT' && n.type === 'file')[0];
    assert.ok(fileInput, 'file input should render with type=file');
    fileInput.files = [{
      name: 't.pdf',
      type: 'application/pdf',
      arrayBuffer: async () => new Uint8Array([0x25, 0x50, 0x44, 0x46]).buffer,
    }];
    const btn = [...root.querySelectorAll('button')].find((b) => b.textContent.includes('quét'));
    assert.ok(btn);
    btn.dispatchEvent({ type: 'click' });
    await workflowDonePromise;
    assert.equal(navigatedTo, '#/exams/draft/d1');
    const uploadCall = calls.find((c) => c.url.includes('/api/teacher/attachments') && c.method === 'POST');
    assert.ok(uploadCall?.body);
    assert.ok(calls.some((c) => c.url.includes('/imports') && c.method === 'POST'));
    assert.ok(calls.some((c) => c.url.includes('/imports/job1')));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('exam UI: draft editor textareas show extracted stem and passage body', async (t) => {
  installBaDomEnvironment(t, { cookie: 'bn_csrf=ui-test-csrf' });
  const root = document.getElementById('app-root');
  const originalFetch = globalThis.fetch;
  let draftLoaded;
  const draftLoadedPromise = new Promise((resolve) => {
    draftLoaded = resolve;
  });
  globalThis.fetch = async (url) => {
    if (String(url).includes('/drafts/d-dom')) {
      draftLoaded();
      return {
        ok: true,
        headers: { get: () => 'application/json' },
        json: async () => ({
          ok: true,
          draft: {
            id: 'd-dom',
            revision: 1,
            title: 'Sample',
            sections: [{ id: 'sec1', title: 'Phần 1', order: 0 }],
            passages: [{
              id: 'p1',
              sectionId: 'sec1',
              title: 'Reading Passage',
              bodyText: 'Fox jumps.',
            }],
            questions: [{
              id: 'q1',
              sectionId: 'sec1',
              displayNumber: '1',
              stemText: 'What color?',
              options: [
                { id: 'A', label: 'A', text: 'red' },
                { id: 'B', label: 'B', text: 'brown' },
              ],
              correctOptionId: 'B',
              points: 1,
              order: 1,
            }],
            warnings: [],
            needsOcr: false,
            teacherConfirmedReview: false,
          },
        }),
      };
    }
    return {
      ok: true,
      headers: { get: () => 'application/json' },
      json: async () => ({ ok: true }),
    };
  };
  try {
    const ctx = {
      isTeacher: () => true,
      navigate: () => {},
      toastOk: () => {},
      toastErr: (m) => { throw new Error(m); },
      state: { data: { classes: [] } },
    };
    tryRenderExamView(ctx, { view: 'exams-draft', draftId: 'd-dom' });
    await draftLoadedPromise;
    await new Promise((r) => setTimeout(r, 0));
    const textareas = root.querySelectorAll('textarea');
    assert.ok(textareas.length >= 3);
    const values = textareas.map((ta) => ta.value);
    assert.ok(values.some((v) => v.includes('Reading Passage')));
    assert.ok(values.some((v) => v.includes('Fox jumps.')));
    assert.ok(values.some((v) => v.includes('What color?')));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
