import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createFormPendingLock,
  closePendingFormDialogAfterSuccessfulSave,
  snapshotFormDirty,
  captureAcknowledgedFormSnapshot,
} from '../dist/ux-forms.js';
import { resolveNewAssignmentClassId, closeAssignmentDialogAfterSuccessfulSave } from '../dist/ux-assignment-save.js';
import { createPersistWithStatus } from '../dist/ux-persist.js';
import {
  captureCreateAccountDraft,
  applyCreateAccountSuccessAck,
  rebuildStudentAccountSelect,
} from '../dist/ux-accounts-view.js';

function makeDialogCloseHarness() {
  let dialogOpen = true;
  let skipDirtyCheck = false;
  let waitError = '';
  const formLock = createFormPendingLock({ controls: [] });

  const onBeforeClose = () => {
    if (formLock.isPending()) {
      waitError = 'pending';
      return false;
    }
    return true;
  };

  const closeAfterSave = () => {
    if (!dialogOpen) return false;
    skipDirtyCheck = true;
    if (!skipDirtyCheck && onBeforeClose() === false) return false;
    if (onBeforeClose() === false) return false;
    dialogOpen = false;
    waitError = '';
    return true;
  };

  return {
    formLock,
    onBeforeClose,
    closeAfterSave,
    isOpen: () => dialogOpen,
    waitError: () => waitError,
    setOpen: (v) => { dialogOpen = v; },
  };
}

test('closePendingFormDialogAfterSuccessfulSave releases lock before skip-dirty close', () => {
  const h = makeDialogCloseHarness();
  assert.equal(h.isOpen(), true);
  h.formLock.acquire();
  h.closeAfterSave();
  assert.equal(h.isOpen(), true, 'close blocked while pending lock held');
  assert.equal(h.waitError(), 'pending');

  closePendingFormDialogAfterSuccessfulSave({
    isDialogActive: h.isOpen,
    formLock: h.formLock,
    onAcknowledged: () => {},
    closeAfterSave: h.closeAfterSave,
  });

  assert.equal(h.formLock.isPending(), false);
  assert.equal(h.isOpen(), false);
  assert.equal(h.waitError(), '');
});

test('class create handler closes once after deferred persist ack and skips duplicate persist', async () => {
  const h = makeDialogCloseHarness();
  let persistCount = 0;
  let pendingCreateId = 'class-op-1';
  let releasePersist;
  const persistGate = new Promise((resolve) => { releasePersist = resolve; });

  const runCreateClick = async () => {
    const ran = await h.formLock.run(async () => {
      try {
        const ok = await (async () => {
          persistCount += 1;
          await persistGate;
          return true;
        })();
        if (ok) {
          pendingCreateId = null;
          closePendingFormDialogAfterSuccessfulSave({
            isDialogActive: h.isOpen,
            formLock: h.formLock,
            onAcknowledged: () => {},
            closeAfterSave: h.closeAfterSave,
          });
        }
        return ok;
      } finally {
        /* button busy reset — must not re-open dialog */
      }
    });
    return ran;
  };

  const first = runCreateClick();
  const second = h.formLock.run(async () => {
    persistCount += 1;
    return true;
  });
  assert.equal((await second).skipped, true, 'overlapping create click must not duplicate persist');

  releasePersist();
  await first;
  assert.equal(persistCount, 1);
  assert.equal(pendingCreateId, null);
  assert.equal(h.isOpen(), false);

  h.setOpen(true);
  h.formLock.acquire();
  h.formLock.release();
  h.closeAfterSave();
  assert.equal(h.isOpen(), false, 'close exactly once per successful ack path');
});

test('stale dialog host after slow create does not close or render', async () => {
  let dialogOpen = true;
  let hostLive = true;
  let renderCalls = 0;
  const formLock = createFormPendingLock({ controls: [] });
  const closeAfterSave = () => {
    if (!hostLive) return false;
    dialogOpen = false;
    return true;
  };

  let releasePersist;
  const persistGate = new Promise((resolve) => { releasePersist = resolve; });

  const runCreate = async () => {
    await formLock.run(async () => {
      await persistGate;
      const ok = true;
      if (ok) {
        const closed = closePendingFormDialogAfterSuccessfulSave({
          isDialogActive: () => dialogOpen,
          isDialogHostLive: () => hostLive,
          formLock,
          onAcknowledged: () => {},
          closeAfterSave,
        });
        if (closed) renderCalls += 1;
      }
      return ok;
    });
  };

  const pending = runCreate();
  hostLive = false;
  releasePersist();
  await pending;

  assert.equal(renderCalls, 0, 'stale host must not trigger render');
  assert.equal(dialogOpen, true, 'stale closeAfterSave must leave dialog state unchanged');
});

test('student create handler failure preserves values and unlocks for retry', async () => {
  const h = makeDialogCloseHarness();
  const name = { value: 'An', disabled: false };
  const formLock = createFormPendingLock({ controls: [name] });

  const ran = await formLock.run(async () => {
    const ok = await Promise.resolve(false);
    return ok;
  });
  assert.equal(ran.skipped, false);
  assert.equal(formLock.isPending(), false);
  assert.equal(name.disabled, false);
  assert.equal(name.value, 'An');
  assert.equal(h.isOpen(), true);
});

test('resolveNewAssignmentClassId prefers filter then route then first class', () => {
  const classes = [{ id: 'a' }, { id: 'b' }];
  assert.equal(
    resolveNewAssignmentClassId(classes, {
      editing: false,
      classFilterId: 'b',
      routeClassId: 'a',
    }),
    'b',
  );
  assert.equal(
    resolveNewAssignmentClassId(classes, {
      editing: false,
      classFilterId: '',
      routeClassId: 'b',
    }),
    'b',
  );
  assert.equal(
    resolveNewAssignmentClassId(classes, {
      editing: false,
      classFilterId: 'missing',
      routeClassId: 'missing',
    }),
    'a',
  );
  assert.equal(
    resolveNewAssignmentClassId(classes, {
      editing: true,
      existingClassId: 'b',
      classFilterId: 'a',
    }),
    'b',
  );
});

test('accounts list-only refresh keeps live typing on username and password fields', async () => {
  const uname = { value: 'start' };
  const temp = { value: 'keep' };
  const stSel = { value: 's2', options: [] };
  const students = [
    { id: 's1', name: 'An', classId: 'c1' },
    { id: 's2', name: 'Bình', classId: 'c2' },
  ];
  const accountsBefore = [{ studentId: 's1', disabled: false }];
  rebuildStudentAccountSelect(stSel, accountsBefore, students, () => 'Lớp');
  stSel.value = 's2';

  uname.value = 'start';
  let releaseList;
  const listGate = new Promise((resolve) => { releaseList = resolve; });

  const refresh = (async () => {
    await listGate;
    const accountsAfter = [
      { studentId: 's1', disabled: false },
      { studentId: 's2', disabled: false },
    ];
    rebuildStudentAccountSelect(stSel, accountsAfter, students, () => 'Lớp');
  })();

  uname.value = 'typed-while-pending';
  temp.value = 'live-secret';
  releaseList();
  await refresh;

  assert.equal(uname.value, 'typed-while-pending');
  assert.equal(temp.value, 'live-secret');
});

test('account create ack clears fields before markClean avoids false dirty navigation', () => {
  const uname = {
    type: 'text',
    value: '',
    addEventListener() {},
    removeEventListener() {},
  };
  const temp = {
    type: 'text',
    value: '',
    addEventListener() {},
    removeEventListener() {},
  };
  const stSel = {
    type: 'select-one',
    value: 's1',
    addEventListener() {},
    removeEventListener() {},
  };
  const isDirty = snapshotFormDirty([uname, temp, stSel]);

  uname.value = 'new.user';
  temp.value = 'Temp!234';
  assert.equal(isDirty(), true);

  const submitted = captureCreateAccountDraft({
    username: uname.value,
    tempPassword: temp.value,
    studentId: stSel.value,
  });
  applyCreateAccountSuccessAck(
    { username: uname, tempPassword: temp, studentId: stSel.value },
    isDirty,
    submitted,
  );
  assert.equal(isDirty(), false, 'cleared form must not warn on navigate after successful create');
});

test('deferred account create blocks input changes while pending', async () => {
  const uname = { value: 'start', disabled: false };
  const temp = { value: '', disabled: false };
  const stSel = { value: 's1', disabled: false };
  const createBtn = { disabled: false };
  const lock = createFormPendingLock({
    controls: [uname, temp, stSel],
    onSync: [(blocked) => { createBtn.disabled = blocked; }],
  });
  let release;
  const gate = new Promise((r) => { release = r; });
  const pending = lock.run(async () => {
    await gate;
    return true;
  });
  assert.equal(uname.disabled, true);
  assert.equal(createBtn.disabled, true);
  uname.value = 'blocked';
  release();
  await pending;
  assert.equal(uname.disabled, false);
});

function makePersistRetryDialogHarness(onPersistSuccess) {
  const dialog = makeDialogCloseHarness();
  let reloadImpl = async () => {};
  const api = createPersistWithStatus({
    getRequestEpoch: () => 1,
    isStaleEpoch: () => false,
    reloadAppData: async () => reloadImpl(),
    setSaveStatus: () => {},
    showErrorBanner: () => {},
    toastSuccess: () => {},
  });
  return {
    dialog,
    api,
    setReloadImpl(fn) { reloadImpl = fn; },
    onPersistSuccess,
  };
}

async function runFailedSaveThenRetrySuccess(api, onPersistSuccess, assertDialogStillOpen) {
  let attempts = 0;
  const saveFn = async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('save failed');
  };
  await api.persistWithStatus(saveFn, { onPersistSuccess });
  assert.equal(attempts, 1);
  if (assertDialogStillOpen) assertDialogStillOpen();
  const ok = await api.persistWithStatus(api.getPersistRetryHandle().fn, { retrySameOperation: true });
  assert.equal(ok, true);
  assert.equal(attempts, 2);
}

test('class create retry success closes dialog and clears dirty via onPersistSuccess', async () => {
  const field = { value: '', addEventListener() {}, removeEventListener() {} };
  const isDirty = snapshotFormDirty([field]);
  field.value = 'Lớp A';
  const { dialog, api, setReloadImpl } = makePersistRetryDialogHarness(() => {});
  setReloadImpl(async () => {});
  const onSuccess = () => {
    isDirty.markClean();
    closePendingFormDialogAfterSuccessfulSave({
      isDialogActive: dialog.isOpen,
      formLock: dialog.formLock,
      onAcknowledged: () => {},
      closeAfterSave: dialog.closeAfterSave,
    });
  };
  await runFailedSaveThenRetrySuccess(api, onSuccess, () => {
    assert.equal(dialog.isOpen(), true);
    assert.equal(isDirty(), true);
  });
  assert.equal(dialog.isOpen(), false);
  assert.equal(isDirty(), false);
});

test('student create retry success closes dialog and clears dirty via onPersistSuccess', async () => {
  const field = { value: '', addEventListener() {}, removeEventListener() {} };
  const isDirty = snapshotFormDirty([field]);
  field.value = 'An';
  const { dialog, api, setReloadImpl } = makePersistRetryDialogHarness(() => {});
  setReloadImpl(async () => {});
  await runFailedSaveThenRetrySuccess(api, () => {
    isDirty.markClean();
    closePendingFormDialogAfterSuccessfulSave({
      isDialogActive: dialog.isOpen,
      formLock: dialog.formLock,
      onAcknowledged: () => {},
      closeAfterSave: dialog.closeAfterSave,
    });
  }, () => {
    assert.equal(dialog.isOpen(), true);
    assert.equal(isDirty(), true);
  });
  assert.equal(dialog.isOpen(), false);
  assert.equal(isDirty(), false);
});

test('assignment save retry success closes dialog and clears dirty via onPersistSuccess', async () => {
  const field = { value: '', addEventListener() {}, removeEventListener() {} };
  const isDirty = snapshotFormDirty([field]);
  field.value = 'Essay';
  const { dialog, api, setReloadImpl } = makePersistRetryDialogHarness(() => {});
  setReloadImpl(async () => {});
  let assignmentSaving = false;
  await runFailedSaveThenRetrySuccess(api, () => {
    isDirty.markClean();
    closeAssignmentDialogAfterSuccessfulSave({
      isDialogActive: dialog.isOpen,
      setAssignmentSaving: (value) => { assignmentSaving = value; },
      onAcknowledged: () => {},
      closeAfterSave: dialog.closeAfterSave,
    });
  }, () => {
    assert.equal(dialog.isOpen(), true);
    assert.equal(isDirty(), true);
  });
  assert.equal(dialog.isOpen(), false);
  assert.equal(isDirty(), false);
  assert.equal(assignmentSaving, false);
});

async function runFailedSaveEditThenGlobalRetry(api, field, buildOnSuccess) {
  let attempts = 0;
  const saveFn = async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('save failed');
  };
  const formMatchesAcknowledgedSnapshot = captureAcknowledgedFormSnapshot(() => field.value);
  const onPersistSuccess = buildOnSuccess(formMatchesAcknowledgedSnapshot);
  await api.persistWithStatus(saveFn, { onPersistSuccess });
  assert.equal(attempts, 1);
  field.value = 'edited-after-failure';
  assert.equal(formMatchesAcknowledgedSnapshot(), false);
  const ok = await api.persistWithStatus(api.getPersistRetryHandle().fn, { retrySameOperation: true });
  assert.equal(ok, true);
  assert.equal(attempts, 2);
  return { onPersistSuccess, formMatchesAcknowledgedSnapshot };
}

test('class create failed save edit global retry keeps dialog open and dirty', async () => {
  const field = { value: 'Lớp A', addEventListener() {}, removeEventListener() {} };
  const isDirty = snapshotFormDirty([field]);
  const { dialog, api, setReloadImpl } = makePersistRetryDialogHarness(() => {});
  setReloadImpl(async () => {});
  let ackCalls = 0;
  await runFailedSaveEditThenGlobalRetry(api, field, (formMatchesAcknowledgedSnapshot) => () => {
    ackCalls += 1;
    closePendingFormDialogAfterSuccessfulSave({
      isDialogActive: dialog.isOpen,
      formLock: dialog.formLock,
      formMatchesAcknowledgedSnapshot,
      onAcknowledged: () => { isDirty.markClean(); },
      closeAfterSave: dialog.closeAfterSave,
    });
  });
  assert.equal(ackCalls, 1);
  assert.equal(dialog.isOpen(), true);
  assert.equal(isDirty(), true);
  assert.equal(field.value, 'edited-after-failure');
});

test('student create failed save edit global retry keeps dialog open and dirty', async () => {
  const field = { value: 'An', addEventListener() {}, removeEventListener() {} };
  const isDirty = snapshotFormDirty([field]);
  const { dialog, api, setReloadImpl } = makePersistRetryDialogHarness(() => {});
  setReloadImpl(async () => {});
  await runFailedSaveEditThenGlobalRetry(api, field, (formMatchesAcknowledgedSnapshot) => () => {
    closePendingFormDialogAfterSuccessfulSave({
      isDialogActive: dialog.isOpen,
      formLock: dialog.formLock,
      formMatchesAcknowledgedSnapshot,
      onAcknowledged: () => { isDirty.markClean(); },
      closeAfterSave: dialog.closeAfterSave,
    });
  });
  assert.equal(dialog.isOpen(), true);
  assert.equal(isDirty(), true);
});

test('assignment save failed save edit global retry keeps dialog open and dirty', async () => {
  const field = { value: 'Essay', addEventListener() {}, removeEventListener() {} };
  const isDirty = snapshotFormDirty([field]);
  const { dialog, api, setReloadImpl } = makePersistRetryDialogHarness(() => {});
  setReloadImpl(async () => {});
  let assignmentSaving = true;
  await runFailedSaveEditThenGlobalRetry(api, field, (formMatchesAcknowledgedSnapshot) => () => {
    closeAssignmentDialogAfterSuccessfulSave({
      isDialogActive: dialog.isOpen,
      setAssignmentSaving: (value) => { assignmentSaving = value; },
      formMatchesAcknowledgedSnapshot,
      onAcknowledged: () => { isDirty.markClean(); },
      closeAfterSave: dialog.closeAfterSave,
    });
  });
  assert.equal(dialog.isOpen(), true);
  assert.equal(isDirty(), true);
  assert.equal(assignmentSaving, true, 'must not release save lock when form diverged');
});

test('unchanged form global retry closes clean exactly once', async () => {
  const field = { value: 'Same', addEventListener() {}, removeEventListener() {} };
  const isDirty = snapshotFormDirty([field]);
  const { dialog, api, setReloadImpl } = makePersistRetryDialogHarness(() => {});
  setReloadImpl(async () => {});
  let closeCalls = 0;
  const formMatchesAcknowledgedSnapshot = captureAcknowledgedFormSnapshot(() => field.value);
  const onSuccess = () => {
    if (closePendingFormDialogAfterSuccessfulSave({
      isDialogActive: dialog.isOpen,
      formLock: dialog.formLock,
      formMatchesAcknowledgedSnapshot,
      onAcknowledged: () => { isDirty.markClean(); },
      closeAfterSave: () => {
        closeCalls += 1;
        return dialog.closeAfterSave();
      },
    })) {
      /* render */
    }
  };
  await runFailedSaveThenRetrySuccess(api, onSuccess, () => {
    assert.equal(dialog.isOpen(), true);
  });
  assert.equal(closeCalls, 1);
  assert.equal(dialog.isOpen(), false);
  assert.equal(isDirty(), false);
});
