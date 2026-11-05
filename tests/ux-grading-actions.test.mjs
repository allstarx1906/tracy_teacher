import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createGradingMutatingCoordinator,
  syncGradingMutatingButton,
  guardGradingNotBusy,
  shouldNavigateAfterGradingPublish,
} from '../dist/ux-grading-actions.js';

test('shared grading mutating guard runs only first deferred explicit action', async () => {
  const writes = [];
  let releaseFirst;
  const gate = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  let uiBusy = false;
  const coord = createGradingMutatingCoordinator({
    onBusyChange: (busy) => { uiBusy = busy; },
  });

  const first = coord.runExplicitAction(async () => {
    writes.push('first-start');
    await gate;
    writes.push('first-write');
    return 'first-ok';
  });

  assert.equal(coord.isBusy(), true);
  assert.equal(uiBusy, true);

  const second = await coord.runExplicitAction(async () => {
    writes.push('second');
    return 'second-ok';
  });
  assert.deepEqual(second, { skipped: true });
  assert.deepEqual(writes, ['first-start']);

  releaseFirst();
  const firstResult = await first;
  assert.deepEqual(firstResult, { skipped: false, result: 'first-ok' });
  assert.deepEqual(writes, ['first-start', 'first-write']);
  assert.equal(coord.isBusy(), false);
  assert.equal(uiBusy, false);
});

test('grading mutating failure unlocks for retry and success clears busy', async () => {
  let uiBusy = false;
  const coord = createGradingMutatingCoordinator({
    onBusyChange: (busy) => { uiBusy = busy; },
  });
  let attempts = 0;

  const failed = await coord.runExplicitAction(async () => {
    attempts += 1;
    throw new Error('network');
  }).catch((e) => e);
  assert.ok(failed instanceof Error);
  assert.equal(attempts, 1);
  assert.equal(coord.isBusy(), false);
  assert.equal(uiBusy, false);

  const ok = await coord.runExplicitAction(async () => {
    attempts += 1;
    return 'saved';
  });
  assert.deepEqual(ok, { skipped: false, result: 'saved' });
  assert.equal(attempts, 2);
  assert.equal(coord.isBusy(), false);
});

test('dispose prevents stale busy UI callback after explicit action finishes', async () => {
  let uiBusy = false;
  const coord = createGradingMutatingCoordinator({
    onBusyChange: (busy) => { uiBusy = busy; },
  });
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });

  const flight = coord.runExplicitAction(async () => {
    await gate;
  });
  assert.equal(uiBusy, true);
  coord.dispose();
  release();
  await flight;
  assert.equal(uiBusy, true, 'disposed coordinator must not restore UI via finally');
});

test('dispose after pending draft wait skips explicit fn body', async () => {
  const coord = createGradingMutatingCoordinator();
  let releaseDraft;
  const draftGate = new Promise((resolve) => {
    releaseDraft = resolve;
  });
  coord.queueAutosaveDraft(async () => {
    await draftGate;
  });

  let explicitRan = false;
  const explicit = coord.runExplicitAction(async () => {
    explicitRan = true;
    return 'should-not-run';
  });

  coord.dispose();
  releaseDraft();
  const result = await explicit;
  assert.deepEqual(result, { skipped: true, disposed: true });
  assert.equal(explicitRan, false);
});

test('autosave during explicit action is deferred and flushed after busy clears', async () => {
  const writes = [];
  let releaseExplicit;
  let resolveStarted;
  const startedSignal = new Promise((resolve) => {
    resolveStarted = resolve;
  });
  const explicitGate = new Promise((resolve) => {
    releaseExplicit = resolve;
  });
  const coord = createGradingMutatingCoordinator();

  const explicit = coord.runExplicitAction(async () => {
    resolveStarted();
    writes.push('explicit-start');
    coord.queueAutosaveDraft(async () => {
      writes.push('deferred-autosave');
    });
    await explicitGate;
    writes.push('explicit-end');
    return 'ok';
  });

  await startedSignal;
  assert.deepEqual(writes, ['explicit-start']);

  releaseExplicit();
  await explicit;
  await coord.waitPendingDraft();

  assert.deepEqual(writes, ['explicit-start', 'explicit-end', 'deferred-autosave']);
});

test('publish success navigates only after explicit lock released and editor still live', async () => {
  const coord = createGradingMutatingCoordinator();
  let editorLive = true;
  let navigated = false;

  const ran = await coord.runExplicitAction(async () => {
    coord.clearDeferredAutosave();
    return { didPublish: true };
  });

  if (shouldNavigateAfterGradingPublish(ran, {
    isBusy: () => coord.isBusy(),
    isEditorLive: () => editorLive,
  })) {
    navigated = true;
  }

  assert.equal(coord.isBusy(), false);
  assert.equal(navigated, true);

  editorLive = false;
  assert.equal(
    shouldNavigateAfterGradingPublish(ran, {
      isBusy: () => coord.isBusy(),
      isEditorLive: () => editorLive,
    }),
    false,
  );
});

test('publish failure and skipped explicit action do not navigate', async () => {
  const coord = createGradingMutatingCoordinator();
  const failed = await coord.runExplicitAction(async () => ({ didPublish: false }));
  assert.equal(
    shouldNavigateAfterGradingPublish(failed, {
      isBusy: () => coord.isBusy(),
      isEditorLive: () => true,
    }),
    false,
  );

  let release;
  const gate = new Promise((r) => { release = r; });
  const pending = coord.runExplicitAction(async () => {
    await gate;
    return { didPublish: true };
  });
  const skipped = await coord.runExplicitAction(async () => ({ didPublish: true }));
  assert.deepEqual(skipped, { skipped: true });
  assert.equal(
    shouldNavigateAfterGradingPublish(skipped, {
      isBusy: () => coord.isBusy(),
      isEditorLive: () => true,
    }),
    false,
  );
  release();
  await pending;
});

test('clearDeferredAutosave drops autosave queued during publish explicit action', async () => {
  const writes = [];
  let releaseExplicit;
  const explicitGate = new Promise((resolve) => { releaseExplicit = resolve; });
  const coord = createGradingMutatingCoordinator();

  const explicit = coord.runExplicitAction(async () => {
    coord.queueAutosaveDraft(async () => {
      writes.push('deferred-should-drop');
    });
    coord.clearDeferredAutosave();
    await explicitGate;
    return { didPublish: true };
  });

  releaseExplicit();
  await explicit;
  await coord.waitPendingDraft();

  assert.deepEqual(writes, []);
});

test('guardGradingNotBusy skips handler while grading publish is in flight', () => {
  let busy = true;
  let calls = 0;
  const guarded = guardGradingNotBusy(() => busy, () => {
    calls += 1;
  });
  guarded();
  assert.equal(calls, 0);
  busy = false;
  guarded();
  assert.equal(calls, 1);
});

test('syncGradingMutatingButton toggles disabled and busy label', () => {
  const btn = {
    disabled: false,
    textContent: 'Trả bài',
    attrs: {},
    setAttribute(name, value) {
      this.attrs[name] = value;
    },
    removeAttribute(name) {
      delete this.attrs[name];
    },
  };
  syncGradingMutatingButton(btn, 'Trả bài', true);
  assert.equal(btn.disabled, true);
  assert.equal(btn.textContent, 'Đang lưu…');
  assert.equal(btn.attrs['aria-busy'], 'true');
  syncGradingMutatingButton(btn, 'Trả bài', false);
  assert.equal(btn.disabled, false);
  assert.equal(btn.textContent, 'Trả bài');
  assert.equal(btn.attrs['aria-busy'], undefined);
});
