import test from 'node:test';
import assert from 'node:assert/strict';
import { createGradingGestureSettlement } from '../dist/ux-grading-gestures.js';

function makePenGesture(overrides = {}) {
  return {
    pointerId: 1,
    pageIndex: 0,
    versionId: 'v1',
    imageLoadSeq: 1,
    w: 400,
    h: 300,
    color: '#111',
    nw: 0.01,
    points: [{ x: 10, y: 10 }, { x: 20, y: 20 }],
    livePath: null,
    ...overrides,
  };
}

function makeSettlement(session, draft, queueAutosave) {
  let undoCount = 0;
  const settlement = createGradingGestureSettlement({
    getSession: () => session,
    getDraft: () => draft,
    getVersionId: () => 'v1',
    getPageIndex: () => session.pageIndex,
    measureDisplaySize: () => ({ w: 400, h: 300 }),
    pushUndo: () => { undoCount += 1; },
    getUndoStack: (pageIndex) => {
      const key = String(pageIndex);
      if (!draft.undoStacks[key]) draft.undoStacks[key] = { past: [], future: [] };
      return draft.undoStacks[key];
    },
    renderOverlay: () => {},
    uid: () => 'stroke-1',
    queueAutosave,
  });
  return { settlement, getUndoCount: () => undoCount };
}

function undoStackFor(draft, pageIndex = 0) {
  const key = String(pageIndex);
  if (!draft.undoStacks[key]) draft.undoStacks[key] = { past: [], future: [] };
  return draft.undoStacks[key];
}

test('pen pointer finish clears live gesture before autosave re-enters settle', () => {
  const draft = { pages: [{ annotations: [] }], undoStacks: {} };
  const session = {
    pageIndex: 0,
    imageLoadSeq: 1,
    penGesture: makePenGesture(),
    eraserGesture: null,
    drag: null,
  };
  let autosaveCalls = 0;
  const { settlement, getUndoCount } = makeSettlement(session, draft, () => {
    autosaveCalls += 1;
    settlement.settleGradingGesturesIntoDraft();
  });

  settlement.finishPenPointer({ pointerId: 1 });

  assert.equal(session.penGesture, null);
  assert.equal(draft.pages[0].annotations.length, 1);
  assert.equal(getUndoCount(), 1);
  assert.equal(autosaveCalls, 1);
});

test('pen stale imageLoadSeq clears gesture without commit or autosave', () => {
  const draft = { pages: [{ annotations: [] }], undoStacks: {} };
  const session = {
    pageIndex: 0,
    imageLoadSeq: 2,
    penGesture: makePenGesture({ imageLoadSeq: 1 }),
    eraserGesture: null,
    drag: null,
  };
  let autosaveCalls = 0;
  const { settlement, getUndoCount } = makeSettlement(session, draft, () => {
    autosaveCalls += 1;
  });

  settlement.finishPenPointer({ pointerId: 1 });

  assert.equal(session.penGesture, null);
  assert.equal(draft.pages[0].annotations.length, 0);
  assert.equal(getUndoCount(), 0);
  assert.equal(autosaveCalls, 0);
});

test('eraser finish clears live gesture before autosave re-enters settle', () => {
  const pre = JSON.stringify([{ id: 'p1', type: 'pen', points: [] }]);
  const draft = { pages: [{ annotations: JSON.parse(pre) }], undoStacks: {} };
  const session = {
    pageIndex: 0,
    imageLoadSeq: 1,
    penGesture: null,
    drag: null,
    eraserGesture: {
      pointerId: 2,
      pageIndex: 0,
      preSnapshot: pre,
      touchedIds: ['p1'],
    },
  };
  let autosaveCalls = 0;
  const { settlement } = makeSettlement(session, draft, () => {
    autosaveCalls += 1;
    settlement.settleGradingGesturesIntoDraft();
  });

  settlement.finishEraserPointer({ pointerId: 2 });

  assert.equal(session.eraserGesture, null);
  assert.equal(autosaveCalls, 1);
  assert.equal(draft.pages[0].annotations.length, 0);
  const stack = undoStackFor(draft, 0);
  assert.equal(stack.past.length, 1);
  assert.equal(stack.future.length, 0);
  assert.equal(stack.past[0], pre);
});

test('finishPenPointer ignores wrong pointerId', () => {
  const draft = { pages: [{ annotations: [] }], undoStacks: {} };
  const session = {
    pageIndex: 0,
    imageLoadSeq: 1,
    penGesture: makePenGesture({ pointerId: 1 }),
    eraserGesture: null,
    drag: null,
  };
  let autosaveCalls = 0;
  const { settlement, getUndoCount } = makeSettlement(session, draft, () => {
    autosaveCalls += 1;
  });

  settlement.finishPenPointer({ pointerId: 99 });

  assert.ok(session.penGesture);
  assert.equal(draft.pages[0].annotations.length, 0);
  assert.equal(getUndoCount(), 0);
  assert.equal(autosaveCalls, 0);
});

test('finishPenPointer is idempotent after successful commit', () => {
  const draft = { pages: [{ annotations: [] }], undoStacks: {} };
  const session = {
    pageIndex: 0,
    imageLoadSeq: 1,
    penGesture: makePenGesture(),
    eraserGesture: null,
    drag: null,
  };
  let autosaveCalls = 0;
  const { settlement, getUndoCount } = makeSettlement(session, draft, () => {
    autosaveCalls += 1;
  });

  settlement.finishPenPointer({ pointerId: 1 });
  settlement.finishPenPointer({ pointerId: 1 });

  assert.equal(session.penGesture, null);
  assert.equal(draft.pages[0].annotations.length, 1);
  assert.equal(getUndoCount(), 1);
  assert.equal(autosaveCalls, 1);
});

test('finishEraserPointer ignores wrong pointerId', () => {
  const pre = JSON.stringify([{ id: 'p1', type: 'pen', points: [] }]);
  const draft = { pages: [{ annotations: JSON.parse(pre) }], undoStacks: {} };
  const session = {
    pageIndex: 0,
    imageLoadSeq: 1,
    penGesture: null,
    drag: null,
    eraserGesture: {
      pointerId: 2,
      pageIndex: 0,
      preSnapshot: pre,
      touchedIds: ['p1'],
    },
  };
  let autosaveCalls = 0;
  const { settlement } = makeSettlement(session, draft, () => {
    autosaveCalls += 1;
  });

  settlement.finishEraserPointer({ pointerId: 99 });

  assert.ok(session.eraserGesture);
  assert.equal(draft.pages[0].annotations.length, 1);
  assert.equal(undoStackFor(draft, 0).past.length, 0);
  assert.equal(autosaveCalls, 0);
});
