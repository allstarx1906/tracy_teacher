/**
 * CSRF / mutation origin checks. When publicOrigin is set (production HTTPS URL),
 * Origin header must match it exactly — do not trust X-Forwarded-* alone.
 * @param {import('node:http').IncomingMessage} req
 * @param {string} hostHeader
 * @param {string|undefined|null} publicOrigin e.g. https://class.example.com
 */
export function assertSameOrigin(req, hostHeader, publicOrigin) {
  const origin = req.headers.origin;
  if (origin) {
    try {
      const o = new URL(origin);
      if (publicOrigin) {
        const expected = new URL(publicOrigin);
        if (o.origin !== expected.origin) return false;
      } else if (o.host !== hostHeader) {
        return false;
      }
    } catch {
      return false;
    }
  }
  if (publicOrigin) {
    return true;
  }
  const host = req.headers.host;
  if (host && host !== hostHeader) return false;
  return true;
}

export function assertMutationHeaders(req, hostHeader, csrfCookie, csrfHeader, publicOrigin) {
  if (req.method === 'GET' || req.method === 'HEAD') return true;
  const ct = req.headers['content-type'] || '';
  if (!ct.includes('application/json')) return false;
  const header = csrfHeader ?? req.headers['x-bn-csrf'];
  if (!csrfCookie || typeof csrfCookie !== 'string' || csrfCookie.length === 0) return false;
  if (!header || typeof header !== 'string' || header.length === 0) return false;
  if (header !== csrfCookie) return false;
  if (!assertSameOrigin(req, hostHeader, publicOrigin)) return false;
  return true;
}

export function assertAttachmentUploadHeaders(req, hostHeader, csrfCookie, csrfHeader, publicOrigin) {
  if (req.method !== 'POST') return false;
  if (req.headers['x-bn-csrf'] !== csrfCookie) return false;
  return assertSameOrigin(req, hostHeader, publicOrigin);
}
