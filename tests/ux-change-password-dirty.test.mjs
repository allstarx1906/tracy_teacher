import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  registerDirtyProbe,
  snapshotFormDirty,
  isGloballyDirty,
  confirmDiscard,
} from '../dist/ux-forms.js';
import { installBrowserWindowFixture, dispatchBeforeUnload } from './helper-browser-window.mjs';

const appSrc = readFileSync(new URL('../dist/app.js', import.meta.url), 'utf8');

function makePasswordField(initial = '') {
  return {
    type: 'password',
    value: initial,
    addEventListener() {},
    removeEventListener() {},
  };
}

test('renderChangePassword registers snapshotFormDirty probe on password fields', () => {
  assert.match(appSrc, /const passwordFormDirty = snapshotFormDirty\(passwordFields\)/);
  assert.match(appSrc, /registerDirtyProbe\(passwordFormDirty, \{ fields: passwordFields \}\)/);
  assert.match(appSrc, /authChangePasswordFormGeneration/);
  assert.match(
    appSrc,
    /if \(formGeneration !== authChangePasswordFormGeneration\) return;\s*\n\s*registerDirtyProbe\(null\)/,
  );
});

test('change-password dirty probe arms beforeunload and clean baseline stays silent', async (t) => {
  const handlers = installBrowserWindowFixture(t);
  const current = makePasswordField('');
  const next = makePasswordField('');
  const confirm = makePasswordField('');
  const passwordFormDirty = snapshotFormDirty([current, next, confirm]);
  registerDirtyProbe(passwordFormDirty, { fields: [current, next, confirm] });

  assert.equal(isGloballyDirty(), false);
  next.value = 'new-secret-value';
  assert.equal(isGloballyDirty(), true);
  const dirtyEvent = dispatchBeforeUnload(handlers);
  assert.equal(dirtyEvent._prevented, true);

  passwordFormDirty.markClean();
  assert.equal(isGloballyDirty(), false);
  const cleanEvent = dispatchBeforeUnload(handlers);
  assert.equal(cleanEvent._prevented, undefined);
});

test('canceled discard keeps password field values in memory', async (t) => {
  let confirmCalls = 0;
  installBrowserWindowFixture(t, {
    confirm: () => {
      confirmCalls += 1;
      return false;
    },
  });

  const next = makePasswordField('');
  const confirm = makePasswordField('');
  const passwordFormDirty = snapshotFormDirty([next, confirm]);
  registerDirtyProbe(passwordFormDirty, { fields: [next, confirm] });
  next.value = 'typed-new-pass';
  confirm.value = 'typed-new-pass';
  assert.equal(isGloballyDirty(), true);
  if (isGloballyDirty() && !confirmDiscard()) {
    assert.equal(next.value, 'typed-new-pass');
    assert.equal(confirm.value, 'typed-new-pass');
    assert.equal(isGloballyDirty(), true);
  }
  assert.equal(confirmCalls, 1);
});

test('successful change-password flow clears dirty probe before navigation', () => {
  assert.match(
    appSrc,
    /registerDirtyProbe\(null\);\s*\n\s*passwordFormDirty\.markClean\(\);\s*\n\s*state\.user = getCurrentUser\(\)/,
  );
  assert.match(appSrc, /if \(isGloballyDirty\(\) && !confirmDiscard\(\)\) return;\s*\n\s*registerDirtyProbe\(null\);\s*\n\s*const r = await logout\(\)/);
});

test('must-change-password omits current field from dirty baseline fields', () => {
  assert.match(
    appSrc,
    /const passwordFields = state\.user\?\.mustChangePassword \? \[next, next2\] : \[current, next, next2\]/,
  );
});
