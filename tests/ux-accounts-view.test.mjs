import test from 'node:test';
import assert from 'node:assert/strict';
import { snapshotFormDirty } from '../dist/ux-forms.js';
import {
  captureCreateAccountDraft,
  createAccountDraftUnchanged,
  rebuildStudentAccountSelect,
  shouldApplyAccountsViewWork,
  applyCreateAccountSuccessAck,
  syncCleanFormBaselineAfterProgrammaticSelectRefresh,
  queueCreateAccountCredentialIfValid,
} from '../dist/ux-accounts-view.js';

test('rebuildStudentAccountSelect preserves create draft fields', () => {
  const stSel = {
    value: 's2',
    options: [],
  };
  const accountsBefore = [{ studentId: 's1', disabled: false }];
  rebuildStudentAccountSelect(
    stSel,
    accountsBefore,
    [
      { id: 's1', name: 'An', classId: 'c1' },
      { id: 's2', name: 'Bình', classId: 'c1' },
    ],
    () => 'Lớp A',
  );
  assert.equal(stSel.value, 's2');
  const draft = captureCreateAccountDraft({
    username: 'new.user',
    tempPassword: 'Temp!234',
    studentId: stSel.value,
  });
  const accountsAfter = [
    { studentId: 's1', disabled: false },
    { studentId: 's2', disabled: false },
  ];
  rebuildStudentAccountSelect(
    stSel,
    accountsAfter,
    [
      { id: 's1', name: 'An', classId: 'c1' },
      { id: 's2', name: 'Bình', classId: 'c1' },
    ],
    () => 'Lớp A',
  );
  stSel.value = draft.studentId;
  const after = captureCreateAccountDraft({
    username: 'new.user',
    tempPassword: 'Temp!234',
    studentId: stSel.value,
  });
  assert.equal(
    createAccountDraftUnchanged(draft, after),
    true,
    'unrelated list refresh must not wipe create form draft',
  );
});

test('createAccountDraftUnchanged detects edits', () => {
  const before = captureCreateAccountDraft({
    username: 'u',
    tempPassword: 't',
    studentId: 's1',
  });
  const after = captureCreateAccountDraft({
    username: 'u2',
    tempPassword: 't',
    studentId: 's1',
  });
  assert.equal(createAccountDraftUnchanged(before, after), false);
});

test('wrong-order markClean before clear leaves account form dirty after ack', () => {
  const uname = { value: 'filled' };
  const temp = { value: 'secret' };
  const stSel = { value: 's1' };
  const before = captureCreateAccountDraft({
    username: uname.value,
    tempPassword: temp.value,
    studentId: stSel.value,
  });
  uname.value = '';
  temp.value = '';
  const afterWrong = captureCreateAccountDraft({
    username: uname.value,
    tempPassword: temp.value,
    studentId: stSel.value,
  });
  assert.equal(createAccountDraftUnchanged(before, afterWrong), false);
});

test('queueCreateAccountCredentialIfValid enqueues on auth epoch even when accounts view inactive', () => {
  let queued = null;
  const ok = queueCreateAccountCredentialIfValid(
    { username: 'stu1', temporaryPassword: 'Temp!234' },
    {
      actionEpoch: 7,
      submittedUsername: 'stu1',
      isStaleEpoch: () => false,
      showCredentialDialog: (entry) => { queued = entry; },
    },
  );
  assert.equal(ok, true);
  assert.equal(queued.requestEpoch, 7);
  assert.match(queued.accountKey, /^create:/);
});

test('queueCreateAccountCredentialIfValid skips stale epoch', () => {
  let calls = 0;
  assert.equal(
    queueCreateAccountCredentialIfValid(
      { username: 'x', temporaryPassword: 'y' },
      {
        actionEpoch: 1,
        submittedUsername: 'x',
        isStaleEpoch: () => true,
        showCredentialDialog: () => { calls += 1; },
      },
    ),
    false,
  );
  assert.equal(calls, 0);
});

test('shouldApplyAccountsViewWork rejects stale view generation after re-entry', () => {
  assert.equal(shouldApplyAccountsViewWork(1, 2, {}), false);
  assert.equal(shouldApplyAccountsViewWork(2, 2, { canRender: () => true }), true);
  assert.equal(shouldApplyAccountsViewWork(2, 2, { canRender: () => false }), false);
});

test('applyCreateAccountSuccessAck ignores stale success when user edited during request', () => {
  const uname = { value: 'old.user' };
  const temp = { value: 'Old!234' };
  const submitted = captureCreateAccountDraft({
    username: 'old.user',
    tempPassword: 'Old!234',
    studentId: 's1',
  });
  uname.value = 'newer.user';
  temp.value = 'New!234';
  const dirty = {
    markClean() {
      this.cleaned = true;
    },
  };
  assert.equal(
    applyCreateAccountSuccessAck(
      { username: uname, tempPassword: temp, studentId: 's1' },
      dirty,
      submitted,
    ),
    false,
  );
  assert.equal(uname.value, 'newer.user');
  assert.equal(temp.value, 'New!234');
  assert.equal(dirty.cleaned, undefined);
});

test('applyCreateAccountSuccessAck clears then markClean when draft unchanged', () => {
  const uname = { value: 'u1' };
  const temp = { value: 't1' };
  const submitted = captureCreateAccountDraft({
    username: 'u1',
    tempPassword: 't1',
    studentId: 's1',
  });
  let cleaned = false;
  const dirty = {
    markClean() { cleaned = true; },
  };
  assert.equal(
    applyCreateAccountSuccessAck(
      { username: uname, tempPassword: temp, studentId: 's1' },
      dirty,
      submitted,
    ),
    true,
  );
  assert.equal(uname.value, '');
  assert.equal(temp.value, '');
  assert.equal(cleaned, true);
});

test('create ack after list refresh selects next student before markClean stays navigable', () => {
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
    value: '',
    options: [],
    addEventListener() {},
    removeEventListener() {},
  };
  const students = [
    { id: 's1', name: 'An', classId: 'c1' },
    { id: 's2', name: 'Bình', classId: 'c1' },
  ];
  const accountsBefore = [];
  rebuildStudentAccountSelect(stSel, accountsBefore, students, () => 'Lớp A');
  const isDirty = snapshotFormDirty([uname, temp, stSel]);
  assert.equal(isDirty(), false, 'baseline must be captured before user fills create form');

  stSel.value = 's1';
  uname.value = 'new.user';
  temp.value = 'Temp!234';
  assert.equal(isDirty(), true);

  const submitted = captureCreateAccountDraft({
    username: uname.value,
    tempPassword: temp.value,
    studentId: stSel.value,
  });
  const studentIdBeforeRefresh = stSel.value;
  assert.equal(studentIdBeforeRefresh, submitted.studentId);

  const accountsAfter = [{ studentId: 's1', disabled: false }];
  rebuildStudentAccountSelect(stSel, accountsAfter, students, () => 'Lớp A');
  assert.equal(stSel.value, 's2', 'refresh should auto-select next eligible student');

  assert.equal(
    applyCreateAccountSuccessAck(
      { username: uname, tempPassword: temp, studentId: stSel.value },
      isDirty,
      submitted,
      { studentIdBeforeRefresh },
    ),
    true,
  );
  assert.equal(uname.value, '');
  assert.equal(temp.value, '');
  assert.equal(stSel.value, 's2');
  assert.equal(isDirty(), false, 'S2 + empty fields must not trigger discard after create ack');
});

test('applyCreateAccountSuccessAck rejects selector change without beforeRefresh proof', () => {
  const uname = { value: 'u1' };
  const temp = { value: 't1' };
  const submitted = captureCreateAccountDraft({
    username: 'u1',
    tempPassword: 't1',
    studentId: 's1',
  });
  let cleaned = false;
  const dirty = { markClean() { cleaned = true; } };
  assert.equal(
    applyCreateAccountSuccessAck(
      { username: uname, tempPassword: temp, studentId: 's2' },
      dirty,
      submitted,
    ),
    false,
  );
  assert.equal(cleaned, false);
});

test('applyCreateAccountSuccessAck rejects when user changed selector before refresh proof', () => {
  const uname = { value: 'u1' };
  const temp = { value: 't1' };
  const submitted = captureCreateAccountDraft({
    username: 'u1',
    tempPassword: 't1',
    studentId: 's1',
  });
  let cleaned = false;
  const dirty = { markClean() { cleaned = true; } };
  assert.equal(
    applyCreateAccountSuccessAck(
      { username: uname, tempPassword: temp, studentId: 's2' },
      dirty,
      submitted,
      { studentIdBeforeRefresh: 's2' },
    ),
    false,
  );
  assert.equal(cleaned, false);
});

test('create ack after last account leaves empty selector and stays clean', () => {
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
    value: '',
    options: [],
    addEventListener() {},
    removeEventListener() {},
  };
  const students = [{ id: 's1', name: 'An', classId: 'c1' }];
  rebuildStudentAccountSelect(stSel, [], students, () => 'Lớp A');
  const isDirty = snapshotFormDirty([uname, temp, stSel]);
  stSel.value = 's1';
  uname.value = 'only.one';
  temp.value = 'Temp!234';
  const submitted = captureCreateAccountDraft({
    username: uname.value,
    tempPassword: temp.value,
    studentId: stSel.value,
  });
  const studentIdBeforeRefresh = stSel.value;
  rebuildStudentAccountSelect(stSel, [{ studentId: 's1', disabled: false }], students, () => 'Lớp A');
  assert.equal(stSel.value, '', 'no eligible students after final create');
  assert.equal(
    applyCreateAccountSuccessAck(
      { username: uname, tempPassword: temp, studentId: stSel.value },
      isDirty,
      submitted,
      { studentIdBeforeRefresh },
    ),
    true,
  );
  assert.equal(uname.value, '');
  assert.equal(temp.value, '');
  assert.equal(isDirty(), false);
});

test('syncCleanFormBaselineAfterProgrammaticSelectRefresh updates baseline only when clean', () => {
  const uname = { value: '' };
  const temp = { value: '' };
  const stSel = { value: 's1', options: [] };
  const students = [
    { id: 's1', name: 'An', classId: 'c1' },
    { id: 's2', name: 'Bình', classId: 'c1' },
  ];
  rebuildStudentAccountSelect(
    stSel,
    [{ studentId: 's2', disabled: false }],
    students,
    () => 'Lớp',
  );
  const isDirty = snapshotFormDirty([uname, temp, stSel]);
  assert.equal(isDirty(), false);
  const before = captureCreateAccountDraft({
    username: uname.value,
    tempPassword: temp.value,
    studentId: stSel.value,
  });
  rebuildStudentAccountSelect(
    stSel,
    [{ studentId: 's1', disabled: false }, { studentId: 's2', disabled: false }],
    students,
    () => 'Lớp',
  );
  const after = captureCreateAccountDraft({
    username: uname.value,
    tempPassword: temp.value,
    studentId: stSel.value,
  });
  assert.equal(
    syncCleanFormBaselineAfterProgrammaticSelectRefresh(before, after, true, isDirty),
    true,
  );
  assert.equal(isDirty(), false);
});
