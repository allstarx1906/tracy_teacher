import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createPersistWithStatus, replayPayloadSignature } from '../dist/ux-persist.js';
import {
  createGradingDirtyTracker,
  gradingWriteResourceKey,
} from '../dist/ux-grading-dirty.js';
import { registerDirtyProbe, isGloballyDirty } from '../dist/ux-forms.js';
import { installBrowserWindowFixture } from './helper-browser-window.mjs';

const appSrc = readFileSync(new URL('../dist/app.js', import.meta.url), 'utf8');

const baseDraft = {
  score: '8',
  overallFeedback: 'Good',
  pages: [{ annotations: [] }],
};

function gradingCtx(tracker, overrides = {}) {
  return {
    getScore: () => overrides.score ?? '8',
    getFeedback: () => overrides.feedback ?? 'Good',
    getDraft: () => overrides.draft ?? baseDraft,
    getSession: () => overrides.session ?? {},
    hasPendingSave: overrides.hasPendingSave,
  };
}

test('app.js grading draft and publish persist pass onPersistSuccess ack handlers', () => {
  assert.match(appSrc, /onPersistSuccess: acknowledgeGradingDraftPersist/);
  assert.match(appSrc, /onPersistSuccess: acknowledgeGradingPublish/);
  assert.match(appSrc, /if \(!isGradingEditorLive\(activeSession\)\) return;/);
});

test('grading draft failed save then banner retry acks capture and clears dirty guard', async (t) => {
  installBrowserWindowFixture(t);

  let epoch = 1;
  let editorLive = true;
  const tracker = createGradingDirtyTracker(baseDraft);
  registerDirtyProbe(() => tracker.isDirty(gradingCtx(tracker, { score: '9' })));

  let persistAttempts = 0;
  let captureToken = null;
  const resourceKey = gradingWriteResourceKey('sub-a', 'ver-1');

  const api = createPersistWithStatus({
    getRequestEpoch: () => epoch,
    isStaleEpoch: (e) => e !== epoch,
    reloadAppData: async () => {},
    setSaveStatus: () => {},
    showErrorBanner: () => {},
  });

  captureToken = tracker.captureForPersist(baseDraft, '9', 'Good');
  assert.equal(isGloballyDirty(), true);

  await api.persistWithStatus(async () => {
    persistAttempts += 1;
    if (persistAttempts === 1) throw new Error('draft failed');
  }, {
    logicalKey: 'submission:sub-a:grading-draft',
    resourceKey,
    replayPayloadSignature: replayPayloadSignature({ sub: 'sub-a' }),
    onPersistSuccess: () => {
      if (!editorLive) return;
      tracker.markAcknowledgedFromCapture(captureToken);
    },
  });

  assert.equal(persistAttempts, 1);
  assert.equal(tracker.isDirty(gradingCtx(tracker, { score: '9' })), true);

  const ok = await api.persistWithStatus(api.getPersistRetryHandle().fn, {
    retrySameOperation: true,
  });
  assert.equal(ok, true);
  assert.equal(persistAttempts, 2);
  assert.equal(tracker.isDirty(gradingCtx(tracker, { score: '9' })), false);
  assert.equal(isGloballyDirty(), false);
});

test('grading draft retry ack ignores stale editor session', async (t) => {
  installBrowserWindowFixture(t);

  let editorLive = true;
  const tracker = createGradingDirtyTracker(baseDraft);
  const api = createPersistWithStatus({
    getRequestEpoch: () => 1,
    isStaleEpoch: () => false,
    reloadAppData: async () => {},
    setSaveStatus: () => {},
    showErrorBanner: () => {},
  });

  let captureToken = null;
  let attempts = 0;
  const resourceKey = gradingWriteResourceKey('sub-b', 'ver-2');

  await api.persistWithStatus(async () => {
    attempts += 1;
    captureToken = tracker.captureForPersist(baseDraft, '7', 'Try');
    if (attempts === 1) throw new Error('fail');
  }, {
    logicalKey: 'submission:sub-b:grading-draft',
    resourceKey,
    replayPayloadSignature: replayPayloadSignature({ sub: 'sub-b' }),
    onPersistSuccess: () => {
      if (!editorLive) return;
      tracker.markAcknowledgedFromCapture(captureToken);
    },
  });

  editorLive = false;
  await api.persistWithStatus(api.getPersistRetryHandle().fn, { retrySameOperation: true });
  assert.equal(tracker.isDirty(gradingCtx(tracker, { score: '7' })), true);
});

test('grading draft retry ack does not clear edits made after failed capture', async (t) => {
  installBrowserWindowFixture(t);

  const tracker = createGradingDirtyTracker(baseDraft);
  const api = createPersistWithStatus({
    getRequestEpoch: () => 1,
    isStaleEpoch: () => false,
    reloadAppData: async () => {},
    setSaveStatus: () => {},
    showErrorBanner: () => {},
  });

  let staleToken = null;
  let attempts = 0;
  const resourceKey = gradingWriteResourceKey('sub-c', 'ver-3');

  await api.persistWithStatus(async () => {
    attempts += 1;
    staleToken = tracker.captureForPersist(baseDraft, '9', 'Good');
    if (attempts === 1) throw new Error('fail');
  }, {
    logicalKey: 'submission:sub-c:grading-draft',
    resourceKey,
    replayPayloadSignature: replayPayloadSignature({ sub: 'sub-c' }),
    onPersistSuccess: () => {
      tracker.markAcknowledgedFromCapture(staleToken);
    },
  });

  tracker.captureForPersist(baseDraft, '9.5', 'Good');
  await api.persistWithStatus(api.getPersistRetryHandle().fn, { retrySameOperation: true });
  assert.equal(tracker.isDirty(gradingCtx(tracker, { score: '9.5' })), true);
});

test('grading reload-only retry acks without replaying mutation', async (t) => {
  installBrowserWindowFixture(t);

  const tracker = createGradingDirtyTracker(baseDraft);
  let reloads = 0;
  let mutate = 0;
  const api = createPersistWithStatus({
    getRequestEpoch: () => 1,
    isStaleEpoch: () => false,
    reloadAppData: async () => {
      reloads += 1;
      if (reloads === 1) throw new Error('reload failed after ack');
    },
    setSaveStatus: () => {},
    showErrorBanner: () => {},
  });

  let captureToken = null;
  const resourceKey = gradingWriteResourceKey('sub-d', 'ver-4');

  await api.persistWithStatus(async () => {
    mutate += 1;
    captureToken = tracker.captureForPersist(baseDraft, '8.5', 'Good');
  }, {
    logicalKey: 'submission:sub-d:grading-draft',
    resourceKey,
    replayPayloadSignature: replayPayloadSignature({ sub: 'sub-d' }),
    onPersistSuccess: () => {
      tracker.markAcknowledgedFromCapture(captureToken);
    },
  });

  assert.equal(mutate, 1);
  assert.equal(tracker.isDirty(gradingCtx(tracker, { score: '8.5' })), true);

  await api.persistWithStatus(api.getPersistRetryHandle().fn, { retrySameOperation: true });
  assert.equal(mutate, 1);
  assert.equal(reloads, 2);
  assert.equal(tracker.isDirty(gradingCtx(tracker, { score: '8.5' })), false);
});
