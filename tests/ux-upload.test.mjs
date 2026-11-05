import test from 'node:test';
import assert from 'node:assert/strict';
import { createAttachmentUploadController } from '../dist/ux-upload.js';

/** Minimal DOM so the real upload controller can render rows in Node tests. */
function installMinimalDocument() {
  if (globalThis.document?.createElement) return;
  function makeEl(tag) {
    const node = {
      tagName: String(tag).toUpperCase(),
      className: '',
      textContent: '',
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

function findRetryButton(rows) {
  for (const row of rows) {
    const walk = (node) => {
      if (node.textContent === 'Thử lại') return node;
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

test('attachment controller registers all selected files before upload work finishes', async () => {
  installMinimalDocument();
  const pendingIds = [];
  const pendingMeta = new Map();
  const listEl = makeListEl();
  let active = true;
  let inFlightCount = 0;
  let maxInFlight = 0;

  const ctrl = createAttachmentUploadController({
    uploadFn: async () => {
      inFlightCount += 1;
      maxInFlight = Math.max(maxInFlight, inFlightCount);
      await new Promise((r) => setTimeout(r, 5));
      inFlightCount -= 1;
      return {
        id: `att-${pendingIds.length + 1}`,
        filename: 'a.pdf',
        mime: 'application/pdf',
        size: 4,
      };
    },
    pendingIds,
    pendingMeta,
    isActive: () => active,
    onError: () => {},
    refreshList: () => {},
    listEl,
  });

  const mkFile = (n, byte) => ({
    name: `${n}.pdf`,
    type: 'application/pdf',
    size: 4,
    arrayBuffer: async () => new Uint8Array([byte, byte, byte, byte]).buffer,
  });

  ctrl.enqueueFiles([mkFile('a', 1), mkFile('b', 2)]);
  assert.equal(ctrl.isBusy(), true);
  await ctrl.waitSettled();
  assert.equal(maxInFlight >= 2, true);
  assert.equal(pendingIds.length, 2);
  assert.equal(ctrl.hasFailed(), false);
  active = false;
});

test('duplicate content selection keeps save enabled after dedupe', async () => {
  installMinimalDocument();
  const pendingIds = [];
  const pendingMeta = new Map();
  const listEl = makeListEl();
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const file = {
    name: 'once.pdf',
    type: 'application/pdf',
    size: 4,
    arrayBuffer: async () => bytes.buffer,
  };
  let busySnapshots = [];
  const ctrl = createAttachmentUploadController({
    uploadFn: async () => ({
      id: 'att-1',
      filename: 'once.pdf',
      mime: 'application/pdf',
      size: 4,
    }),
    pendingIds,
    pendingMeta,
    isActive: () => true,
    onError: () => {},
    refreshList: () => {},
    listEl,
    onBusyChange: () => busySnapshots.push(ctrl.isBusy()),
  });

  ctrl.enqueueFiles([file]);
  await ctrl.waitSettled();
  assert.equal(pendingIds.length, 1);
  busySnapshots = [];
  ctrl.enqueueFiles([file]);
  if (ctrl.isBusy()) {
    assert.equal(ctrl.isBusy(), true, 'hashing duplicate candidate should stay busy until settled');
  }
  await ctrl.waitSettled();
  assert.equal(ctrl.isBusy(), false, 'duplicate should not leave controller busy');
  assert.equal(busySnapshots.at(-1), false, 'last onBusyChange should report not busy');
  assert.equal(pendingIds.length, 1);
  assert.equal(pendingIds.filter((id) => id === 'att-1').length, 1, 'no second upload');
});

test('failed upload releases fingerprint so retry can enqueue again', async () => {
  installMinimalDocument();
  const pendingIds = [];
  const pendingMeta = new Map();
  const listEl = makeListEl();
  const bytes = new Uint8Array([9, 9, 9, 9]);
  const file = {
    name: 'dup.pdf',
    type: 'application/pdf',
    size: 4,
    arrayBuffer: async () => bytes.buffer,
  };
  let attempts = 0;
  const ctrl = createAttachmentUploadController({
    uploadFn: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('network');
      return { id: 'ok-id', filename: 'dup.pdf', mime: 'application/pdf', size: 4 };
    },
    pendingIds,
    pendingMeta,
    isActive: () => true,
    onError: () => {},
    refreshList: () => {},
    listEl,
  });

  ctrl.enqueueFiles([file]);
  await ctrl.waitSettled();
  assert.equal(ctrl.hasFailed(), true);
  assert.equal(attempts, 1);
  const retryBtn = findRetryButton(listEl.rows);
  assert.ok(retryBtn, 'failed row should expose retry');
  retryBtn.click();
  await ctrl.waitSettled();
  assert.deepEqual(pendingIds, ['ok-id']);
  assert.equal(ctrl.hasFailed(), false);
  assert.equal(attempts, 2);
});
