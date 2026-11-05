/**
 * App hash navigation: same-route no-op and canceled back/forward restore without re-render.
 */

export function normalizeAppHash(hash) {
  const trimmed = hash == null ? '' : String(hash).trim();
  if (!trimmed || trimmed === '#') {
    return '#/dashboard';
  }
  let path = trimmed.startsWith('#') ? trimmed.slice(1) : trimmed;
  if (!path || path === '/') {
    return '#/dashboard';
  }
  if (!path.startsWith('/')) {
    path = `/${path}`;
  }
  return `#${path}`;
}

/**
 * @param {string} [initialHash]
 */
export function createAppHashNavigation(initialHash) {
  let allowedAppHash = normalizeAppHash(initialHash);
  let suppressHashDirtyConfirm = false;
  let hashRestoreTransitionIgnores = 0;

  return {
    getAllowedAppHash() {
      return allowedAppHash;
    },

    isSameRouteNavigate(targetHash, locationHash) {
      return normalizeAppHash(targetHash) === normalizeAppHash(locationHash);
    },

    prepareAcceptedNavigate(targetHash) {
      const target = normalizeAppHash(targetHash);
      allowedAppHash = target;
      suppressHashDirtyConfirm = true;
      return { target };
    },

    beginRestoreCanceledNavigation(locationHash) {
      hashRestoreTransitionIgnores += 1;
      suppressHashDirtyConfirm = true;
      if (normalizeAppHash(locationHash) !== allowedAppHash) {
        return { action: 'set-hash', hash: allowedAppHash };
      }
      hashRestoreTransitionIgnores = Math.max(0, hashRestoreTransitionIgnores - 1);
      return { action: 'noop' };
    },

    /**
     * @param {string} nextHash
     * @param {{ isDirty: () => boolean, confirmDiscard: () => boolean }} guards
     */
    planHashChange(nextHash, guards) {
      const next = normalizeAppHash(nextHash);

      if (suppressHashDirtyConfirm || hashRestoreTransitionIgnores > 0) {
        const restoringCanceledNavigation = hashRestoreTransitionIgnores > 0;
        suppressHashDirtyConfirm = false;
        if (hashRestoreTransitionIgnores > 0) {
          hashRestoreTransitionIgnores -= 1;
        }
        allowedAppHash = next;
        if (restoringCanceledNavigation) {
          return { kind: 'canceled-restore-noop' };
        }
        return { kind: 'suppress-bypass', disposeModals: true };
      }

      if (guards.isDirty() && !guards.confirmDiscard()) {
        return { kind: 'reject-restore' };
      }

      allowedAppHash = next;
      return { kind: 'accept', disposeModals: true };
    },
  };
}
