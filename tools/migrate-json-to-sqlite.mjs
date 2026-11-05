#!/usr/bin/env node
/**
 * Offline migration: JSON state.json + blobs -> new directory with SQLite (app.sqlite).
 * Source must not have a running writer. Never modifies the source directory.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  STATE_FILE,
  IMAGES_DIR,
  ATTACHMENTS_DIR,
  statesLogicallyEqual,
  stateEntityCounts,
  normalizeState,
} from '../server/store-state.mjs';
import { createSqliteStore } from '../server/store-sqlite.mjs';
import { importJsonStateToDb } from '../server/store-sqlite-schema.mjs';
import {
  MIGRATION_PENDING_MARKER,
  MIGRATION_COMPLETE_MARKER,
  MIGRATION_INCOMPLETE_MARKER,
  MIGRATION_SOURCE_DIR,
} from '../server/store-migration-markers.mjs';
import {
  resolveSafeDataPath,
  assertEmptyDestinationDir,
  assertDistinctPaths,
  assertNotSymlinkDir,
  assertNoSymlinkAncestorSegments,
  hashUtf8,
  hashFileSync,
  readFileHashIfExists,
  copyDirectoryFiles,
} from '../server/store-fs-utils.mjs';

function printHelp() {
  console.log(`Usage:
  node tools/migrate-json-to-sqlite.mjs --source <existingDataDir> --destination <newEmptyDir>

Offline only — stop the app before migrating. Copies images/ and attachments/, imports state into
app.sqlite in the destination, verifies integrity, and writes migration-source/ backup + manifest.
Does not delete or modify the source tree. On failure the destination may remain partial
(migration-pending / migration-incomplete markers) for manual recovery — nothing is auto-deleted.

Options:
  --help    Show this help
`);
}

function parseArgs(argv) {
  /** @type {Record<string, string|boolean>} */
  const out = {};
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') {
      out.help = true;
      continue;
    }
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const val = argv[i + 1];
      if (!val || val.startsWith('--')) throw new Error(`Missing value for ${a}`);
      out[key] = val;
      i += 1;
    }
  }
  return out;
}

/**
 * @param {string} destination
 * @param {unknown} err
 */
function flagMigrationIncomplete(destination, err) {
  const message = err instanceof Error ? err.message : String(err);
  try {
    fs.writeFileSync(
      path.join(destination, MIGRATION_INCOMPLETE_MARKER),
      JSON.stringify({ at: new Date().toISOString(), error: message }, null, 2),
      'utf8',
    );
  } catch {
    /* ignore */
  }
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    printHelp();
    return;
  }

  if (!args.source || !args.destination) {
    throw new Error('Both --source and --destination are required');
  }

  const source = resolveSafeDataPath(String(args.source), '--source');
  const destination = assertEmptyDestinationDir(String(args.destination));
  assertDistinctPaths(source, destination);
  assertNotSymlinkDir(destination, 'Destination');
  assertNoSymlinkAncestorSegments(destination, 'Destination');

  const statePath = path.join(source, STATE_FILE);
  if (!fs.existsSync(statePath)) {
    throw new Error(`Source missing ${STATE_FILE}; nothing to migrate`);
  }

  const sourceStat = fs.lstatSync(statePath);
  if (sourceStat.isSymbolicLink()) {
    throw new Error('Source state.json must not be a symlink');
  }

  const rawText = fs.readFileSync(statePath, 'utf8');
  const sourceStateHash = hashUtf8(rawText);
  let rawJson;
  try {
    rawJson = JSON.parse(rawText);
  } catch {
    throw new Error('Source state.json is not valid JSON');
  }
  if (!rawJson || typeof rawJson !== 'object' || Array.isArray(rawJson)) {
    throw new Error('Source state.json must be a JSON object');
  }

  const normalizedSource = normalizeState(structuredClone(rawJson));

  fs.writeFileSync(path.join(destination, MIGRATION_PENDING_MARKER), new Date().toISOString(), 'utf8');

  fs.mkdirSync(path.join(destination, IMAGES_DIR), { recursive: true });
  fs.mkdirSync(path.join(destination, ATTACHMENTS_DIR), { recursive: true });

  const sourceImages = path.join(source, IMAGES_DIR);
  const sourceAttachments = path.join(source, ATTACHMENTS_DIR);
  if (fs.existsSync(sourceImages)) assertNotSymlinkDir(sourceImages, 'Source images');
  if (fs.existsSync(sourceAttachments)) assertNotSymlinkDir(sourceAttachments, 'Source attachments');

  const imageManifest = copyDirectoryFiles(sourceImages, path.join(destination, IMAGES_DIR));
  const attachmentManifest = copyDirectoryFiles(
    sourceAttachments,
    path.join(destination, ATTACHMENTS_DIR),
  );

  const backupDir = path.join(destination, MIGRATION_SOURCE_DIR);
  fs.mkdirSync(backupDir, { recursive: true });
  fs.copyFileSync(statePath, path.join(backupDir, STATE_FILE));
  const backupHash = hashFileSync(path.join(backupDir, STATE_FILE));
  if (backupHash !== sourceStateHash) {
    flagMigrationIncomplete(destination, new Error('Backup copy hash mismatch'));
    throw new Error('Backup copy hash mismatch');
  }

  /** @type {import('../server/store-sqlite.mjs').ReturnType<typeof createSqliteStore>|null} */
  let store = null;
  try {
    store = createSqliteStore(destination, { ignorePartialMigrationMarkers: true });
    const db = store.getDatabaseHandle();
    importJsonStateToDb(db, rawJson);

    const loaded = store.loadSync();
    if (!statesLogicallyEqual(normalizedSource, loaded)) {
      throw new Error('Post-import state does not match source after normalization');
    }

    const integrity = db.prepare('PRAGMA integrity_check').get();
    if (!integrity || integrity.integrity_check !== 'ok') {
      throw new Error(`SQLite integrity_check failed: ${JSON.stringify(integrity)}`);
    }

    const finalBackupHash = hashFileSync(path.join(backupDir, STATE_FILE));
    if (finalBackupHash !== sourceStateHash) {
      throw new Error('Final migration-source state.json hash does not match source');
    }

    const originalHashNow = readFileHashIfExists(statePath);
    if (originalHashNow !== sourceStateHash) {
      throw new Error('Source state.json changed during migration; refusing to mark complete');
    }

    const manifest = {
      completedAt: new Date().toISOString(),
      sourcePath: source,
      destinationPath: destination,
      sourceStateSha256: sourceStateHash,
      backupStateSha256: finalBackupHash,
      entityCounts: stateEntityCounts(loaded),
      files: {
        images: imageManifest,
        attachments: attachmentManifest,
      },
      notes: 'Manifest contains counts and hashes only — no credential fields.',
    };

    fs.writeFileSync(path.join(destination, 'migration-manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
    fs.writeFileSync(path.join(destination, MIGRATION_COMPLETE_MARKER), manifest.completedAt, 'utf8');
    try {
      fs.unlinkSync(path.join(destination, MIGRATION_PENDING_MARKER));
    } catch {
      /* ignore */
    }
    try {
      fs.unlinkSync(path.join(destination, MIGRATION_INCOMPLETE_MARKER));
    } catch {
      /* ignore */
    }

    await store.close();
    store = null;
    console.log('Migration OK:', destination);
    console.log('Verify migration-manifest.json then point DATA_DIR to the new directory when cutting over.');
  } catch (e) {
    if (store) {
      await store.close();
    }
    flagMigrationIncomplete(destination, e);
    throw e;
  }
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
