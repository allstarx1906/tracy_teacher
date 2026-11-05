import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dockerfile = fs.readFileSync(path.join(repoRoot, 'Dockerfile'), 'utf8');

test('Dockerfile uses official node user (no duplicate uid 1000 groupadd)', () => {
  assert.match(dockerfile, /FROM node:24\.16\.0-bookworm-slim/);
  assert.doesNotMatch(dockerfile, /groupadd\s+-g\s+1000/);
  assert.doesNotMatch(dockerfile, /useradd\s+-u\s+1000/);
  assert.doesNotMatch(dockerfile, /nodeapp/);
  assert.match(dockerfile, /chown\s+-R\s+node:node/);
  assert.match(dockerfile, /^USER node/m);
});

test('Dockerfile copies migration/backup CLI tools into image', () => {
  assert.match(dockerfile, /COPY tools \.\/tools/);
  for (const rel of [
    'tools/migrate-json-to-sqlite.mjs',
    'tools/backup-sqlite-data.mjs',
    'tools/export-sqlite-state.mjs',
  ]) {
    assert.ok(fs.existsSync(path.join(repoRoot, rel)), `missing ${rel}`);
  }
});
