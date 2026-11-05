/**
 * Teacher assignment attachment upload UI + duplicate detection (shared with tests via model wait helper).
 */

import {
  validateAssignmentAttachmentFile,
  ASSIGNMENT_ATTACHMENT_LIMITS,
  fileContentFingerprint,
  waitForInFlightUploads,
} from './model.js';

export { waitForInFlightUploads };

/**
 * Dirty probe for assignment attachment queue vs saved baseline (used by form + tests).
 * @param {string[]} pendingIds
 * @param {{ ids: string[] }} baseline
 * @param {{ hasPendingWork: () => boolean, hasFailed: () => boolean }} uploadCtrl
 */
export function probeAssignmentAttachmentsDirty(pendingIds, baseline, uploadCtrl) {
  if (uploadCtrl.hasPendingWork()) return true;
  if (uploadCtrl.hasFailed()) return true;
  if (pendingIds.length !== baseline.ids.length) return true;
  return pendingIds.some((id, i) => id !== baseline.ids[i]);
}

async function fingerprintFile(file) {
  return fileContentFingerprint(file);
}

/**
 * @param {object} opts
 * @param {(file: File, onProgress: (loaded: number, total: number) => void) => Promise<object>} opts.uploadFn
 * @param {string[]} opts.pendingIds
 * @param {Map<string, object>} opts.pendingMeta
 * @param {() => boolean} opts.isActive
 * @param {(msg: string) => void} opts.onError
 * @param {() => void} opts.refreshList
 * @param {HTMLElement} opts.listEl
 * @param {() => void} [opts.onBusyChange]
 * @param {Set<string>} [opts.reservedFingerprints]
 * @param {() => boolean} [opts.canMutate]
 */
export function createAttachmentUploadController(opts) {
  const inFlight = new Set();
  /** @type {Map<string, UploadItem>} */
  const localItems = new Map();
  const reserved = opts.reservedFingerprints || new Set();
  /** @type {(() => void)|null} */
  let queueTransitionHandler = null;

  function attachmentsMutable() {
    return opts.canMutate ? opts.canMutate() : true;
  }

  function notifyQueueTransition() {
    queueTransitionHandler?.();
  }

  function syncBusy() {
    opts.onBusyChange?.();
    notifyQueueTransition();
  }

  function releaseFingerprint(fp) {
    if (fp) reserved.delete(fp);
  }

  function activeSlotCount() {
    return opts.pendingIds.length + localItems.size;
  }

  for (const id of opts.pendingIds) {
    const m = opts.pendingMeta.get(id);
    if (m?.contentFingerprint) reserved.add(m.contentFingerprint);
  }

  function trackJob(job) {
    inFlight.add(job);
    syncBusy();
    void job.finally(() => {
      inFlight.delete(job);
      syncBusy();
    });
  }

  async function retryItem(key) {
    if (!attachmentsMutable()) return;
    const item = localItems.get(key);
    if (!item?.file) return;
    item.status = 'pending';
    item.error = '';
    opts.refreshList();
    trackJob(runPipeline(key, item.file, item));
  }

  function renderLocalRow(item) {
    const row = document.createElement('div');
    row.className = 'attachment-row attachment-upload-row';
    const info = document.createElement('div');
    info.className = 'attachment-info';
    info.innerHTML = `<span class="attachment-name"></span><span class="attachment-meta"></span>`;
    info.querySelector('.attachment-name').textContent = item.filename || item.file?.name || 'Tệp';
    const meta = info.querySelector('.attachment-meta');
    if (item.status === 'hashing' || item.status === 'pending') {
      meta.textContent = 'Đang chuẩn bị…';
    } else if (item.status === 'uploading') {
      meta.textContent = `Đang tải… ${item.progress != null ? `${Math.round(item.progress * 100)}%` : ''}`;
    } else if (item.status === 'failed') {
      meta.textContent = item.error || 'Tải lên thất bại';
    } else {
      meta.textContent = 'Sẵn sàng';
    }
    row.appendChild(info);
    const actions = document.createElement('div');
    actions.className = 'attachment-actions';
    if (item.status === 'failed') {
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'btn btn-ghost btn-sm';
      retry.textContent = 'Thử lại';
      retry.disabled = !attachmentsMutable();
      retry.addEventListener('click', () => void retryItem(item.localKey));
      actions.appendChild(retry);
    }
    if (item.status !== 'uploading' && item.status !== 'hashing') {
      const rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'btn btn-ghost btn-sm';
      rm.textContent = 'Xóa';
      rm.disabled = !attachmentsMutable();
      rm.addEventListener('click', () => {
        if (!attachmentsMutable()) return;
        if (item.id && opts.pendingIds.includes(item.id)) {
          const idx = opts.pendingIds.indexOf(item.id);
          if (idx >= 0) opts.pendingIds.splice(idx, 1);
          const metaRow = opts.pendingMeta.get(item.id);
          releaseFingerprint(metaRow?.contentFingerprint);
          opts.pendingMeta.delete(item.id);
        }
        releaseFingerprint(item.fingerprint);
        localItems.delete(item.localKey);
        opts.refreshList();
        syncBusy();
      });
      actions.appendChild(rm);
    }
    row.appendChild(actions);
    return row;
  }

  opts.refreshList = () => {
    opts.listEl.replaceChildren();
    for (const id of opts.pendingIds) {
      const att = opts.pendingMeta.get(id);
      if (att) {
        const row = document.createElement('div');
        row.className = 'attachment-row';
        row.textContent = `${att.filename} · ${att.size || 0} B`;
        const rm = document.createElement('button');
        rm.type = 'button';
        rm.className = 'btn btn-ghost btn-sm';
        rm.textContent = 'Gỡ';
        rm.disabled = !attachmentsMutable();
        rm.addEventListener('click', () => {
          if (!attachmentsMutable()) return;
          const idx = opts.pendingIds.indexOf(id);
          if (idx >= 0) opts.pendingIds.splice(idx, 1);
          releaseFingerprint(att.contentFingerprint);
          opts.pendingMeta.delete(id);
          opts.refreshList();
          syncBusy();
        });
        row.appendChild(rm);
        opts.listEl.appendChild(row);
      }
    }
    for (const item of localItems.values()) {
      if (item.status !== 'ready' || !item.id) {
        opts.listEl.appendChild(renderLocalRow(item));
      }
    }
  };

  async function runPipeline(localKey, file, item) {
    if (!opts.isActive()) {
      localItems.delete(localKey);
      return;
    }
    item.status = 'hashing';
    localItems.set(localKey, item);
    opts.refreshList();
    syncBusy();

    let fp;
    try {
      fp = await fingerprintFile(file);
    } catch (e) {
      if (!opts.isActive()) {
        localItems.delete(localKey);
        return;
      }
      item.status = 'failed';
      item.error = e?.message || 'Không đọc được tệp.';
      localItems.set(localKey, item);
      opts.refreshList();
      syncBusy();
      return;
    }

    if (!opts.isActive()) {
      localItems.delete(localKey);
      syncBusy();
      return;
    }

    if (reserved.has(fp)) {
      opts.onError(`Tệp "${file.name}" trùng nội dung với tệp đã chọn.`);
      localItems.delete(localKey);
      opts.refreshList();
      syncBusy();
      return;
    }

    reserved.add(fp);
    item.fingerprint = fp;
    item.status = 'uploading';
    localItems.set(localKey, item);
    opts.refreshList();
    syncBusy();

    try {
      const uploaded = await opts.uploadFn(file, (loaded, total) => {
        item.progress = total ? loaded / total : 1;
        opts.refreshList();
      });
      if (!opts.isActive()) return;
      item.status = 'ready';
      item.id = uploaded.id;
      opts.pendingIds.push(uploaded.id);
      opts.pendingMeta.set(uploaded.id, {
        ...uploaded,
        contentFingerprint: fp,
      });
      localItems.delete(localKey);
      opts.refreshList();
    } catch (e) {
      if (!opts.isActive()) return;
      item.status = 'failed';
      item.error = e?.message || 'Không tải được tệp.';
      releaseFingerprint(fp);
      item.fingerprint = '';
      localItems.set(localKey, item);
      opts.refreshList();
    } finally {
      syncBusy();
    }
  }

  function enqueueFiles(files, { retryKey } = {}) {
    if (!attachmentsMutable()) return;
    const batch = [];
    for (const file of files) {
      if (!opts.isActive()) break;
      if (activeSlotCount() >= ASSIGNMENT_ATTACHMENT_LIMITS.maxFiles) {
        opts.onError(`Tối đa ${ASSIGNMENT_ATTACHMENT_LIMITS.maxFiles} tệp mỗi bài tập.`);
        break;
      }
      const fv = validateAssignmentAttachmentFile(file);
      if (!fv.ok) {
        opts.onError(fv.error);
        continue;
      }
      const localKey = retryKey || `local:${crypto.randomUUID()}`;
      const item = {
        localKey,
        id: '',
        filename: file.name,
        mime: file.type,
        size: file.size,
        status: 'pending',
        progress: 0,
        fingerprint: '',
        file,
      };
      localItems.set(localKey, item);
      batch.push({ localKey, file, item });
    }
    opts.refreshList();
    syncBusy();
    for (const { localKey, file, item } of batch) {
      trackJob(runPipeline(localKey, file, item));
    }
  }

  return {
    inFlight,
    reservedFingerprints: reserved,
    enqueueFiles,
    bindQueueTransition(handler) {
      queueTransitionHandler = typeof handler === 'function' ? handler : null;
      return () => {
        if (queueTransitionHandler === handler) queueTransitionHandler = null;
      };
    },
    refresh() {
      opts.refreshList();
    },
    refreshMutability() {
      opts.refreshList();
    },
    async waitSettled() {
      for (;;) {
        await waitForInFlightUploads(inFlight);
        if (!this.hasPendingWork()) break;
        await new Promise((r) => setTimeout(r, 0));
      }
    },
    hasFailed() {
      return [...localItems.values()].some((x) => x.status === 'failed');
    },
    hasPendingWork() {
      return inFlight.size > 0 || [...localItems.values()].some(
        (x) => x.status === 'pending' || x.status === 'hashing' || x.status === 'uploading',
      );
    },
    isBusy() {
      return this.hasPendingWork();
    },
  };
}
