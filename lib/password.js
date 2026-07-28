const { randomBytes, scrypt: scryptCallback, timingSafeEqual } = require('node:crypto');
const { promisify } = require('node:util');

const scrypt = promisify(scryptCallback);
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;
const PREFIX = 'scrypt';

async function hashPassword(password) {
  if (typeof password !== 'string' || password.length === 0) {
    throw new TypeError('password must be a non-empty string');
  }
  const salt = randomBytes(SALT_LENGTH);
  const derivedKey = await scrypt(password, salt, KEY_LENGTH);
  return `${PREFIX}$${salt.toString('hex')}$${derivedKey.toString('hex')}`;
}

async function verifyPassword(password, storedHash) {
  if (typeof password !== 'string' || typeof storedHash !== 'string') return false;
  const [prefix, saltHex, hashHex, ...extra] = storedHash.split('$');
  if (prefix !== PREFIX || extra.length || !/^[0-9a-f]{32}$/i.test(saltHex || '') ||
      !/^[0-9a-f]{128}$/i.test(hashHex || '')) return false;
  try {
    const expected = Buffer.from(hashHex, 'hex');
    const actual = await scrypt(password, Buffer.from(saltHex, 'hex'), expected.length);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

function getDefaultAdminCredentials(env = process.env) {
  if (typeof env.ADMIN_PASSWORD !== 'string' || env.ADMIN_PASSWORD.length === 0) {
    throw new Error('ADMIN_PASSWORD is required when creating the initial administrator');
  }

  return {
    username: env.ADMIN_USERNAME || 'admin',
    password: env.ADMIN_PASSWORD
  };
}

module.exports = {
  hashPassword,
  verifyPassword,
  getDefaultAdminCredentials,
  KEY_LENGTH,
  SALT_LENGTH
};
