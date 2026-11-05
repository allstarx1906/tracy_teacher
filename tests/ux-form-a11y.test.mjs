import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const appSrc = readFileSync(new URL('../dist/app.js', import.meta.url), 'utf8');

function assertControlId(id) {
  assert.match(
    appSrc,
    new RegExp(`id:\\s*['\`]${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['\`]`),
    `expected control id ${id}`,
  );
}

function assertHtmlFor(id) {
  assert.match(
    appSrc,
    new RegExp(`htmlFor:\\s*['\`]${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['\`]`),
    `expected label htmlFor ${id}`,
  );
}

test('login form controls expose visible label associations', () => {
  assertControlId('auth-login-username');
  assertControlId('auth-login-password');
  assertHtmlFor('auth-login-username');
  assertHtmlFor('auth-login-password');
  assert.match(appSrc, /'Tên đăng nhập'/);
  assert.match(appSrc, /htmlFor: 'auth-login-password'[^\\n]*'Mật khẩu'/);
});

test('change-password form controls expose visible label associations', () => {
  assertControlId('auth-change-password-current');
  assertControlId('auth-change-password-new');
  assertControlId('auth-change-password-confirm');
  assertHtmlFor('auth-change-password-current');
  assertHtmlFor('auth-change-password-new');
  assertHtmlFor('auth-change-password-confirm');
});

test('assignment dialog uses paired ids and htmlFor for core fields', () => {
  assert.match(appSrc, /id:\s*`assignment-title-\$\{assignmentFormUid\}`/);
  assert.match(appSrc, /htmlFor:\s*`assignment-title-\$\{assignmentFormUid\}`/);
  assert.match(appSrc, /id:\s*`assignment-class-\$\{assignmentFormUid\}`/);
  assert.match(appSrc, /htmlFor:\s*`assignment-files-\$\{assignmentFormUid\}`/);
});

test('accounts create form uses view-scoped ids with htmlFor labels', () => {
  assert.match(appSrc, /id:\s*`\$\{accountFormFieldPrefix\}-student`/);
  assert.match(appSrc, /htmlFor:\s*`\$\{accountFormFieldPrefix\}-username`/);
  assert.match(appSrc, /htmlFor:\s*`\$\{accountFormFieldPrefix\}-temp-password`/);
});
