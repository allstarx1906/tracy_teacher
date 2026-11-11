/**
 * Per-page optimistic revision queue for exam PDF annotation saves.
 */

export function createExamPdfSaveQueue({ savePage, onStatusChange }) {
  let baseRevision = 0;
  let chain = Promise.resolve();
  const pendingByPage = new Map();
  const newestByPage = new Map();
  let disposed = false;
  let failure = false;

  function setStatus(text, kind) {
    if (typeof onStatusChange === 'function') onStatusChange(text, kind);
  }

  function runSerialized(fn) {
    const run = chain.then(fn, fn);
    chain = run.catch(() => {});
    return run;
  }

  function enqueue(pageKey, body) {
    if (disposed) return;
    newestByPage.set(pageKey, body);
    pendingByPage.set(pageKey, body);
    runSerialized(flushLoop);
  }

  async function flushLoop() {
    if (disposed) return;
    while (pendingByPage.size && !disposed) {
      const [pageKey, body] = pendingByPage.entries().next().value;
      const outbound = newestByPage.get(pageKey) ?? body;
      setStatus('Đang lưu…', 'pending');
      try {
        const res = await savePage(pageKey, outbound, baseRevision);
        if (disposed) return;
        if (res?.revision != null) baseRevision = res.revision;
        const newer = newestByPage.get(pageKey);
        if (newer && JSON.stringify(newer) !== JSON.stringify(outbound)) {
          pendingByPage.set(pageKey, newer);
          continue;
        }
        pendingByPage.delete(pageKey);
        newestByPage.delete(pageKey);
        failure = false;
        setStatus('Đã lưu', 'ok');
      } catch (e) {
        if (disposed) return;
        failure = true;
        const still = newestByPage.get(pageKey);
        pendingByPage.set(pageKey, still ?? outbound);
        const code = e?.status;
        if (code === 409) setStatus('Xung đột — tải lại', 'err');
        else setStatus(e?.message || 'Lỗi lưu — thử lại', 'err');
        break;
      }
    }
  }

  return {
    setBaseRevision(rev) {
      if (Number.isInteger(rev) && rev >= 0) baseRevision = rev;
    },
    getBaseRevision() {
      return baseRevision;
    },
    enqueue,
    async flush() {
      await runSerialized(async () => {
        let guard = 0;
        while (pendingByPage.size && !disposed && guard < 64) {
          guard += 1;
          await flushLoop();
          if (!pendingByPage.size || disposed) break;
          if (failure) break;
        }
      });
      if (failure || pendingByPage.size) {
        throw new Error('Còn chú thích chưa lưu.');
      }
    },
    hasPending() {
      return pendingByPage.size > 0;
    },
    hasFailure() {
      return failure;
    },
    dispose() {
      disposed = true;
      pendingByPage.clear();
      newestByPage.clear();
    },
  };
}
