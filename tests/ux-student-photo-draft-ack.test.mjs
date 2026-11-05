import test from 'node:test';
import assert from 'node:assert/strict';
import { createStudentPhotoDraftAckState } from '../dist/ux-student-photo-draft-ack.js';

test('draft persist ack marks only captured snapshot clean', () => {
  const ack = createStudentPhotoDraftAckState([]);
  const pages = ['p1'];
  const token = ack.captureForPersist(pages);
  assert.equal(ack.isPagesDirty(pages), true);
  ack.markAcknowledgedFromCapture(token);
  assert.deepEqual(ack.getAckPageIds(), ['p1']);
  assert.equal(ack.isPagesDirty(pages), false);
});

test('late ack of superseded draft capture does not regress newer baseline', () => {
  const ack = createStudentPhotoDraftAckState([]);
  const tokenA = ack.captureForPersist(['p1']);
  const tokenB = ack.captureForPersist(['p1', 'p2']);
  ack.markAcknowledgedFromCapture(tokenA);
  assert.deepEqual(ack.getAckPageIds(), []);
  assert.equal(ack.isPagesDirty(['p1', 'p2']), true);
  ack.markAcknowledgedFromCapture(tokenB);
  assert.deepEqual(ack.getAckPageIds(), ['p1', 'p2']);
  ack.markAcknowledgedFromCapture(tokenA);
  assert.deepEqual(ack.getAckPageIds(), ['p1', 'p2']);
});
