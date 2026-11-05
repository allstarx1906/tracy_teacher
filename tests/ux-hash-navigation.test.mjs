import test from 'node:test';
import assert from 'node:assert/strict';
import { createAppHashNavigation, normalizeAppHash } from '../dist/ux-hash-navigation.js';

test('normalizeAppHash canonicalizes accounts route variants', () => {
  const canonical = '#/accounts';
  for (const variant of ['accounts', '/accounts', '#accounts', '#/accounts']) {
    assert.equal(normalizeAppHash(variant), canonical);
  }
});

test('normalizeAppHash defaults empty hash to dashboard like parseRoute', () => {
  for (const variant of ['', '#', '#/', null, undefined]) {
    assert.equal(normalizeAppHash(variant), '#/dashboard');
  }
});

test('normalizeAppHash preserves nested route paths', () => {
  assert.equal(normalizeAppHash('#/classes/c1'), '#/classes/c1');
  assert.equal(normalizeAppHash('classes/c1'), '#/classes/c1');
  assert.equal(normalizeAppHash('#/grading/a1/s2'), '#/grading/a1/s2');
});

test('same-route navigate is a no-op before guards or render', () => {
  const nav = createAppHashNavigation('#/accounts');
  assert.equal(nav.isSameRouteNavigate('#/accounts', '#/accounts'), true);
  assert.equal(nav.isSameRouteNavigate('accounts', '#/accounts'), true);
  assert.equal(nav.isSameRouteNavigate('/accounts', '#/accounts'), true);
  assert.equal(nav.isSameRouteNavigate('#accounts', '#/accounts'), true);
  assert.equal(nav.isSameRouteNavigate('#/settings', '#/accounts'), false);
});

test('canceled back restore consumes token without parse or render plan', () => {
  const nav = createAppHashNavigation('#/settings');
  const begin = nav.beginRestoreCanceledNavigation('#/dashboard');
  assert.equal(begin.action, 'set-hash');
  assert.equal(begin.hash, '#/settings');
  const plan = nav.planHashChange('#/settings', {
    isDirty: () => true,
    confirmDiscard: () => false,
  });
  assert.equal(plan.kind, 'canceled-restore-noop');
});

test('canceled restore noop when location hash is a variant of allowed route', () => {
  const nav = createAppHashNavigation('#/accounts');
  const begin = nav.beginRestoreCanceledNavigation('#accounts');
  assert.equal(begin.action, 'noop');
});

test('accepted programmatic hash change still bypasses dirty confirm', () => {
  const nav = createAppHashNavigation('#/settings');
  nav.prepareAcceptedNavigate('#/accounts');
  const plan = nav.planHashChange('#/accounts', {
    isDirty: () => true,
    confirmDiscard: () => false,
  });
  assert.equal(plan.kind, 'suppress-bypass');
  assert.equal(plan.disposeModals, true);
});

test('dirty hash change without restore token rejects and begins restore', () => {
  const nav = createAppHashNavigation('#/settings');
  const plan = nav.planHashChange('#/dashboard', {
    isDirty: () => true,
    confirmDiscard: () => false,
  });
  assert.equal(plan.kind, 'reject-restore');
});
