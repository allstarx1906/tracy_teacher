/**
 * Grading editor dirty state vs last server-acknowledged snapshot (score, feedback, annotations).
 */

import { replayPayloadSignature } from './ux-persist.js';

/** Canonical score string for dirty comparisons (aligns with validated numeric grades). */
export function normalizeGradingScore(score) {
  if (score === null || score === undefined || score === '') return '';
  const n = Number(score);
  if (!Number.isFinite(n)) return String(score);
  return String(Math.round(n * 10) / 10);
}

export function gradingDraftAnnotationsSignature(draft) {
  return replayPayloadSignature({
    pages: draft.pages,
  });
}

/** Pages-only payload signature; score and feedback are compared independently. */
export function gradingDraftBodySignature(draft) {
  return gradingDraftAnnotationsSignature(draft);
}

export function gradingWriteResourceKey(submissionId, versionId) {
  return `submission:${submissionId}:${versionId}`;
}

/**
 * @param {{ score?: string|number, overallFeedback?: string, pages: object[] }} initialDraft
 */
export function createGradingDirtyTracker(initialDraft) {
  let ackAnnotationsSignature = gradingDraftAnnotationsSignature(initialDraft);
  let ackScore = normalizeGradingScore(initialDraft.score);
  let ackFeedback = String(initialDraft.overallFeedback ?? '');
  let captureSequence = 0;
  /** @type {{ sequence: number, annotationsSignature: string, score: string, feedback: string } | null} */
  let inFlightCapture = null;

  /**
   * @param {object} draft
   * @param {string|number} score UI score at persist time
   * @param {string} feedback UI feedback at persist time
   * @returns {{ sequence: number, annotationsSignature: string, score: string, feedback: string }}
   */
  function captureForPersist(draft, score, feedback) {
    captureSequence += 1;
    const token = Object.freeze({
      sequence: captureSequence,
      annotationsSignature: gradingDraftAnnotationsSignature(draft),
      score: normalizeGradingScore(score),
      feedback: String(feedback ?? ''),
    });
    inFlightCapture = token;
    return token;
  }

  /**
   * @param {{ sequence: number, annotationsSignature: string, score: string, feedback: string }} token
   */
  function markAcknowledgedFromCapture(token) {
    if (!token || !inFlightCapture) return;
    if (token.sequence !== inFlightCapture.sequence) return;
    ackAnnotationsSignature = token.annotationsSignature;
    ackScore = token.score;
    ackFeedback = token.feedback;
    inFlightCapture = null;
  }

  function markAcknowledgedFromSnapshot(draft, score, feedback) {
    ackAnnotationsSignature = gradingDraftAnnotationsSignature(draft);
    ackScore = normalizeGradingScore(score);
    ackFeedback = String(feedback ?? '');
    inFlightCapture = null;
  }

  function hasLiveGestures(session) {
    if (!session) return false;
    return !!(
      session.penGesture ||
      session.eraserGesture ||
      session.drag ||
      session.inlineTextEditor
    );
  }

  /**
   * @param {object} ctx
   * @param {() => string} ctx.getScore
   * @param {() => string} ctx.getFeedback
   * @param {() => object} ctx.getDraft
   * @param {() => object} ctx.getSession
   * @param {() => boolean} [ctx.hasPendingSave]
   */
  function isDirty(ctx) {
    if (ctx.hasPendingSave?.()) return true;
    if (hasLiveGestures(ctx.getSession())) return true;
    if (normalizeGradingScore(ctx.getScore()) !== ackScore) return true;
    if (String(ctx.getFeedback()) !== ackFeedback) return true;
    return gradingDraftAnnotationsSignature(ctx.getDraft()) !== ackAnnotationsSignature;
  }

  return {
    captureForPersist,
    markAcknowledgedFromCapture,
    markAcknowledgedFromSnapshot,
    isDirty,
    hasLiveGestures,
  };
}
