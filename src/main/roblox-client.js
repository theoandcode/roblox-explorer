const { randomUUID } = require('node:crypto');
const {
  ValidationError,
  assertPlainObject,
  boundedString,
  normalizeExperience,
  normalizeId,
  normalizePrivateServer,
  normalizeServer,
  normalizeThumbnail,
  optionalBoolean,
  requireId,
  UUID_PATTERN
} = require('./validation');

const ALLOWED_API_HOSTS = new Set([
  'apis.roblox.com',
  'games.roblox.com',
  'api.rolimons.com',
  'thumbnails.roblox.com',
  'users.roblox.com',
  'auth.roblox.com'
]);

class RobloxApiError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'RobloxApiError';
    this.code = details.code || 'API_ERROR';
    this.status = details.status;
    this.host = details.host;
    this.retryAfterMs = details.retryAfterMs;
    this.csrfToken = details.csrfToken;
    this.safeMessage = message;
  }
}

class TtlCache {
  constructor() { this.entries = new Map(); }
  get(key) {
    const entry = this.entries.get(key);
    if (!entry || entry.expiresAt <= Date.now()) { this.entries.delete(key); return undefined; }
    return entry.value;
  }
  set(key, value, ttlMs) { this.entries.set(key, { value, expiresAt: Date.now() + ttlMs }); return value; }
  clear() { this.entries.clear(); }
  deletePrefix(prefix) { for (const key of this.entries.keys()) if (key.startsWith(prefix)) this.entries.delete(key); }
}

class HostRateLimiter {
  constructor() { this.nextAllowed = new Map(); }
  async wait(host) {
    const now = Date.now();
    const next = this.nextAllowed.get(host) || now;
    const delay = Math.max(0, next - now);
    this.nextAllowed.set(host, Math.max(now, next) + 80);
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(delay, 2000)));
  }
}

function normalizeRetryAfter(value) {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, Math.min(seconds * 1000, 30000));
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, Math.min(date - Date.now(), 30000)) : undefined;
}

class RobloxApiClient {
  constructor({ fetchImpl = globalThis.fetch, session, cache = new TtlCache(), rateLimiter = new HostRateLimiter(), timeoutMs = 15000 } = {}) {
    if (session && typeof session.fetch === 'function' && fetchImpl === globalThis.fetch) fetchImpl = session.fetch.bind(session);
    if (typeof fetchImpl !== 'function') throw new Error('A fetch implementation is required');
    this.fetchImpl = fetchImpl;
    this.session = session;
    this.cache = cache;
    this.rateLimiter = rateLimiter;
    this.timeoutMs = timeoutMs;
  }

  clearCache() {
    if (typeof this.cache.clear === 'function') this.cache.clear();
  }

  async request(baseUrl, pathname, options = {}) {
    const maxAttempts = options.retry === false ? 1 : 3;
    let lastError;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        return await this._request(baseUrl, pathname, options);
      } catch (error) {
        lastError = error;
        const retryable = ['NETWORK_ERROR', 'TIMEOUT', 'RATE_LIMITED', 'SERVICE_UNAVAILABLE'].includes(error.code);
        if (!retryable || attempt === maxAttempts - 1) throw error;
        const retryAfter = error.retryAfterMs ?? Math.min(1000 * (2 ** attempt), 8000);
        const jitter = Math.floor(Math.random() * 250);
        await new Promise((resolve) => setTimeout(resolve, Math.min(30000, retryAfter + jitter)));
      }
    }
    throw lastError;
  }

  async _request(baseUrl, pathname, options = {}) {
    const url = new URL(pathname, baseUrl);
    if (url.protocol !== 'https:' || !ALLOWED_API_HOSTS.has(url.hostname)) {
      throw new RobloxApiError('Blocked request to an unapproved Roblox host', { code: 'HOST_NOT_ALLOWED', host: url.hostname });
    }
    const method = options.method || 'GET';
    const cacheKey = options.cacheKey || `${method}:${url.toString()}`;
    if (method === 'GET' && options.cacheTtlMs) {
      const cached = this.cache.get(cacheKey);
      if (cached !== undefined) return cached;
    }
    await this.rateLimiter.wait(url.hostname);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs || this.timeoutMs);
    const headers = { Accept: 'application/json', ...(options.headers || {}) };
    if (options.csrf && this.csrfToken) headers['x-csrf-token'] = this.csrfToken;
    let response;
    try {
      const fetchOptions = { method, headers, signal: controller.signal };
      if (options.body !== undefined) {
        fetchOptions.body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
        if (!headers['Content-Type'] && !headers['content-type']) headers['Content-Type'] = 'application/json';
      }
      // A session-backed fetch must opt in to the session cookie jar. This is
      // especially important for the legacy private-server endpoints, which
      // authenticate with the `.ROBLOSECURITY` cookie established by the
      // isolated login window.
      if (this.session) fetchOptions.credentials = 'include';
      response = await this.fetchImpl(url, fetchOptions);
    } catch (error) {
      const code = error?.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK_ERROR';
      throw new RobloxApiError(code === 'TIMEOUT' ? 'Roblox API request timed out' : 'Unable to reach Roblox API', { code, host: url.hostname });
    } finally {
      clearTimeout(timeout);
    }
    const text = await response.text();
    let payload;
    try { payload = text ? JSON.parse(text) : undefined; } catch { payload = undefined; }
    if (!response.ok) {
      const csrfToken = response.headers?.get?.('x-csrf-token');
      if (options.csrf && response.status === 403 && csrfToken && !options._csrfRetried) {
        this.csrfToken = csrfToken;
        return this.request(baseUrl, pathname, { ...options, _csrfRetried: true });
      }
      const code = response.status === 401 ? 'AUTH_REQUIRED' : response.status === 403 ? 'FORBIDDEN' : response.status === 404 ? 'NOT_FOUND' : response.status === 429 ? 'RATE_LIMITED' : response.status >= 500 ? 'SERVICE_UNAVAILABLE' : 'API_ERROR';
      const message = code === 'AUTH_REQUIRED' ? 'Roblox sign-in is required for this operation' : code === 'RATE_LIMITED' ? 'Roblox rate-limited the request; please try again shortly' : `Roblox API returned HTTP ${response.status}`;
      throw new RobloxApiError(message, { code, status: response.status, host: url.hostname, retryAfterMs: normalizeRetryAfter(response.headers?.get?.('retry-after')), csrfToken });
    }
    if (method === 'GET' && options.cacheTtlMs) this.cache.set(cacheKey, payload, options.cacheTtlMs);
    return payload;
  }
}

function flattenSearchResults(payload) {
  assertPlainObject(payload, 'search response');
  const results = [];
  for (const group of Array.isArray(payload.searchResults) ? payload.searchResults : []) {
    if (!group || typeof group !== 'object' || !Array.isArray(group.contents)) continue;
    for (const item of group.contents) {
      if (!item || typeof item !== 'object') continue;
      const contentType = item.contentType || group.contentGroupType;
      if (contentType !== 'Game' && contentType !== 'Experience') continue;
      try { results.push(normalizeExperience(item)); } catch { /* schema drift is isolated per result */ }
    }
  }
  const deduped = [...new Map(results.map((item) => [item.universeId, item])).values()];
  return { results: deduped, nextPageToken: typeof payload.nextPageToken === 'string' && payload.nextPageToken ? payload.nextPageToken : undefined, filteredSearchQuery: typeof payload.filteredSearchQuery === 'string' ? payload.filteredSearchQuery : undefined };
}

class ExperienceSearchProvider {
  constructor(client) { this.client = client; }
  async search({ query, sessionId, pageToken }) {
    boundedString(query, 'query', 200);
    const sid = sessionId || randomUUID();
    const params = new URLSearchParams({ searchQuery: query, sessionId: sid, pageType: 'all' });
    if (pageToken) boundedString(pageToken, 'pageToken', 2048), params.set('pageToken', pageToken);
    const payload = await this.client.request('https://apis.roblox.com', `/search-api/omni-search?${params}`, { cacheTtlMs: 60000 });
    return { ...flattenSearchResults(payload), sessionId: sid };
  }
}

function discoveryCandidates(value, output = [], depth = 0) {
  if (depth > 8 || value === null || value === undefined) return output;
  if (Array.isArray(value)) {
    for (const item of value) discoveryCandidates(item, output, depth + 1);
    return output;
  }
  if (typeof value !== 'object') return output;

  // Explore responses have changed nesting a few times (contents, games,
  // gameSet, and experience). Preserve the parent fields while unwrapping a
  // nested game object so the normal experience DTO remains the only shape
  // consumed by the renderer.
  const nested = value.game || value.experience || value.gameData || value.place;
  if (nested && typeof nested === 'object') output.push({ ...value, ...nested });
  else output.push(value);
  for (const child of Object.values(value)) discoveryCandidates(child, output, depth + 1);
  return output;
}

function normalizeDiscoveryExperience(value) {
  if (!value || typeof value !== 'object') return undefined;
  const metadata = value.contentMetadata && typeof value.contentMetadata === 'object' ? value.contentMetadata : undefined;
  const source = metadata ? { ...value, ...metadata } : value;
  const explicitUniverseId = source.universeId ?? source.universeID ?? source.experienceId ?? source.experienceID ?? source.gameId ?? source.gameID ?? source.contentId ?? source.contentID;
  const universeId = explicitUniverseId ?? (source.id !== undefined && (source.name || source.displayName || source.title || source.playerCount !== undefined || source.playing !== undefined || source.placeId !== undefined) ? source.id : undefined);
  const rootPlaceId = source.rootPlaceId ?? source.rootPlaceID ?? source.placeId ?? source.placeID ?? source.rootPlace?.id;
  if (universeId === undefined) return undefined;
  const playerCount = source.playerCount ?? source.playing ?? source.playerCounts?.playing ?? source.currentPlayers ?? source.stats?.playerCount ?? source.stats?.playing;
  const visits = source.visits ?? source.visitCount;
  const hasExperienceFields = rootPlaceId !== undefined || ['name', 'displayName', 'title', 'description', 'playerCount', 'playing', 'currentPlayers', 'visits', 'visitCount', 'primaryMediaAsset'].some((field) => source[field] !== undefined) || playerCount !== undefined || visits !== undefined;
  if (!hasExperienceFields) return undefined;
  try {
    return normalizeExperience({
      ...source,
      universeId,
      ...(rootPlaceId === undefined ? {} : { rootPlaceId }),
      name: source.name ?? source.displayName ?? source.title,
      description: source.description ?? source.gameDescription,
      playerCount: Number.isFinite(playerCount) ? playerCount : (typeof playerCount === 'string' && playerCount.trim() ? Number(playerCount) : undefined),
      visits: Number.isFinite(visits) ? visits : (typeof visits === 'string' && visits.trim() ? Number(visits) : undefined),
      iconUrl: source.iconUrl ?? source.iconImageUrl,
      thumbnailUrls: source.thumbnailUrls || source.thumbnails
    }, { allowMissingRootPlaceId: true });
  } catch {
    return undefined;
  }
}

function normalizeRobloxCdnUrl(value) {
  if (typeof value !== 'string' || !value) return undefined;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && parsed.hostname.endsWith('.rbxcdn.com') ? parsed.toString() : undefined;
  } catch {
    return undefined;
  }
}

function flattenDiscoveryResults(payload) {
  const results = [];
  for (const candidate of discoveryCandidates(payload)) {
    const normalized = normalizeDiscoveryExperience(candidate);
    if (normalized) results.push(normalized);
  }
  return [...new Map(results.map((item) => [item.universeId, item])).values()];
}

class ExperienceDiscoveryProvider {
  constructor(client, experiences, options = {}) {
    this.client = client;
    this.experiences = experiences;
    // Keep the external compatibility source opt-in for library consumers;
    // the app enables it in createApiClients below after the official source
    // has been attempted.
    this.chartFallbackEnabled = options.chartFallbackEnabled === true;
  }

  async topCharts() {
    const sessionId = randomUUID();
    let sortId = 'top-playing-now';
    let officialError;
    let results = [];
    try {
      const sorts = await this.getSorts(sessionId);
      const sortIds = ['top-playing-now', 'top-trending', 'up-and-coming', 'top-revisited', 'fun-with-friends', 'top-earning'];
      const candidates = discoveryCandidates(sorts);
      const sort = sortIds.map((wanted) => candidates.find((item) => String(item?.sortId ?? item?.sortID ?? item?.id ?? '') === wanted)).find(Boolean)
        || candidates.find((item) => /top-playing-now|top[_-]?charts?|popular/i.test(String(item?.sortId ?? item?.sortID ?? item?.id ?? '')));
      sortId = String(sort?.sortId ?? sort?.sortID ?? sort?.id ?? sortId);
      const content = await this.getSortContent(sessionId, sortId);
      results = flattenDiscoveryResults(content);
    } catch (error) {
      officialError = error;
    }
    if (!results.length && this.chartFallbackEnabled) {
      try {
        const fallback = await this.fallbackCharts();
        if (fallback.results.length) return fallback;
      } catch (fallbackError) {
        if (!officialError) officialError = fallbackError;
      }
    }
    if (officialError && !results.length) {
      throw new RobloxApiError('Top charts are unavailable because Roblox returned no experience rows', { code: 'CHART_UNAVAILABLE', host: officialError.host, status: officialError.status });
    }
    if (!results.length) return { sortId, results };
    results = await this.hydrateChartResults(results);
    return { sortId, results };
  }

  async getSorts(sessionId) {
    let sorts = [];
    let sortsPageToken;
    for (let page = 0; page < 5; page += 1) {
      const query = new URLSearchParams({ device: 'computer', country: 'all', sessionId });
      if (sortsPageToken) query.set('sortsPageToken', sortsPageToken);
      const payload = await this.client.request('https://apis.roblox.com', `/explore-api/v1/get-sorts?${query}`, { cacheTtlMs: 120000 });
      sorts.push(payload);
      const next = typeof payload?.nextSortsPageToken === 'string' && payload.nextSortsPageToken ? payload.nextSortsPageToken : undefined;
      if (!next || next === sortsPageToken) break;
      sortsPageToken = next;
    }
    return sorts;
  }

  async getSortContent(sessionId, sortId) {
    let content = [];
    let pageToken;
    for (let page = 0; page < 3; page += 1) {
      const query = new URLSearchParams({ device: 'computer', country: 'all', sessionId, sortId });
      if (pageToken) query.set('pageToken', pageToken);
      const payload = await this.client.request('https://apis.roblox.com', `/explore-api/v1/get-sort-content?${query}`, { cacheTtlMs: 120000 });
      content.push(payload);
      const pageResults = flattenDiscoveryResults(payload);
      if (pageResults.length) break;
      const next = typeof payload?.nextPageToken === 'string' && payload.nextPageToken ? payload.nextPageToken : undefined;
      if (!next || next === pageToken) break;
      pageToken = next;
    }
    return content;
  }

  async hydrateChartResults(results, { hydrateAll = false } = {}) {
    // Chart entries often contain a universe ID and live player count but no
    // root place ID. Resolve those IDs in one anonymous Games API batch when
    // possible; the partial chart DTO is still returned if that enrichment is
    // unavailable so the renderer can show the chart and link to details.
    const unresolvedIds = results.filter((item) => hydrateAll || !item.rootPlaceId).map((item) => item.universeId).slice(0, 50);
    if (this.experiences && unresolvedIds.length) {
      try {
        const details = await this.experiences.getMany(unresolvedIds);
        const byUniverseId = new Map(details.map((item) => [item.universeId, item]));
        results = results.map((item) => {
          const detail = byUniverseId.get(item.universeId);
          if (!detail) return item;
          return {
            ...detail,
            ...item,
            rootPlaceId: item.rootPlaceId || detail.rootPlaceId,
            name: item.name === 'Untitled experience' ? detail.name : item.name,
            description: item.description || detail.description,
            creator: item.creator?.name && item.creator.name !== 'Unknown creator' ? item.creator : detail.creator,
            maxPlayers: item.maxPlayers || detail.maxPlayers,
            visits: item.visits || detail.visits,
            iconUrl: item.iconUrl || detail.iconUrl,
            thumbnailUrls: item.thumbnailUrls?.length ? item.thumbnailUrls : detail.thumbnailUrls
          };
        });
      } catch {
        // The chart itself remains useful even when Games API enrichment is
        // blocked or has a temporary schema/network failure.
      }
    }
    return results;
  }

  async fallbackCharts() {
    const payload = await this.client.request('https://api.rolimons.com', '/games/v1/gamelist', { cacheTtlMs: 300000, timeoutMs: 10000, retry: false });
    if (!payload?.success || !payload.games || typeof payload.games !== 'object' || Array.isArray(payload.games)) {
      throw new RobloxApiError('The fallback chart catalog returned an unsupported response', { code: 'CHART_UNAVAILABLE', host: 'api.rolimons.com' });
    }
    const candidates = Object.entries(payload.games).flatMap(([placeId, value]) => {
      if (!Array.isArray(value)) return [];
      const rootPlaceId = normalizeId(placeId);
      const name = typeof value[0] === 'string' ? value[0].trim() : '';
      const playerCount = Number(value[1]);
      if (!rootPlaceId || !name || !Number.isFinite(playerCount) || playerCount < 0) return [];
      const thumbnailUrl = normalizeRobloxCdnUrl(value[2]);
      return [{ rootPlaceId, name, playerCount, ...(thumbnailUrl ? { thumbnailUrls: [thumbnailUrl] } : {}) }];
    }).sort((a, b) => b.playerCount - a.playerCount).slice(0, 12);
    if (!candidates.length) throw new RobloxApiError('The fallback chart catalog contains no usable games', { code: 'CHART_UNAVAILABLE', host: 'api.rolimons.com' });

    const resolved = await Promise.all(candidates.map(async (candidate) => {
      try {
        const mapping = await this.client.request('https://apis.roblox.com', `/universes/v1/places/${candidate.rootPlaceId}/universe`, { cacheTtlMs: 300000, timeoutMs: 10000, retry: false });
        const universeId = normalizeId(mapping?.universeId ?? mapping?.id);
        if (!universeId) return undefined;
        return normalizeDiscoveryExperience({ ...candidate, universeId });
      } catch {
        return undefined;
      }
    }));
    const results = resolved.filter(Boolean);
    if (!results.length) throw new RobloxApiError('The fallback chart catalog could not resolve any Roblox universes', { code: 'CHART_UNAVAILABLE', host: 'apis.roblox.com' });
    return { sortId: 'top-playing-now', source: 'rolimons-fallback', results: await this.hydrateChartResults(results, { hydrateAll: true }) };
  }
}

function isUnavailableExperience(experience) {
  if (!experience || typeof experience !== 'object') return true;
  if (experience.isContentRestricted === true) return true;
  return /^\[(?:TITLE|DESCRIPTION) UNAVAILABLE\]$/i.test(String(experience.name || '').trim());
}

function normalizeFallbackExperience(fallback, universeId) {
  try { return normalizeExperience({ ...fallback, universeId: String(universeId) }); } catch { return undefined; }
}

function mergeUnavailableExperience(experience, fallback, universeId) {
  const normalizedFallback = normalizeFallbackExperience(fallback, universeId);
  if (!normalizedFallback) return experience;
  if (!experience) return normalizedFallback;
  if (!isUnavailableExperience(experience)) return experience;
  const hasUsableCreator = experience.creator?.name && !/^\[(?:UNKNOWN)\]$/i.test(experience.creator.name);
  const hasUsableName = experience.name && !/^\[(?:TITLE) UNAVAILABLE\]$/i.test(experience.name) && experience.name !== 'Untitled experience';
  const hasUsableDescription = experience.description && !/^\[(?:DESCRIPTION) UNAVAILABLE\]$/i.test(experience.description);
  return {
    ...normalizedFallback,
    ...experience,
    universeId: String(universeId),
    rootPlaceId: experience.rootPlaceId || normalizedFallback.rootPlaceId,
    name: hasUsableName ? experience.name : normalizedFallback.name,
    description: hasUsableDescription ? experience.description : normalizedFallback.description,
    creator: hasUsableCreator ? experience.creator : normalizedFallback.creator,
    playerCount: experience.playerCount > 0 ? experience.playerCount : normalizedFallback.playerCount,
    visits: experience.visits > 0 ? experience.visits : normalizedFallback.visits,
    maxPlayers: experience.maxPlayers > 0 ? experience.maxPlayers : normalizedFallback.maxPlayers,
    contentMaturity: experience.contentMaturity || normalizedFallback.contentMaturity,
    ageRecommendationDisplayName: experience.ageRecommendationDisplayName || normalizedFallback.ageRecommendationDisplayName,
    canonicalUrlPath: experience.canonicalUrlPath || normalizedFallback.canonicalUrlPath,
    iconUrl: experience.iconUrl || normalizedFallback.iconUrl,
    thumbnailUrls: experience.thumbnailUrls?.length ? experience.thumbnailUrls : normalizedFallback.thumbnailUrls
  };
}

class ExperienceRepository {
  constructor(client, authenticatedClient, searchProvider) {
    this.client = client;
    this.authenticatedClient = authenticatedClient && authenticatedClient !== client ? authenticatedClient : undefined;
    this.searchProvider = searchProvider;
  }

  async _getMany(client, universeIds, { cache = true } = {}) {
    if (!Array.isArray(universeIds) || universeIds.length < 1 || universeIds.length > 50) throw new ValidationError('up to 50 universe IDs are required');
    const ids = [...new Set(universeIds.map((id) => requireId(String(id), 'universeId')))];
    const options = cache ? { cacheTtlMs: 300000 } : {};
    const payload = await client.request('https://games.roblox.com', `/v1/games?universeIds=${encodeURIComponent(ids.join(','))}`, options);
    const data = Array.isArray(payload?.data) ? payload.data : [];
    return data.flatMap((item) => { try { return [normalizeExperience(item)]; } catch { return []; } });
  }

  async getMany(universeIds, options) {
    return this._getMany(this.client, universeIds, options);
  }

  async hasAuthenticatedSession() {
    const cookies = this.authenticatedClient?.session?.cookies;
    if (!cookies || typeof cookies.get !== 'function') return true;
    try {
      const values = await cookies.get({ url: 'https://www.roblox.com', name: '.ROBLOSECURITY' });
      return Array.isArray(values) && values.length > 0;
    } catch {
      return false;
    }
  }

  async getOne(universeId, fallback, { cache = true } = {}) {
    let experience;
    let lastError;
    try { [experience] = await this.getMany([universeId], { cache }); } catch (error) {
      lastError = error;
    }
    // Roblox may return a valid HTTP response containing only the restricted
    // placeholder for anonymous requests. If an isolated signed-in session
    // is available, retry through it before falling back to local card data.
    if ((!experience || isUnavailableExperience(experience)) && this.authenticatedClient && await this.hasAuthenticatedSession()) {
      try { [experience] = await this._getMany(this.authenticatedClient, [universeId], { cache }); }
      catch (error) { lastError ||= error; }
    }
    // A recent entry retains its root place ID. Roblox's search API can still
    // resolve that place to current public metadata when both Games API paths
    // return the restricted placeholder, so use it as a read-only fallback.
    if ((!experience || isUnavailableExperience(experience)) && this.searchProvider && fallback?.rootPlaceId) {
      try {
        const page = await this.searchProvider.search({ query: String(fallback.rootPlaceId) });
        const placeId = String(fallback.rootPlaceId);
        const match = (Array.isArray(page?.results) ? page.results : []).find((item) => String(item.rootPlaceId || '') === placeId || String(item.universeId || '') === String(universeId));
        if (match) experience = match;
      } catch (error) { lastError ||= error; }
    }
    let resolved = experience;
    if (fallback) resolved = mergeUnavailableExperience(resolved, fallback, universeId) || normalizeFallbackExperience(fallback, universeId);
    if (!resolved) {
      if (lastError) throw lastError;
      throw new RobloxApiError('Experience details are unavailable', { code: 'NOT_FOUND', status: 404 });
    }
    const thumbnails = await this.getThumbnails(resolved.universeId, { cache }).catch(() => ({ iconUrl: undefined, thumbnailUrls: [] }));
    return {
      ...resolved,
      ...(thumbnails.iconUrl ? { iconUrl: thumbnails.iconUrl } : {}),
      ...(thumbnails.thumbnailUrls?.length ? { thumbnailUrls: thumbnails.thumbnailUrls } : {})
    };
  }

  async getThumbnails(universeId, { cache = true } = {}) {
    const id = requireId(String(universeId), 'universeId');
    const options = cache ? { cacheTtlMs: 300000 } : {};
    const iconPayload = await this.client.request('https://thumbnails.roblox.com', `/v1/games/icons?universeIds=${id}&returnPolicy=PlaceHolder&size=150x150&format=Png&isCircular=false`, options);
    const icon = Array.isArray(iconPayload?.data) ? iconPayload.data.find((item) => normalizeId(item?.targetId) === id) : undefined;
    let iconUrl;
    if (icon) { try { iconUrl = normalizeThumbnail(icon).imageUrl; } catch { iconUrl = undefined; } }
    const mediaPayload = await this.client.request('https://thumbnails.roblox.com', `/v1/games/${id}/thumbnails?countPerUniverse=10&defaults=true&size=768x432&format=Png&isCircular=false`, options).catch(() => undefined);
    const thumbnailUrls = Array.isArray(mediaPayload?.data) ? mediaPayload.data.flatMap((item) => {
      try { return [normalizeThumbnail(item).imageUrl]; } catch { return []; }
    }) : [];
    return { iconUrl, thumbnailUrls };
  }
}

class ServerRepository {
  constructor(client, authenticatedClient) {
    this.client = client;
    this.authenticatedClient = authenticatedClient || client;
    // Keep the latest normalized private-server records in the main process.
    // The renderer receives only redacted flags, but a list response may be
    // the only place Roblox exposes a usable link/access code for a server.
    this.privateServerRecords = new Map();
  }

  rememberPrivatePage(page) {
    for (const server of page?.data || []) this.privateServerRecords.set(server.id, server);
    return page;
  }

  clearPrivateCache() {
    this.privateServerRecords.clear();
  }

  async listPublic({ placeId, sortOrder = 'Asc', limit = 25, cursor, excludeFullGames = true }) {
    const id = requireId(String(placeId), 'placeId');
    if (!['Asc', 'Desc'].includes(sortOrder)) throw new ValidationError('sortOrder is invalid');
    if (![10, 25, 50, 100].includes(Number(limit))) throw new ValidationError('limit is invalid');
    const params = new URLSearchParams({ sortOrder, limit: String(limit) });
    if (cursor) params.set('cursor', boundedString(cursor, 'cursor', 2048));
    if (excludeFullGames) params.set('excludeFullGames', 'true');
    const payload = await this.client.request('https://games.roblox.com', `/v1/games/${id}/servers/Public?${params}`, { cacheTtlMs: 10000 });
    const servers = Array.isArray(payload?.data) ? payload.data.flatMap((item) => { try { return [normalizeServer(item)]; } catch { return []; } }) : [];
    return { previousPageCursor: typeof payload?.previousPageCursor === 'string' ? payload.previousPageCursor : undefined, nextPageCursor: typeof payload?.nextPageCursor === 'string' ? payload.nextPageCursor : undefined, data: servers };
  }

  async listPrivateByPlace(placeId) {
    const id = requireId(String(placeId), 'placeId');
    const payload = await this.authenticatedClient.request('https://games.roblox.com', `/v1/games/${id}/private-servers?limit=100`, { cacheTtlMs: 30000 });
    return this.rememberPrivatePage(normalizePrivatePage(payload));
  }

  async getPrivate(vipServerId, { cache = true } = {}) {
    const id = requireId(String(vipServerId), 'vipServerId');
    const payload = await this.authenticatedClient.request('https://games.roblox.com', `/v1/vip-servers/${id}`, cache ? { cacheTtlMs: 30000 } : {});
    const server = normalizePrivateServer(payload?.data || payload);
    this.privateServerRecords.set(server.id, server);
    return server;
  }

  async joinPrivate({ vipServerId, placeId }) {
    const id = requireId(String(vipServerId), 'vipServerId');
    const cached = this.privateServerRecords.get(id);
    const requestedPlaceId = placeId === undefined ? undefined : requireId(String(placeId), 'placeId');
    // Prefer a code from the list response. Roblox can return 403 for the
    // metadata endpoint even when the signed-in user may join the server.
    // A place ID from the list is enough for the official-style fallback, so
    // do not make a second metadata request merely because no code was shown.
    let server = cached;
    let resolvedPlaceId = cached?.placeId || requestedPlaceId;
    if (!server && !resolvedPlaceId) {
      server = await this.getPrivate(id, { cache: false });
      resolvedPlaceId = server.placeId || requestedPlaceId;
    }
    if (!server) server = { id, placeId: resolvedPlaceId };
    if (!resolvedPlaceId) resolvedPlaceId = server.placeId;
    if (!resolvedPlaceId) throw new ValidationError('The private server response did not include a place ID');
    if (server.linkCode || cached?.linkCode) return { server, intent: { placeId: resolvedPlaceId, linkCode: server.linkCode || cached.linkCode } };
    if (server.accessCode || cached?.accessCode) return { server, intent: { placeId: resolvedPlaceId, accessCode: server.accessCode || cached.accessCode } };
    // Roblox's own private-server list can launch Player without exposing a
    // share/access code. The Player then applies the signed-in account's
    // permissions and may show its own “no permission” result. Keep the
    // attempt ID opaque and short-lived; it is not a server credential.
    return {
      server,
      intent: {
        placeId: resolvedPlaceId,
        // The private-server list can expose the stable UUID used by the
        // Roblox client. If it is absent, generate a normal attempt UUID so
        // the Player still receives the same no-code handoff shape.
        joinAttemptId: UUID_PATTERN.test(server.privateServerId || '') ? server.privateServerId : randomUUID(),
        joinAttemptOrigin: 'privateServerListJoin'
      }
    };
  }

  async isPrivateEnabled(universeId) {
    const id = requireId(String(universeId), 'universeId');
    const payload = await this.client.request('https://games.roblox.com', `/v1/private-servers/enabled-in-universe/${id}`, { cacheTtlMs: 30000 });
    return Boolean(payload?.enabled ?? payload?.isEnabled ?? payload?.data?.enabled);
  }

  async canInvite(userId) {
    const id = requireId(String(userId), 'userId');
    const payload = await this.authenticatedClient.request('https://games.roblox.com', `/v1/vip-server/can-invite/${id}`, { cacheTtlMs: 30000 });
    return payload;
  }

  async createPrivate({ universeId, body, confirmPurchase }) {
    if (confirmPurchase !== true) throw new ValidationError('Creating a private server requires explicit confirmation');
    const id = requireId(String(universeId), 'universeId');
    assertPlainObject(body, 'body');
    const safeBody = {};
    if (body.name !== undefined) safeBody.name = boundedString(body.name, 'name', 100);
    if (body.expectedPrice !== undefined) {
      if (!Number.isSafeInteger(body.expectedPrice) || body.expectedPrice < 0) throw new ValidationError('expectedPrice is invalid');
      safeBody.expectedPrice = body.expectedPrice;
    }
    const payload = await this.authenticatedClient.request('https://games.roblox.com', `/v1/games/vip-servers/${id}`, { method: 'POST', body: safeBody, csrf: true, retry: false });
    return normalizePrivateServer(payload?.data || payload);
  }

  async listMine() {
    try {
      const payload = await this.authenticatedClient.request('https://games.roblox.com', '/v1/private-servers/my-private-servers?limit=100', { cacheTtlMs: 30000, retry: false });
      return this.rememberPrivatePage(normalizePrivatePage(payload));
    } catch (error) {
      if (![404, 405, 501].includes(error.status)) throw error;
      const payload = await this.authenticatedClient.request('https://games.roblox.com', '/v1/vip-servers/my-private-servers?limit=100', { cacheTtlMs: 30000 });
      return this.rememberPrivatePage(normalizePrivatePage(payload));
    }
  }

  async updatePrivate({ vipServerId, operation, payload }) {
    const id = requireId(String(vipServerId), 'vipServerId');
    assertPlainObject(payload, 'payload');
    let path;
    if (operation === 'rename') {
      path = `/v1/vip-servers/${id}`;
      payload = { name: boundedString(payload.name, 'name', 100) };
    } else if (operation === 'regenerate-link-code') {
      path = `/v1/vip-servers/${id}`;
      if (payload.confirm !== true) throw new ValidationError('Regenerating a private-server link requires explicit confirmation');
      payload = { newJoinCode: true };
    } else if (operation === 'permissions') {
      path = `/v1/vip-servers/${id}/permissions`;
      for (const field of ['usersToAdd', 'usersToRemove']) {
        if (payload[field] !== undefined && !Array.isArray(payload[field])) throw new ValidationError(`${field} must be an array`);
      }
      payload = {
        ...(optionalBoolean(payload.friendsAllowed, 'friendsAllowed') === undefined ? {} : { friendsAllowed: payload.friendsAllowed }),
        ...(Array.isArray(payload.usersToAdd) ? { usersToAdd: payload.usersToAdd.map((userId) => requireId(String(userId), 'userId')) } : {}),
        ...(Array.isArray(payload.usersToRemove) ? { usersToRemove: payload.usersToRemove.map((userId) => requireId(String(userId), 'userId')) } : {})
      };
    } else if (operation === 'subscription') {
      path = `/v1/vip-servers/${id}/subscription`;
      if (typeof payload.active !== 'boolean') throw new ValidationError('subscription active must be boolean');
      if (payload.active === true && payload.confirmPurchase !== true) throw new ValidationError('Renewing a private-server subscription requires explicit confirmation');
      payload = { active: payload.active };
    } else throw new ValidationError('unsupported private-server operation');
    const response = await this.authenticatedClient.request('https://games.roblox.com', path, { method: 'PATCH', body: payload, csrf: true, retry: ['regenerate-link-code', 'subscription'].includes(operation) ? false : true });
    try { return normalizePrivateServer(response?.data || response); } catch { return { id, ...payload }; }
  }
}

function normalizePrivatePage(payload) {
  const candidates = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.privateServers) ? payload.privateServers : Array.isArray(payload) ? payload : [];
  const data = candidates.flatMap((item) => { try { return [normalizePrivateServer(item)]; } catch { return []; } });
  return { previousPageCursor: typeof payload?.previousPageCursor === 'string' ? payload.previousPageCursor : undefined, nextPageCursor: typeof payload?.nextPageCursor === 'string' ? payload.nextPageCursor : undefined, data };
}

// Private-server join codes are secrets. This DTO is the only shape that may
// cross the main/preload boundary; the main process keeps the actual code for
// the explicit join-by-ID operation.
function redactPrivateServer(value) {
  const source = value || {};
  const safe = {};
  for (const field of ['id', 'name', 'placeId', 'universeId', 'ownerId', 'active', 'friendsAllowed']) {
    if (source[field] !== undefined) safe[field] = source[field];
  }
  if (Array.isArray(source.users)) safe.users = source.users.slice();
  if (source.subscription && typeof source.subscription === 'object') {
    const subscription = {};
    for (const field of ['active', 'price', 'currencyCode', 'expirationDate', 'renewalDate', 'isRenewing']) {
      if (source.subscription[field] !== undefined) subscription[field] = source.subscription[field];
    }
    safe.subscription = subscription;
  }
  return {
    ...safe,
    hasLinkCode: Boolean(source.linkCode || source.privateServerLinkCode || source.joinCode),
    hasAccessCode: Boolean(source.accessCode || source.privateServerAccessCode || source.reservedServerAccessCode)
  };
}

function redactPrivatePage(page) {
  return { ...page, data: Array.isArray(page?.data) ? page.data.map(redactPrivateServer) : [] };
}

function createApiClients({ fetchImpl, authFetch, authSession } = {}) {
  const anonymous = new RobloxApiClient({ fetchImpl });
  const authenticated = new RobloxApiClient({ fetchImpl: authFetch || fetchImpl, session: authSession });
  const search = new ExperienceSearchProvider(anonymous);
  // Anonymous Games API calls can return a restricted placeholder even for
  // public experiences. Keep the isolated authenticated session as a second
  // source so signed-in users still get the full metadata contract.
  const experiences = new ExperienceRepository(anonymous, authenticated, search);
  return {
    anonymous,
    authenticated,
    search,
    discovery: new ExperienceDiscoveryProvider(anonymous, experiences, { chartFallbackEnabled: true }),
    experiences,
    servers: new ServerRepository(anonymous, authenticated)
  };
}

module.exports = {
  ALLOWED_API_HOSTS,
  RobloxApiError,
  TtlCache,
  HostRateLimiter,
  RobloxApiClient,
  ExperienceSearchProvider,
  ExperienceDiscoveryProvider,
  ExperienceRepository,
  ServerRepository,
  flattenSearchResults,
  flattenDiscoveryResults,
  normalizePrivatePage,
  redactPrivateServer,
  redactPrivatePage,
  createApiClients
};
