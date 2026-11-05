import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createGradingDirtyTracker,
  gradingWriteResourceKey,
  normalizeGradingScore,
} from '../dist/ux-grading-dirty.js';

const baseDraft = {
  score: '8',
  overallFeedback: 'Good',
  pages: [{ annotations: [] }],
};

function ctx(overrides = {}) {
  return {
    getScore: () => overrides.score ?? baseDraft.score,
    getFeedback: () => overrides.feedback ?? baseDraft.overallFeedback,
    getDraft: () => overrides.draft ?? baseDraft,
    getSession: () => overrides.session ?? {},
    hasPendingSave: overrides.hasPendingSave,
  };
}

test('gradingWriteResourceKey combines submission and version ids', () => {
  assert.equal(gradingWriteResourceKey('sub-1', 'ver-2'), 'submission:sub-1:ver-2');
});

test('normalizeGradingScore aligns numeric and string UI values', () => {
  assert.equal(normalizeGradingScore(9), '9');
  assert.equal(normalizeGradingScore('9'), '9');
  assert.equal(normalizeGradingScore('9.0'), '9');
});

test('grading dirty stays clean until score or feedback changes', () => {
  const tracker = createGradingDirtyTracker(baseDraft);
  assert.equal(tracker.isDirty(ctx()), false);
  assert.equal(tracker.isDirty(ctx({ score: '9' })), true);
  assert.equal(tracker.isDirty(ctx({ feedback: 'Updated' })), true);
});

test('autosave ack marks only captured snapshot clean', () => {
  const tracker = createGradingDirtyTracker(baseDraft);
  const token = tracker.captureForPersist(baseDraft, '9', 'Good');
  assert.equal(tracker.isDirty(ctx({ score: '9' })), true, 'still dirty until ack');
  tracker.markAcknowledgedFromCapture(token);
  assert.equal(tracker.isDirty(ctx({ score: '9' })), false);
  assert.equal(tracker.isDirty(ctx({ score: '9.5' })), true, 'edits after ack stay dirty');
});

test('acked UI score stays clean when draft.score lags or uses numeric type', () => {
  const tracker = createGradingDirtyTracker(baseDraft);
  const laggingDraft = { ...baseDraft, score: 8 };
  const token = tracker.captureForPersist(laggingDraft, '9', 'Good');
  tracker.markAcknowledgedFromCapture(token);
  assert.equal(
    tracker.isDirty(ctx({ score: '9', draft: laggingDraft })),
    false,
    'UI score matches ack; draft scalar may lag',
  );
});

test('failed persist keeps dirty when capture never acked', () => {
  const tracker = createGradingDirtyTracker(baseDraft);
  tracker.captureForPersist(baseDraft, '7', 'Try again');
  assert.equal(tracker.isDirty(ctx({ score: '7' })), true);
});

test('late ack of superseded capture does not regress newer baseline', () => {
  const tracker = createGradingDirtyTracker(baseDraft);
  const tokenA = tracker.captureForPersist(baseDraft, '9', 'Good');
  const tokenB = tracker.captureForPersist(baseDraft, '9.5', 'Good');
  tracker.markAcknowledgedFromCapture(tokenA);
  assert.equal(
    tracker.isDirty(ctx({ score: '9.5' })),
    true,
    'ackA must not clear newer capture B',
  );
  tracker.markAcknowledgedFromCapture(tokenB);
  assert.equal(tracker.isDirty(ctx({ score: '9.5' })), false);
  tracker.markAcknowledgedFromCapture(tokenA);
  assert.equal(
    tracker.isDirty(ctx({ score: '9.5' })),
    false,
    'stale ackA must not regress confirmed B',
  );
});

test('live grading gestures keep editor dirty', () => {
  const tracker = createGradingDirtyTracker(baseDraft);
  assert.equal(
    tracker.isDirty(ctx({ session: { penGesture: { points: [1] } } })),
    true,
  );
});

test('pending explicit save counts as dirty', () => {
  const tracker = createGradingDirtyTracker(baseDraft);
  assert.equal(tracker.isDirty(ctx({ hasPendingSave: () => true })), true);
});
