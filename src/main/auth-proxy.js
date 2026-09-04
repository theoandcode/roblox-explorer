const { URL } = require('node:url');
const { ValidationError } = require('./validation');

const AUTH_PROXY_ENV = 'ROBLOX_NAVIGATOR_AUTH_PROXY';
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;

/**
 * Validate and canonicalize the proxy syntax accepted by Electron's
 * session.setProxy(). Electron expects a proxy endpoint, not an HTTP URL with
 * a resource path. Browsers commonly add a root slash when a URL is copied,
 * so discard one or more root-only trailing slashes before handing it to
 * Electron.
 */
function normalizeAuthProxy(raw) {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string') throw new ValidationError(`${AUTH_PROXY_ENV} is invalid`);
  const value = raw.trim();
  if (!value) return undefined;
  if (value.length > 512 || CONTROL_CHARACTER_PATTERN.test(value)) {
    throw new ValidationError(`${AUTH_PROXY_ENV} is invalid`);
  }

  let parsed;
  try { parsed = new URL(value); } catch { throw new ValidationError(`${AUTH_PROXY_ENV} must be a proxy URL`); }
  const rootPath = !parsed.pathname || /^\/+$/u.test(parsed.pathname);
  if (!['http:', 'https:', 'socks4:', 'socks5:'].includes(parsed.protocol)
    || !parsed.hostname
    || parsed.username
    || parsed.password
    || !rootPath
    || parsed.search
    || parsed.hash) {
    throw new ValidationError(`${AUTH_PROXY_ENV} must be an HTTP(S) or SOCKS proxy URL without credentials or a path`);
  }

  // URL#toString() always adds a root slash. Construct the endpoint from the
  // canonical protocol/host pair so Electron receives no trailing slash.
  return `${parsed.protocol}//${parsed.host}`;
}

module.exports = { AUTH_PROXY_ENV, normalizeAuthProxy };
