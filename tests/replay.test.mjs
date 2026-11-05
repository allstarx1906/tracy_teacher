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

test('ensureReplayStore creates object', () => {
  const s = {};
  const store = ensureReplayStore(s);
  assert.equal(store, s.operationReplay);
  assert.ok(typeof store === 'object');
});
