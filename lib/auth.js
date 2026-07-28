const crypto = require('node:crypto');
const {
  generateSessionToken,
  hashSessionToken,
  getSessionToken,
  createSessionCookie,
  clearSessionCookie,
  parseCookies,
  serializeCookie
} = require('./session');

const IDLE_MS = 12 * 60 * 60 * 1000;
const ABSOLUTE_MS = 7 * 24 * 60 * 60 * 1000;
const LOGIN_CSRF_MS = 5 * 60 * 1000;
const LOGIN_CSRF_COOKIE = 'zcode_login_csrf';

function safeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = crypto.createHash('sha256').update(left, 'utf8').digest();
  const b = crypto.createHash('sha256').update(right, 'utf8').digest();
  return crypto.timingSafeEqual(a, b);
}

function createAuth(db, options = {}) {
  const secure = options.secure ?? process.env.COOKIE_SECURE === 'true';
  const cookieName = secure ? '__Host-zcode_session' : 'zcode_session';
  const loginCsrfSecret = options.loginCsrfSecret || crypto.randomBytes(32);
  const now = options.now || Date.now;

  function sessionOptions() {
    return { name: cookieName, httpOnly: true, secure, sameSite: 'Lax', path: '/', maxAge: Math.floor(ABSOLUTE_MS / 1000) };
  }

  function currentSession(req) {
    const raw = getSessionToken(req.headers.cookie, cookieName);
    if (!raw) return null;
    const hash = hashSessionToken(raw);
    const session = db.getSessionByHash(hash);
    if (!session) return null;
    db.touchSession(hash, new Date(Date.now() + IDLE_MS).toISOString());
    return { raw, hash, session };
  }

  function optional(req, res, next) {
    const found = currentSession(req);
    if (found) {
      req.auth = {
        sessionHash: found.hash,
        user: {
          id: found.session.user_id,
          username: found.session.username,
          role: found.session.role,
          defaultPassword: Boolean(found.session.default_password)
        },
        csrfHash: found.session.csrf_hash
      };
    }
    next();
  }

  function required(req, res, next) {
    optional(req, res, () => {
      if (!req.auth) return res.status(401).json({ error: '请先登录' });
      next();
    });
  }

  function admin(req, res, next) {
    required(req, res, () => {
      if (req.auth.user.role !== 'admin') return res.status(403).json({ error: '需要管理员权限' });
      next();
    });
  }

  function issue(user) {
    const token = generateSessionToken();
    const csrfToken = generateSessionToken();
    const timestamp = Date.now();
    db.createSession({
      tokenHash: hashSessionToken(token),
      userId: user.id,
      csrfHash: hashSessionToken(csrfToken),
      sessionVersion: user.session_version,
      idleExpiresAt: new Date(timestamp + IDLE_MS).toISOString(),
      absoluteExpiresAt: new Date(timestamp + ABSOLUTE_MS).toISOString()
    });
    return {
      token,
      csrfToken,
      cookie: createSessionCookie(token, sessionOptions()),
      csrfCookie: serializeCookie('zcode_csrf', csrfToken, {
        httpOnly: false, secure, sameSite: 'Lax', path: '/', maxAge: Math.floor(ABSOLUTE_MS / 1000)
      })
    };
  }

  function clearCookie() {
    return [
      clearSessionCookie(sessionOptions()),
      serializeCookie('zcode_csrf', '', { httpOnly: false, secure, sameSite: 'Lax', path: '/', maxAge: 0, expires: new Date(0) })
    ];
  }

  function issueLoginCsrf() {
    const issuedAt = now();
    const nonce = generateSessionToken();
    const payload = `${issuedAt}.${nonce}`;
    const signature = crypto.createHmac('sha256', loginCsrfSecret).update(payload).digest('base64url');
    const token = `${payload}.${signature}`;
    return {
      token,
      cookie: serializeCookie(LOGIN_CSRF_COOKIE, token, {
        httpOnly: false, secure, sameSite: 'Lax', path: '/', maxAge: Math.floor(LOGIN_CSRF_MS / 1000)
      })
    };
  }

  function clearLoginCsrfCookie() {
    return serializeCookie(LOGIN_CSRF_COOKIE, '', {
      httpOnly: false, secure, sameSite: 'Lax', path: '/', maxAge: 0, expires: new Date(0)
    });
  }

  function loginCsrf(req, res, next) {
    const cookieToken = parseCookies(req.headers.cookie)[LOGIN_CSRF_COOKIE];
    const headerToken = req.get('x-login-csrf-token');
    const parts = typeof cookieToken === 'string' ? cookieToken.split('.') : [];
    const issuedAt = parts.length === 3 ? Number(parts[0]) : NaN;
    const payload = parts.length === 3 ? `${parts[0]}.${parts[1]}` : '';
    const expected = payload ? crypto.createHmac('sha256', loginCsrfSecret).update(payload).digest('base64url') : '';
    const age = now() - issuedAt;
    const valid = safeEqual(cookieToken || '', headerToken || '') && safeEqual(parts[2] || '', expected) &&
      Number.isSafeInteger(issuedAt) && age >= 0 && age <= LOGIN_CSRF_MS;
    if (!valid) return res.status(403).json({ error: '登录 CSRF 校验失败，请刷新页面后重试' });
    next();
  }

  function csrf(req, res, next) {
    required(req, res, () => {
      const token = req.get('x-csrf-token');
      if (!token || !safeEqual(hashSessionToken(token), req.auth.csrfHash)) {
        return res.status(403).json({ error: 'CSRF 校验失败，请刷新页面后重试' });
      }
      next();
    });
  }

  return {
    optional, required, admin, csrf, loginCsrf, issue, issueLoginCsrf, clearCookie,
    clearLoginCsrfCookie, currentSession, cookieName
  };
}

module.exports = { createAuth, IDLE_MS, ABSOLUTE_MS, LOGIN_CSRF_MS, safeEqual };
