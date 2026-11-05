#!/usr/bin/env node
/** Read-only export of logical state JSON from app.sqlite (for local comparison). */
import fs from 'node:fs';
import path from 'node:path';
import { SQLITE_FILE } from '../server/store-state.mjs';
import { createSqliteStore } from '../server/store-sqlite.mjs';
import { stableStringify } from '../server/store-state.mjs';
import { resolveSafeDataPath } from '../server/store-fs-utils.mjs';

function printHelp() {
  console.log(`Usage:
  node tools/export-sqlite-state.mjs --source <dataDir> [--out snapshot.json]

Prints normalized state JSON to stdout or --out file. Read-only.
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
  if (!fs.existsSync(path.join(source, SQLITE_FILE))) {
    throw new Error(`Missing ${SQLITE_FILE}`);
  }
  const store = createSqliteStore(source, { createIfMissing: false });
  const state = store.loadSync();
  await store.close();
  const text = stableStringify(state);
  const outPath = args.out ? String(args.out) : null;
  if (outPath) {
    fs.writeFileSync(outPath, text, 'utf8');
    console.log('Wrote', outPath);
  } else {
    console.log(text);
  }
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
