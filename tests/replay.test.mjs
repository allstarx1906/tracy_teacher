import test from 'node:test';
import assert from 'node:assert/strict';
import {
  hashOperationPayload,
  lookupOperationReplay,
  rememberOperationReplay,
  ensureReplayStore,
} from '../server/replay.mjs';

test('operation replay returns same result and rejects payload change', () => {
  const state = { operationReplay: {} };
  const auth = { role: 'teacher', account: { id: 't1' } };
  const payload = { id: 'c1', name: 'Lớp A' };
  const op = 'op-1';

  const first = lookupOperationReplay(state, auth, 'teacher.class.put', op, payload);
  assert.equal(first.kind, 'fresh');

  rememberOperationReplay(state, op, {
    actorKey: first.actorKey,
    action: 'teacher.class.put',
    payloadHash: first.payloadHash,
  }, { ok: true, id: 'c1' });

  const replay = lookupOperationReplay(state, auth, 'teacher.class.put', op, payload);
  assert.equal(replay.kind, 'replay');
  assert.deepEqual(replay.result, { ok: true, id: 'c1' });

  const changed = lookupOperationReplay(state, auth, 'teacher.class.put', op, { ...payload, name: 'Lớp B' });
  assert.equal(changed.kind, 'conflict');

  const otherActor = { role: 'teacher', account: { id: 't2' } };
  const wrongActor = lookupOperationReplay(state, otherActor, 'teacher.class.put', op, payload);
  assert.equal(wrongActor.kind, 'conflict');
});

test('hashOperationPayload is stable for key order', () => {
  assert.equal(
    hashOperationPayload({ a: 1, b: 2 }),
    hashOperationPayload({ b: 2, a: 1 }),
  );
});

test('exam grade routes hash marks and keys into replay fingerprint', () => {
  const state = { operationReplay: {} };
  const auth = { role: 'teacher', account: { id: 't1' } };
  const op = 'op-exam-grades';
  const marksA = [{ questionId: 'q1', score: 4 }];
  const marksB = [{ questionId: 'q1', score: 3 }];
  const payloadA = { attemptId: 'at1', baseRevision: 0, marks: marksA };
  const payloadB = { attemptId: 'at1', baseRevision: 0, marks: marksB };

  const first = lookupOperationReplay(state, auth, 'exam.attempt.manual-grades', op, payloadA);
  assert.equal(first.kind, 'fresh');
  rememberOperationReplay(state, op, {
    actorKey: first.actorKey,
    action: 'exam.attempt.manual-grades',
    payloadHash: first.payloadHash,
  }, { ok: true });

  const replay = lookupOperationReplay(state, auth, 'exam.attempt.manual-grades', op, payloadA);
  assert.equal(replay.kind, 'replay');

  const changed = lookupOperationReplay(state, auth, 'exam.attempt.manual-grades', op, payloadB);
  assert.equal(changed.kind, 'conflict');

  const keyPayloadA = {
    versionId: 'v1',
    baseRevision: 1,
    keys: { q_short: ['Alpha'] },
    confirmOverwrite: false,
  };
  const keyPayloadB = {
    versionId: 'v1',
    baseRevision: 1,
    keys: { q_short: ['Beta'] },
    confirmOverwrite: false,
  };
  const freshKey = lookupOperationReplay(state, auth, 'exam.version.text-answer-key', 'op-key', keyPayloadA);
  assert.equal(freshKey.kind, 'fresh');
  const keyConflict = lookupOperationReplay(state, auth, 'exam.version.text-answer-key', 'op-key', keyPayloadB);
  assert.equal(keyConflict.kind, 'fresh');
});

test('ensureReplayStore creates object', () => {
  const s = {};
  const store = ensureReplayStore(s);
  assert.equal(store, s.operationReplay);
  assert.ok(typeof store === 'object');
});
