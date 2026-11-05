import { migrateLegacyMemberships } from '../dist/ba-domain.js';

export function normalizeBaState(state) {
  migrateLegacyMemberships(state);
  if (!state.meta.baVersion) state.meta.baVersion = 1;
  return state;
}
