import test from 'node:test';
import assert from 'node:assert/strict';
import {
  configureCredentialQueue,
  showCredentialDialog,
  clearCredentialQueueSecrets,
  tryPresentNextCredential,
  notifyCredentialDialogClosed,
  hasForeignModalBlockingCredentials,
  getCredentialQueueDepthForTests,
  peekCredentialQueueAccountKeysForTests,
  shouldApplyCredentialCallback,
  onCredentialRouteNavigation,
} from '../dist/ux-credential-queue.js';

function makeHost(overrides = {}) {
  let dialogOpen = false;
  let dialogKind = '';
  let openCount = 0;
  let noticeMessage = '';
  const host = {
    openCount: () => openCount,
    dialogOpen: () => dialogOpen,
    noticeMessage: () => noticeMessage,
    openCredentialsDialog: (spec, openHost, mkEl) => {
      openHost(
        spec.title,
        spec.lines.map((line) => mkEl('p', {}, line)),
        [mkEl('button', { type: 'button' }, 'OK')],
        {},
      );
    },
    openDialog: () => {
      openCount += 1;
      dialogOpen = true;
      dialogKind = 'credential';
      host.getDialogRootFirstChild = () => ({ dataset: { dialogKind } });
      return {
        close: () => {
          dialogOpen = false;
          dialogKind = '';
          host.getDialogRootFirstChild = () => null;
        },
      };
    },
    mkEl: (tag, attrs, text) => ({ tag, attrs, text }),
    isStaleEpoch: () => false,
    getAccountsViewGeneration: () => 1,
    isAccountsViewActive: () => true,
    getDialogRootFirstChild: () => null,
    showPendingNotice: ({ message }) => { noticeMessage = message; },
    hidePendingNotice: () => { noticeMessage = ''; },
    toastInfo: () => {},
    ...overrides,
  };
  configureCredentialQueue(host);
  return host;
}

test('foreign modal blocks credential openDialog and keeps queue depth', () => {
  const host = makeHost({
    getDialogRootFirstChild: () => ({ dataset: { dialogKind: 'assignment' } }),
  });
  showCredentialDialog({
    accountKey: 'reset:a1',
    requestEpoch: 1,
    title: 'Mật khẩu tạm mới',
    lines: ['secret once'],
    copyValue: 'Temp!234',
  });
  assert.equal(hasForeignModalBlockingCredentials(), true);
  assert.equal(tryPresentNextCredential(), false);
  assert.equal(host.openCount(), 0);
  assert.equal(getCredentialQueueDepthForTests(), 1);
  assert.match(host.noticeMessage(), /chờ xem/);
  clearCredentialQueueSecrets();
});

test('delayed reset queued while assignment modal stays open until user returns to accounts', async () => {
  let foreignOpen = true;
  let onAccounts = false;
  const host = makeHost({
    getDialogRootFirstChild: () => (foreignOpen ? { dataset: { dialogKind: 'assignment' } } : null),
    isAccountsViewActive: () => onAccounts,
  });
  showCredentialDialog({
    accountKey: 'reset:a1',
    requestEpoch: 3,
    title: 'Mật khẩu tạm mới',
    lines: ['line'],
    copyValue: 'pw-one',
  });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(host.openCount(), 0);
  assert.equal(getCredentialQueueDepthForTests(), 1);

  onAccounts = true;
  foreignOpen = false;
  onCredentialRouteNavigation();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(host.openCount(), 1);
  assert.equal(getCredentialQueueDepthForTests(), 0);
  clearCredentialQueueSecrets();
});

test('concurrent reset results for different accounts stay FIFO accessible one at a time', async () => {
  const host = makeHost();
  showCredentialDialog({
    accountKey: 'reset:a1',
    requestEpoch: 1,
    title: 'First',
    lines: ['a'],
    copyValue: 'pw-a',
  });
  showCredentialDialog({
    accountKey: 'reset:a2',
    requestEpoch: 1,
    title: 'Second',
    lines: ['b'],
    copyValue: 'pw-b',
  });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(host.openCount(), 1);
  assert.deepEqual(peekCredentialQueueAccountKeysForTests(), ['reset:a2']);
  notifyCredentialDialogClosed();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(host.openCount(), 2);
  assert.equal(getCredentialQueueDepthForTests(), 0);
  clearCredentialQueueSecrets();
});

test('newer reset for same account invalidates stale queued entry', () => {
  makeHost();
  showCredentialDialog({
    accountKey: 'reset:same',
    requestEpoch: 1,
    title: 'Old',
    lines: ['old'],
    copyValue: 'old-secret',
  });
  showCredentialDialog({
    accountKey: 'reset:same',
    requestEpoch: 1,
    title: 'New',
    lines: ['new'],
    copyValue: 'new-secret',
  });
  assert.equal(getCredentialQueueDepthForTests(), 1);
  clearCredentialQueueSecrets();
});

test('logout clears credential queue without retaining secrets', () => {
  makeHost();
  showCredentialDialog({
    accountKey: 'reset:x',
    requestEpoch: 9,
    title: 'T',
    lines: ['l'],
    copyValue: 'secret',
  });
  assert.equal(getCredentialQueueDepthForTests(), 1);
  clearCredentialQueueSecrets();
  assert.equal(getCredentialQueueDepthForTests(), 0);
  assert.deepEqual(peekCredentialQueueAccountKeysForTests(), []);
});

test('empty credential queue hidePendingNotice only clears credential notice host', () => {
  let noticeHidden = 0;
  makeHost({
    hidePendingNotice: () => { noticeHidden += 1; },
  });
  showCredentialDialog({
    accountKey: 'reset:once',
    requestEpoch: 1,
    title: 'T',
    lines: ['l'],
    copyValue: 's',
  });
  clearCredentialQueueSecrets();
  assert.equal(getCredentialQueueDepthForTests(), 0);
  assert.equal(noticeHidden, 1);
});

test('shouldApplyCredentialCallback rejects stale epoch and older account sequence', () => {
  makeHost({ isStaleEpoch: (epoch) => epoch < 5 });
  showCredentialDialog({
    accountKey: 'reset:acc',
    requestEpoch: 4,
    title: 'Stale epoch',
    lines: [],
    copyValue: 'x',
  });
  assert.equal(
    shouldApplyCredentialCallback({ requestEpoch: 4, accountKey: 'reset:acc', accountSeq: 1 }),
    false,
  );
  showCredentialDialog({
    accountKey: 'reset:acc',
    requestEpoch: 6,
    title: 'Fresh',
    lines: [],
    copyValue: 'y',
  });
  assert.equal(
    shouldApplyCredentialCallback({ requestEpoch: 6, accountKey: 'reset:acc', accountSeq: 1 }),
    false,
  );
  assert.equal(
    shouldApplyCredentialCallback({ requestEpoch: 6, accountKey: 'reset:acc', accountSeq: 2 }),
    true,
  );
  clearCredentialQueueSecrets();
});
