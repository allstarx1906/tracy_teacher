import test from 'node:test';
import assert from 'node:assert/strict';
import { parseExamRoute, EXAM_NAV_ITEM, gradeAttempt } from '../dist/exam-domain.js';

test('parseExamRoute recognizes student take path', () => {
  const r = parseExamRoute(['exams', 'take', 'abc']);
  assert.equal(r.view, 'exams-take');
  assert.equal(r.assignmentId, 'abc');
});

test('EXAM_NAV_ITEM visible for teacher and student', () => {
  assert.ok(EXAM_NAV_ITEM.teacher);
  assert.ok(EXAM_NAV_ITEM.student);
});

test('gradeAttempt weights points', () => {
  const version = {
    questions: [
      { id: 'q1', correctOptionId: 'A', points: 2, options: [{ id: 'A' }, { id: 'B' }] },
      { id: 'q2', correctOptionId: 'B', points: 1, options: [{ id: 'A' }, { id: 'B' }] },
    ],
  };
  const graded = gradeAttempt(version, { q1: 'A', q2: 'A' });
  assert.equal(graded.earnedPoints, 2);
  assert.equal(graded.score10, 6.67);
});
