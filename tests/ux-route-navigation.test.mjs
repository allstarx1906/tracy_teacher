import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bindModalRouteHost,
  clearModalRouteHost,
  disposeAuthorizedDialogHost,
  getAuthorizedDialogDisposeGeneration,
  isDialogGenerationLive,
} from '../dist/ux-dialog-host.js';
import { registerDirtyProbe, snapshotFormDirty, isGloballyDirty } from '../dist/ux-forms.js';

test('disposeAuthorizedDialogHost tears down overlay without second discard prompt', () => {
  let confirmCalls = 0;
  const originalConfirm = globalThis.confirm;
  globalThis.confirm = () => {
    confirmCalls += 1;
    return true;
  };
  try {
    let rootHtml = '<div class="dialog-backdrop"></div>';
    let afterCloseCalls = 0;
    let a11yDisposed = false;
    const bindings = bindModalRouteHost({
      disposeA11y: () => { a11yDisposed = true; },
      onAfterClose: () => { afterCloseCalls += 1; },
      cancelOwnedWork: () => {},
    });
    const genBefore = getAuthorizedDialogDisposeGeneration();
    disposeAuthorizedDialogHost({
      clearRoot: () => { rootHtml = ''; },
      unregisterDirtyProbe: () => registerDirtyProbe(null),
      bumpDialogGeneration: () => {},
    });
    assert.equal(rootHtml, '');
    assert.equal(a11yDisposed, true);
    assert.equal(afterCloseCalls, 1);
    assert.equal(confirmCalls, 0);
    assert.equal(getAuthorizedDialogDisposeGeneration(), genBefore + 1);
    clearModalRouteHost(bindings);
  } finally {
    globalThis.confirm = originalConfirm;
  }
});

test('canceled navigation restore must not dispose bound modal host', () => {
  let disposed = false;
  bindModalRouteHost({
    onAfterClose: () => { disposed = true; },
  });
  assert.equal(disposed, false);
});

test('stale dialog async callback cannot treat disposed generation as live', () => {
  const openedGeneration = 3;
  disposeAuthorizedDialogHost({
    clearRoot: () => {},
    unregisterDirtyProbe: () => {},
    bumpDialogGeneration: () => {},
  });
  const currentGeneration = 4;
  assert.equal(isDialogGenerationLive(openedGeneration, currentGeneration), false);
  assert.equal(isDialogGenerationLive(currentGeneration, currentGeneration), true);
});

test('authorized dispose unregisters dirty probe from dialog form', async (t) => {
  const originalWindow = globalThis.window;
  const originalConfirm = globalThis.confirm;
  const handlers = new Map();
  globalThis.window = {
    addEventListener(type, fn) {
      handlers.set(type, fn);
    },
    removeEventListener(type) {
      if (handlers.get(type)) handlers.delete(type);
    },
  };
  let confirmCalls = 0;
  globalThis.confirm = () => {
    confirmCalls += 1;
    return true;
  };

  t.after(() => {
    registerDirtyProbe(null);
    globalThis.window = originalWindow;
    globalThis.confirm = originalConfirm;
  });

  const input = {
    type: 'text',
    value: '',
    addEventListener() {},
    removeEventListener() {},
  };
  const isDirty = snapshotFormDirty([input]);
  registerDirtyProbe(isDirty, { fields: [input] });
  input.value = 'draft';
  assert.equal(isGloballyDirty(), true);
  assert.ok(handlers.has('beforeunload'));
  const dirtyBeforeDispose = { preventDefault() { this._prevented = true; }, returnValue: 'x' };
  handlers.get('beforeunload')(dirtyBeforeDispose);
  assert.equal(dirtyBeforeDispose._prevented, true);

  bindModalRouteHost({
    onAfterClose: () => registerDirtyProbe(null),
  });
  disposeAuthorizedDialogHost({
    clearRoot: () => {},
    unregisterDirtyProbe: () => registerDirtyProbe(null),
    bumpDialogGeneration: () => {},
  });

  assert.equal(isGloballyDirty(), false);
  assert.equal(confirmCalls, 0);
  assert.equal(handlers.has('beforeunload'), false);
});
