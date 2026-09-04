const { URL } = require('node:url');
const { requireId, requireCode, ValidationError } = require('./validation');

const RECOGNIZED_KEYS = new Set(['placeId', 'universeId', 'privateServerLinkCode', 'linkCode', 'accessCode', 'gameInstanceId', 'userId', 'launchData', 'code', 'type']);

function parsePrivateServerLink(input) {
  if (typeof input !== 'string' || input.trim().length === 0 || input.length > 4096) {
    throw new ValidationError('Paste a Roblox private-server link or code');
  }
  const value = input.trim();
  if (/^roblox:\/\//i.test(value)) return parseRobloxScheme(value);
  if (!/^https?:\/\//i.test(value)) {
    if (/[:\/\s]/.test(value)) throw new ValidationError('Paste a Roblox private-server link or code');
    const code = value.replace(/^\s+|\s+$/g, '');
    return { kind: 'linkCode', code: requireCode(code, 'private-server code') };
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new ValidationError('That is not a valid URL');
  }
  if (parsed.protocol !== 'https:' || !/^(www\.)?roblox\.com$/i.test(parsed.hostname)) {
    throw new ValidationError('Only HTTPS Roblox links are accepted');
  }
  const params = parsed.searchParams;
  const placeId = params.get('placeId') || params.get('placeid');
  const privateServerLinkCode = params.get('privateServerLinkCode');
  const linkCode = params.get('linkCode');
  const accessCode = params.get('accessCode');
  const shareCode = params.get('type')?.toLowerCase() === 'server' ? params.get('code') : null;
  const gameInstanceId = params.get('gameInstanceId');
  const userId = params.get('userId');
  const codeCandidates = [privateServerLinkCode, linkCode, accessCode, shareCode].filter(Boolean);
  if (codeCandidates.length > 1) throw new ValidationError('The Roblox link contains conflicting private-server codes');
  const code = codeCandidates[0];
  if (!code) throw new ValidationError('The Roblox link does not contain a private-server code');
  const result = {
    kind: accessCode ? 'accessCode' : 'linkCode',
    code: requireCode(code, 'private-server code'),
    placeId: placeId ? requireId(placeId, 'placeId') : undefined,
    gameInstanceId: gameInstanceId || undefined,
    userId: userId ? requireId(userId, 'userId') : undefined,
    ignoredKeys: [...params.keys()].filter((key) => !RECOGNIZED_KEYS.has(key))
  };
  return result;
}

function parseRobloxScheme(value) {
  let params;
  try {
    const legacyPayload = value.slice('roblox://'.length).split('?')[0];
    if (legacyPayload.includes('=')) params = new URLSearchParams(legacyPayload);
    else {
    const parsed = new URL(value);
    params = parsed.searchParams;
    }
  } catch {
    throw new ValidationError('That is not a valid Roblox deep link');
  }
  const placeId = params.get('placeId') || params.get('placeid');
  const privateServerLinkCode = params.get('privateServerLinkCode');
  const linkCode = params.get('linkCode');
  const accessCode = params.get('accessCode');
  const codeCandidates = [privateServerLinkCode, linkCode, accessCode].filter(Boolean);
  if (codeCandidates.length > 1) throw new ValidationError('The Roblox deep link contains conflicting private-server codes');
  const code = codeCandidates[0];
  if (!code) throw new ValidationError('The Roblox deep link does not contain a private-server code');
  return {
    kind: accessCode ? 'accessCode' : 'linkCode',
    code: requireCode(code, 'private-server code'),
    placeId: placeId ? requireId(placeId, 'placeId') : undefined,
    gameInstanceId: params.get('gameInstanceId') || undefined,
    userId: params.get('userId') ? requireId(params.get('userId'), 'userId') : undefined,
    ignoredKeys: [...params.keys()].filter((key) => !RECOGNIZED_KEYS.has(key))
  };
}

module.exports = { parsePrivateServerLink };
