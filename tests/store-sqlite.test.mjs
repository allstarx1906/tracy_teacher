import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import {
  createStore,
  createJsonStore,
  statesLogicallyEqual,
  stableStringify,
} from '../server/store.mjs';
import {
  SQLITE_FILE,
  STATE_FILE,
  emptyState,
  normalizeState,
} from '../server/store-state.mjs';
import {
  MIGRATION_PENDING_MARKER,
  MIGRATION_COMPLETE_MARKER,
  MIGRATION_SOURCE_DIR,
} from '../server/store-migration-markers.mjs';
import {
  listOpenDatabaseCountForTests,
  closeAllOpenDatabasesForTests,
} from '../server/store-sqlite.mjs';
import { createServer } from '../server.mjs';
import { runSqliteTransaction } from '../server/store-sqlite-tx.mjs';
import { hashFileSync, hashDirectoryFiles, listBinFilesHashes } from '../server/store-fs-utils.mjs';

test('new data dir uses SQLite app.sqlite by default', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bn-sqlite-new-'));
  try {
    const store = createStore(dataDir);
    assert.equal(store.backend, 'sqlite');
    assert.ok(fs.existsSync(path.join(dataDir, SQLITE_FILE)));
    await store.mutate((s) => {
      s.meta.initialized = true;
      s.settings.teacherDisplayName = 'T';
    });
    await store.close();
    const store2 = createStore(dataDir);
    const state = await store2.read();
    assert.equal(state.settings.teacherDisplayName, 'T');
    await store2.close();
  } finally {
    await closeAllOpenDatabasesForTests();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('legacy state.json without sqlite throws migration error', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bn-legacy-'));
  try {
    fs.writeFileSync(path.join(dataDir, STATE_FILE), JSON.stringify(emptyState()), 'utf8');
    assert.throws(() => createStore(dataDir), /state\.json|migrate-json-to-sqlite/);
    const legacy = createJsonStore(dataDir);
    assert.equal(legacy.backend, 'json');
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('SQLite roundtrip preserves unknown fields null vs object', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bn-ext-'));
  try {
    const store = createStore(dataDir);
    await store.mutate((s) => {
      s.meta.initialized = true;
      s.customFlag = true;
      s.customNull = null;
      s.classes.push({ id: 'c1', name: 'X', scheduleDays: [], scheduleTime: '1', createdAt: new Date().toISOString() });
    });
    await store.close();
    const store2 = createStore(dataDir);
    const state = await store2.read();
    assert.equal(state.customFlag, true);
    assert.equal(state.customNull, null);
    assert.ok(!Object.prototype.hasOwnProperty.call(state, 'customMissing'));
    await store2.close();
  } finally {
    await closeAllOpenDatabasesForTests();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('mutate rolls back when callback throws', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bn-rollback-'));
  try {
    const store = createStore(dataDir);
    await store.mutate((s) => {
      s.settings.teacherDisplayName = 'Before';
    });
    await assert.rejects(
      () => store.mutate(() => {
        throw new Error('fail-on-purpose');
      }),
      /fail-on-purpose/,
    );
    const state = await store.read();
    assert.equal(state.settings.teacherDisplayName, 'Before');
    await store.close();
  } finally {
    await closeAllOpenDatabasesForTests();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('concurrent handles on same dataDir serialize updates', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bn-concurrent-'));
  try {
    const a = createStore(dataDir);
    const b = createStore(dataDir);
    await Promise.all([
      a.mutate(async (s) => {
        s.settings.teacherDisplayName = `${s.settings.teacherDisplayName || ''}A`;
        await new Promise((r) => setTimeout(r, 5));
      }),
      b.mutate(async (s) => {
        s.settings.teacherDisplayName = `${s.settings.teacherDisplayName || ''}B`;
      }),
    ]);
    const state = await a.read();
    assert.equal(state.settings.teacherDisplayName, 'AB');
    await a.close();
    await b.close();
  } finally {
    await closeAllOpenDatabasesForTests();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('unsupported schema version is rejected', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bn-schema-'));
  try {
    const store = createStore(dataDir);
    const db = store.getDatabaseHandle();
    db.prepare('UPDATE app_metadata SET value = ? WHERE key = ?').run('999', 'schemaVersion');
    await store.close();
    assert.throws(() => createStore(dataDir), /Unsupported SQLite schema/);
  } finally {
    await closeAllOpenDatabasesForTests();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('close releases database handle (Windows cleanup)', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bn-close-'));
  try {
    const store = createStore(dataDir);
    assert.ok(listOpenDatabaseCountForTests() >= 1);
    await store.close();
    assert.equal(listOpenDatabaseCountForTests(), 0);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('offline migration copies state blobs and matches normalized state', async () => {
  const source = fs.mkdtempSync(path.join(os.tmpdir(), 'bn-mig-src-'));
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'bn-mig-dst-'));
  try {
    const raw = normalizeState(emptyState());
    raw.meta.initialized = true;
    raw.settings.teacherDisplayName = 'Migrate';
    raw.futureBucket = { n: 1 };
    fs.writeFileSync(path.join(source, STATE_FILE), JSON.stringify(raw), 'utf8');
    fs.mkdirSync(path.join(source, 'images'), { recursive: true });
    fs.writeFileSync(path.join(source, 'images', 'x.bin'), Buffer.from('img'));

    const run = spawnSync(
      process.execPath,
      ['tools/migrate-json-to-sqlite.mjs', '--source', source, '--destination', dest],
      { cwd: path.join(path.dirname(fileURLToPath(import.meta.url)), '..'), encoding: 'utf8' },
    );
    assert.equal(run.status, 0, run.stderr || run.stdout);

    assert.ok(fs.existsSync(path.join(dest, 'migration-complete.marker')));
    assert.ok(fs.existsSync(path.join(dest, SQLITE_FILE)));
    assert.ok(fs.existsSync(path.join(dest, 'images', 'x.bin')));

    const store = createStore(dest);
    const loaded = await store.read();
    assert.ok(statesLogicallyEqual(normalizeState(structuredClone(raw)), loaded));
    await store.close();
  } finally {
    fs.rmSync(source, { recursive: true, force: true });
    fs.rmSync(dest, { recursive: true, force: true });
    closeAllOpenDatabasesForTests();
  }
});

test('migration rejects non-empty destination and same path', () => {
  const source = fs.mkdtempSync(path.join(os.tmpdir(), 'bn-mig-bad-'));
  fs.writeFileSync(path.join(source, STATE_FILE), '{}', 'utf8');
  const runSame = spawnSync(
    process.execPath,
    ['tools/migrate-json-to-sqlite.mjs', '--source', source, '--destination', source],
    { cwd: path.join(import.meta.dirname, '..'), encoding: 'utf8' },
  );
  assert.notEqual(runSame.status, 0);
  fs.writeFileSync(path.join(source, 'occupied.txt'), 'x', 'utf8');
  const dest = path.join(source, 'sub');
  fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(path.join(dest, 'x'), '1', 'utf8');
  const runOccupied = spawnSync(
    process.execPath,
    ['tools/migrate-json-to-sqlite.mjs', '--source', source, '--destination', dest],
    { cwd: path.join(import.meta.dirname, '..'), encoding: 'utf8' },
  );
  assert.notEqual(runOccupied.status, 0);
  fs.rmSync(source, { recursive: true, force: true });
});

test('backup tool produces integrity-checked bundle and restores to new dir', async () => {
  const source = fs.mkdtempSync(path.join(os.tmpdir(), 'bn-bak-src-'));
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'bn-bak-dst-'));
  const restoreDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bn-bak-restore-'));
  try {
    fs.mkdirSync(path.join(source, 'images'), { recursive: true });
    fs.writeFileSync(path.join(source, 'images', 'pic.bin'), Buffer.from('blob'));
    const store = createStore(source);
    await store.mutate((s) => {
      s.settings.teacherDisplayName = 'B';
    });
    const sourceState = await store.read();
    await store.close();
    const sourceDbHash = hashFileSync(path.join(source, SQLITE_FILE));
    const sourceImageHash = hashFileSync(path.join(source, 'images', 'pic.bin'));

    const run = spawnSync(
      process.execPath,
      ['tools/backup-sqlite-data.mjs', '--source', source, '--destination', dest],
      { cwd: path.join(path.dirname(fileURLToPath(import.meta.url)), '..'), encoding: 'utf8' },
    );
    assert.equal(run.status, 0, run.stderr || run.stdout);
    assert.ok(fs.existsSync(path.join(dest, 'backup-complete.marker')));
    const manifest = JSON.parse(fs.readFileSync(path.join(dest, 'backup-manifest.json'), 'utf8'));

    fs.cpSync(dest, restoreDir, { recursive: true });
    const restored = createStore(restoreDir);
    const restoredState = await restored.read();
    assert.ok(statesLogicallyEqual(sourceState, restoredState));
    await restored.close();

    assert.equal(hashFileSync(path.join(restoreDir, 'images', 'pic.bin')), sourceImageHash);
    assert.deepEqual(manifest.files.images.find((f) => f.relative === 'pic.bin')?.sha256, sourceImageHash);
    assert.equal(hashFileSync(path.join(source, SQLITE_FILE)), sourceDbHash);
    const db = new DatabaseSync(path.join(restoreDir, SQLITE_FILE), { readOnly: true });
    const check = db.prepare('PRAGMA integrity_check').get();
    db.close();
    assert.equal(check.integrity_check, 'ok');
  } finally {
    closeAllOpenDatabasesForTests();
    fs.rmSync(source, { recursive: true, force: true });
    fs.rmSync(dest, { recursive: true, force: true });
    fs.rmSync(restoreDir, { recursive: true, force: true });
  }
});

test('/api/health does not leak secrets or paths', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bn-health-'));
  const { server, examStartupReady, shutdownServices, closeStore } = createServer({
    host: '127.0.0.1',
    dataDir,
    secureCookie: false,
  });
  await examStartupReady;
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const res = await fetch(`http://127.0.0.1:${port}/api/health`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.storage, 'ready');
  assert.ok(!('dataDir' in body));
  assert.ok(!('password' in body));
  shutdownServices();
  await new Promise((r) => server.close(() => r()));
  await closeStore();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('PUBLIC_ORIGIN enforces CSRF origin behind reverse proxy', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bn-origin-'));
  const publicOrigin = 'https://class.example.com';
  const { server, examStartupReady, shutdownServices, closeStore } = createServer({
    host: '127.0.0.1',
    dataDir,
    secureCookie: false,
    publicOrigin,
  });
  await examStartupReady;
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  let jar = {};
  const csrfRes = await fetch(`${base}/api/auth/csrf`);
  for (const line of csrfRes.headers.getSetCookie?.() || []) {
    const part = line.split(';')[0];
    const eq = part.indexOf('=');
    if (eq >= 0) jar[part.slice(0, eq)] = part.slice(eq + 1);
  }
  const bad = await fetch(`${base}/api/auth/setup`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: `bn_csrf=${jar.bn_csrf}`,
      'x-bn-csrf': jar.bn_csrf,
      origin: 'https://evil.example',
    },
    body: JSON.stringify({ username: 't', password: 'password123', displayName: 'X' }),
  });
  assert.equal(bad.status, 403);
  shutdownServices();
  await new Promise((r) => server.close(() => r()));
  await closeStore();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('createStore rejects pending migration markers', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bn-mig-pending-'));
  try {
    fs.writeFileSync(path.join(dataDir, MIGRATION_PENDING_MARKER), new Date().toISOString(), 'utf8');
    assert.throws(() => createStore(dataDir), /migration dở dang/i);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('createStore rejects sqlite without migration-complete when migration-source present', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bn-mig-nocomplete-'));
  try {
    const store = createStore(dataDir);
    await store.close();
    const backupDir = path.join(dataDir, MIGRATION_SOURCE_DIR);
    fs.mkdirSync(backupDir, { recursive: true });
    fs.writeFileSync(path.join(backupDir, STATE_FILE), '{}', 'utf8');
    assert.throws(() => createStore(dataDir), /migration-complete\.marker/i);
  } finally {
    await closeAllOpenDatabasesForTests();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('runSqliteTransaction rolls back failed write', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bn-tx-'));
  try {
    const store = createStore(dataDir);
    const db = store.getDatabaseHandle();
    await assert.rejects(
      () =>
        Promise.resolve().then(() => {
          runSqliteTransaction(db, () => {
            db.prepare('INSERT INTO singletons (name, payload_json) VALUES (?, ?)').run('meta', '{"x":1}');
            throw new Error('abort-tx');
          });
        }),
      /abort-tx/,
    );
    const row = db.prepare('SELECT COUNT(*) AS c FROM singletons').get();
    assert.equal(row.c, 0);
    await store.close();
  } finally {
    await closeAllOpenDatabasesForTests();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('async mutate interleaves with read under shared lock', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bn-read-mutate-'));
  try {
    const store = createStore(dataDir);
    const readPromise = store.read();
    const mutatePromise = store.mutate((s) => {
      s.settings.teacherDisplayName = 'Interleaved';
    });
    const [beforeMutate,] = await Promise.all([readPromise, mutatePromise]);
    assert.ok(beforeMutate);
    const after = await store.read();
    assert.equal(after.settings.teacherDisplayName, 'Interleaved');
    await store.close();
  } finally {
    await closeAllOpenDatabasesForTests();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('SETUP_TOKEN rejects loopback setup without header', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bn-setup-no-hdr-'));
  const token = 'unit-test-setup-token';
  const { server, examStartupReady, shutdownServices, closeStore } = createServer({
    host: '127.0.0.1',
    dataDir,
    secureCookie: false,
    setupToken: token,
  });
  try {
    await examStartupReady;
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    const base = `http://127.0.0.1:${port}`;
    const csrfRes = await fetch(`${base}/api/auth/csrf`);
    let jar = {};
    for (const line of csrfRes.headers.getSetCookie?.() || []) {
      const part = line.split(';')[0];
      const eq = part.indexOf('=');
      if (eq >= 0) jar[part.slice(0, eq)] = part.slice(eq + 1);
    }
    const missing = await fetch(`${base}/api/auth/setup`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: `bn_csrf=${jar.bn_csrf}`,
        'x-bn-csrf': jar.bn_csrf,
        origin: base,
      },
      body: JSON.stringify({ username: 'teacher1', password: 'password123', displayName: 'T' }),
    });
    assert.equal(missing.status, 403);
    const wrong = await fetch(`${base}/api/auth/setup`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: `bn_csrf=${jar.bn_csrf}`,
        'x-bn-csrf': jar.bn_csrf,
        'x-bn-setup-token': 'wrong-token',
        origin: base,
      },
      body: JSON.stringify({ username: 'teacher1', password: 'password123', displayName: 'T' }),
    });
    assert.equal(wrong.status, 403);
  } finally {
    shutdownServices();
    await new Promise((r) => server.close(() => r()));
    await closeStore();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('PUBLIC_ORIGIN without SETUP_TOKEN blocks setup when uninitialized', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bn-origin-notoken-'));
  const publicOrigin = 'https://class.example.com';
  const { server, examStartupReady, shutdownServices, closeStore } = createServer({
    host: '127.0.0.1',
    dataDir,
    secureCookie: false,
    publicOrigin,
  });
  try {
    await examStartupReady;
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    const base = `http://127.0.0.1:${port}`;
    const csrfRes = await fetch(`${base}/api/auth/csrf`);
    let jar = {};
    for (const line of csrfRes.headers.getSetCookie?.() || []) {
      const part = line.split(';')[0];
      const eq = part.indexOf('=');
      if (eq >= 0) jar[part.slice(0, eq)] = part.slice(eq + 1);
    }
    const res = await fetch(`${base}/api/auth/setup`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: `bn_csrf=${jar.bn_csrf}`,
        'x-bn-csrf': jar.bn_csrf,
        origin: publicOrigin,
      },
      body: JSON.stringify({ username: 't', password: 'password123', displayName: 'X' }),
    });
    assert.equal(res.status, 403);
  } finally {
    shutdownServices();
    await new Promise((r) => server.close(() => r()));
    await closeStore();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('SETUP_TOKEN accepts setup with matching header on server', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bn-setup-token-'));
  const token = 'unit-test-setup-token';
  const { server, examStartupReady, shutdownServices, closeStore } = createServer({
    host: '127.0.0.1',
    dataDir,
    secureCookie: false,
    setupToken: token,
  });
  try {
    await examStartupReady;
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    const base = `http://127.0.0.1:${port}`;
    const csrfRes = await fetch(`${base}/api/auth/csrf`);
    let jar = {};
    for (const line of csrfRes.headers.getSetCookie?.() || []) {
      const part = line.split(';')[0];
      const eq = part.indexOf('=');
      if (eq >= 0) jar[part.slice(0, eq)] = part.slice(eq + 1);
    }
    const setup = await fetch(`${base}/api/auth/setup`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: `bn_csrf=${jar.bn_csrf}`,
        'x-bn-csrf': jar.bn_csrf,
        'x-bn-setup-token': token,
        origin: base,
      },
      body: JSON.stringify({ username: 'teacher1', password: 'password123', displayName: 'T' }),
    });
    assert.equal(setup.status, 200);
  } finally {
    shutdownServices();
    await new Promise((r) => server.close(() => r()));
    await closeStore();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('listBinFilesHashes reads without copying files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bn-hash-only-'));
  try {
    fs.mkdirSync(path.join(dir, 'images'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'images', 'a.bin'), 'one');
    const before = hashFileSync(path.join(dir, 'images', 'a.bin'));
    const listed = listBinFilesHashes(dir, 'images');
    assert.equal(listed.length, 1);
    assert.equal(listed[0].sha256, before);
    assert.equal(hashFileSync(path.join(dir, 'images', 'a.bin')), before);
    const direct = hashDirectoryFiles(path.join(dir, 'images'));
    assert.equal(direct[0].sha256, before);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('json legacy backend explicit roundtrip', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bn-json-'));
  try {
    fs.writeFileSync(path.join(dataDir, STATE_FILE), JSON.stringify(emptyState()), 'utf8');
    const store = createStore(dataDir, { backend: 'json' });
    await store.mutate((s) => {
      s.settings.teacherDisplayName = 'JSON';
    });
    await store.close();
    const text = fs.readFileSync(path.join(dataDir, STATE_FILE), 'utf8');
    assert.ok(text.includes('JSON'));
    assert.ok(!fs.existsSync(path.join(dataDir, SQLITE_FILE)));
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
