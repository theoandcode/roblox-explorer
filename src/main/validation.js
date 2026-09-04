const ID_PATTERN = /^[1-9][0-9]{0,19}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CODE_PATTERN = /^[A-Za-z0-9._~+=/%:-]{1,512}$/;

function isId(value) {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

function isJobId(value) {
  return typeof value === 'string' && (UUID_PATTERN.test(value) || /^[A-Za-z0-9-]{8,128}$/.test(value));
}

function isCode(value) {
  return typeof value === 'string' && CODE_PATTERN.test(value);
}

function requireId(value, label = 'id') {
  if (!isId(value)) throw new ValidationError(`${label} must be a positive decimal ID`);
  return value;
}

function requireJobId(value) {
  if (!isJobId(value)) throw new ValidationError('jobId must be a valid server instance ID');
  return value;
}

function requireUuid(value, label = 'id') {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) throw new ValidationError(`${label} must be a valid UUID`);
  return value;
}

function requireCode(value, label = 'code') {
  if (!isCode(value)) throw new ValidationError(`${label} contains unsupported characters or is too long`);
  return value;
}

function boundedString(value, label, max = 200) {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new ValidationError(`${label} is invalid`);
  }
  return value;
}

function optionalBoolean(value, label) {
  if (value !== undefined && typeof value !== 'boolean') throw new ValidationError(`${label} must be boolean`);
  return value;
}

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
    this.code = 'VALIDATION_ERROR';
  }
}

function assertPlainObject(value, label = 'input') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ValidationError(`${label} must be an object`);
  return value;
}

function normalizeId(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  if (isId(value)) return value;
  return null;
}

function normalizeExperience(value, { allowMissingRootPlaceId = false } = {}) {
  assertPlainObject(value, 'experience');
  const universeId = normalizeId(value.universeId ?? value.id ?? value.contentId);
  const rootPlaceId = normalizeId(value.rootPlaceId ?? value.placeId);
  if (!universeId || (!rootPlaceId && !allowMissingRootPlaceId)) throw new ValidationError('experience is missing universeId or rootPlaceId');
  return {
    universeId,
    rootPlaceId,
    name: typeof value.name === 'string' ? value.name : 'Untitled experience',
    description: typeof value.description === 'string' ? value.description : '',
    playerCount: Number.isFinite(value.playerCount) ? value.playerCount : (Number.isFinite(value.playing) ? value.playing : 0),
    visits: Number.isFinite(value.visits) ? value.visits : 0,
    maxPlayers: Number.isFinite(value.maxPlayers) ? value.maxPlayers : 0,
    creator: value.creator && typeof value.creator === 'object' ? {
      id: normalizeId(value.creator.id),
      name: typeof value.creator.name === 'string' ? value.creator.name : 'Unknown creator',
      type: typeof value.creator.type === 'string' ? value.creator.type : undefined,
      hasVerifiedBadge: Boolean(value.creator.hasVerifiedBadge)
    } : undefined,
    contentMaturity: typeof value.contentMaturity === 'string' ? value.contentMaturity : undefined,
    ageRecommendationDisplayName: typeof value.ageRecommendationDisplayName === 'string' ? value.ageRecommendationDisplayName : undefined,
    createVipServersAllowed: Boolean(value.createVipServersAllowed),
    isContentRestricted: Boolean(value.isContentRestricted),
    canonicalUrlPath: typeof value.canonicalUrlPath === 'string' ? value.canonicalUrlPath : undefined,
    iconUrl: typeof value.iconUrl === 'string' ? value.iconUrl : undefined,
    thumbnailUrls: Array.isArray(value.thumbnailUrls) ? value.thumbnailUrls.filter((url) => typeof url === 'string') : []
  };
}

function normalizeServer(value) {
  assertPlainObject(value, 'server');
  const id = typeof value.id === 'string' ? value.id : null;
  if (!id || !isJobId(id)) throw new ValidationError('server is missing a valid job ID');
  return {
    id,
    maxPlayers: Number.isFinite(value.maxPlayers) ? value.maxPlayers : 0,
    playing: Number.isFinite(value.playing) ? value.playing : 0,
    fps: Number.isFinite(value.fps) ? value.fps : undefined,
    ping: Number.isFinite(value.ping) ? value.ping : undefined
  };
}

function normalizeThumbnail(value) {
  assertPlainObject(value, 'thumbnail');
  const targetId = normalizeId(value.targetId);
  const imageUrl = typeof value.imageUrl === 'string' ? value.imageUrl : null;
  if (!targetId || !imageUrl) throw new ValidationError('thumbnail is missing targetId or imageUrl');
  const parsed = new URL(imageUrl);
  if (parsed.protocol !== 'https:' || !parsed.hostname.endsWith('.rbxcdn.com')) {
    throw new ValidationError('thumbnail URL is not an allowed Roblox CDN URL');
  }
  return { targetId, state: typeof value.state === 'string' ? value.state : 'Completed', imageUrl };
}

function normalizePrivateServer(value) {
  assertPlainObject(value, 'private server');
  const id = normalizeId(value.id ?? value.vipServerId ?? value.privateServerId);
  if (!id) throw new ValidationError('private server is missing an ID');
  const privateServerIdCandidate = value.privateServerId ?? value.privateId;
  const privateServerId = typeof privateServerIdCandidate === 'string' && UUID_PATTERN.test(privateServerIdCandidate)
    ? privateServerIdCandidate
    : undefined;
  // Roblox has returned several names for these values across the legacy
  // private-server endpoints. Normalize them into one internal shape while
  // keeping the raw secrets in the main process only.
  let linkCode = value.linkCode ?? value.privateServerLinkCode ?? value.joinCode;
  if (typeof linkCode === 'string' && /^https:\/\//i.test(linkCode)) {
    try {
      const parsed = new URL(linkCode);
      if (!/^(www\.)?roblox\.com$/i.test(parsed.hostname)) linkCode = undefined;
      else linkCode = parsed.searchParams.get('linkCode') || parsed.searchParams.get('privateServerLinkCode') || (parsed.searchParams.get('type')?.toLowerCase() === 'server' ? parsed.searchParams.get('code') : undefined);
    } catch { linkCode = undefined; }
  }
  if (!isCode(linkCode)) linkCode = undefined;
  const permissions = value.permissions && typeof value.permissions === 'object' ? value.permissions : {};
  const friendsAllowed = typeof value.friendsAllowed === 'boolean' ? value.friendsAllowed
    : typeof value.allowFriends === 'boolean' ? value.allowFriends
      : typeof value.allowedFriends === 'boolean' ? value.allowedFriends
        : typeof value.isFriendsAllowed === 'boolean' ? value.isFriendsAllowed
          : typeof permissions.friendsAllowed === 'boolean' ? permissions.friendsAllowed
            : typeof permissions.allowFriends === 'boolean' ? permissions.allowFriends
              : typeof permissions.allowFriendsToJoin === 'boolean' ? permissions.allowFriendsToJoin
                : undefined;
  const users = Array.isArray(value.users) ? value.users
    : Array.isArray(value.allowedUsers) ? value.allowedUsers
      : Array.isArray(value.userIds) ? value.userIds
        : Array.isArray(permissions.users) ? permissions.users
          : Array.isArray(permissions.allowedUsers) ? permissions.allowedUsers
            : [];
  const subscriptionRaw = value.subscription && typeof value.subscription === 'object' ? value.subscription : undefined;
  const subscription = subscriptionRaw ? {
    active: typeof subscriptionRaw.active === 'boolean' ? subscriptionRaw.active : undefined,
    price: Number.isSafeInteger(subscriptionRaw.price) && subscriptionRaw.price >= 0 ? subscriptionRaw.price : undefined,
    currencyCode: typeof subscriptionRaw.currencyCode === 'string' ? subscriptionRaw.currencyCode : undefined,
    expirationDate: typeof subscriptionRaw.expirationDate === 'string' ? subscriptionRaw.expirationDate : undefined,
    renewalDate: typeof subscriptionRaw.renewalDate === 'string' ? subscriptionRaw.renewalDate : undefined,
    isRenewing: typeof subscriptionRaw.isRenewing === 'boolean' ? subscriptionRaw.isRenewing : undefined
  } : undefined;
  return {
    id,
    privateServerId,
    name: typeof value.name === 'string' ? value.name : (typeof value.serverName === 'string' ? value.serverName : 'Private server'),
    placeId: normalizeId(value.placeId ?? value.rootPlaceId),
    universeId: normalizeId(value.universeId),
    ownerId: normalizeId(value.ownerId ?? value.privateServerOwnerId),
    active: typeof value.active === 'boolean' ? value.active : (subscription && typeof subscription.active === 'boolean' ? subscription.active : undefined),
    subscription,
    friendsAllowed,
    users: users.map(normalizeId).filter(Boolean),
    linkCode,
    accessCode: isCode(value.accessCode ?? value.privateServerAccessCode ?? value.reservedServerAccessCode)
      ? (value.accessCode ?? value.privateServerAccessCode ?? value.reservedServerAccessCode)
      : undefined,
    raw: undefined
  };
}

module.exports = {
  ValidationError,
  ID_PATTERN,
  UUID_PATTERN,
  isId,
  isJobId,
  isCode,
  requireId,
  requireJobId,
  requireUuid,
  requireCode,
  boundedString,
  optionalBoolean,
  assertPlainObject,
  normalizeId,
  normalizeExperience,
  normalizeServer,
  normalizeThumbnail,
  normalizePrivateServer
};
