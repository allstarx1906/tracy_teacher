import test from 'node:test';
import assert from 'node:assert/strict';
import { installBaDomEnvironment, findDomNodes, findDomNodeByAttr, findDomNodeWithinAttr, domClassIncludes, domNodeAttributeValue } from './helper-browser-window.mjs';
import { examDraftSourceUrl } from '../dist/exam-api.js';
import { tryRenderExamView, EXAM_NAV_ITEM } from '../dist/exam-ui.js';

/** Tear down teacher preview overlays appended to document.body (FakeDocument has no document.querySelectorAll). */
function removeExamTeacherPreviewOverlays() {
  for (const overlay of findDomNodes(
    document.body,
    (n) => domNodeAttributeValue(n, 'data-exam-teacher-preview') != null,
  )) {
    overlay.remove();
  }
}

test('exam UI smoke: teacher hub renders title', async (t) => {
  installBaDomEnvironment(t);
  const root = document.getElementById('app-root');
  assert.ok(root);
  const originalFetch = globalThis.fetch;
  let summaryLoaded;
  const summaryLoadedPromise = new Promise((resolve) => {
    summaryLoaded = resolve;
  });
  globalThis.fetch = async (url) => {
    if (String(url).includes('/api/teacher/exams/summary')) summaryLoaded();
    return {
      ok: true,
      headers: { get: () => 'application/json' },
      json: async () => ({
        ok: true,
        drafts: [],
        versions: [{ id: 'v1', title: 'Đề 1', questionCount: 2 }],
        assignments: [{ id: 'asg1', versionId: 'v1', title: 'Lớp A' }],
      }),
    };
  };
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
    await summaryLoadedPromise;
    await new Promise((r) => setTimeout(r, 0));
    const text = root.textContent || '';
    assert.ok(text.includes('Kho đề'));
    assert.equal(EXAM_NAV_ITEM.label, 'Kho đề');
    const gradeLinks = findDomNodes(root, (n) => n.tagName === 'BUTTON'
      && (n.textContent || '').includes('Chấm bài'));
    assert.ok(gradeLinks.length >= 1);
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
      || findDomNodes(root, (n) => n.tagName === 'INPUT' && (n.type === 'file' || n.getAttribute?.('type') === 'file'))[0];
    assert.ok(fileInput, 'file input should render with type=file');
    fileInput.files = [{
      name: 't.pdf',
      type: 'application/pdf',
      arrayBuffer: async () => new Uint8Array([0x25, 0x50, 0x44, 0x46]).buffer,
    }];
    const btn = findDomNodes(root, (n) => n.tagName === 'BUTTON'
      && domNodeAttributeValue(n, 'data-action') === 'exam-import-process')[0];
    assert.ok(btn, 'import process button');
    const questionPagesField = findDomNodes(root, (n) => {
      if (n.tagName !== 'INPUT') return false;
      const ph = n.getAttribute?.('placeholder') ?? n.attributes?.placeholder ?? '';
      return String(ph).includes('12');
    })[0];
    assert.ok(questionPagesField, 'question page range input');
    questionPagesField.value = '1';
    btn.dispatchEvent({ type: 'click' });
    await workflowDonePromise;
    assert.equal(navigatedTo, '#/exams/draft/d1');
    const uploadCall = calls.find((c) => c.url.includes('/api/teacher/attachments') && c.method === 'POST');
    assert.ok(uploadCall?.body);
    const importCall = calls.find((c) => c.url.includes('/imports') && c.method === 'POST');
    assert.ok(importCall?.body);
    const importBody = JSON.parse(importCall.body);
    assert.equal(importBody.questionPageRange, '1');
    assert.equal(importBody.allPages, undefined);
    assert.ok(calls.some((c) => c.url.includes('/imports/job1')));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('exam UI: draft defaults to readable stem and passage; edit opens textareas', async (t) => {
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
    const text = root.textContent || '';
    assert.ok(text.includes('What color?'));
    assert.ok(text.includes('Fox jumps.'));
    assert.equal(root.querySelectorAll('.exam-draft-q-edit-panel').length, 0);
    assert.equal(root.querySelectorAll('.exam-draft-passage-edit-panel').length, 0);
    const qEdit = findDomNodes(root, (n) => n.tagName === 'BUTTON'
      && domNodeAttributeValue(n, 'aria-label') === 'Chỉnh sửa câu 1')[0];
    assert.ok(qEdit);
    qEdit.dispatchEvent({ type: 'click' });
    await new Promise((r) => setTimeout(r, 0));
    const qBlock = findDomNodeByAttr(root, 'data-question-id', 'q1');
    const stemTa = findDomNodes(qBlock, (n) => n.tagName === 'TEXTAREA'
      && domNodeAttributeValue(n, 'data-exam-draft-q-stem-editor') != null)[0];
    assert.ok(stemTa);
    assert.match(String(stemTa.value || ''), /What color\?/);
    const pEdit = findDomNodes(root, (n) => n.tagName === 'BUTTON'
      && domNodeAttributeValue(n, 'aria-label') === 'Chỉnh sửa nhóm đọc')[0];
    assert.ok(pEdit);
    pEdit.dispatchEvent({ type: 'click' });
    await new Promise((r) => setTimeout(r, 0));
    const pBlock = findDomNodeByAttr(root, 'data-passage-id', 'p1');
    const passageTas = findDomNodes(pBlock, (n) => n.tagName === 'TEXTAREA');
    assert.ok(passageTas.length >= 2);
    assert.ok(passageTas.some((ta) => String(ta.value || '').includes('Reading Passage')));
    assert.ok(passageTas.some((ta) => String(ta.value || '').includes('Fox jumps.')));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('exam UI: new question opens edit mode; Xong then save persists stem in PUT body', async (t) => {
  installBaDomEnvironment(t, { cookie: 'bn_csrf=ui-test-csrf' });
  const root = document.getElementById('app-root');
  const originalFetch = globalThis.fetch;
  let draftLoaded;
  let savedBody = null;
  const draftLoadedPromise = new Promise((resolve) => {
    draftLoaded = resolve;
  });
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes('/drafts/d-newq') && (!init?.method || init.method === 'GET')) {
      draftLoaded();
      return {
        ok: true,
        headers: { get: () => 'application/json' },
        json: async () => ({
          ok: true,
          draft: {
            id: 'd-newq',
            revision: 1,
            title: 'Trống',
            sections: [{ id: 'sec1', title: 'Phần 1', order: 0 }],
            passages: [],
            questions: [],
            warnings: [],
            needsOcr: false,
            teacherConfirmedReview: false,
            gradingMode: 'automatic',
          },
        }),
      };
    }
    if (u.includes('/drafts/d-newq') && init?.method === 'PUT') {
      savedBody = JSON.parse(init.body);
      return {
        ok: true,
        headers: { get: () => 'application/json' },
        json: async () => ({ ok: true, revision: 2 }),
      };
    }
    if (u.includes('/auth/csrf')) {
      return {
        ok: true,
        headers: { get: () => 'application/json' },
        json: async () => ({ ok: true }),
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
    tryRenderExamView(ctx, { view: 'exams-draft', draftId: 'd-newq' });
    await draftLoadedPromise;
    await new Promise((r) => setTimeout(r, 0));
    const addBtn = [...root.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === 'Thêm câu');
    assert.ok(addBtn);
    addBtn.dispatchEvent({ type: 'click' });
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(root.querySelectorAll('.exam-draft-q-edit-panel').length, 1);
    const qBlock = findDomNodes(root, (n) => domNodeAttributeValue(n, 'data-question-id') != null)[0];
    assert.ok(qBlock);
    const stemTa = findDomNodes(qBlock, (n) => n.tagName === 'TEXTAREA')[0];
    assert.ok(stemTa);
    stemTa.value = 'Câu mới nhập tay';
    stemTa.dispatchEvent({ type: 'input', target: stemTa });
    const xong = findDomNodes(qBlock, (n) => n.tagName === 'BUTTON'
      && (n.textContent || '').trim() === 'Xong')[0];
    assert.ok(xong);
    xong.dispatchEvent({ type: 'click' });
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(root.querySelectorAll('.exam-draft-q-edit-panel').length, 0);
    const saveBtn = [...root.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === 'Lưu đề');
    assert.ok(saveBtn);
    saveBtn.dispatchEvent({ type: 'click' });
    await new Promise((r) => setTimeout(r, 80));
    assert.ok(savedBody?.questions?.length === 1);
    assert.equal(savedBody.questions[0].stemText, 'Câu mới nhập tay');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('exam UI: draft review warning jumps to question editor', async (t) => {
  installBaDomEnvironment(t, { cookie: 'bn_csrf=ui-test-csrf' });
  const root = document.getElementById('app-root');
  const originalFetch = globalThis.fetch;
  let draftLoaded;
  const draftLoadedPromise = new Promise((resolve) => {
    draftLoaded = resolve;
  });
  globalThis.fetch = async (url) => {
    if (String(url).includes('/drafts/d-nav')) {
      draftLoaded();
      return {
        ok: true,
        headers: { get: () => 'application/json' },
        json: async () => ({
          ok: true,
          draft: {
            id: 'd-nav',
            revision: 1,
            title: 'Nav test',
            sections: [{ id: 'sec1', title: 'Phần 1', order: 0 }],
            passages: [],
            questions: [{
              id: 'q-warn',
              sectionId: 'sec1',
              displayNumber: '3',
              stemText: 'Stem here',
              options: [
                { id: 'A', label: 'A', text: '' },
                { id: 'B', label: 'B', text: 'b' },
              ],
              correctOptionId: 'A',
              points: 1,
              order: 1,
            }],
            warnings: ['Câu 3: thiếu lựa chọn — cần rà soát.'],
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
      toastErr: () => {},
      state: { data: { classes: [] } },
    };
    tryRenderExamView(ctx, { view: 'exams-draft', draftId: 'd-nav' });
    await draftLoadedPromise;
    await new Promise((r) => setTimeout(r, 0));
    t.mock.timers.enable({ apis: ['setTimeout'] });
    t.after(() => {
      t.mock.timers.reset();
    });
    const jumpBtn = findDomNodes(root, (n) => n.tagName === 'BUTTON'
      && domClassIncludes(n, 'exam-draft-review-action'))[0];
    assert.ok(jumpBtn, 'expected actionable review control');
    const bannerText = (findDomNodes(root, (n) => domClassIncludes(n, 'exam-draft-review-banner'))[0]?.textContent) || '';
    assert.match(bannerText, /cần kiểm tra/);
    assert.ok(!/rà soát/.test(bannerText));
    jumpBtn.dispatchEvent({ type: 'click' });
    await new Promise((resolve) => queueMicrotask(resolve));
    const qBlock = findDomNodeByAttr(root, 'data-question-id', 'q-warn');
    assert.ok(qBlock, 'expected live question block after jump rerender');
    assert.ok(qBlock._scrollIntoViewCalls?.length >= 1);
    assert.equal(qBlock._scrollIntoViewCalls[0].block, 'center');
    const editPanel = findDomNodes(qBlock, (n) => domClassIncludes(n, 'exam-draft-q-edit-panel'))[0];
    assert.ok(editPanel, 'jump should open question editor');
    const stemTa = findDomNodes(qBlock, (n) => n.tagName === 'TEXTAREA')[0];
    assert.ok(stemTa);
    t.mock.timers.runAll();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('exam UI: passage review warning jumps to reading group document', async (t) => {
  installBaDomEnvironment(t, { cookie: 'bn_csrf=ui-test-csrf' });
  const root = document.getElementById('app-root');
  const originalFetch = globalThis.fetch;
  let draftLoaded;
  const draftLoadedPromise = new Promise((resolve) => {
    draftLoaded = resolve;
  });
  globalThis.fetch = async (url) => {
    if (String(url).includes('/drafts/d-grp')) {
      draftLoaded();
      return {
        ok: true,
        headers: { get: () => 'application/json' },
        json: async () => ({
          ok: true,
          draft: {
            id: 'd-grp',
            revision: 1,
            title: 'Group nav',
            sections: [{ id: 'sec1', title: 'Phần 1', order: 0 }],
            passages: [{
              id: 'pg1',
              sectionId: 'sec1',
              title: 'Questions 1-2 refer to the following text.',
              sourcePage: 12,
              documents: [{
                id: 'doc12',
                bodyText: 'Short',
                sourcePages: [12],
                requiresReview: true,
              }],
            }],
            questions: [],
            warnings: ['Đoạn đọc (trang 12): có thể thiếu nội dung — đồ họa hoặc bố cục chưa trích được đủ.'],
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
      toastErr: () => {},
      state: { data: { classes: [] } },
    };
    tryRenderExamView(ctx, { view: 'exams-draft', draftId: 'd-grp' });
    await draftLoadedPromise;
    await new Promise((r) => setTimeout(r, 0));
    t.mock.timers.enable({ apis: ['setTimeout'] });
    t.after(() => {
      t.mock.timers.reset();
    });
    const jumpBtn = findDomNodes(root, (n) => n.tagName === 'BUTTON'
      && domClassIncludes(n, 'exam-draft-review-action'))[0];
    assert.ok(jumpBtn);
    jumpBtn.dispatchEvent({ type: 'click' });
    await new Promise((resolve) => queueMicrotask(resolve));
    const docBlock = findDomNodeByAttr(root, 'data-document-id', 'doc12');
    assert.ok(docBlock, 'expected live document block after jump rerender');
    assert.ok(docBlock._scrollIntoViewCalls?.length >= 1);
    assert.equal(docBlock._scrollIntoViewCalls[0].block, 'center');
    const passageTa = findDomNodes(docBlock, (n) => n.tagName === 'TEXTAREA')[0];
    assert.ok(passageTa, 'jump should focus reading document editor');
    t.mock.timers.runAll();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('exam UI: informational warning has no dead jump link', async (t) => {
  installBaDomEnvironment(t, { cookie: 'bn_csrf=ui-test-csrf' });
  const root = document.getElementById('app-root');
  const originalFetch = globalThis.fetch;
  let draftLoaded;
  const draftLoadedPromise = new Promise((resolve) => {
    draftLoaded = resolve;
  });
  globalThis.fetch = async (url) => {
    if (String(url).includes('/drafts/d-info')) {
      draftLoaded();
      return {
        ok: true,
        headers: { get: () => 'application/json' },
        json: async () => ({
          ok: true,
          draft: {
            id: 'd-info',
            revision: 1,
            title: 'Info',
            sections: [{ id: 'sec1', title: 'Phần 1', order: 0 }],
            passages: [],
            questions: [],
            warnings: ['Trang 4: trang trắng (không có nội dung) — bỏ qua khi trích câu hỏi.'],
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
      toastErr: () => {},
      state: { data: { classes: [] } },
    };
    tryRenderExamView(ctx, { view: 'exams-draft', draftId: 'd-info' });
    await draftLoadedPromise;
    await new Promise((r) => setTimeout(r, 0));
    const jumpBtns = findDomNodes(root, (n) => n.tagName === 'BUTTON'
      && domClassIncludes(n, 'exam-draft-review-action'));
    assert.equal(jumpBtns.length, 0);
    const infoBanner = findDomNodes(root, (n) => domNodeAttributeValue(n, 'data-exam-review-info') != null)[0];
    assert.ok(infoBanner);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('exam UI: draft editor shows teacher-manual-later grading mode controls', async (t) => {
  installBaDomEnvironment(t, { cookie: 'bn_csrf=ui-test-csrf' });
  const root = document.getElementById('app-root');
  const originalFetch = globalThis.fetch;
  let draftLoaded;
  const draftLoadedPromise = new Promise((resolve) => {
    draftLoaded = resolve;
  });
  globalThis.fetch = async (url) => {
    if (String(url).includes('/drafts/d-mode')) {
      draftLoaded();
      return {
        ok: true,
        headers: { get: () => 'application/json' },
        json: async () => ({
          ok: true,
          draft: {
            id: 'd-mode',
            revision: 1,
            title: 'Mode',
            gradingMode: 'teacher-manual-later',
            sections: [{ id: 'sec1', title: 'Phần 1', order: 0 }],
            passages: [],
            questions: [{
              id: 'q1',
              sectionId: 'sec1',
              displayNumber: '1',
              stemText: '?',
              options: [{ id: 'A', label: 'A', text: 'a' }, { id: 'B', label: 'B', text: 'b' }],
              correctOptionId: null,
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
    tryRenderExamView(ctx, { view: 'exams-draft', draftId: 'd-mode' });
    await draftLoadedPromise;
    await new Promise((r) => setTimeout(r, 0));
    assert.ok(root.querySelector('#exam-grading-mode-manual'));
    assert.ok((root.textContent || '').includes('Giáo viên chấm sau'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('exam UI: review filter hides clean items and publish errors target distinct groups', async (t) => {
  installBaDomEnvironment(t, { cookie: 'bn_csrf=ui-test-csrf' });
  const root = document.getElementById('app-root');
  const originalFetch = globalThis.fetch;
  let draftLoaded;
  const draftLoadedPromise = new Promise((resolve) => {
    draftLoaded = resolve;
  });
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/drafts/d-filter')) {
      draftLoaded();
      return {
        ok: true,
        headers: { get: () => 'application/json' },
        json: async () => ({
          ok: true,
          draft: {
            id: 'd-filter',
            revision: 3,
            title: 'Filter draft',
            gradingMode: 'teacher-manual-later',
            sections: [{ id: 'sec1', title: 'Phần 1', order: 0 }],
            passages: [
              {
                id: 'pg-a',
                sectionId: 'sec1',
                title: 'Questions 1-1 refer to the following text.',
                sourcePage: 5,
                requiresContext: true,
                documents: [{ id: 'doc-a', bodyText: 'Alpha', sourcePages: [5] }],
                contextConfirmed: true,
              },
              {
                id: 'pg-b',
                sectionId: 'sec1',
                title: 'Questions 2-2 refer to the following text.',
                sourcePage: 6,
                requiresContext: true,
                documents: [{ id: 'doc-b', bodyText: 'Beta', sourcePages: [6] }],
                contextConfirmed: false,
              },
            ],
            questions: [
              {
                id: 'q-ok',
                sectionId: 'sec1',
                displayNumber: '1',
                stemText: 'Good',
                passageId: 'pg-a',
                options: [{ id: 'A', label: 'A', text: 'a' }, { id: 'B', label: 'B', text: 'b' }],
                correctOptionId: null,
              },
              {
                id: 'q-bad',
                sectionId: 'sec1',
                displayNumber: '2',
                stemText: 'Bad',
                passageId: 'pg-b',
                options: [{ id: 'A', label: 'A', text: 'a' }, { id: 'B', label: 'B', text: 'b' }],
                correctOptionId: null,
              },
            ],
            warnings: [],
            needsOcr: false,
            needsReview: false,
            teacherConfirmedReview: true,
          },
        }),
      };
    }
    if (String(url).includes('/drafts/d-filter') && init?.method === 'PUT') {
      return {
        ok: true,
        headers: { get: () => 'application/json' },
        json: async () => ({ ok: true, revision: 4 }),
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
      toastErr: () => {},
      state: { data: { classes: [] } },
    };
    tryRenderExamView(ctx, { view: 'exams-draft', draftId: 'd-filter' });
    await draftLoadedPromise;
    await new Promise((r) => setTimeout(r, 0));
    const needBtn = [...root.querySelectorAll('button')].find((b) => (b.textContent || '').startsWith('Cần kiểm tra'));
    assert.ok(needBtn);
    needBtn.dispatchEvent({ type: 'click' });
    await new Promise((r) => setTimeout(r, 0));
    assert.ok(!findDomNodeByAttr(root, 'data-question-id', 'q-ok'));
    assert.ok(findDomNodeByAttr(root, 'data-passage-id', 'pg-b'));
    assert.ok(findDomNodeByAttr(root, 'data-question-id', 'q-bad'));
    const pubBtn = [...root.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === 'Xuất bản');
    assert.ok(pubBtn);
    pubBtn.dispatchEvent({ type: 'click' });
    await new Promise((r) => setTimeout(r, 0));
    const errBtns = findDomNodes(root, (n) => n.tagName === 'BUTTON'
      && domClassIncludes(n, 'exam-draft-review-action'));
    assert.ok(errBtns.length >= 1);
    const errTexts = findDomNodes(root, (n) => domClassIncludes(n, 'exam-draft-review-banner'))
      .map((n) => n.textContent || '');
    assert.ok(errTexts.some((tx) => /Nhóm câu 2/.test(tx)));
    errBtns[0].dispatchEvent({ type: 'click' });
    await new Promise((r) => setTimeout(r, 0));
    const ctxCheck = findDomNodeWithinAttr(
      root,
      'data-passage-id',
      'pg-b',
      (n) => n.tagName === 'INPUT' && domNodeAttributeValue(n, 'type') === 'checkbox',
    );
    assert.ok(ctxCheck);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('exam UI: save draft PUT includes contextConfirmed on passages', async (t) => {
  installBaDomEnvironment(t, { cookie: 'bn_csrf=ui-test-csrf' });
  const root = document.getElementById('app-root');
  const originalFetch = globalThis.fetch;
  let draftLoaded;
  let savedBody = null;
  const draftLoadedPromise = new Promise((resolve) => {
    draftLoaded = resolve;
  });
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/drafts/d-savectx') && (!init?.method || init.method === 'GET')) {
      draftLoaded();
      return {
        ok: true,
        headers: { get: () => 'application/json' },
        json: async () => ({
          ok: true,
          draft: {
            id: 'd-savectx',
            revision: 1,
            title: 'Ctx save',
            sections: [{ id: 'sec1', title: 'Phần 1', order: 0 }],
            passages: [{
              id: 'pg1',
              sectionId: 'sec1',
              title: 'Questions 1-1 refer to the following text.',
              requiresContext: true,
              documents: [{ id: 'd1', bodyText: 'Body' }],
              contextConfirmed: false,
            }],
            questions: [{
              id: 'q1',
              sectionId: 'sec1',
              displayNumber: '1',
              stemText: '?',
              options: [{ id: 'A', label: 'A', text: 'a' }, { id: 'B', label: 'B', text: 'b' }],
              correctOptionId: 'A',
            }],
            warnings: [],
            needsOcr: false,
            needsReview: false,
            teacherConfirmedReview: false,
          },
        }),
      };
    }
    if (String(url).includes('/drafts/d-savectx') && init?.method === 'PUT') {
      savedBody = JSON.parse(init.body);
      return {
        ok: true,
        headers: { get: () => 'application/json' },
        json: async () => ({ ok: true, revision: 2 }),
      };
    }
    if (String(url).includes('/auth/csrf')) {
      return {
        ok: true,
        headers: { get: () => 'application/json' },
        json: async () => ({ ok: true }),
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
    tryRenderExamView(ctx, { view: 'exams-draft', draftId: 'd-savectx' });
    await draftLoadedPromise;
    await new Promise((r) => setTimeout(r, 0));
    const ctxCheck = findDomNodeWithinAttr(
      root,
      'data-passage-id',
      'pg1',
      (n) => n.tagName === 'INPUT' && domNodeAttributeValue(n, 'type') === 'checkbox',
    );
    assert.ok(ctxCheck);
    ctxCheck.checked = true;
    ctxCheck.dispatchEvent({ type: 'change' });
    const saveBtn = [...root.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === 'Lưu đề');
    assert.ok(saveBtn);
    saveBtn.dispatchEvent({ type: 'click' });
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(savedBody?.passages?.[0]?.contextConfirmed);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('exam UI: teacher preview overlay is interactive and never calls student attempt APIs', async (t) => {
  installBaDomEnvironment(t, { cookie: 'bn_csrf=ui-test-csrf' });
  const root = document.getElementById('app-root');
  const calls = [];
  let summaryLoaded;
  const summaryLoadedPromise = new Promise((resolve) => {
    summaryLoaded = resolve;
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    const method = init?.method || 'GET';
    calls.push({ url: u, method });
    if (u.includes('/api/student/exams/attempts')) {
      throw new Error('student attempt API must not run in teacher preview');
    }
    if (u.includes('/api/teacher/exams/summary')) {
      summaryLoaded();
      return {
        ok: true,
        headers: { get: () => 'application/json' },
        json: async () => ({
          ok: true,
          drafts: [],
          versions: [{ id: 'v-prev', title: 'Đề preview', questionCount: 1 }],
          assignments: [],
        }),
      };
    }
    if (u.includes('/student-preview')) {
      return {
        ok: true,
        headers: { get: () => 'application/json' },
        json: async () => ({
          ok: true,
          exam: {
            title: 'Đề preview',
            passages: [{
              id: 'pg1',
              title: 'Questions 1-1 refer to the following text.',
              documents: [{ id: 'd1', title: 'Doc', bodyText: 'Passage once.', order: 0 }],
            }],
            questions: [{
              id: 'q1',
              displayNumber: '1',
              stemText: 'Pick one',
              passageId: 'pg1',
              options: [{ id: 'A', label: 'A', text: 'one' }, { id: 'B', label: 'B', text: 'two' }],
            }],
            assignment: { showScore: false, timeLimitMinutes: 30, dueAt: '2099-01-01T00:00:00.000Z' },
            attempt: { answers: {} },
            disclaimer: 'Xem thử.',
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
    tryRenderExamView(ctx, { view: 'exams-hub' });
    await summaryLoadedPromise;
    await new Promise((r) => setTimeout(r, 0));
    const previewBtn = findDomNodes(root, (n) => n.tagName === 'BUTTON'
      && domNodeAttributeValue(n, 'data-exam-action') === 'preview-as-student')[0];
    assert.ok(previewBtn);
    previewBtn.dispatchEvent({ type: 'click' });
    await new Promise((r) => setTimeout(r, 0));
    const overlay = findDomNodes(document.body, (n) => domNodeAttributeValue(n, 'data-exam-teacher-preview') != null)[0];
    assert.ok(overlay);
    assert.ok((overlay.textContent || '').includes('Chế độ xem trước — bài làm thử không được lưu'));
    assert.ok((overlay.textContent || '').includes('Passage once.'));
    const radios = findDomNodes(overlay, (n) => n.tagName === 'INPUT'
      && domNodeAttributeValue(n, 'type') === 'radio');
    assert.equal(radios.length, 2);
    radios[1].checked = true;
    radios[1].dispatchEvent({ type: 'change' });
    const passageCards = findDomNodes(overlay, (n) => domClassIncludes(n, 'exam-passage'));
    assert.equal(passageCards.length, 1, 'reading group should render once');
    const closeBtn = findDomNodes(overlay, (n) => domNodeAttributeValue(n, 'data-exam-preview-close') != null)[0];
    closeBtn.dispatchEvent({ type: 'click' });
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(findDomNodes(document.body, (n) => domNodeAttributeValue(n, 'data-exam-teacher-preview') != null).length, 0);
    assert.ok(calls.some((c) => c.url.includes('/student-preview')));
    assert.ok(!calls.some((c) => c.url.includes('/attempts/')));
  } finally {
    globalThis.fetch = originalFetch;
    removeExamTeacherPreviewOverlays();
  }
});

test('exam UI: draft preview keeps unsaved stem after close', async (t) => {
  installBaDomEnvironment(t, { cookie: 'bn_csrf=ui-test-csrf' });
  const root = document.getElementById('app-root');
  const originalFetch = globalThis.fetch;
  let draftLoaded;
  const draftLoadedPromise = new Promise((resolve) => {
    draftLoaded = resolve;
  });
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes('/drafts/d-prev') && (!init?.method || init.method === 'GET')) {
      draftLoaded();
      return {
        ok: true,
        headers: { get: () => 'application/json' },
        json: async () => ({
          ok: true,
          draft: {
            id: 'd-prev',
            revision: 1,
            title: 'Draft prev',
            sections: [{ id: 'sec1', title: 'Phần 1', order: 0 }],
            passages: [],
            questions: [{
              id: 'q1',
              sectionId: 'sec1',
              displayNumber: '1',
              stemText: 'Original stem',
              options: [
                { id: 'A', label: 'A', text: 'a' },
                { id: 'B', label: 'B', text: 'b' },
              ],
              correctOptionId: 'B',
            }],
            warnings: [],
            needsOcr: false,
            teacherConfirmedReview: false,
          },
        }),
      };
    }
    if (u.includes('/api/student/exams/attempts')) {
      throw new Error('no student attempt APIs in draft preview');
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
    tryRenderExamView(ctx, { view: 'exams-draft', draftId: 'd-prev' });
    await draftLoadedPromise;
    await new Promise((r) => setTimeout(r, 0));
    const qBlock = findDomNodeByAttr(root, 'data-question-id', 'q1');
    findDomNodes(qBlock, (n) => n.tagName === 'BUTTON'
      && domNodeAttributeValue(n, 'aria-label') === 'Chỉnh sửa câu 1')[0]?.dispatchEvent({ type: 'click' });
    await new Promise((r) => setTimeout(r, 0));
    const qBlockOpen = findDomNodeByAttr(root, 'data-question-id', 'q1');
    assert.ok(qBlockOpen);
    const stemTa = findDomNodes(qBlockOpen, (n) => n.tagName === 'TEXTAREA')[0];
    assert.ok(stemTa);
    stemTa.value = 'Edited stem unsaved';
    stemTa.dispatchEvent({ type: 'input', target: stemTa });
    const previewBtn = findDomNodes(root, (n) => n.tagName === 'BUTTON'
      && domNodeAttributeValue(n, 'data-exam-action') === 'preview-as-student')[0];
    assert.ok(previewBtn);
    previewBtn.dispatchEvent({ type: 'click' });
    await new Promise((r) => setTimeout(r, 0));
    const overlay = findDomNodes(document.body, (n) => domNodeAttributeValue(n, 'data-exam-teacher-preview') != null)[0];
    assert.ok((overlay.textContent || '').includes('Edited stem unsaved'));
    const closeBtn = findDomNodes(overlay, (n) => domNodeAttributeValue(n, 'data-exam-preview-close') != null)[0];
    closeBtn.dispatchEvent({ type: 'click' });
    await new Promise((r) => setTimeout(r, 0));
    const q1Again = findDomNodeByAttr(root, 'data-question-id', 'q1');
    assert.ok(q1Again);
    const q1PencilAgain = findDomNodes(q1Again, (n) => n.tagName === 'BUTTON'
      && domNodeAttributeValue(n, 'aria-label') === 'Chỉnh sửa câu 1')[0];
    assert.ok(q1PencilAgain);
    const q1PencilSvg = findDomNodes(
      q1PencilAgain,
      (n) => String(n.tagName).toLowerCase() === 'svg',
    )[0];
    assert.ok(q1PencilSvg);
    assert.equal(q1PencilSvg.namespaceURI, 'http://www.w3.org/2000/svg');
    assert.equal(q1PencilSvg.getAttribute('width'), '18');
    assert.equal(q1PencilSvg.getAttribute('height'), '18');
    q1PencilAgain.dispatchEvent({ type: 'click' });
    await new Promise((r) => setTimeout(r, 0));
    const q1Live = findDomNodeByAttr(root, 'data-question-id', 'q1');
    assert.ok(q1Live);
    const stemAfter = findDomNodes(q1Live, (n) => n.tagName === 'TEXTAREA')[0];
    assert.equal(stemAfter.value, 'Edited stem unsaved');
  } finally {
    globalThis.fetch = originalFetch;
    removeExamTeacherPreviewOverlays();
  }
});

test('exam UI: compose draft remove is immediate; undo restores group, stem, and save payload', async (t) => {
  installBaDomEnvironment(t, { cookie: 'bn_csrf=ui-test-csrf' });
  const root = document.getElementById('app-root');
  const originalFetch = globalThis.fetch;
  const originalConfirm = globalThis.confirm;
  let confirmInvoked = false;
  globalThis.confirm = () => {
    confirmInvoked = true;
    return false;
  };
  let draftLoaded;
  let savedBody = null;
  const putUrls = [];
  const draftLoadedPromise = new Promise((resolve) => {
    draftLoaded = resolve;
  });
  const mkOpts = () => ([
    { id: 'A', label: 'A', text: 'a' },
    { id: 'B', label: 'B', text: 'b' },
  ]);
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes('/drafts/d-compose-rm') && (!init?.method || init.method === 'GET')) {
      draftLoaded();
      return {
        ok: true,
        headers: { get: () => 'application/json' },
        json: async () => ({
          ok: true,
          draft: {
            id: 'd-compose-rm',
            revision: 3,
            title: 'Bản soạn QA',
            composedFromVersionId: 'v-source-frozen',
            sections: [{ id: 'sec1', title: 'Phần 1', order: 1 }],
            passages: [{
              id: 'pg-compose',
              sectionId: 'sec1',
              title: 'Questions 31-32 refer to the following text.',
              expectedQuestionRange: { min: 31, max: 32 },
              documents: [{ id: 'doc1', bodyText: 'Shared reading.' }],
            }],
            questions: [
              {
                id: 'q-rem-1',
                sectionId: 'sec1',
                passageId: 'pg-compose',
                groupId: 'pg-compose',
                displayNumber: '31',
                originalDisplayNumber: '31',
                sourceQuestionId: 'src-q-31',
                stemText: 'Stem one',
                options: mkOpts(),
                correctOptionId: 'A',
                points: 1,
                order: 1,
              },
              {
                id: 'q-rem-2',
                sectionId: 'sec1',
                passageId: 'pg-compose',
                groupId: 'pg-compose',
                displayNumber: '32',
                originalDisplayNumber: '32',
                sourceQuestionId: 'src-q-32',
                stemText: 'Stem two',
                options: mkOpts(),
                correctOptionId: 'B',
                points: 1,
                order: 2,
              },
            ],
            warnings: [],
            needsOcr: false,
            needsReview: false,
            teacherConfirmedReview: true,
          },
        }),
      };
    }
    if (u.includes('/drafts/d-compose-rm') && init?.method === 'PUT') {
      putUrls.push(u);
      savedBody = JSON.parse(init.body);
      return {
        ok: true,
        headers: { get: () => 'application/json' },
        json: async () => ({ ok: true, revision: 4 }),
      };
    }
    if (u.includes('/drafts/d-source-frozen') && init?.method === 'PUT') {
      throw new Error('source draft must not be mutated from compose editor');
    }
    if (u.includes('/auth/csrf')) {
      return {
        ok: true,
        headers: { get: () => 'application/json' },
        json: async () => ({ ok: true }),
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
    tryRenderExamView(ctx, { view: 'exams-draft', draftId: 'd-compose-rm' });
    await draftLoadedPromise;
    await new Promise((r) => setTimeout(r, 0));
    const block1 = findDomNodeByAttr(root, 'data-question-id', 'q-rem-1');
    assert.ok(block1);
    findDomNodes(block1, (n) => n.tagName === 'BUTTON'
      && domNodeAttributeValue(n, 'aria-label') === 'Chỉnh sửa câu 31')[0]?.dispatchEvent({ type: 'click' });
    await new Promise((r) => setTimeout(r, 0));
    const block1Open = findDomNodeByAttr(root, 'data-question-id', 'q-rem-1');
    assert.ok(block1Open);
    const stemTa = findDomNodes(block1Open, (n) => n.tagName === 'TEXTAREA')[0];
    assert.ok(stemTa);
    stemTa.value = 'Edited stem unsaved';
    stemTa.dispatchEvent({ type: 'input', target: stemTa });
    const rmBtn = findDomNodes(block1Open, (n) => n.tagName === 'BUTTON'
      && (n.textContent || '').trim() === 'Gỡ khỏi đề')[0];
    assert.ok(rmBtn);
    rmBtn.dispatchEvent({ type: 'click' });
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(confirmInvoked, false);
    assert.equal(findDomNodeByAttr(root, 'data-question-id', 'q-rem-1'), null);
    assert.ok(findDomNodeByAttr(root, 'data-question-id', 'q-rem-2'));
    const undoBtn = [...root.querySelectorAll('button')].find(
      (b) => (b.textContent || '').includes('Hoàn tác gỡ câu'),
    );
    assert.ok(undoBtn);
    assert.notEqual(undoBtn.disabled, true);
    undoBtn.dispatchEvent({ type: 'click' });
    await new Promise((r) => setTimeout(r, 0));
    const restoredLive = findDomNodeByAttr(root, 'data-question-id', 'q-rem-1');
    assert.ok(restoredLive);
    assert.ok(findDomNodeByAttr(root, 'data-question-id', 'q-rem-2'));
    const rmPencilBtn = findDomNodes(restoredLive, (n) => n.tagName === 'BUTTON'
      && domNodeAttributeValue(n, 'aria-label') === 'Chỉnh sửa câu 31')[0];
    assert.ok(rmPencilBtn);
    const rmPencilSvg = findDomNodes(
      rmPencilBtn,
      (n) => String(n.tagName).toLowerCase() === 'svg',
    )[0];
    assert.ok(rmPencilSvg);
    assert.equal(rmPencilSvg.namespaceURI, 'http://www.w3.org/2000/svg');
    assert.equal(rmPencilSvg.getAttribute('width'), '18');
    assert.equal(rmPencilSvg.getAttribute('height'), '18');
    const rmPencilPath = findDomNodes(
      rmPencilSvg,
      (n) => String(n.tagName).toLowerCase() === 'path',
    )[0];
    assert.ok(rmPencilPath);
    assert.equal(rmPencilPath.namespaceURI, 'http://www.w3.org/2000/svg');
    rmPencilBtn.dispatchEvent({ type: 'click' });
    await new Promise((r) => setTimeout(r, 0));
    const restoredOpen = findDomNodeByAttr(root, 'data-question-id', 'q-rem-1');
    assert.ok(restoredOpen);
    const groupSel = findDomNodes(
      restoredOpen,
      (n) => n.tagName === 'SELECT' && domNodeAttributeValue(n, 'data-exam-draft-q-passage-group') !== null,
    )[0];
    assert.equal(groupSel?.value, 'pg-compose');
    const stemAfterUndo = findDomNodes(restoredOpen, (n) => n.tagName === 'TEXTAREA')[0];
    assert.equal(stemAfterUndo?.value, 'Edited stem unsaved');
    const saveBtn = [...root.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === 'Lưu đề');
    assert.ok(saveBtn);
    saveBtn.dispatchEvent({ type: 'click' });
    await new Promise((r) => setTimeout(r, 80));
    assert.ok(savedBody);
    assert.equal(savedBody.questions.length, 2);
    const q1Saved = savedBody.questions.find((q) => q.id === 'q-rem-1');
    assert.equal(q1Saved?.stemText, 'Edited stem unsaved');
    assert.equal(q1Saved?.passageId, 'pg-compose');
    assert.equal(putUrls.length, 1);
    assert.ok(putUrls[0].includes('/drafts/d-compose-rm'));
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.confirm = originalConfirm;
  }
});

test('exam UI: draft editor points input saves positive weight only when edited', async (t) => {
  installBaDomEnvironment(t, { cookie: 'bn_csrf=ui-test-csrf' });
  const root = document.getElementById('app-root');
  const originalFetch = globalThis.fetch;
  let draftLoaded;
  let savedBody = null;
  const draftLoadedPromise = new Promise((resolve) => {
    draftLoaded = resolve;
  });
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/drafts/d-points') && (!init?.method || init.method === 'GET')) {
      draftLoaded();
      return {
        ok: true,
        headers: { get: () => 'application/json' },
        json: async () => ({
          ok: true,
          draft: {
            id: 'd-points',
            revision: 1,
            title: 'Points',
            sections: [{ id: 'sec1', title: 'Phần 1', order: 0 }],
            passages: [],
            questions: [{
              id: 'q-pts',
              sectionId: 'sec1',
              displayNumber: '5',
              originalDisplayNumber: '5',
              sourceQuestionId: 'src-5',
              stemText: 'Weight?',
              options: [
                { id: 'A', label: 'A', text: 'a' },
                { id: 'B', label: 'B', text: 'b' },
              ],
              correctOptionId: 'A',
              order: 1,
            }],
            warnings: [],
            needsOcr: false,
            teacherConfirmedReview: false,
          },
        }),
      };
    }
    if (String(url).includes('/drafts/d-points') && init?.method === 'PUT') {
      savedBody = JSON.parse(init.body);
      return {
        ok: true,
        headers: { get: () => 'application/json' },
        json: async () => ({ ok: true, revision: 2 }),
      };
    }
    if (String(url).includes('/auth/csrf')) {
      return {
        ok: true,
        headers: { get: () => 'application/json' },
        json: async () => ({ ok: true }),
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
    tryRenderExamView(ctx, { view: 'exams-draft', draftId: 'd-points' });
    await draftLoadedPromise;
    await new Promise((r) => setTimeout(r, 0));
    const qPtsBlock = findDomNodeByAttr(root, 'data-question-id', 'q-pts');
    findDomNodes(qPtsBlock, (n) => n.tagName === 'BUTTON'
      && domNodeAttributeValue(n, 'aria-label') === 'Chỉnh sửa câu 5')[0]?.dispatchEvent({ type: 'click' });
    await new Promise((r) => setTimeout(r, 0));
    const pointsInput = findDomNodeWithinAttr(
      root,
      'data-question-id',
      'q-pts',
      (n) => n.id === 'exam-q-points-q-pts',
    );
    assert.ok(pointsInput);
    assert.match(root.textContent || '', /Điểm câu 5/);
    pointsInput.value = '2.5';
    pointsInput.dispatchEvent({ type: 'input', target: pointsInput });
    const saveBtn = [...root.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === 'Lưu đề');
    saveBtn.dispatchEvent({ type: 'click' });
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(savedBody?.questions?.[0]?.points, 2.5);
    assert.equal(savedBody?.questions?.[0]?.originalDisplayNumber, '5');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('exam UI: assign view shows purpose and question selection summary', async (t) => {
  installBaDomEnvironment(t, { cookie: 'bn_csrf=ui-test-csrf' });
  const root = document.getElementById('app-root');
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes('/student-preview')) {
      return {
        ok: true,
        headers: { get: () => 'application/json' },
        json: async () => ({
          ok: true,
          exam: {
            versionId: 'v1',
            title: 'Đề chọn câu',
            sections: [],
            passages: [],
            questions: [
              { id: 'q1', displayNumber: '1', stemText: 'One', options: [] },
              { id: 'q2', displayNumber: '2', stemText: 'Two', options: [] },
            ],
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
      state: { data: { classes: [{ id: 'c1', name: 'Lớp A' }] } },
    };
    tryRenderExamView(ctx, { view: 'exams-assign', versionId: 'v1' });
    await new Promise((r) => setTimeout(r, 0));
    const text = root.textContent || '';
    assert.ok(text.includes('Loại giao bài'));
    assert.ok(text.includes('Chọn câu hỏi'));
    const summary = findDomNodes(root, (n) => domNodeAttributeValue(n, 'data-exam-selection-summary') != null)[0];
    assert.ok(summary);
    assert.match(summary.textContent || '', /2\/2/);
    const hwRadio = findDomNodes(root, (n) => n.id === 'exam-assign-purpose-hw')[0];
    assert.ok(hwRadio);
    hwRadio.checked = true;
    hwRadio.dispatchEvent({ type: 'change', target: hwRadio });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('exam UI: compose view shows per-source count and builds multi-source create body', async (t) => {
  installBaDomEnvironment(t, { cookie: 'bn_csrf=ui-test-csrf' });
  const root = document.getElementById('app-root');
  const originalFetch = globalThis.fetch;
  const posts = [];
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes('/auth/csrf')) {
      return { ok: true, headers: { get: () => 'application/json' }, json: async () => ({ ok: true }) };
    }
    if (u.includes('/teacher/exams/summary')) {
      return {
        ok: true,
        headers: { get: () => 'application/json' },
        json: async () => ({
          ok: true,
          versions: [
            { id: 'v-a', title: 'Đề A', questionCount: 2 },
            { id: 'v-b', title: 'Đề B', questionCount: 1 },
          ],
        }),
      };
    }
    if (u.includes('/versions/v-a/compose-source')) {
      return {
        ok: true,
        headers: { get: () => 'application/json' },
        json: async () => ({
          ok: true,
          source: {
            versionId: 'v-a',
            title: 'Đề A',
            questionCount: 2,
            hasSourcePdf: true,
            questions: [
              { id: 'qa1', displayNumber: '1', stemSnippet: 'A1', passageId: null },
              { id: 'qa2', displayNumber: '2', stemSnippet: 'A2', passageId: null },
            ],
            groups: [],
          },
        }),
      };
    }
    if (u.includes('/versions/v-b/compose-source')) {
      return {
        ok: true,
        headers: { get: () => 'application/json' },
        json: async () => ({
          ok: true,
          source: {
            versionId: 'v-b',
            title: 'Đề B',
            questionCount: 1,
            questions: [{ id: 'qb1', displayNumber: '1', stemSnippet: 'B1', passageId: null }],
            groups: [],
          },
        }),
      };
    }
    if (u.includes('/teacher/exams/drafts') && init?.method === 'POST') {
      posts.push(JSON.parse(init.body));
      return {
        ok: true,
        headers: { get: () => 'application/json' },
        json: async () => ({ ok: true, draftId: 'd-new' }),
      };
    }
    return { ok: false, status: 404, headers: { get: () => 'application/json' }, json: async () => ({ ok: false }) };
  };
  try {
    const ctx = {
      isTeacher: () => true,
      navigate: () => {},
      toastOk: () => {},
      toastErr: (m) => { throw new Error(m); },
      state: { data: { classes: [] } },
    };
    tryRenderExamView(ctx, { view: 'exams-compose' });
    await new Promise((r) => setTimeout(r, 0));
    const pickA = findDomNodes(root, (n) => n.tagName === 'INPUT'
      && n.type === 'checkbox'
      && domNodeAttributeValue(n, 'data-version-id') === 'v-a')[0];
    const pickB = findDomNodes(root, (n) => n.tagName === 'INPUT'
      && n.type === 'checkbox'
      && domNodeAttributeValue(n, 'data-version-id') === 'v-b')[0];
    assert.ok(pickA && pickB);
    pickA.checked = true;
    pickA.dispatchEvent({ type: 'change', target: pickA });
    pickB.checked = true;
    pickB.dispatchEvent({ type: 'change', target: pickB });
    await new Promise((r) => setTimeout(r, 0));
    const q1 = findDomNodes(root, (n) => n.tagName === 'INPUT'
      && n.type === 'checkbox'
      && domNodeAttributeValue(n, 'data-question-id') === 'qa1')[0];
    assert.ok(q1);
    q1.checked = true;
    q1.dispatchEvent({ type: 'change', target: q1 });
    const qb = findDomNodes(root, (n) => n.tagName === 'INPUT'
      && n.type === 'checkbox'
      && domNodeAttributeValue(n, 'data-question-id') === 'qb1')[0];
    assert.ok(qb);
    qb.checked = true;
    qb.dispatchEvent({ type: 'change', target: qb });
    const status = root.textContent || '';
    assert.match(status, /Đề A: 1 câu/);
    assert.match(status, /Đề B: 1 câu/);
    assert.match(status, /tổng 2 câu/);
    const createBtn = [...root.querySelectorAll('button')].find((b) => (b.textContent || '').includes('Tạo bản nháp'));
    assert.ok(createBtn);
    createBtn.dispatchEvent({ type: 'click' });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(posts.length, 1);
    assert.ok(Array.isArray(posts[0].sources));
    assert.equal(posts[0].sources.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('exam UI: draft editor shows provenance summary and merge-from-bank panel', async (t) => {
  installBaDomEnvironment(t, { cookie: 'bn_csrf=ui-test-csrf' });
  const root = document.getElementById('app-root');
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/teacher/exams/summary')) {
      return {
        ok: true,
        headers: { get: () => 'application/json' },
        json: async () => ({
          ok: true,
          versions: [{ id: 'v-bank', title: 'Đề kho', questionCount: 3 }],
        }),
      };
    }
    if (u.includes('/drafts/d-prov')) {
      return {
        ok: true,
        headers: { get: () => 'application/json' },
        json: async () => ({
          ok: true,
          draft: {
            id: 'd-prov',
            revision: 1,
            title: 'Gộp',
            sections: [{ id: 'sec1', title: 'Phần 1', order: 1 }],
            passages: [],
            composedSourceExamBindings: {
              'v-x': { sourceTitle: 'Đề một', sourceAttachmentId: 'att1' },
              'v-y': { sourceTitle: 'Đề hai', sourceAttachmentId: 'att2' },
            },
            questions: [
              {
                id: 'q1',
                sectionId: 'sec1',
                displayNumber: '1',
                order: 1,
                sourceVersionId: 'v-x',
                stemText: 'S1',
                options: [{ id: 'A', label: 'A', text: 'a' }],
                correctOptionId: 'A',
              },
              {
                id: 'q2',
                sectionId: 'sec1',
                displayNumber: '2',
                order: 2,
                sourceVersionId: 'v-y',
                stemText: 'S2',
                options: [{ id: 'A', label: 'A', text: 'a' }],
                correctOptionId: 'A',
              },
            ],
            warnings: [],
            needsOcr: false,
            needsReview: false,
            teacherConfirmedReview: false,
            gradingMode: 'automatic',
            sourceAttachmentId: 'att1',
          },
        }),
      };
    }
    return { ok: true, headers: { get: () => 'application/json' }, json: async () => ({ ok: true }) };
  };
  try {
    const ctx = {
      isTeacher: () => true,
      navigate: () => {},
      toastOk: () => {},
      toastErr: (m) => { throw new Error(m); },
      state: { data: { classes: [] } },
    };
    tryRenderExamView(ctx, { view: 'exams-draft', draftId: 'd-prov' });
    await new Promise((r) => setTimeout(r, 0));
    const prov = findDomNodes(root, (n) => domNodeAttributeValue(n, 'data-exam-draft-provenance-summary') != null)[0];
    assert.ok(prov);
    assert.match(prov.textContent || '', /Đề một: 1 câu/);
    assert.match(prov.textContent || '', /Đề hai: 1 câu/);
    const merge = findDomNodes(root, (n) => domNodeAttributeValue(n, 'data-exam-draft-merge-panel') != null)[0];
    assert.ok(merge);
    assert.match(merge.textContent || '', /Thêm câu từ đề đã xuất bản/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('exam UI: compose-append locks draft controls until deferred append finishes', async (t) => {
  installBaDomEnvironment(t, { cookie: 'bn_csrf=ui-test-csrf' });
  const root = document.getElementById('app-root');
  const originalFetch = globalThis.fetch;
  let appendResolve;
  const appendPromise = new Promise((r) => {
    appendResolve = r;
  });
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes('/teacher/exams/summary')) {
      return {
        ok: true,
        headers: { get: () => 'application/json' },
        json: async () => ({ ok: true, versions: [{ id: 'v-bank', title: 'Đề kho', questionCount: 2 }] }),
      };
    }
    if (u.includes('/drafts/d-append-lock') && (!init?.method || init.method === 'GET')) {
      return {
        ok: true,
        headers: { get: () => 'application/json' },
        json: async () => ({
          ok: true,
          draft: {
            id: 'd-append-lock',
            revision: 1,
            title: 'Gộp',
            sections: [{ id: 'sec1', title: 'Phần 1', order: 1 }],
            passages: [],
            composedSourceExamBindings: {
              'v-a': { sourceTitle: 'Đề một', sourceAttachmentId: 'att-a' },
              'v-b': { sourceTitle: 'Đề hai', sourceAttachmentId: 'att-b' },
            },
            questions: [
              {
                id: 'q1',
                sectionId: 'sec1',
                displayNumber: '1',
                order: 1,
                sourceVersionId: 'v-a',
                sourceQuestionId: 's1',
                stemText: 'A',
                options: [{ id: 'A', label: 'A', text: 'a' }],
                correctOptionId: 'A',
              },
            ],
            warnings: [],
            needsOcr: false,
            needsReview: false,
            teacherConfirmedReview: false,
            gradingMode: 'automatic',
            sourceAttachmentId: 'att-a',
          },
        }),
      };
    }
    if (u.includes('/versions/v-bank/compose-source')) {
      return {
        ok: true,
        headers: { get: () => 'application/json' },
        json: async () => ({
          ok: true,
          source: {
            versionId: 'v-bank',
            title: 'Kho',
            questionCount: 1,
            hasSourcePdf: false,
            questions: [{ id: 'qnew', displayNumber: '9', stemSnippet: 'New', passageId: null }],
            groups: [],
          },
        }),
      };
    }
    if (u.includes('/drafts/d-append-lock/compose-append') && init?.method === 'POST') {
      await appendPromise;
      return {
        ok: true,
        headers: { get: () => 'application/json' },
        json: async () => ({
          ok: true,
          addedCount: 1,
          skippedDuplicateSourceQuestions: 0,
          draft: {
            id: 'd-append-lock',
            revision: 2,
            title: 'Gộp',
            sections: [{ id: 'sec1', title: 'Phần 1', order: 1 }],
            passages: [],
            composedSourceExamBindings: {
              'v-a': { sourceTitle: 'Đề một', sourceAttachmentId: 'att-a' },
              'v-b': { sourceTitle: 'Đề hai', sourceAttachmentId: 'att-b' },
            },
            questions: [
              {
                id: 'q1',
                sectionId: 'sec1',
                displayNumber: '1',
                order: 1,
                sourceVersionId: 'v-a',
                stemText: 'A',
                options: [{ id: 'A', label: 'A', text: 'a' }],
                correctOptionId: 'A',
              },
              {
                id: 'q2',
                sectionId: 'sec1',
                displayNumber: '2',
                order: 2,
                sourceVersionId: 'v-bank',
                stemText: 'B',
                options: [{ id: 'A', label: 'A', text: 'a' }],
                correctOptionId: 'A',
              },
            ],
            warnings: [],
            needsOcr: false,
            needsReview: false,
            teacherConfirmedReview: false,
            gradingMode: 'automatic',
            sourceAttachmentId: 'att-a',
          },
        }),
      };
    }
    if (u.includes('/auth/csrf')) {
      return { ok: true, headers: { get: () => 'application/json' }, json: async () => ({ ok: true }) };
    }
    return { ok: false, status: 404, headers: { get: () => 'application/json' }, json: async () => ({ ok: false }) };
  };
  try {
    let errDuringAssert;
    const ctx = {
      isTeacher: () => true,
      navigate: () => {},
      toastOk: () => {},
      toastErr: (m) => { throw new Error(m); },
      state: { data: { classes: [] } },
    };
    tryRenderExamView(ctx, { view: 'exams-draft', draftId: 'd-append-lock' });
    await new Promise((r) => setTimeout(r, 0));
    const mergeSelPick = [...root.querySelectorAll('select')].find((s) => s.getAttribute('aria-label') === 'Chọn đề nguồn để thêm câu');
    assert.ok(mergeSelPick);
    mergeSelPick.value = 'v-bank';
    mergeSelPick.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
    const mergeCb = [...root.querySelectorAll('input[type=checkbox]')].find((c) => domNodeAttributeValue(c, 'data-merge-qid'));
    assert.ok(mergeCb);
    mergeCb.checked = true;
    mergeCb.dispatchEvent(new Event('change', { bubbles: true }));
    const mergeBtn = [...root.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === 'Thêm câu đã chọn');
    assert.ok(mergeBtn);
    mergeBtn.dispatchEvent({ type: 'click' });
    await new Promise((r) => setTimeout(r, 0));
    const titleDuring = root.querySelector('input[data-exam-target="title"]');
    const mergeSelDuring = [...root.querySelectorAll('select')].find((s) => s.getAttribute('aria-label') === 'Chọn đề nguồn để thêm câu');
    assert.ok(titleDuring);
    assert.ok(mergeSelDuring);
    try {
      assert.equal(titleDuring.disabled, true);
      assert.equal(mergeSelDuring.disabled, true);
    } catch (e) {
      errDuringAssert = e;
    } finally {
      appendResolve();
      await appendPromise.catch(() => {});
      await new Promise((r) => setTimeout(r, 20));
    }
    if (!errDuringAssert) {
      const titleAfter = root.querySelector('input[data-exam-target="title"]');
      const mergeSelAfter = [...root.querySelectorAll('select')].find((s) => s.getAttribute('aria-label') === 'Chọn đề nguồn để thêm câu');
      assert.ok(titleAfter);
      assert.ok(mergeSelAfter);
      assert.equal(titleAfter.disabled, false);
      assert.equal(mergeSelAfter.disabled, false);
    }
    if (errDuringAssert) throw errDuringAssert;
  } finally {
    globalThis.fetch = originalFetch;
    appendResolve?.();
    await appendPromise.catch(() => {});
  }
});

test('exam UI: Xem nguồn switches PDF toolbar to question sourceVersionId before gotoPage', async (t) => {
  installBaDomEnvironment(t, { cookie: 'bn_csrf=ui-test-csrf' });
  const root = document.getElementById('app-root');
  const originalFetch = globalThis.fetch;
  const sourceFetchUrls = [];
  globalThis.__examPdfJsTestLib = async () => ({
    GlobalWorkerOptions: {},
    getDocument: () => ({
      promise: Promise.resolve({
        numPages: 3,
        getPage: async (n) => ({
          getViewport: () => ({ width: 100, height: 100 }),
          render: () => ({ promise: Promise.resolve() }),
          cleanup: () => {},
        }),
      }),
    }),
  });
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/teacher/exams/summary')) {
      return {
        ok: true,
        headers: { get: () => 'application/json' },
        json: async () => ({ ok: true, versions: [] }),
      };
    }
    if (u.includes('/drafts/d-pdf-jump') && !u.includes('/source')) {
      return {
        ok: true,
        headers: { get: () => 'application/json' },
        json: async () => ({
          ok: true,
          draft: {
            id: 'd-pdf-jump',
            revision: 1,
            title: 'Hai PDF',
            sections: [{ id: 'sec1', title: 'Phần 1', order: 1 }],
            passages: [],
            composedSourceExamBindings: {
              'v-a': { sourceTitle: 'Đề một', sourceAttachmentId: 'att-a' },
              'v-b': { sourceTitle: 'Đề hai', sourceAttachmentId: 'att-b' },
            },
            questions: [
              {
                id: 'q-a',
                sectionId: 'sec1',
                displayNumber: '1',
                order: 1,
                sourceVersionId: 'v-a',
                sourcePage: 1,
                stemText: 'A',
                options: [{ id: 'A', label: 'A', text: 'a' }],
                correctOptionId: 'A',
              },
              {
                id: 'q-b',
                sectionId: 'sec1',
                displayNumber: '2',
                order: 2,
                sourceVersionId: 'v-b',
                sourcePage: 2,
                stemText: 'B',
                options: [{ id: 'A', label: 'A', text: 'a' }],
                correctOptionId: 'A',
              },
            ],
            warnings: [],
            needsOcr: false,
            needsReview: false,
            teacherConfirmedReview: false,
            gradingMode: 'automatic',
            sourceAttachmentId: 'att-a',
          },
        }),
      };
    }
    if (u.includes('/drafts/d-pdf-jump/source')) {
      sourceFetchUrls.push(u);
      return { ok: true, arrayBuffer: async () => new ArrayBuffer(8) };
    }
    if (u.includes('/auth/csrf')) {
      return { ok: true, headers: { get: () => 'application/json' }, json: async () => ({ ok: true }) };
    }
    return { ok: true, headers: { get: () => 'application/json' }, json: async () => ({ ok: true }) };
  };
  try {
    const ctx = {
      isTeacher: () => true,
      navigate: () => {},
      toastOk: () => {},
      toastErr: (m) => { throw new Error(m); },
      state: { data: { classes: [] } },
    };
    tryRenderExamView(ctx, { view: 'exams-draft', draftId: 'd-pdf-jump' });
    await new Promise((r) => setTimeout(r, 0));
    const pdfSel = root.querySelector('.exam-draft-pdf-toolbar select');
    assert.ok(pdfSel);
    pdfSel.value = 'v-a';
    pdfSel.dispatchEvent(new Event('change', { bubbles: true }));
    let wrap = root.querySelector('.exam-pdf-preview');
    assert.ok(wrap?.__whenReady);
    await wrap.__whenReady.catch(() => {});
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(root.querySelector('.exam-draft-pdf-toolbar select')?.value, 'v-a');
    const blockB = findDomNodeByAttr(root, 'data-question-id', 'q-b');
    assert.ok(blockB);
    const srcBtn = [...blockB.querySelectorAll('button')].find((b) => (b.textContent || '').includes('Xem nguồn'));
    assert.ok(srcBtn);
    srcBtn.dispatchEvent({ type: 'click', bubbles: true });
    await new Promise((r) => queueMicrotask(r));
    wrap = root.querySelector('.exam-pdf-preview');
    assert.ok(wrap?.__whenReady);
    await wrap.__whenReady.catch(() => {});
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(root.querySelector('.exam-draft-pdf-toolbar select')?.value, 'v-b');
    const pageSelAfter = wrap.querySelector('select');
    assert.equal(String(pageSelAfter?.value ?? ''), '2');
    assert.ok(
      sourceFetchUrls.some((s) => s.startsWith(examDraftSourceUrl('d-pdf-jump', { sourceVersionId: 'v-b' }))),
      `expected source fetch for v-b, got: ${sourceFetchUrls.join(' | ')}`,
    );
  } finally {
    globalThis.fetch = originalFetch;
    delete globalThis.__examPdfJsTestLib;
  }
});
