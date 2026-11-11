import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeDisplayName,
  findDuplicateStudentName,
  findDuplicateClassName,
  waitForInFlightUploads,
  buildStudentPhotoUploadJobs,
  blobContentFingerprint,
} from '../dist/model.js';
import { createMinimalDomElement } from './helper-browser-window.mjs';

test('normalizeDisplayName collapses whitespace and case', () => {
  assert.equal(normalizeDisplayName('  Nguyễn   Văn A  '), 'nguyễn văn a');
});

test('duplicate student name in same class only', () => {
  const students = [
    { id: '1', name: 'Lan Anh', classId: 'c1' },
    { id: '2', name: '  lan   anh ', classId: 'c1' },
    { id: '3', name: 'Lan Anh', classId: 'c2' },
  ];
  assert.equal(findDuplicateStudentName(students, 'c1', 'Lan Anh', '9')?.id, '1');
  assert.equal(findDuplicateStudentName(students, 'c1', 'Lan Anh', '1')?.id, '2');
  assert.equal(findDuplicateStudentName(students, 'c2', 'Lan Anh', '9')?.id, '3');
});

test('duplicate class name detection', () => {
  const classes = [{ id: 'a', name: 'IELTS 6.5' }];
  assert.equal(findDuplicateClassName(classes, 'ielts 6.5')?.id, 'a');
});

test('waitForInFlightUploads uses shared production helper', async () => {
  let done = false;
  const job = (async () => {
    await new Promise((r) => setTimeout(r, 5));
    done = true;
  })();
  await waitForInFlightUploads(new Set([job]));
  assert.equal(done, true);
});

test('student photo ids stay in file order when uploads finish out of order', async () => {
  const files = [{ name: 'slow.jpg' }, { name: 'fast.jpg' }];
  const finishOrder = [];
  const pages = ['existing-page'];
  const batch = buildStudentPhotoUploadJobs(files, {
    validateFile: () => ({ ok: true }),
    prepareFile: async (file) => ({
      fingerprint: `fp-${file.name}`,
    }),
    uploadPrepared: async (prepared) => {
      const delayMs = prepared.fingerprint === 'fp-slow.jpg' ? 25 : 1;
      await new Promise((r) => setTimeout(r, delayMs));
      finishOrder.push(files.find((f) => `fp-${f.name}` === prepared.fingerprint)?.name);
      return `id-${prepared.fingerprint}`;
    },
    onFileError: () => {},
  });
  await batch.applyResultsTo(pages);
  assert.deepEqual(finishOrder, ['fast.jpg', 'slow.jpg']);
  assert.deepEqual(pages, ['existing-page', 'id-fp-slow.jpg', 'id-fp-fast.jpg']);
});

test('student photo upload skips duplicate content in batch and reserved set', async () => {
  const reserved = new Set(['fp-dup']);
  const duplicates = [];
  const pages = ['page-a'];
  const bytes = new Uint8Array([1, 2, 3]);
  const mkFile = (name) => ({
    name,
    arrayBuffer: async () => bytes.buffer,
  });
  const batch = buildStudentPhotoUploadJobs([mkFile('a.jpg'), mkFile('b.jpg')], {
    validateFile: () => ({ ok: true }),
    prepareFile: async () => ({ fingerprint: 'fp-dup' }),
    uploadPrepared: async () => 'should-not-run',
    reservedFingerprints: reserved,
    onDuplicateFile: (file) => duplicates.push(file.name),
    onFileError: () => {},
  });
  await batch.applyResultsTo(pages);
  assert.deepEqual(duplicates, ['a.jpg', 'b.jpg']);
  assert.deepEqual(pages, ['page-a']);
  assert.equal(reserved.size, 1);
});

test('student photo failed upload releases fingerprint reservation for retry', async () => {
  const reserved = new Set();
  let attempts = 0;
  const file = { name: 'once.jpg' };
  const pages = [];
  const batch = buildStudentPhotoUploadJobs([file], {
    validateFile: () => ({ ok: true }),
    prepareFile: async () => ({ fingerprint: 'fp-once' }),
    uploadPrepared: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('network');
      return 'img-1';
    },
    reservedFingerprints: reserved,
    onFileError: () => {},
  });
  await batch.applyResultsTo(pages);
  assert.equal(pages.length, 0);
  assert.equal(reserved.has('fp-once'), false);
  const retry = buildStudentPhotoUploadJobs([file], {
    validateFile: () => ({ ok: true }),
    prepareFile: async () => ({ fingerprint: 'fp-once' }),
    uploadPrepared: async () => 'img-1',
    reservedFingerprints: reserved,
    onFileError: () => {},
  });
  await retry.applyResultsTo(pages);
  assert.deepEqual(pages, ['img-1']);
});

test('blobContentFingerprint hashes bytes deterministically', async () => {
  const blob = { size: 3, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
  const a = await blobContentFingerprint(blob);
  const b = await blobContentFingerprint(blob);
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{64}$/);
});

test('minimal DOM querySelectorAll splits comma groups before descendant combinators', () => {
  const root = createMinimalDomElement('div');
  const inp = createMinimalDomElement('input', { type: 'text' });
  const wrap = createMinimalDomElement('div', { className: 'wrap' });
  const ta = createMinimalDomElement('textarea');
  root.appendChild(inp);
  wrap.appendChild(ta);
  root.appendChild(wrap);
  const both = root.querySelectorAll('input, textarea');
  assert.equal(both.length, 2);
  assert.ok(both.some((n) => n.tagName === 'INPUT'));
  assert.ok(both.some((n) => n.tagName === 'TEXTAREA'));
  const mixed = root.querySelectorAll('input, .wrap textarea');
  assert.equal(mixed.length, 2);
});

test('minimal DOM classList.contains mirrors className and setAttribute(class)', () => {
  const el = createMinimalDomElement('button', { className: 'a b' });
  assert.equal(el.classList.contains('a'), true);
  assert.equal(el.classList.contains('c'), false);
  el.classList.add('c');
  assert.equal(el.classList.contains('c'), true);
  assert.match(String(el.className), /\bc\b/);
  el.setAttribute('class', 'x');
  assert.equal(el.classList.contains('x'), true);
  assert.equal(el.classList.contains('a'), false);
});
