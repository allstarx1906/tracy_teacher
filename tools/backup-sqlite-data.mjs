#!/usr/bin/env node
/**
 * Full backup: SQLite snapshot + images/ + attachments/ into a new directory.
 * Stop the server before running for a consistent bundle.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import {
  SQLITE_FILE,
  IMAGES_DIR,
  ATTACHMENTS_DIR,
} from '../server/store-state.mjs';
import {
  resolveSafeDataPath,
  assertEmptyDestinationDir,
  assertDistinctPaths,
  assertNotSymlinkDir,
  assertNoSymlinkAncestorSegments,
  copyDirectoryFiles,
  hashFileSync,
} from '../server/store-fs-utils.mjs';

function printHelp() {
  console.log(`Usage:
  node tools/backup-sqlite-data.mjs --source <dataDirWithAppSqlite> --destination <newEmptyDir>

Requires the app to be stopped. Creates a consistent SQLite backup (online backup API),
copies images/ and attachments/, runs integrity_check, writes backup-manifest.json.
Does not delete source files (no --force).

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

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    printHelp();
    return;
  }

  const source = resolveSafeDataPath(String(args.source || ''), '--source');
  const destination = assertEmptyDestinationDir(String(args.destination || ''));
  assertDistinctPaths(source, destination);
  assertNotSymlinkDir(source, 'Source');
  assertNoSymlinkAncestorSegments(destination, 'Destination');

  const sqlitePath = path.join(source, SQLITE_FILE);
  if (!fs.existsSync(sqlitePath)) {
    throw new Error(`Source missing ${SQLITE_FILE}; use migration tool for JSON stores`);
  }

  fs.mkdirSync(path.join(destination, IMAGES_DIR), { recursive: true });
  fs.mkdirSync(path.join(destination, ATTACHMENTS_DIR), { recursive: true });

  const sourceImages = path.join(source, IMAGES_DIR);
  const sourceAttachments = path.join(source, ATTACHMENTS_DIR);
  if (fs.existsSync(sourceImages)) assertNotSymlinkDir(sourceImages, 'Source images');
  if (fs.existsSync(sourceAttachments)) assertNotSymlinkDir(sourceAttachments, 'Source attachments');

  const destDbPath = path.join(destination, SQLITE_FILE);
  const sourceDb = new DatabaseSync(sqlitePath, { readOnly: true });
  try {
    sourceDb.exec('PRAGMA wal_checkpoint(FULL);');
  } finally {
    sourceDb.close();
  }

  if (typeof DatabaseSync.prototype.backup === 'function') {
    const live = new DatabaseSync(sqlitePath, { readOnly: true });
    const destDb = new DatabaseSync(destDbPath);
    try {
      const backup = live.backup(destDb);
      if (backup?.step) backup.step(-1);
      backup?.close?.();
    } finally {
      live.close();
      destDb.close();
    }
  } else {
    fs.copyFileSync(sqlitePath, destDbPath);
  }

  const destDb = new DatabaseSync(destDbPath, { readOnly: true });
  const check = destDb.prepare('PRAGMA integrity_check').get();
  destDb.close();
  if (!check || check.integrity_check !== 'ok') {
    try {
      fs.writeFileSync(
        path.join(destination, 'backup-incomplete.marker'),
        JSON.stringify(
          { at: new Date().toISOString(), error: `integrity_check: ${JSON.stringify(check)}` },
          null,
          2,
        ),
        'utf8',
      );
    } catch {
      /* ignore */
    }
    throw new Error(`integrity_check failed: ${JSON.stringify(check)}`);
  }

  const images = copyDirectoryFiles(sourceImages, path.join(destination, IMAGES_DIR));
  const attachments = copyDirectoryFiles(
    sourceAttachments,
    path.join(destination, ATTACHMENTS_DIR),
  );

  const manifest = {
    completedAt: new Date().toISOString(),
    sourcePath: source,
    destinationPath: destination,
    databaseSha256: hashFileSync(destDbPath),
    files: { images, attachments },
  };
  fs.writeFileSync(path.join(destination, 'backup-manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  fs.writeFileSync(path.join(destination, 'backup-complete.marker'), manifest.completedAt, 'utf8');

  console.log('Backup OK:', destination);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
