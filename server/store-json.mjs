import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  STATE_FILE,
  IMAGES_DIR,
  ATTACHMENTS_DIR,
  emptyState,
  normalizeState,
} from './store-state.mjs';
import { getStoreLock, runSerialized } from './store-lock.mjs';

/** @typedef {import('./store-state.mjs').AppState} AppState */

export function createJsonStore(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(path.join(dataDir, IMAGES_DIR), { recursive: true });
  fs.mkdirSync(path.join(dataDir, ATTACHMENTS_DIR), { recursive: true });

  const lock = getStoreLock(dataDir);

  function statePath() {
    return path.join(dataDir, STATE_FILE);
  }

  function imagePath(id) {
    return path.join(dataDir, IMAGES_DIR, `${id}.bin`);
  }

  function attachmentPath(id) {
    return path.join(dataDir, ATTACHMENTS_DIR, `${id}.bin`);
  }

  function loadSync() {
    const p = statePath();
    if (!fs.existsSync(p)) return emptyState();
    const raw = fs.readFileSync(p, 'utf8');
    return normalizeState(JSON.parse(raw));
  }

  function writeAtomic(state) {
    const p = statePath();
    const tmp = `${p}.${randomUUID()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state), 'utf8');
    fs.renameSync(tmp, p);
  }

  /**
   * @template T
   * @param {(state: AppState) => T | Promise<T>} fn
   */
  async function mutate(fn) {
    return runSerialized(lock, async () => {
      const state = loadSync();
      const result = await fn(state);
      writeAtomic(state);
      return result;
    });
  }

  async function read() {
    await lock.chain;
    return loadSync();
  }

  function writeImageBuffer(id, buffer) {
    const p = imagePath(id);
    const tmp = `${p}.${randomUUID()}.tmp`;
    fs.writeFileSync(tmp, buffer);
    fs.renameSync(tmp, p);
  }

  async function saveImage(id, buffer, meta) {
    await lock.chain;
    writeImageBuffer(id, buffer);
    await mutate((state) => {
      state.imageMeta[id] = meta;
    });
  }

  function attachImageInState(state, id, buffer, meta) {
    writeImageBuffer(id, buffer);
    state.imageMeta[id] = meta;
  }

  async function readImage(id) {
    await lock.chain;
    const p = imagePath(id);
    if (!fs.existsSync(p)) return null;
    return fs.readFileSync(p);
  }

  async function deleteImage(id) {
    await mutate((state) => {
      delete state.imageMeta[id];
    });
    const p = imagePath(id);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }

  function writeAttachmentBuffer(id, buffer) {
    const p = attachmentPath(id);
    const tmp = `${p}.${randomUUID()}.tmp`;
    fs.writeFileSync(tmp, buffer);
    fs.renameSync(tmp, p);
  }

  function attachAttachmentInState(state, id, buffer, meta) {
    writeAttachmentBuffer(id, buffer);
    state.attachmentMeta[id] = meta;
  }

  async function readAttachment(id) {
    await lock.chain;
    const p = attachmentPath(id);
    if (!fs.existsSync(p)) return null;
    return fs.readFileSync(p);
  }

  async function close() {
    await lock.chain;
  }

  return {
    backend: 'json',
    mutate,
    read,
    saveImage,
    attachImageInState,
    readImage,
    deleteImage,
    attachAttachmentInState,
    readAttachment,
    emptyState,
    dataDir,
    close,
  };
}
