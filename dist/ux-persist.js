/**
 * Global save status + retry handles guarded by auth request epoch.
 * Each login session owns { inFlight, failures, retry, pendingReplays }.
 * Backend replay IDs live only in pendingReplays while a write is unacknowledged.
 * UI failure entries use their own ids, separate from replay operation ids.
 */

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

/** Canonical payload fingerprint for replay ID reuse while a write is unacknowledged. */
export function replayPayloadSignature(value) {
  return stableStringify(value);
}

/**
 * @param {object} deps
 * @param {() => number} deps.getRequestEpoch
 * @param {(epoch: number) => boolean} deps.isStaleEpoch
 * @param {() => Promise<void>} deps.reloadAppData
 * @param {(kind: string, message: string) => void} deps.setSaveStatus
 * @param {(message: string, opts?: object) => void} deps.showErrorBanner
 * @param {(message: string) => void} [deps.toastSuccess]
 * @param {(err: unknown) => boolean | Promise<boolean>} [deps.onUnauthorized]
 * @param {() => void} [deps.hideErrorBanner]
 */
export function createPersistWithStatus(deps) {
  /** @type {(() => Promise<void>)|null} */
  let lastPersistFn = null;
  /** @type {string[]} */
  const activeOperationIdStack = [];
  let persistSessionEpoch = null;

  /** @typedef {{
   *   inFlight: number,
   *   failures: Map<string, {
   *     fn: () => Promise<void>,
   *     epoch: number,
   *     options: object,
   *     message: string,
   *     replayOperationId: string,
   *     writeAcknowledged: boolean,
   *     logicalKey: string | null,
   *     resourceKey: string | null,
   *     sequence: number,
   *   }>,
   *   retry: { fn: () => Promise<void>, epoch: number, operationId: string } | null,
   *   pendingReplays: Map<string, { operationId: string, payloadSignature: string | null }>,
   *   writeSequenceByResourceKey: Map<string, number>,
   *   confirmedWriteSequenceByResourceKey: Map<string, number>,
   *   displayedFailureId: string | null,
   * }} PersistSessionState */

  /** @returns {PersistSessionState} */
  function createSessionState() {
    return {
      inFlight: 0,
      failures: new Map(),
      retry: null,
      pendingReplays: new Map(),
      writeSequenceByResourceKey: new Map(),
      confirmedWriteSequenceByResourceKey: new Map(),
      displayedFailureId: null,
    };
  }

  /** @type {PersistSessionState} */
  let currentSession = createSessionState();

  function getActivePersistOperationId() {
    return activeOperationIdStack[activeOperationIdStack.length - 1] ?? null;
  }

  function pushActiveOperationId(operationId) {
    activeOperationIdStack.push(operationId);
  }

  function popActiveOperationId(operationId) {
    if (activeOperationIdStack[activeOperationIdStack.length - 1] === operationId) {
      activeOperationIdStack.pop();
    }
  }

  /** @param {object} options */
  function resolveResourceKey(options) {
    return options.resourceKey ?? options.logicalKey ?? null;
  }

  /** @param {PersistSessionState} session */
  function clearRetryIfOwned(session, failureId) {
    if (session.retry?.operationId !== failureId) return;
    session.retry = null;
    const next = session.failures.entries().next().value;
    if (next) {
      const [id, entry] = next;
      session.retry = { fn: entry.fn, epoch: entry.epoch, operationId: id };
    }
  }

  /** @param {PersistSessionState} session */
  function retireFailure(session, failureId) {
    session.failures.delete(failureId);
    if (session.displayedFailureId === failureId) {
      session.displayedFailureId = null;
    }
    if (session.retry?.operationId === failureId) {
      session.retry = null;
      const next = session.failures.entries().next().value;
      if (next) {
        const [id, entry] = next;
        session.retry = { fn: entry.fn, epoch: entry.epoch, operationId: id };
      }
    }
  }

  /** @param {PersistSessionState} session */
  function supersedeFailuresForResource(session, resourceKey, throughSequence) {
    if (!resourceKey) return;
    for (const [id, entry] of session.failures) {
      if (entry.resourceKey === resourceKey && entry.sequence <= throughSequence) {
        retireFailure(session, id);
      }
    }
  }

  /** @param {PersistSessionState} session */
  function retirePendingReplay(session, logicalKey) {
    if (logicalKey) session.pendingReplays.delete(logicalKey);
  }

  /** @param {PersistSessionState} session */
  function abortIfStale(session, entryEpoch, failureId) {
    if (!deps.isStaleEpoch(entryEpoch)) return false;
    session.failures.delete(failureId);
    clearRetryIfOwned(session, failureId);
    return true;
  }

  /** @param {PersistSessionState} session */
  function mayTouchUi(session, entryEpoch) {
    return session === currentSession && !deps.isStaleEpoch(entryEpoch);
  }

  /** @param {PersistSessionState} session */
  function invokeOnPersistSuccess(session, entryEpoch, options) {
    if (!mayTouchUi(session, entryEpoch)) return;
    const cb = options.onPersistSuccess;
    if (typeof cb !== 'function') return;
    try {
      cb({ retrySameOperation: !!options.retrySameOperation });
    } catch (e) {
      console.error(e);
    }
  }

  /** @param {PersistSessionState} session */
  function mergeRetryFailureOptions(session, options) {
    if (!options.retrySameOperation || !session.retry?.operationId) return options;
    const failEntry = session.failures.get(session.retry.operationId);
    if (!failEntry?.options) return options;
    return { ...failEntry.options, ...options, retrySameOperation: true };
  }

  /** @param {PersistSessionState} session */
  function isFailureRegistrationStale(session, resourceKey, entrySequence) {
    if (!resourceKey) return false;
    const confirmed = session.confirmedWriteSequenceByResourceKey.get(resourceKey);
    if (confirmed == null) return false;
    return entrySequence <= confirmed;
  }

  /** @param {PersistSessionState} session */
  function confirmWriteForResource(session, resourceKey, entrySequence) {
    if (!resourceKey) return;
    const prev = session.confirmedWriteSequenceByResourceKey.get(resourceKey) ?? 0;
    const next = Math.max(prev, entrySequence);
    session.confirmedWriteSequenceByResourceKey.set(resourceKey, next);
    supersedeFailuresForResource(session, resourceKey, next);
  }

  /** @param {PersistSessionState} session */
  function syncPersistUi(session) {
    if (session !== currentSession) return;

    if (session.failures.size > 0) {
      const [firstId, first] = session.failures.entries().next().value;
      session.retry = { fn: first.fn, epoch: first.epoch, operationId: firstId };
      deps.setSaveStatus('err', 'Lưu thất bại — bấm để thử lại');
      if (session.displayedFailureId !== firstId) {
        session.displayedFailureId = firstId;
        deps.showErrorBanner(first.message || 'Lưu thất bại.', {
          retry: () => {
            if (!session.failures.has(firstId)) return;
            const entry = session.failures.get(firstId);
            if (!entry || session !== currentSession || deps.isStaleEpoch(entry.epoch)) return;
            persistWithStatus(entry.fn, {
              ...entry.options,
              retrySameOperation: true,
            });
          },
          persistent: true,
        });
      }
      return;
    }

    session.displayedFailureId = null;
    if (session.inFlight > 0) {
      deps.setSaveStatus('pending', 'Đang lưu…');
      deps.hideErrorBanner?.();
      return;
    }
    session.retry = null;
    deps.setSaveStatus('ok', 'Đã lưu');
    deps.hideErrorBanner?.();
  }

  /** @param {PersistSessionState} session */
  function recordFailure(
    session,
    failureId,
    entryEpoch,
    fn,
    options,
    message,
    replayOperationId,
    writeAcknowledged,
    tracking,
  ) {
    session.failures.set(failureId, {
      fn,
      epoch: entryEpoch,
      options,
      message: message || 'Lưu thất bại.',
      replayOperationId,
      writeAcknowledged,
      logicalKey: tracking.logicalKey,
      resourceKey: tracking.resourceKey,
      sequence: tracking.sequence,
    });
    if (!session.retry) {
      session.retry = { fn, epoch: entryEpoch, operationId: failureId };
    }
  }

  /**
   * @param {PersistSessionState} session
   * @param {object} options
   */
  function resolveFailureTrackingId(session, options) {
    if (options.retrySameOperation && session.retry?.operationId) {
      return session.retry.operationId;
    }
    return crypto.randomUUID();
  }

  /**
   * @param {PersistSessionState} session
   * @param {object} options
   */
  function resolveReplayOperationId(session, options) {
    const {
      retrySameOperation = false,
      logicalKey = null,
      replayPayloadSignature: payloadSignature = null,
    } = options;

    if (retrySameOperation) {
      const failureId = session.retry?.operationId;
      if (failureId) {
        const entry = session.failures.get(failureId);
        if (entry?.replayOperationId) return entry.replayOperationId;
      }
    }

    if (logicalKey && session.pendingReplays.has(logicalKey)) {
      const pending = session.pendingReplays.get(logicalKey);
      const sigMatches = payloadSignature === pending.payloadSignature
        || (payloadSignature == null && pending.payloadSignature == null);
      if (sigMatches) {
        return pending.operationId;
      }
    }

    const opId = crypto.randomUUID();
    if (logicalKey) {
      session.pendingReplays.set(logicalKey, {
        operationId: opId,
        payloadSignature: payloadSignature ?? null,
      });
    }
    return opId;
  }

  /** @param {PersistSessionState} session */
  function allocateWriteSequence(session, resourceKey, options) {
    if (!resourceKey) return 0;
    if (options.retrySameOperation && session.retry?.operationId) {
      const failEntry = session.failures.get(session.retry.operationId);
      if (failEntry?.resourceKey === resourceKey && failEntry.sequence) {
        return failEntry.sequence;
      }
    }
    const next = (session.writeSequenceByResourceKey.get(resourceKey) ?? 0) + 1;
    session.writeSequenceByResourceKey.set(resourceKey, next);
    return next;
  }

  async function runReloadOnlyRetry(session, failEntry, options) {
    const entryFailureId = session.retry.operationId;
    const entryEpoch = failEntry.epoch;
    const { successToast = null, silent = false } = options;

    if (!session.failures.has(entryFailureId)) {
      return false;
    }

    session.inFlight += 1;
    if (mayTouchUi(session, entryEpoch)) {
      deps.setSaveStatus('pending', 'Đang lưu…');
    }

    let flightEnded = false;
    const endFlight = () => {
      if (flightEnded) return;
      flightEnded = true;
      session.inFlight -= 1;
      if (session.inFlight < 0) session.inFlight = 0;
    };

    try {
      await deps.reloadAppData();
      if (abortIfStale(session, entryEpoch, entryFailureId)) {
        endFlight();
        if (mayTouchUi(session, entryEpoch)) syncPersistUi(session);
        return false;
      }

      if (!session.failures.has(entryFailureId)) {
        endFlight();
        if (mayTouchUi(session, entryEpoch)) syncPersistUi(session);
        return false;
      }

      retireFailure(session, entryFailureId);

      endFlight();
      if (mayTouchUi(session, entryEpoch)) syncPersistUi(session);
      if (
        !silent
        && successToast
        && deps.toastSuccess
        && mayTouchUi(session, entryEpoch)
        && session.failures.size === 0
        && session.inFlight === 0
      ) {
        deps.toastSuccess(successToast);
      }
      invokeOnPersistSuccess(session, entryEpoch, options);
      return true;
    } catch (e) {
      console.error(e);
      if (abortIfStale(session, entryEpoch, entryFailureId)) {
        endFlight();
        if (mayTouchUi(session, entryEpoch)) syncPersistUi(session);
        return false;
      }
      if (!session.failures.has(entryFailureId)) {
        endFlight();
        if (mayTouchUi(session, entryEpoch)) syncPersistUi(session);
        return false;
      }
      recordFailure(
        session,
        entryFailureId,
        entryEpoch,
        failEntry.fn,
        failEntry.options,
        e?.message || 'Lưu thất bại.',
        failEntry.replayOperationId,
        true,
        {
          logicalKey: failEntry.logicalKey,
          resourceKey: failEntry.resourceKey,
          sequence: failEntry.sequence,
        },
      );
      endFlight();
      if (mayTouchUi(session, entryEpoch)) syncPersistUi(session);
      return false;
    }
  }

  async function persistWithStatus(fn, options = {}) {
    const session = currentSession;
    options = mergeRetryFailureOptions(session, options);
    const { successToast = null, silent = false, retrySameOperation = false } = options;
    const logicalKey = options.logicalKey ?? null;
    const resourceKey = resolveResourceKey(options);

    if (retrySameOperation && session.retry) {
      const failEntry = session.failures.get(session.retry.operationId);
      if (failEntry?.writeAcknowledged) {
        return runReloadOnlyRetry(session, failEntry, options);
      }
    }

    const entryEpoch = deps.getRequestEpoch();
    if (!retrySameOperation || persistSessionEpoch !== entryEpoch) {
      persistSessionEpoch = entryEpoch;
    }

    const entrySequence = allocateWriteSequence(session, resourceKey, options);
    const entryFailureId = resolveFailureTrackingId(session, options);
    const entryReplayOperationId = resolveReplayOperationId(session, options);
    const tracking = { logicalKey, resourceKey, sequence: entrySequence };

    lastPersistFn = fn;
    session.inFlight += 1;
    if (mayTouchUi(session, entryEpoch)) {
      deps.setSaveStatus('pending', 'Đang lưu…');
    }

    pushActiveOperationId(entryReplayOperationId);
    let flightEnded = false;
    let writeAcknowledged = false;
    const endFlight = () => {
      if (flightEnded) return;
      flightEnded = true;
      session.inFlight -= 1;
      if (session.inFlight < 0) session.inFlight = 0;
    };
    try {
      await fn();
      writeAcknowledged = true;
      retirePendingReplay(session, logicalKey);
      if (abortIfStale(session, entryEpoch, entryFailureId)) {
        endFlight();
        if (mayTouchUi(session, entryEpoch)) syncPersistUi(session);
        return false;
      }
      await deps.reloadAppData();
      if (abortIfStale(session, entryEpoch, entryFailureId)) {
        endFlight();
        if (mayTouchUi(session, entryEpoch)) syncPersistUi(session);
        return false;
      }

      confirmWriteForResource(session, resourceKey, entrySequence);
      retireFailure(session, entryFailureId);

      endFlight();
      if (mayTouchUi(session, entryEpoch)) syncPersistUi(session);
      if (
        !silent
        && successToast
        && deps.toastSuccess
        && mayTouchUi(session, entryEpoch)
        && session.failures.size === 0
        && session.inFlight === 0
      ) {
        deps.toastSuccess(successToast);
      }
      invokeOnPersistSuccess(session, entryEpoch, options);
      return true;
    } catch (e) {
      console.error(e);
      if (e?.status === 401) {
        if (e.staleAuth) {
          endFlight();
          if (mayTouchUi(session, entryEpoch)) syncPersistUi(session);
          return false;
        }
        if (deps.onUnauthorized) await deps.onUnauthorized(e);
        endFlight();
        if (mayTouchUi(session, entryEpoch)) syncPersistUi(session);
        return false;
      }
      if (abortIfStale(session, entryEpoch, entryFailureId)) {
        endFlight();
        if (mayTouchUi(session, entryEpoch)) syncPersistUi(session);
        return false;
      }
      if (!writeAcknowledged) {
        try {
          await deps.reloadAppData();
          if (abortIfStale(session, entryEpoch, entryFailureId)) {
            endFlight();
            if (mayTouchUi(session, entryEpoch)) syncPersistUi(session);
            return false;
          }
        } catch (reloadErr) {
          console.error(reloadErr);
          if (abortIfStale(session, entryEpoch, entryFailureId)) {
            endFlight();
            if (mayTouchUi(session, entryEpoch)) syncPersistUi(session);
            return false;
          }
        }
      }
      if (abortIfStale(session, entryEpoch, entryFailureId)) {
        endFlight();
        if (mayTouchUi(session, entryEpoch)) syncPersistUi(session);
        return false;
      }

      if (isFailureRegistrationStale(session, resourceKey, entrySequence)) {
        endFlight();
        if (mayTouchUi(session, entryEpoch)) syncPersistUi(session);
        return false;
      }

      const failureMessage = e?.status === 409
        ? (e.message || 'Xung đột thao tác — tải lại và thử lại.')
        : (e.message || 'Lưu thất bại.');
      recordFailure(
        session,
        entryFailureId,
        entryEpoch,
        fn,
        options,
        failureMessage,
        entryReplayOperationId,
        writeAcknowledged,
        tracking,
      );
      endFlight();
      if (mayTouchUi(session, entryEpoch)) syncPersistUi(session);
      return false;
    } finally {
      popActiveOperationId(entryReplayOperationId);
    }
  }

  function resetPersistSession() {
    persistSessionEpoch = null;
    activeOperationIdStack.length = 0;
    currentSession = createSessionState();
  }

  function setActivePersistOperationId(id) {
    if (id == null) {
      activeOperationIdStack.length = 0;
      return;
    }
    activeOperationIdStack.push(id);
  }

  return {
    persistWithStatus,
    resetPersistSession,
    getActivePersistOperationId,
    setActivePersistOperationId,
    getPersistRetryHandle: () => currentSession.retry,
    getOutstandingFailureCount: () => currentSession.failures.size,
  };
}
