import test from 'node:test';
import assert from 'node:assert/strict';

test('beforeunload guard arms on active probe and warns only when dirty', async (t) => {
  const originalWindow = globalThis.window;
  const handlers = new Map();
  globalThis.window = {
    addEventListener(type, fn) {
      handlers.set(type, fn);
    },
    removeEventListener(type) {
      if (handlers.get(type)) handlers.delete(type);
    },
  };

  t.after(() => {
    globalThis.window = originalWindow;
  });

  const { registerDirtyProbe, snapshotFormDirty } = await import('../dist/ux-forms.js');

  const input = {
    type: 'text',
    value: '',
    _listeners: {},
    addEventListener(type, fn) {
      (this._listeners[type] ||= []).push(fn);
    },
    removeEventListener(type, fn) {
      this._listeners[type] = (this._listeners[type] || []).filter((h) => h !== fn);
    },
    simulateInput(next) {
      this.value = next;
      for (const fn of this._listeners.input || []) fn({ type: 'input', target: this });
    },
  };

  const isDirty = snapshotFormDirty([input]);
  registerDirtyProbe(isDirty, { fields: [input] });
  assert.ok(handlers.has('beforeunload'), 'listener attached while form dialog is active');

  const cleanEvent = { preventDefault() { this._prevented = true; }, returnValue: 'x' };
  handlers.get('beforeunload')(cleanEvent);
  assert.equal(cleanEvent._prevented, undefined);
  assert.equal(cleanEvent.returnValue, 'x');

  input.simulateInput('IELTS 6.5');
  const dirtyEvent = { preventDefault() { this._prevented = true; }, returnValue: 'x' };
  handlers.get('beforeunload')(dirtyEvent);
  assert.equal(dirtyEvent._prevented, true);
  assert.equal(dirtyEvent.returnValue, '');

  registerDirtyProbe(null);
  assert.equal(handlers.has('beforeunload'), false);
});

test('wireDialogA11y restores focus to opener on dispose via keyboard path', async (t) => {
  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;

  let active = null;
  const opener = {
    tagName: 'BUTTON',
    disabled: false,
    isConnected: true,
    offsetParent: {},
    focus() {
      active = this;
    },
  };
  const dialogClose = {
    tagName: 'BUTTON',
    disabled: false,
    isConnected: true,
    offsetParent: {},
    focus() {
      active = this;
    },
  };
  const dialog = {
    querySelectorAll() {
      return [dialogClose];
    },
    querySelector() {
      return null;
    },
  };
  const handlers = [];
  globalThis.document = {
    activeElement: opener,
    addEventListener(type, fn) {
      if (type === 'keydown') handlers.push(fn);
    },
    removeEventListener(type, fn) {
      const i = handlers.indexOf(fn);
      if (i >= 0) handlers.splice(i, 1);
    },
  };
  globalThis.window = originalWindow ?? {};

  t.after(() => {
    globalThis.document = originalDocument;
    globalThis.window = originalWindow;
  });

  const { wireDialogA11y } = await import('../dist/ux-forms.js');
  let closeRequested = false;
  const dispose = wireDialogA11y({
    backdrop: {},
    dialog,
    titleId: 'dlg-title',
    onRequestClose: () => {
      closeRequested = true;
    },
    focusOpener: opener,
  });

  assert.equal(active, dialogClose, 'dialog initial focus moves inside modal');
  assert.ok(handlers.length === 1);

  handlers[0]({ key: 'Escape' });
  assert.equal(closeRequested, true);

  dispose();
  assert.equal(active, opener, 'closing dialog restores focus to opener');
});

test('createFormPendingLock disables controls and restores on release', async () => {
  const { createFormPendingLock } = await import('../dist/ux-forms.js');
  const input = { disabled: false };
  const fieldset = { inert: false, toggleAttribute() {} };
  const lock = createFormPendingLock({
    fieldsetRoot: fieldset,
    controls: [input],
  });
  assert.equal(lock.canMutate(), true);
  assert.equal(lock.acquire(), true);
  assert.equal(input.disabled, true);
  assert.equal(fieldset.inert, true);
  assert.equal(lock.acquire(), false);
  lock.release();
  assert.equal(input.disabled, false);
  assert.equal(fieldset.inert, false);
});

test('createFormPendingLock run skips overlapping persist', async () => {
  const { createFormPendingLock } = await import('../dist/ux-forms.js');
  const lock = createFormPendingLock({ controls: [] });
  let inFlight = 0;
  const first = lock.run(async () => {
    inFlight += 1;
    await new Promise((r) => setTimeout(r, 20));
    inFlight -= 1;
    return 'a';
  });
  const second = lock.run(async () => 'b');
  assert.equal((await second).skipped, true);
  assert.equal((await first).skipped, false);
  assert.equal((await first).result, 'a');
});

test('closePendingFormDialogAfterSuccessfulSave unblocks onBeforeClose pending guard', async () => {
  const { createFormPendingLock, closePendingFormDialogAfterSuccessfulSave } = await import('../dist/ux-forms.js');
  const lock = createFormPendingLock({ controls: [] });
  let dialogOpen = true;
  const onBeforeClose = () => {
    if (lock.isPending()) return false;
    return true;
  };
  const closeAfterSave = () => {
    if (onBeforeClose() === false) return;
    dialogOpen = false;
  };
  lock.acquire();
  closeAfterSave();
  assert.equal(dialogOpen, true);
  closePendingFormDialogAfterSuccessfulSave({
    isDialogActive: () => dialogOpen,
    formLock: lock,
    onAcknowledged: () => {},
    closeAfterSave,
  });
  assert.equal(dialogOpen, false);
  assert.equal(lock.isPending(), false);
});
