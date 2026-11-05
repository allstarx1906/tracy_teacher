import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bumpRequestEpoch,
  getRequestEpoch,
  isStaleEpoch,
} from '../dist/api-client.js';
import { createPersistWithStatus, replayPayloadSignature } from '../dist/ux-persist.js';
import { gradingWriteResourceKey } from '../dist/ux-grading-dirty.js';

function makePersistHarness() {
  const status = [];
  const banners = [];
  let reloadImpl = async () => {};
  const api = createPersistWithStatus({
    getRequestEpoch,
    isStaleEpoch,
    reloadAppData: async () => reloadImpl(),
    setSaveStatus: (kind, message) => status.push({ kind, message }),
    showErrorBanner: (message, opts) => banners.push({ message, retry: opts?.retry }),
    toastSuccess: () => {},
    onUnauthorized: async () => {
      bumpRequestEpoch();
    },
  });
  return {
    api,
    status,
    banners,
    setReloadImpl(fn) {
      reloadImpl = fn;
    },
  };
}

test('failed save fallback reload skips error UI when request epoch changes during reload', async () => {
  const { api, status, banners, setReloadImpl } = makePersistHarness();
  let releaseReload;
  let reloadEntered;
  const reloadGate = new Promise((resolve) => {
    releaseReload = resolve;
  });
  const reloadStarted = new Promise((resolve) => {
    reloadEntered = resolve;
  });
  setReloadImpl(async () => {
    reloadEntered();
    await reloadGate;
  });

  const persistPromise = api.persistWithStatus(async () => {
    throw new Error('put failed');
  });

  await reloadStarted;
  bumpRequestEpoch();
  releaseReload();
  const ok = await persistPromise;
  assert.equal(ok, false);
  assert.equal(
    banners.length,
    0,
    'stale epoch after fallback reload must not show persistent error banner',
  );
  assert.equal(
    status.some((s) => s.kind === 'err'),
    false,
    'stale epoch must not set error save status',
  );
  assert.equal(api.getPersistRetryHandle(), null);
});

test('failed save shows retry banner only when epoch still valid after reload', async () => {
  const { api, status, banners, setReloadImpl } = makePersistHarness();
  setReloadImpl(async () => {});

  const ok = await api.persistWithStatus(async () => {
    throw new Error('put failed');
  });
  assert.equal(ok, false);
  assert.equal(banners.length, 1);
  assert.equal(status.at(-1)?.kind, 'err');
  assert.ok(typeof banners[0].retry === 'function');
  assert.ok(api.getPersistRetryHandle());
});

test('stale save completion does not clear newer failed save retry handle', async () => {
  const { api, status, banners, setReloadImpl } = makePersistHarness();
  setReloadImpl(async () => {});

  let releaseSlowSave;
  const slowSaveGate = new Promise((resolve) => {
    releaseSlowSave = resolve;
  });

  const slowSave = api.persistWithStatus(async () => {
    await slowSaveGate;
  });

  bumpRequestEpoch();

  let saveAttempts = 0;
  const failedNewSession = await api.persistWithStatus(async () => {
    saveAttempts += 1;
    if (saveAttempts === 1) throw new Error('save failed after login');
  });
  assert.equal(failedNewSession, false);
  assert.equal(banners.length, 1);
  const retryHandleBeforeSlowCompletes = api.getPersistRetryHandle();
  assert.ok(retryHandleBeforeSlowCompletes);

  releaseSlowSave();
  const slowOk = await slowSave;
  assert.equal(slowOk, false);
  assert.ok(
    api.getPersistRetryHandle(),
    'newer failed save retry handle must survive stale completion',
  );
  assert.equal(
    api.getPersistRetryHandle().operationId,
    retryHandleBeforeSlowCompletes.operationId,
  );
  assert.equal(
    banners.length,
    1,
    'stale completion must not add another error banner',
  );
  assert.equal(
    status.filter((s) => s.kind === 'err').length,
    1,
    'stale completion must not set another error save status',
  );

  const retriedOk = await api.persistWithStatus(
    retryHandleBeforeSlowCompletes.fn,
    { retrySameOperation: true },
  );
  assert.equal(retriedOk, true);
  assert.equal(saveAttempts, 2);
});

test('overlapping same-session saves keep failed A visible when B succeeds', async () => {
  const { api, status, banners, setReloadImpl } = makePersistHarness();
  setReloadImpl(async () => {});

  let releaseA;
  const gateA = new Promise((resolve) => {
    releaseA = resolve;
  });

  const saveA = api.persistWithStatus(async () => {
    await gateA;
    throw new Error('save A failed');
  });

  let saveBAttempts = 0;
  const saveB = api.persistWithStatus(async () => {
    saveBAttempts += 1;
  });

  await saveB;
  assert.equal(saveBAttempts, 1);
  releaseA();
  const okA = await saveA;
  assert.equal(okA, false);
  assert.equal(banners.length, 1, 'failed A must surface error UI after B succeeds');
  assert.equal(status.at(-1)?.kind, 'err');
  assert.ok(api.getPersistRetryHandle());
  assert.equal(api.getOutstandingFailureCount(), 1);

  const handle = api.getPersistRetryHandle();
  let retryAttempts = 0;
  const retried = await api.persistWithStatus(async () => {
    retryAttempts += 1;
  }, { retrySameOperation: true });
  assert.equal(retried, true);
  assert.equal(retryAttempts, 1);
  assert.equal(api.getOutstandingFailureCount(), 0);
  assert.equal(status.at(-1)?.kind, 'ok');
});

test('stale failed retry cannot clear unrelated newer failure', async () => {
  const { api, banners, setReloadImpl } = makePersistHarness();
  setReloadImpl(async () => {});

  let releaseSlow;
  const slowGate = new Promise((resolve) => {
    releaseSlow = resolve;
  });
  const slowStale = api.persistWithStatus(async () => {
    await slowGate;
    throw new Error('stale failure A');
  });

  bumpRequestEpoch();

  await api.persistWithStatus(async () => {
    throw new Error('failure B');
  });
  assert.equal(api.getOutstandingFailureCount(), 1);
  const handleB = api.getPersistRetryHandle();

  releaseSlow();
  await slowStale;
  assert.equal(
    banners.length,
    1,
    'stale failure must not add another banner',
  );
  assert.ok(api.getPersistRetryHandle());
  assert.equal(api.getPersistRetryHandle().operationId, handleB.operationId);
});

test('unchanged payload reuses pending replay operation id without retrySameOperation flag', async () => {
  const { api, setReloadImpl } = makePersistHarness();
  setReloadImpl(async () => {});

  const logicalKey = 'assignment:edit:a1';
  const sig = replayPayloadSignature({ title: 'Essay' });
  const opIds = [];

  await api.persistWithStatus(async () => {
    opIds.push(api.getActivePersistOperationId());
    throw new Error('network lost');
  }, { logicalKey, replayPayloadSignature: sig });

  await api.persistWithStatus(async () => {
    opIds.push(api.getActivePersistOperationId());
  }, { logicalKey, replayPayloadSignature: sig });

  assert.equal(opIds.length, 2);
  assert.equal(opIds[0], opIds[1]);
});

test('changed payload on same record gets new replay operation id', async () => {
  const { api, setReloadImpl } = makePersistHarness();
  setReloadImpl(async () => {});

  const logicalKey = 'assignment:edit:a1';
  const opIds = [];

  await api.persistWithStatus(async () => {
    opIds.push(api.getActivePersistOperationId());
    throw new Error('fail');
  }, {
    logicalKey,
    replayPayloadSignature: replayPayloadSignature({ title: 'Old' }),
  });

  await api.persistWithStatus(async () => {
    opIds.push(api.getActivePersistOperationId());
  }, {
    logicalKey,
    replayPayloadSignature: replayPayloadSignature({ title: 'New' }),
  });

  assert.notEqual(opIds[0], opIds[1]);
});

test('newer successful save supersedes stale failure retry for same record', async () => {
  const { api, status, banners, setReloadImpl } = makePersistHarness();
  setReloadImpl(async () => {});

  const logicalKey = 'assignment:edit:rec-1';
  let serverTitle = 'New Title';
  let oldPayloadApplied = false;

  await api.persistWithStatus(async () => {
    oldPayloadApplied = true;
    throw new Error('save old failed');
  }, {
    logicalKey,
    replayPayloadSignature: replayPayloadSignature({ title: 'Old Title' }),
  });

  assert.equal(banners.length, 1);
  const staleRetry = banners[0].retry;

  await api.persistWithStatus(async () => {
    serverTitle = 'New Title';
  }, {
    logicalKey,
    replayPayloadSignature: replayPayloadSignature({ title: 'New Title' }),
  });

  assert.equal(api.getOutstandingFailureCount(), 0);
  assert.equal(status.at(-1)?.kind, 'ok');

  oldPayloadApplied = false;
  staleRetry();
  await Promise.resolve();
  assert.equal(oldPayloadApplied, false);
  assert.equal(serverTitle, 'New Title');
  assert.equal(api.getOutstandingFailureCount(), 0);
});

test('same record old failure superseded when newer payload succeeds via form', async () => {
  const { api, banners, setReloadImpl } = makePersistHarness();
  setReloadImpl(async () => {});

  const logicalKey = 'assignment:edit:x';

  await api.persistWithStatus(async () => {
    throw new Error('old payload failed');
  }, {
    logicalKey,
    replayPayloadSignature: replayPayloadSignature({ title: 'A' }),
  });

  await api.persistWithStatus(async () => {}, {
    logicalKey,
    replayPayloadSignature: replayPayloadSignature({ title: 'B' }),
  });

  assert.equal(api.getOutstandingFailureCount(), 0);
  assert.equal(banners.length, 1);
  banners[0].retry();
  await Promise.resolve();
  assert.equal(api.getOutstandingFailureCount(), 0);
});

test('late failure after newer write ack does not resurrect error UI', async () => {
  const { api, status, banners, setReloadImpl } = makePersistHarness();
  setReloadImpl(async () => {});

  const logicalKey = 'assignment:edit:late';
  let releaseSlow;
  const slowGate = new Promise((resolve) => {
    releaseSlow = resolve;
  });

  const slowOld = api.persistWithStatus(async () => {
    await slowGate;
    throw new Error('old slow failure');
  }, {
    logicalKey,
    replayPayloadSignature: replayPayloadSignature({ title: 'Old' }),
  });

  await api.persistWithStatus(async () => {}, {
    logicalKey,
    replayPayloadSignature: replayPayloadSignature({ title: 'New' }),
  });
  assert.equal(api.getOutstandingFailureCount(), 0);
  assert.equal(
    status.at(-1)?.kind,
    'pending',
    'save status stays pending while an older write is still in flight',
  );

  releaseSlow();
  await slowOld;
  assert.equal(status.at(-1)?.kind, 'ok');
  assert.equal(api.getOutstandingFailureCount(), 0);
  assert.equal(
    status.filter((s) => s.kind === 'err').length,
    0,
    'late stale failure must not show error status',
  );
  assert.equal(banners.length, 0);
});

test('grading draft failure retry is noop after publish ack on shared resourceKey', async () => {
  const { api, banners, setReloadImpl } = makePersistHarness();
  setReloadImpl(async () => {});

  const resourceKey = gradingWriteResourceKey('sub-1', 'ver-1');
  let draftMutationRan = false;
  let serverFeedback = 'published feedback';

  await api.persistWithStatus(async () => {
    draftMutationRan = true;
    throw new Error('draft save failed');
  }, {
    logicalKey: 'submission:sub-1:grading-draft',
    resourceKey,
    replayPayloadSignature: replayPayloadSignature({ status: 'grading' }),
  });

  assert.equal(banners.length, 1);
  const staleDraftRetry = banners[0].retry;
  assert.ok(api.getOutstandingFailureCount() === 1);

  await api.persistWithStatus(async () => {
    serverFeedback = 'published feedback';
  }, {
    logicalKey: 'submission:sub-1:grading-publish',
    resourceKey,
    replayPayloadSignature: replayPayloadSignature({
      grading: { published: true, overallFeedback: serverFeedback },
    }),
  });

  assert.equal(api.getOutstandingFailureCount(), 0);

  draftMutationRan = false;
  staleDraftRetry();
  await Promise.resolve();
  assert.equal(draftMutationRan, false);
  assert.equal(api.getOutstandingFailureCount(), 0);
});

test('grading draft and publish keep distinct replay logical keys', async () => {
  const { api, setReloadImpl } = makePersistHarness();
  setReloadImpl(async () => {});

  const resourceKey = gradingWriteResourceKey('s', 'v');
  const draftOp = [];
  const publishOp = [];

  await api.persistWithStatus(async () => {
    draftOp.push(api.getActivePersistOperationId());
  }, {
    logicalKey: 'submission:s:grading-draft',
    resourceKey,
    replayPayloadSignature: replayPayloadSignature({ draft: 1 }),
  });

  await api.persistWithStatus(async () => {
    publishOp.push(api.getActivePersistOperationId());
  }, {
    logicalKey: 'submission:s:grading-publish',
    resourceKey,
    replayPayloadSignature: replayPayloadSignature({ publish: 1 }),
  });

  assert.equal(draftOp.length, 1);
  assert.equal(publishOp.length, 1);
  assert.notEqual(draftOp[0], publishOp[0]);
});

test('retrySameOperation invokes stored onPersistSuccess after successful save', async () => {
  const { api, setReloadImpl } = makePersistHarness();
  setReloadImpl(async () => {});
  let onSuccess = 0;
  let attempts = 0;
  await api.persistWithStatus(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('network');
  }, {
    onPersistSuccess: () => { onSuccess += 1; },
  });
  assert.equal(onSuccess, 0);
  const ok = await api.persistWithStatus(api.getPersistRetryHandle().fn, { retrySameOperation: true });
  assert.equal(ok, true);
  assert.equal(attempts, 2);
  assert.equal(onSuccess, 1);
});

test('acknowledged write reload-only retry invokes onPersistSuccess without replaying mutation', async () => {
  const { api, setReloadImpl } = makePersistHarness();
  let reloads = 0;
  let mutate = 0;
  let onSuccess = 0;
  setReloadImpl(async () => {
    reloads += 1;
    if (reloads === 1) throw new Error('reload failed after ack');
  });
  await api.persistWithStatus(async () => {
    mutate += 1;
  }, {
    onPersistSuccess: () => { onSuccess += 1; },
    successToast: 'saved',
  });
  assert.equal(mutate, 1);
  assert.equal(onSuccess, 0);
  const ok = await api.persistWithStatus(api.getPersistRetryHandle().fn, { retrySameOperation: true });
  assert.equal(ok, true);
  assert.equal(mutate, 1, 'reload-only retry must not replay put mutation');
  assert.equal(reloads, 2);
  assert.equal(onSuccess, 1);
});

test('save-status retry merges stored options including onPersistSuccess', async () => {
  const { api, setReloadImpl } = makePersistHarness();
  setReloadImpl(async () => {});
  let closed = false;
  let attempts = 0;
  await api.persistWithStatus(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('fail');
  }, {
    onPersistSuccess: () => { closed = true; },
  });
  const ok = await api.persistWithStatus(api.getPersistRetryHandle().fn, { retrySameOperation: true });
  assert.equal(ok, true);
  assert.equal(closed, true);
});
