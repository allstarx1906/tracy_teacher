import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createExamDraftSaveCoordinator,
  snapshotExamDraftPutPayload,
  applyExamDraftSaveAck,
} from '../dist/ux-exam-draft-save.js';

test('exam draft save ack stays dirty when generation advanced during delayed PUT', async () => {
  const coordinator = createExamDraftSaveCoordinator();
  let editorDirty = true;
  coordinator.bumpDirtyGeneration();
  const savedAt = coordinator.currentDirtyGeneration();

  const slowPut = (async () => {
    await new Promise((r) => setTimeout(r, 25));
    coordinator.bumpDirtyGeneration();
    return { revision: 2 };
  })();

  const res = await slowPut;
  const cleaned = applyExamDraftSaveAck(coordinator, savedAt, () => { editorDirty = false; });
  assert.equal(cleaned, false);
  assert.equal(editorDirty, true);
  assert.equal(coordinator.shouldMarkCleanAfterSave(savedAt), false);

  applyExamDraftSaveAck(coordinator, coordinator.currentDirtyGeneration(), () => { editorDirty = false; });
  assert.equal(editorDirty, false);
});

test('exam draft put snapshot is decoupled from live question mutation', () => {
  const live = [{ id: 'q1', stemText: 'A' }];
  const snap = snapshotExamDraftPutPayload({
    title: 'T',
    questions: live,
    passages: [],
    sections: [{ id: 's1' }],
    teacherConfirmedReview: false,
    gradingMode: 'automatic',
    baseRevision: 0,
  });
  live[0].stemText = 'B';
  assert.equal(snap.questions[0].stemText, 'A');
});

test('serialized draft writes run in order', async () => {
  const coordinator = createExamDraftSaveCoordinator();
  const order = [];
  await Promise.all([
    coordinator.runSerializedWrite(async () => {
      order.push('a-start');
      await new Promise((r) => setTimeout(r, 15));
      order.push('a-end');
    }),
    coordinator.runSerializedWrite(async () => {
      order.push('b-start');
      order.push('b-end');
    }),
  ]);
  assert.deepEqual(order, ['a-start', 'a-end', 'b-start', 'b-end']);
});
