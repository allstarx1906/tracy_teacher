/**
 * Student photo draft page list vs last server-acknowledged snapshot (persist capture tokens).
 */

/**
 * @param {string[]} [initialAckPageIds]
 */
export function createStudentPhotoDraftAckState(initialAckPageIds = []) {
  /** @type {string[]} */
  let ackPageIds = [...initialAckPageIds];
  let captureSequence = 0;
  /** @type {{ sequence: number, pageIds: string[] } | null} */
  let inFlightCapture = null;

  function isPagesDirty(pageIds) {
    if (pageIds.length !== ackPageIds.length) return true;
    return pageIds.some((id, i) => id !== ackPageIds[i]);
  }

  /**
   * @param {string[]} pageIds snapshot at persist attempt
   * @returns {{ sequence: number, pageIds: string[] }}
   */
  function captureForPersist(pageIds) {
    captureSequence += 1;
    const token = Object.freeze({
      sequence: captureSequence,
      pageIds: [...pageIds],
    });
    inFlightCapture = token;
    return token;
  }

  /**
   * @param {{ sequence: number, pageIds: string[] }} token
   */
  function markAcknowledgedFromCapture(token) {
    if (!token || !inFlightCapture) return;
    if (token.sequence !== inFlightCapture.sequence) return;
    ackPageIds = [...token.pageIds];
    inFlightCapture = null;
  }

  function syncAckBaselineTo(pageIds) {
    ackPageIds = [...pageIds];
    inFlightCapture = null;
  }

  function getAckPageIds() {
    return [...ackPageIds];
  }

  return {
    isPagesDirty,
    captureForPersist,
    markAcknowledgedFromCapture,
    syncAckBaselineTo,
    getAckPageIds,
  };
}
