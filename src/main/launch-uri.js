const { requireId, requireJobId, requireUuid, requireCode, ValidationError } = require('./validation');

const PRIVATE_SERVER_JOIN_ORIGIN = 'privateServerListJoin';

function encodeQuery(entries) {
  const params = new URLSearchParams();
  for (const [key, value] of entries) {
    if (value !== undefined && value !== null && value !== '') params.set(key, value);
  }
  return params.toString();
}

function buildLaunchUri(intent, format = 'modern') {
  if (!intent || typeof intent !== 'object') throw new ValidationError('join intent is required');
  classifyJoinIntent(intent);
  const placeId = requireId(String(intent.placeId ?? ''), 'placeId');
  const entries = [['placeId', placeId]];
  if (intent.gameInstanceId !== undefined) entries.push(['gameInstanceId', requireJobId(intent.gameInstanceId)]);
  if (intent.linkCode !== undefined) entries.push(['linkCode', requireCode(intent.linkCode, 'linkCode')]);
  if (intent.accessCode !== undefined) entries.push(['accessCode', requireCode(intent.accessCode, 'accessCode')]);
  if (intent.userId !== undefined) entries.push(['userId', requireId(String(intent.userId), 'userId')]);
  if (intent.launchData !== undefined) entries.push(['launchData', requireCode(intent.launchData, 'launchData')]);
  if (intent.joinAttemptId !== undefined || intent.joinAttemptOrigin !== undefined) {
    if (intent.joinAttemptId === undefined || intent.joinAttemptOrigin === undefined) {
      throw new ValidationError('join attempt ID and origin must be provided together');
    }
    entries.push(['joinAttemptId', requireUuid(intent.joinAttemptId, 'joinAttemptId')]);
    if (intent.joinAttemptOrigin !== PRIVATE_SERVER_JOIN_ORIGIN) {
      throw new ValidationError('join attempt origin is invalid');
    }
    entries.push(['joinAttemptOrigin', intent.joinAttemptOrigin]);
  }
  const query = encodeQuery(entries);
  if (format === 'legacy') {
    const rest = encodeQuery(entries.slice(1));
    return `roblox://placeId=${encodeURIComponent(placeId)}${rest ? `&${rest}` : ''}`;
  }
  if (format !== 'modern') throw new ValidationError('unknown launch URI format');
  return `roblox://experiences/start?${query}`;
}

function classifyJoinIntent(input) {
  if (!input || typeof input !== 'object') throw new ValidationError('join intent is required');
  const selectors = ['gameInstanceId', 'linkCode', 'accessCode', 'joinAttemptId'].filter((field) => input[field] !== undefined);
  if (selectors.length > 1) {
    throw new ValidationError('join intent contains conflicting server selectors');
  }
  if (input.gameInstanceId) return 'exact-public';
  if (input.linkCode) return 'private-link';
  if (input.accessCode) return 'private-access';
  if (input.joinAttemptId) return 'private-server';
  if (input.userId) return 'follow-user';
  return 'matchmaking';
}

module.exports = { buildLaunchUri, classifyJoinIntent, PRIVATE_SERVER_JOIN_ORIGIN };
