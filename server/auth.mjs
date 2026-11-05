import crypto from 'node:crypto';
import { timingSafeEqual, scryptSync, randomBytes } from 'node:crypto';

const SCRYPT_OPTS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const SALT_BYTES = 16;
const SESSION_BYTES = 32;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CSRF_BYTES = 32;

export { SESSION_TTL_MS };

export function hashPassword(plain) {
  const salt = randomBytes(SALT_BYTES);
  const hash = scryptSync(plain, salt, 64, SCRYPT_OPTS);
  return { salt: salt.toString('base64'), hash: hash.toString('base64') };
}

export function verifyPassword(plain, stored) {
  if (!stored?.salt || !stored?.hash) return false;
  const salt = Buffer.from(stored.salt, 'base64');
  const expected = Buffer.from(stored.hash, 'base64');
  const actual = scryptSync(plain, salt, 64, SCRYPT_OPTS);
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

export function newSessionToken() {
  return randomBytes(SESSION_BYTES).toString('base64url');
}

export function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function newCsrfToken() {
  return randomBytes(CSRF_BYTES).toString('base64url');
}

export function normalizeUsername(u) {
  return String(u || '').trim().toLowerCase();
}

export function validateUsername(u) {
  const s = String(u || '').trim();
  if (s.length < 3 || s.length > 32) return { ok: false, error: 'Tên đăng nhập phải từ 3–32 ký tự.' };
  if (!/^[a-zA-Z0-9._-]+$/.test(s)) {
    return { ok: false, error: 'Tên đăng nhập chỉ gồm chữ, số, . _ -' };
  }
  return { ok: true, value: s };
}

export function validatePassword(p) {
  const s = String(p || '');
  if (s.length < 8 || s.length > 128) return { ok: false, error: 'Mật khẩu phải từ 8–128 ký tự.' };
  return { ok: true, value: s };
}

export function createRateLimiter({ windowMs, max }) {
  /** @type {Map<string, { count: number, reset: number }>} */
  const buckets = new Map();
  return {
    check(key) {
      const now = Date.now();
      let b = buckets.get(key);
      if (!b || now > b.reset) {
        b = { count: 0, reset: now + windowMs };
        buckets.set(key, b);
      }
      b.count += 1;
      if (b.count > max) return false;
      return true;
    },
  };
}

export function parseCookies(header) {
  /** @type {Record<string, string>} */
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    out[k] = decodeURIComponent(v);
  }
  return out;
}

export function buildSetCookie(name, value, opts = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${opts.path || '/'}`);
  if (opts.httpOnly) parts.push('HttpOnly');
  if (opts.sameSite) parts.push(`SameSite=${opts.sameSite}`);
  if (opts.secure) parts.push('Secure');
  if (opts.maxAge != null) parts.push(`Max-Age=${opts.maxAge}`);
  return parts.join('; ');
}

export function sessionExpiryIso() {
  return new Date(Date.now() + SESSION_TTL_MS).toISOString();
}

export function isSessionExpired(expiresAt) {
  return new Date(expiresAt).getTime() <= Date.now();
}

export function revokeAllSessionsForAccount(state, accountId) {
  for (const [hash, sess] of Object.entries(state.sessions)) {
    if (sess.accountId === accountId) delete state.sessions[hash];
  }
}

export function bumpSessionVersion(account) {
  account.sessionVersion = (account.sessionVersion || 0) + 1;
}
