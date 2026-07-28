const { createHash, randomBytes } = require('node:crypto');

const DEFAULT_COOKIE_NAME = 'session';

function generateSessionToken(bytes = 32) {
  if (!Number.isSafeInteger(bytes) || bytes < 16) {
    throw new RangeError('token size must be an integer of at least 16 bytes');
  }
  return randomBytes(bytes).toString('base64url');
}

function hashSessionToken(token) {
  if (typeof token !== 'string' || token.length === 0) {
    throw new TypeError('token must be a non-empty string');
  }
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function parseCookies(header = '') {
  const cookies = Object.create(null);
  if (typeof header !== 'string') return cookies;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 1) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (!name) continue;
    try {
      cookies[name] = decodeURIComponent(value);
    } catch {
      cookies[name] = value;
    }
  }
  return cookies;
}

function serializeCookie(name, value, options = {}) {
  if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)) {
    throw new TypeError('invalid cookie name');
  }
  const encoded = encodeURIComponent(String(value));
  const parts = [`${name}=${encoded}`];
  if (options.maxAge !== undefined) parts.push(`Max-Age=${Math.floor(options.maxAge)}`);
  if (options.expires) parts.push(`Expires=${new Date(options.expires).toUTCString()}`);
  parts.push(`Path=${options.path || '/'}`);
  if (options.domain) parts.push(`Domain=${options.domain}`);
  if (options.httpOnly !== false) parts.push('HttpOnly');
  if (options.secure) parts.push('Secure');
  parts.push(`SameSite=${options.sameSite || 'Lax'}`);
  return parts.join('; ');
}

function createSessionCookie(token, options = {}) {
  return serializeCookie(options.name || DEFAULT_COOKIE_NAME, token, options);
}

function clearSessionCookie(options = {}) {
  return serializeCookie(options.name || DEFAULT_COOKIE_NAME, '', {
    ...options,
    maxAge: 0,
    expires: new Date(0)
  });
}

function getSessionToken(cookieHeader, name = DEFAULT_COOKIE_NAME) {
  return parseCookies(cookieHeader)[name] || null;
}

module.exports = {
  DEFAULT_COOKIE_NAME,
  generateSessionToken,
  hashSessionToken,
  parseCookies,
  serializeCookie,
  createSessionCookie,
  clearSessionCookie,
  getSessionToken
};
