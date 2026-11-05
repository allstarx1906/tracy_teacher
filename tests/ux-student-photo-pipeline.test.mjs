import test from 'node:test';
import assert from 'node:assert/strict';
import { buildStudentPhotoUploadJobs } from '../dist/model.js';
import {
  captureStudentPhotoInitiatingContext,
  isStudentPhotoInitiatingContextStale,
} from '../dist/ux-student-photo-pipeline.js';

function makeLiveView(assignmentId, viewGeneration) {
  return { assignmentId, viewGeneration };
}

test('deferred compression with auth change skips upload POST and draft append', async () => {
  let epoch = 1;
  let principal = 'student:a';
  let liveView = makeLiveView('asg-a', 1);
  let uploadCalls = 0;
  const pages = ['baseline'];
  let releasePrep;
  const prepGate = new Promise((resolve) => { releasePrep = resolve; });

  const ctx = captureStudentPhotoInitiatingContext({
    getRequestEpoch: () => epoch,
    getAuthPrincipal: () => principal,
    assignmentId: 'asg-a',
    viewGeneration: 1,
    isViewLive: () => true,
  });
  const stale = (c) => isStudentPhotoInitiatingContextStale(c, {
    isStaleEpoch: (e) => e !== epoch,
    getAuthPrincipal: () => principal,
    liveView,
  });

  const batch = buildStudentPhotoUploadJobs([{ name: 'photo.jpg' }], {
    initiatingContext: ctx,
    isInitiatingContextStale: stale,
    validateFile: () => ({ ok: true }),
    prepareFile: async () => {
      await prepGate;
      return { fingerprint: 'fp-photo' };
    },
    uploadPrepared: async () => {
      uploadCalls += 1;
      return 'img-new';
    },
    onFileError: () => {},
  });

  epoch = 2;
  principal = 'student:b';
  releasePrep();
  await batch.applyResultsTo(pages);

  assert.equal(uploadCalls, 0, 'stale principal must not upload under B');
  assert.deepEqual(pages, ['baseline'], 'stale job must not append page ids');
});

test('navigate to assignment B while A prep pending skips append and upload', async () => {
  let liveView = makeLiveView('asg-a', 1);
  let uploadCalls = 0;
  const pages = ['baseline'];
  let releasePrep;
  const prepGate = new Promise((resolve) => { releasePrep = resolve; });

  const ctx = captureStudentPhotoInitiatingContext({
    getRequestEpoch: () => 1,
    getAuthPrincipal: () => 'student:s',
    assignmentId: 'asg-a',
    viewGeneration: 1,
    isViewLive: () => true,
  });
  const stale = (c) => isStudentPhotoInitiatingContextStale(c, {
    isStaleEpoch: () => false,
    getAuthPrincipal: () => 'student:s',
    liveView,
  });

  const batch = buildStudentPhotoUploadJobs([{ name: 'photo.jpg' }], {
    initiatingContext: ctx,
    isInitiatingContextStale: stale,
    validateFile: () => ({ ok: true }),
    prepareFile: async () => {
      await prepGate;
      return { fingerprint: 'fp-photo' };
    },
    uploadPrepared: async () => {
      uploadCalls += 1;
      return 'img-new';
    },
    onFileError: () => {},
  });

  liveView = makeLiveView('asg-b', 2);
  releasePrep();
  await batch.applyResultsTo(pages);

  assert.equal(uploadCalls, 0);
  assert.deepEqual(pages, ['baseline']);
});

test('same initiating identity after deferred prep performs one ordered upload', async () => {
  let epoch = 3;
  const principal = 'student:keep';
  const liveView = makeLiveView('asg-x', 5);
  const pages = [];
  let releasePrep;
  const prepGate = new Promise((resolve) => { releasePrep = resolve; });

  const ctx = captureStudentPhotoInitiatingContext({
    getRequestEpoch: () => epoch,
    getAuthPrincipal: () => principal,
    assignmentId: 'asg-x',
    viewGeneration: 5,
    isViewLive: () => true,
  });
  const stale = (c) => isStudentPhotoInitiatingContextStale(c, {
    isStaleEpoch: (e) => e !== epoch,
    getAuthPrincipal: () => principal,
    liveView,
  });

  const batch = buildStudentPhotoUploadJobs([{ name: 'x.jpg' }], {
    initiatingContext: ctx,
    isInitiatingContextStale: stale,
    validateFile: () => ({ ok: true }),
    prepareFile: async () => {
      await prepGate;
      return { fingerprint: 'fp-x' };
    },
    uploadPrepared: async () => 'id-x',
    onFileError: () => {},
  });

  releasePrep();
  await batch.applyResultsTo(pages);
  assert.deepEqual(pages, ['id-x']);
});

test('disconnected edit host after prep skips append without upload', async () => {
  const host = { isConnected: true };
  let uploadCalls = 0;
  const liveView = makeLiveView('asg-y', 1);
  const ctx = captureStudentPhotoInitiatingContext({
    getRequestEpoch: () => 1,
    getAuthPrincipal: () => 'student:v',
    assignmentId: 'asg-y',
    viewGeneration: 1,
    isViewLive: () => host.isConnected,
  });
  const stale = (c) => isStudentPhotoInitiatingContextStale(c, {
    isStaleEpoch: () => false,
    getAuthPrincipal: () => 'student:v',
    liveView,
  });

  const batch = buildStudentPhotoUploadJobs([{ name: 'y.jpg' }], {
    initiatingContext: ctx,
    isInitiatingContextStale: stale,
    validateFile: () => ({ ok: true }),
    prepareFile: async () => {
      host.isConnected = false;
      return { fingerprint: 'fp-y' };
    },
    uploadPrepared: async () => {
      uploadCalls += 1;
      return 'id-y';
    },
    onFileError: () => {},
  });

  const pages = [];
  await batch.applyResultsTo(pages);
  assert.equal(uploadCalls, 0);
  assert.deepEqual(pages, []);
});

test('awaiting baseline fingerprint reservation dedupes same content without duplicate pages', async () => {
  const knownFp = 'fp-existing-content';
  const reserved = new Set();
  let releaseBaseline;
  const baselineGate = new Promise((resolve) => { releaseBaseline = resolve; });

  const baselinePrep = (async () => {
    reserved.add(await baselineGate);
  })();

  const pages = ['saved-page-id'];
  let uploadCalls = 0;
  let duplicateNotices = 0;
  const ctx = captureStudentPhotoInitiatingContext({
    getRequestEpoch: () => 1,
    getAuthPrincipal: () => 'student:s',
    assignmentId: 'asg-dedupe',
    viewGeneration: 1,
    isViewLive: () => true,
  });
  const stale = (c) => isStudentPhotoInitiatingContextStale(c, {
    isStaleEpoch: () => false,
    getAuthPrincipal: () => 'student:s',
    liveView: makeLiveView('asg-dedupe', 1),
  });

  const selection = (async () => {
    await baselinePrep;
    const batch = buildStudentPhotoUploadJobs([{ name: 'same-content.jpg' }], {
      initiatingContext: ctx,
      isInitiatingContextStale: stale,
      validateFile: () => ({ ok: true }),
      reservedFingerprints: reserved,
      onDuplicateFile: () => { duplicateNotices += 1; },
      prepareFile: async () => ({ fingerprint: knownFp }),
      uploadPrepared: async () => {
        uploadCalls += 1;
        return 'new-id';
      },
      onFileError: () => {},
    });
    await batch.applyResultsTo(pages);
  })();

  releaseBaseline(knownFp);
  await selection;

  assert.equal(uploadCalls, 0, 'duplicate content must not upload again');
  assert.equal(duplicateNotices, 1);
  assert.deepEqual(pages, ['saved-page-id']);
});
