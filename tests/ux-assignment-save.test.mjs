import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createAttachmentUploadController,
  probeAssignmentAttachmentsDirty,
} from '../dist/ux-upload.js';
import { registerDirtyProbe, snapshotFormDirty } from '../dist/ux-forms.js';
import {
  closeAssignmentDialogAfterSuccessfulSave,
  resolveNewAssignmentClassId,
} from '../dist/ux-assignment-save.js';

function installMinimalDocument() {
  if (globalThis.document?.createElement) return;
  function makeEl(tag) {
    const node = {
      tagName: String(tag).toUpperCase(),
      className: '',
      textContent: '',
      disabled: false,
      children: [],
      appendChild(child) {
        this.children.push(child);
        return child;
      },
      addEventListener(type, fn) {
        node._handlers = node._handlers || {};
        (node._handlers[type] ||= []).push(fn);
      },
      click() {
        for (const fn of node._handlers?.click || []) fn();
      },
      querySelector() {
        return null;
      },
    };
    if (tag === 'div') {
      let html = '';
      Object.defineProperty(node, 'innerHTML', {
        get: () => html,
        set(value) {
          html = value;
          const name = makeEl('span');
          name.className = 'attachment-name';
          const meta = makeEl('span');
          meta.className = 'attachment-meta';
          const wrap = makeEl('div');
          wrap.children = [name, meta];
          node.children = [wrap];
          node.querySelector = (sel) => {
            if (sel === '.attachment-name') return name;
            if (sel === '.attachment-meta') return meta;
            return null;
          };
        },
      });
    }
    return node;
  }
  globalThis.document = { createElement: makeEl };
}

function makeListEl() {
  const rows = [];
  return {
    rows,
    replaceChildren() {
      rows.length = 0;
    },
    appendChild(row) {
      rows.push(row);
    },
  };
}

function findButton(rows, label) {
  for (const row of rows) {
    const walk = (node) => {
      if (node.textContent === label) return node;
      for (const c of node.children || []) {
        const hit = walk(c);
        if (hit) return hit;
      }
      return null;
    };
    const btn = walk(row);
    if (btn) return btn;
  }
  return null;
}

test('assignment save lock blocks attachment remove and enqueue until save completes', async () => {
  installMinimalDocument();
  const pendingIds = ['existing'];
  const pendingMeta = new Map([['existing', { filename: 'old.pdf', size: 1 }]]);
  const listEl = makeListEl();
  let assignmentSaving = false;

  const ctrl = createAttachmentUploadController({
    uploadFn: async () => ({
      id: 'att-new',
      filename: 'new.pdf',
      mime: 'application/pdf',
      size: 4,
    }),
    pendingIds,
    pendingMeta,
    isActive: () => true,
    canMutate: () => !assignmentSaving,
    onError: () => {},
    refreshList: () => {},
    listEl,
  });

  ctrl.refresh();
  assignmentSaving = true;
  ctrl.refreshMutability();
  const removeBtn = findButton(listEl.rows, 'Gỡ');
  assert.ok(removeBtn, 'existing attachment row should render remove control');
  assert.equal(removeBtn.disabled, true);
  removeBtn.click();
  assert.deepEqual(pendingIds, ['existing']);

  const file = {
    name: 'new.pdf',
    type: 'application/pdf',
    size: 4,
    arrayBuffer: async () => new Uint8Array([1, 1, 1, 1]).buffer,
  };
  ctrl.enqueueFiles([file]);
  assert.equal(ctrl.hasPendingWork(), false, 'enqueue while saving must be ignored');
  assert.deepEqual(pendingIds, ['existing']);

  assignmentSaving = false;
  ctrl.refreshMutability();
  const removeBtnUnlocked = findButton(listEl.rows, 'Gỡ');
  assert.ok(removeBtnUnlocked, 'remove control should exist after mutability refresh');
  assert.equal(removeBtnUnlocked.disabled, false);
});

test('enqueue while assignment save lock is active is ignored', async () => {
  installMinimalDocument();
  const pendingIds = ['existing'];
  const pendingMeta = new Map([['existing', { filename: 'old.pdf', size: 1 }]]);
  const listEl = makeListEl();
  let assignmentSaving = false;

  const ctrl = createAttachmentUploadController({
    uploadFn: async () => ({
      id: 'att-new',
      filename: 'new.pdf',
      mime: 'application/pdf',
      size: 4,
    }),
    pendingIds,
    pendingMeta,
    isActive: () => true,
    canMutate: () => !assignmentSaving,
    onError: () => {},
    refreshList: () => {},
    listEl,
  });

  ctrl.refresh();
  assignmentSaving = true;
  ctrl.refreshMutability();

  const file = {
    name: 'new.pdf',
    type: 'application/pdf',
    size: 4,
    arrayBuffer: async () => new Uint8Array([1, 1, 1, 1]).buffer,
  };
  ctrl.enqueueFiles([file]);
  assert.equal(ctrl.hasPendingWork(), false, 'enqueue while saving must be ignored');
  assert.deepEqual(pendingIds, ['existing']);
});

test('upload completion onBusyChange does not re-enable save while assignmentSaving', async () => {
  installMinimalDocument();
  const pendingIds = [];
  const pendingMeta = new Map();
  const listEl = makeListEl();
  let assignmentSaving = false;
  const saveDisabledSnapshots = [];
  let releaseUpload;
  const uploadGate = new Promise((resolve) => {
    releaseUpload = resolve;
  });

  const ctrl = createAttachmentUploadController({
    uploadFn: async () => {
      await uploadGate;
      return {
        id: 'att-1',
        filename: 'a.pdf',
        mime: 'application/pdf',
        size: 4,
      };
    },
    pendingIds,
    pendingMeta,
    isActive: () => true,
    canMutate: () => !assignmentSaving,
    onError: () => {},
    refreshList: () => {},
    listEl,
    onBusyChange: () => {
      const locked = assignmentSaving || ctrl.isBusy();
      saveDisabledSnapshots.push(locked || ctrl.hasFailed() || assignmentSaving);
    },
  });

  const file = {
    name: 'a.pdf',
    type: 'application/pdf',
    size: 4,
    arrayBuffer: async () => new Uint8Array([2, 2, 2, 2]).buffer,
  };

  ctrl.enqueueFiles([file]);
  assignmentSaving = true;
  ctrl.refreshMutability();
  releaseUpload();
  await ctrl.waitSettled();
  assert.equal(
    saveDisabledSnapshots.at(-1),
    true,
    'last busy callback must keep save disabled during assignment save',
  );
});

test('closeAssignmentDialogAfterSuccessfulSave releases save lock before skip-dirty close', () => {
  let assignmentSaving = true;
  let dialogOpen = true;
  let skipDirtyCloseCalled = false;

  const onBeforeClose = () => {
    if (assignmentSaving) return false;
    return true;
  };

  const closeAfterSave = () => {
    if (onBeforeClose() === false) return;
    skipDirtyCloseCalled = true;
    dialogOpen = false;
  };

  const blockedWithoutRelease = () => {
    assignmentSaving = true;
    dialogOpen = true;
    skipDirtyCloseCalled = false;
    closeAfterSave();
    return dialogOpen;
  };

  assert.equal(blockedWithoutRelease(), true, 'close guard must block while save lock held');

  closeAssignmentDialogAfterSuccessfulSave({
    isDialogActive: () => dialogOpen,
    setAssignmentSaving: (value) => { assignmentSaving = value; },
    onAcknowledged: () => {},
    closeAfterSave,
  });

  assert.equal(assignmentSaving, false);
  assert.equal(skipDirtyCloseCalled, true);
  assert.equal(dialogOpen, false);
});

test('beforeunload warns when only attachment upload is pending', async (t) => {
  installMinimalDocument();
  const handlers = new Map();
  const originalWindow = globalThis.window;
  globalThis.window = {
    addEventListener(type, fn) {
      handlers.set(type, fn);
    },
    removeEventListener(type) {
      handlers.delete(type);
    },
  };
  t.after(() => {
    globalThis.window = originalWindow;
    registerDirtyProbe(null);
  });

  const pendingIds = [];
  const pendingMeta = new Map();
  const listEl = makeListEl();
  let releaseUpload;
  const uploadGate = new Promise((resolve) => {
    releaseUpload = resolve;
  });

  const ctrl = createAttachmentUploadController({
    uploadFn: async () => {
      await uploadGate;
      return { id: 'att-1', filename: 'a.pdf', mime: 'application/pdf', size: 4 };
    },
    pendingIds,
    pendingMeta,
    isActive: () => true,
    onError: () => {},
    refreshList: () => {},
    listEl,
    onBusyChange: () => {},
  });

  const title = {
    type: 'text',
    value: 'Same',
    addEventListener() {},
    removeEventListener() {},
  };
  const baseline = { ids: [] };
  const isDirty = snapshotFormDirty(
    [title],
    () => probeAssignmentAttachmentsDirty(pendingIds, baseline, ctrl),
  );
  registerDirtyProbe(isDirty, {
    fields: [title],
    onQueueTransition: (handler) => ctrl.bindQueueTransition(handler),
  });

  const file = {
    name: 'a.pdf',
    type: 'application/pdf',
    size: 4,
    arrayBuffer: async () => new Uint8Array([3, 3, 3, 3]).buffer,
  };
  ctrl.enqueueFiles([file]);
  assert.equal(isDirty(), true);
  assert.ok(handlers.has('beforeunload'));

  const dirtyEvent = { preventDefault() { this._prevented = true; }, returnValue: 'x' };
  handlers.get('beforeunload')(dirtyEvent);
  assert.equal(dirtyEvent._prevented, true);

  releaseUpload();
  await ctrl.waitSettled();
  isDirty.markClean();
  registerDirtyProbe(null);
});

test('probeAssignmentAttachmentsDirty marks active hashing without id list change', async () => {
  installMinimalDocument();
  const pendingIds = [];
  const pendingMeta = new Map();
  const listEl = makeListEl();
  let releaseHash;
  const hashGate = new Promise((resolve) => {
    releaseHash = resolve;
  });

  const ctrl = createAttachmentUploadController({
    uploadFn: async () => ({ id: 'x', filename: 'a.pdf', mime: 'application/pdf', size: 4 }),
    pendingIds,
    pendingMeta,
    isActive: () => true,
    onError: () => {},
    refreshList: () => {},
    listEl,
  });

  const baseline = { ids: [] };
  assert.equal(probeAssignmentAttachmentsDirty(pendingIds, baseline, ctrl), false);

  const file = {
    name: 'a.pdf',
    type: 'application/pdf',
    size: 4,
    arrayBuffer: async () => {
      await hashGate;
      return new Uint8Array([4, 4, 4, 4]).buffer;
    },
  };
  ctrl.enqueueFiles([file]);
  assert.equal(probeAssignmentAttachmentsDirty(pendingIds, baseline, ctrl), true);
  releaseHash();
  await ctrl.waitSettled();
  assert.equal(probeAssignmentAttachmentsDirty(pendingIds, baseline, ctrl), true);
});

test('resolveNewAssignmentClassId matches filtered class B when creating', () => {
  const classes = [
    { id: 'class-a', name: 'A' },
    { id: 'class-b', name: 'B' },
  ];
  assert.equal(
    resolveNewAssignmentClassId(classes, {
      editing: false,
      classFilterId: 'class-b',
      routeClassId: 'class-a',
    }),
    'class-b',
  );
});
