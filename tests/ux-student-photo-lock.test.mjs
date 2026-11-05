import test from 'node:test';
import assert from 'node:assert/strict';
import {
  guardStudentPhotoMutation,
  isStudentPhotoMutationBlocked,
  runStudentPhotoDraftPersist,
} from '../dist/ux-student-photo-lock.js';

test('student photo busy covers draft save and in-flight uploads', () => {
  assert.equal(isStudentPhotoMutationBlocked(false, 0), false);
  assert.equal(isStudentPhotoMutationBlocked(true, 0), true);
  assert.equal(isStudentPhotoMutationBlocked(false, 2), true);
  assert.equal(isStudentPhotoMutationBlocked(false, 0, true), true);
});

test('delayed draft save ignores add/remove/reorder and persists exact snapshot', async () => {
  const pages = ['p1', 'p2'];
  let draftActionBusy = false;
  const blocked = () => isStudentPhotoMutationBlocked(draftActionBusy, 0);

  draftActionBusy = true;
  assert.equal(guardStudentPhotoMutation(blocked(), () => pages.push('p3')), false);
  assert.equal(guardStudentPhotoMutation(blocked(), () => pages.reverse()), false);
  assert.deepEqual(pages, ['p1', 'p2']);

  draftActionBusy = true;
  const savePromise = (async () => {
    const { snapshot, ok } = await runStudentPhotoDraftPersist(
      pages,
      async () => {
        await new Promise((r) => setTimeout(r, 20));
      },
      async (snap) => {
        guardStudentPhotoMutation(blocked(), () => pages.push('ignored'));
        guardStudentPhotoMutation(blocked(), () => pages.reverse());
        assert.deepEqual(snap, ['p1', 'p2']);
        return true;
      },
    );
    assert.equal(ok, true);
    return snapshot;
  })();

  const persisted = await savePromise;
  assert.deepEqual(persisted, ['p1', 'p2']);
  assert.deepEqual(pages, ['p1', 'p2']);
  draftActionBusy = false;
  assert.equal(blocked(), false, 'completion unlocks mutations');
});

test('runStudentPhotoDraftPersist waits for uploads before snapshot', async () => {
  const pages = ['only'];
  const order = [];
  await runStudentPhotoDraftPersist(
    pages,
    async () => {
      order.push('wait');
    },
    async (snapshot) => {
      order.push('persist', snapshot.join(','));
      return true;
    },
  );
  assert.deepEqual(order, ['wait', 'persist', 'only']);
});
