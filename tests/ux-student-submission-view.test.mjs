import test from 'node:test';
import assert from 'node:assert/strict';
import {
  captureStudentSubmissionUiScope,
  shouldApplyStudentSubmissionUiWork,
} from '../dist/ux-student-submission-view.js';
import { createStudentPhotoDraftAckState } from '../dist/ux-student-photo-draft-ack.js';
import { registerDirtyProbe, isGloballyDirty } from '../dist/ux-forms.js';
import { runStudentPhotoDraftPersist } from '../dist/ux-student-photo-lock.js';
import { createPersistWithStatus, replayPayloadSignature } from '../dist/ux-persist.js';
import { dispatchBeforeUnload, installBrowserWindowFixture } from './helper-browser-window.mjs';

test('stale assignment save completion does not clear another view dirty guard', async (t) => {
  const handlers = installBrowserWindowFixture(t);

  let liveView = { assignmentId: 'asg-a', viewGeneration: 1 };
  let epoch = 5;
  const principal = 'student:s1';
  let globalRenderCalls = 0;

  const scopeA = captureStudentSubmissionUiScope({
    assignmentId: 'asg-a',
    viewGeneration: 1,
    getRequestEpoch: () => epoch,
    getAuthPrincipal: () => principal,
  });

  const hostA = { isConnected: true };
  let releasePersist;
  const persistGate = new Promise((resolve) => { releasePersist = resolve; });

  const pagesB = ['b-photo'];
  registerDirtyProbe(() => pagesB.length > 1);
  assert.ok(handlers.has('beforeunload'), 'production guard arms beforeunload while B probe is registered');

  liveView = { assignmentId: 'asg-b', viewGeneration: 2 };

  const pagesA = ['a1'];
  const savePromise = (async () => {
    const uiScope = scopeA;
    const { ok } = await runStudentPhotoDraftPersist(
      pagesA,
      async () => {},
      async () => {
        await persistGate;
        return true;
      },
    );
    const live = {
      liveView,
      isStaleEpoch: (e) => e !== epoch,
      getAuthPrincipal: () => principal,
      viewHostEl: hostA,
    };
    if (!shouldApplyStudentSubmissionUiWork(uiScope, live)) return { ok, applied: false };
    globalRenderCalls += 1;
    registerDirtyProbe(null);
    return { ok, applied: true };
  })();

  releasePersist();
  const result = await savePromise;

  assert.equal(result.ok, true);
  assert.equal(result.applied, false);
  assert.equal(globalRenderCalls, 0);
  assert.deepEqual(pagesB, ['b-photo'], 'assignment B draft pages unchanged');
  assert.equal(isGloballyDirty(), false, 'B probe still active but not dirty yet');
  assert.ok(handlers.has('beforeunload'), 'stale A completion must not disarm B beforeunload guard');
  const cleanNav = dispatchBeforeUnload(handlers);
  assert.equal(cleanNav._prevented, undefined, 'beforeunload must not warn while B is clean');
  registerDirtyProbe(null);
});

test('delayed save on A then photos on B keeps B order and dirty state when A completes', async (t) => {
  const handlers = installBrowserWindowFixture(t);

  let liveView = { assignmentId: 'asg-a', viewGeneration: 1 };
  const epoch = 2;
  const principal = 'student:s1';
  const scopeA = captureStudentSubmissionUiScope({
    assignmentId: 'asg-a',
    viewGeneration: 1,
    getRequestEpoch: () => epoch,
    getAuthPrincipal: () => principal,
  });

  let releasePersist;
  const persistGate = new Promise((resolve) => { releasePersist = resolve; });

  const pagesB = ['b1'];
  registerDirtyProbe(() => pagesB.length > 1);
  assert.ok(handlers.has('beforeunload'));

  let renderCalls = 0;
  const savePromise = runStudentPhotoDraftPersist(
    ['a-only'],
    async () => {},
    async () => {
      await persistGate;
      return true;
    },
  ).then(({ ok }) => {
    const live = {
      liveView,
      isStaleEpoch: () => false,
      getAuthPrincipal: () => principal,
      viewHostEl: { isConnected: true },
    };
    if (shouldApplyStudentSubmissionUiWork(scopeA, live)) {
      renderCalls += 1;
      registerDirtyProbe(null);
    }
    return ok;
  });

  liveView = { assignmentId: 'asg-b', viewGeneration: 2 };
  pagesB.push('b2');
  releasePersist();
  await savePromise;

  assert.deepEqual(pagesB, ['b1', 'b2'], 'B photo order untouched by stale A completion');
  assert.equal(renderCalls, 0);
  assert.equal(isGloballyDirty(), true, 'dirty guard stays armed for B edits');
  assert.ok(handlers.has('beforeunload'), 'B dirty state keeps beforeunload listener');
  const dirtyNav = dispatchBeforeUnload(handlers);
  assert.equal(dirtyNav._prevented, true);
  assert.equal(dirtyNav.returnValue, '');
  registerDirtyProbe(null);
});

test('same assignment re-entry invalidates prior view generation for UI apply', () => {
  const epoch = 1;
  const principal = 'student:x';
  const scopeOld = captureStudentSubmissionUiScope({
    assignmentId: 'asg-same',
    viewGeneration: 3,
    getRequestEpoch: () => epoch,
    getAuthPrincipal: () => principal,
  });
  const live = {
    liveView: { assignmentId: 'asg-same', viewGeneration: 4 },
    isStaleEpoch: () => false,
    getAuthPrincipal: () => principal,
    viewHostEl: { isConnected: true },
  };
  assert.equal(shouldApplyStudentSubmissionUiWork(scopeOld, live), false);
});

test('disconnected edit host blocks UI apply even when generation matches', () => {
  const scope = captureStudentSubmissionUiScope({
    assignmentId: 'asg-a',
    viewGeneration: 2,
    getRequestEpoch: () => 1,
    getAuthPrincipal: () => 'student:a',
  });
  const live = {
    liveView: { assignmentId: 'asg-a', viewGeneration: 2 },
    isStaleEpoch: () => false,
    getAuthPrincipal: () => 'student:a',
    viewHostEl: { isConnected: false },
  };
  assert.equal(shouldApplyStudentSubmissionUiWork(scope, live), false);
});

test('student draft global retry success runs scoped onPersistSuccess acknowledgement', async (t) => {
  installBrowserWindowFixture(t);

  let epoch = 1;
  const principal = 'student:s1';
  const scope = captureStudentSubmissionUiScope({
    assignmentId: 'asg-a',
    viewGeneration: 1,
    getRequestEpoch: () => epoch,
    getAuthPrincipal: () => principal,
  });
  const liveView = { assignmentId: 'asg-a', viewGeneration: 1 };
  const live = {
    liveView,
    isStaleEpoch: (e) => e !== epoch,
    getAuthPrincipal: () => principal,
    viewHostEl: { isConnected: true },
  };

  const shouldApply = (uiScope) => shouldApplyStudentSubmissionUiWork(uiScope, live);

  const api = createPersistWithStatus({
    getRequestEpoch: () => epoch,
    isStaleEpoch: (e) => e !== epoch,
    reloadAppData: async () => {},
    setSaveStatus: () => {},
    showErrorBanner: () => {},
  });

  async function runDraftPersistAttempt({
    draftAck,
    draftPages,
    onAck,
    persistAttemptsRef,
    throwOnThisAttempt,
  }) {
    /** @type {{ sequence: number, pageIds: string[] } | null} */
    let captureToken = null;
    await runStudentPhotoDraftPersist(
      draftPages,
      async () => {},
      async (pages) => {
        captureToken = draftAck.captureForPersist(pages);
        return api.persistWithStatus(async () => {
          persistAttemptsRef.count += 1;
          if (persistAttemptsRef.count === throwOnThisAttempt) {
            throw new Error('draft failed');
          }
        }, {
          silent: true,
          logicalKey: 'student-draft:asg-a',
          replayPayloadSignature: replayPayloadSignature({ assignmentId: 'asg-a', pageImageIds: pages }),
          onPersistSuccess: () => {
            if (!shouldApply(scope)) return;
            draftAck.markAcknowledgedFromCapture(captureToken);
            onAck();
          },
        });
      },
    );
  }

  async function retryGlobalDraftPersist() {
    return api.persistWithStatus(api.getPersistRetryHandle().fn, { retrySameOperation: true });
  }

  let renderCalls = 0;
  const onAck = () => { renderCalls += 1; };

  const draftAckA = createStudentPhotoDraftAckState([]);
  const draftPagesA = ['p1'];
  registerDirtyProbe(() => draftAckA.isPagesDirty(draftPagesA));
  assert.equal(draftAckA.isPagesDirty(draftPagesA), true, 'clean baseline with draft p1 is dirty');

  const persistAttemptsA = { count: 0 };
  await runDraftPersistAttempt({
    draftAck: draftAckA,
    draftPages: draftPagesA,
    onAck,
    persistAttemptsRef: persistAttemptsA,
    throwOnThisAttempt: 1,
  });
  assert.equal(persistAttemptsA.count, 1);
  assert.equal(renderCalls, 0);

  const okA = await retryGlobalDraftPersist();

  assert.equal(okA, true);
  assert.equal(persistAttemptsA.count, 2);
  assert.equal(renderCalls, 1);
  assert.deepEqual(draftAckA.getAckPageIds(), ['p1']);
  assert.equal(draftAckA.isPagesDirty(draftPagesA), false);
  assert.equal(isGloballyDirty(), false);
  registerDirtyProbe(null);

  renderCalls = 0;
  const draftAckB = createStudentPhotoDraftAckState([]);
  const draftPagesB = ['p1'];
  registerDirtyProbe(() => draftAckB.isPagesDirty(draftPagesB));

  const persistAttemptsB = { count: 0 };
  await runDraftPersistAttempt({
    draftAck: draftAckB,
    draftPages: draftPagesB,
    onAck,
    persistAttemptsRef: persistAttemptsB,
    throwOnThisAttempt: 1,
  });
  assert.equal(persistAttemptsB.count, 1);
  assert.equal(renderCalls, 0);
  assert.deepEqual(draftAckB.getAckPageIds(), []);
  assert.equal(draftAckB.isPagesDirty(draftPagesB), true);

  draftPagesB.push('p2');
  assert.equal(draftAckB.isPagesDirty(draftPagesB), true);

  const okRetryAfterEdit = await retryGlobalDraftPersist();
  assert.equal(okRetryAfterEdit, true);
  assert.equal(persistAttemptsB.count, 2);
  assert.equal(renderCalls, 1);
  assert.deepEqual(draftAckB.getAckPageIds(), ['p1'], 'retry acks captured p1 only');
  assert.deepEqual(draftPagesB, ['p1', 'p2'], 'newer p2 preserved in draft');
  assert.equal(draftAckB.isPagesDirty(draftPagesB), true);
  assert.equal(isGloballyDirty(), true);

  /** @type {{ sequence: number, pageIds: string[] } | null} */
  let freshCaptureToken = null;
  const okFresh = await runStudentPhotoDraftPersist(
    draftPagesB,
    async () => {},
    async (pages) => {
      freshCaptureToken = draftAckB.captureForPersist(pages);
      return api.persistWithStatus(async () => {}, {
        silent: true,
        logicalKey: 'student-draft:asg-a',
        replayPayloadSignature: replayPayloadSignature({ assignmentId: 'asg-a', pageImageIds: pages }),
        onPersistSuccess: () => {
          if (!shouldApply(scope)) return;
          draftAckB.markAcknowledgedFromCapture(freshCaptureToken);
          onAck();
        },
      });
    },
  ).then(({ ok }) => ok);

  assert.equal(okFresh, true);
  assert.equal(renderCalls, 2);
  assert.deepEqual(draftAckB.getAckPageIds(), ['p1', 'p2']);
  assert.equal(draftAckB.isPagesDirty(draftPagesB), false);
  assert.equal(isGloballyDirty(), false);
  registerDirtyProbe(null);
});
