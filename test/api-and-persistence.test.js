const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  RobloxApiClient,
  RobloxApiError,
  ExperienceSearchProvider,
  ExperienceDiscoveryProvider,
  ExperienceRepository,
  flattenDiscoveryResults,
  ServerRepository,
  TtlCache,
  redactPrivatePage,
  redactPrivateServer
} = require('../src/main/roblox-client');
const { LocalStore } = require('../src/main/persistence');

function response(status, payload, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? headers[name] },
    text: async () => payload === undefined ? '' : JSON.stringify(payload)
  };
}

test('flattens search groups, deduplicates universes, and preserves pagination', async () => {
  let requested;
  const fetchImpl = async (url) => {
    requested = String(url);
    return response(200, {
      nextPageToken: 'next-token',
      searchResults: [
        { contentGroupType: 'Game', contents: [{ universeId: 1, rootPlaceId: 11, name: 'First', description: 'one' }, { universeId: 2, rootPlaceId: 22, name: 'Second' }] },
        { contentGroupType: 'Game', contents: [{ universeId: 1, rootPlaceId: 11, name: 'First duplicate' }] },
        { contentGroupType: 'User', contents: [{ id: 4, name: 'Ignored' }] }
      ]
    });
  };
  const provider = new ExperienceSearchProvider(new RobloxApiClient({ fetchImpl, cache: new TtlCache() }));
  const page = await provider.search({ query: 'obby', sessionId: 'session-1', pageToken: 'old-token' });
  assert.equal(page.results.length, 2);
  assert.equal(page.results[0].universeId, '1');
  assert.equal(page.nextPageToken, 'next-token');
  assert.match(requested, /searchQuery=obby/);
  assert.match(requested, /pageToken=old-token/);
});

test('normalizes discovery chart content and preserves the selected sort', async () => {
  const requests = [];
  const fetchImpl = async (url) => {
    requests.push(String(url));
    if (String(url).includes('/get-sorts?')) return response(200, { sorts: [{ sortId: 'top-playing-now' }, { sortId: 'recommended' }] });
    return response(200, { content: [{ universeId: 77, rootPlaceId: 88, name: 'Chart game', playing: 123 }] });
  };
  const provider = new ExperienceDiscoveryProvider(new RobloxApiClient({ fetchImpl, cache: new TtlCache() }));
  const page = await provider.topCharts();
  assert.equal(page.sortId, 'top-playing-now');
  assert.deepEqual(page.results.map((item) => item.universeId), ['77']);
  assert.equal(page.results[0].playerCount, 123);
  assert.equal(requests.length, 2);
  assert.match(requests[1], /sortId=top-playing-now/);
});

test('uses the Explore sort continuation token when the first page only contains filters', async () => {
  const sortRequests = [];
  const fetchImpl = async (url) => {
    const request = String(url);
    if (request.includes('/get-sorts?')) {
      sortRequests.push(request);
      return sortRequests.length === 1
        ? response(200, { sorts: [{ sortId: 'filters_v5', contentType: 'Filters' }], nextSortsPageToken: 'sort-page-2' })
        : response(200, { sorts: [{ sortId: 'top-playing-now', contentType: 'Games' }] });
    }
    return response(200, { content: [{ universeId: 77, rootPlaceId: 88, name: 'Chart game', playing: 123 }] });
  };
  const provider = new ExperienceDiscoveryProvider(new RobloxApiClient({ fetchImpl, cache: new TtlCache() }));
  const page = await provider.topCharts();
  assert.equal(page.sortId, 'top-playing-now');
  assert.equal(sortRequests.length, 2);
  assert.match(sortRequests[1], /sortsPageToken=sort-page-2/);
});

test('enriches chart entries that omit rootPlaceId', async () => {
  const requests = [];
  const fetchImpl = async (url) => {
    const request = String(url);
    requests.push(request);
    if (request.includes('/get-sorts?')) return response(200, { sorts: [{ sortId: 'top-playing-now' }] });
    if (request.includes('/get-sort-content?')) return response(200, { content: [{ universeId: 77, name: 'Chart game', playerCount: 123 }] });
    if (request.includes('games.roblox.com/v1/games?')) return response(200, { data: [{ id: 77, rootPlaceId: 88, name: 'Chart game', playing: 123 }] });
    throw new Error(`unexpected URL: ${request}`);
  };
  const client = new RobloxApiClient({ fetchImpl, cache: new TtlCache() });
  const provider = new ExperienceDiscoveryProvider(client, new ExperienceRepository(client));
  const page = await provider.topCharts();
  assert.equal(page.results.length, 1);
  assert.equal(page.results[0].universeId, '77');
  assert.equal(page.results[0].rootPlaceId, '88');
  assert.equal(page.results[0].playerCount, 123);
  assert.equal(requests.length, 3);
});

test('uses a bounded catalog fallback when Explore returns chart metadata without rows', async () => {
  const requests = [];
  const fetchImpl = async (url) => {
    const request = String(url);
    requests.push(request);
    if (request.includes('/get-sorts?')) return response(200, { sorts: [{ sortId: 'top-playing-now' }] });
    if (request.includes('/get-sort-content?')) return response(200, { contentType: 'Games', sortId: 'top-playing-now', nextPageToken: undefined });
    if (request.includes('api.rolimons.com/games/v1/gamelist')) return response(200, {
      success: true,
      games: {
        100: ['First fallback game', 900],
        200: ['Second fallback game', 400]
      }
    });
    if (request.includes('/universes/v1/places/100/universe')) return response(200, { universeId: 1000 });
    if (request.includes('/universes/v1/places/200/universe')) return response(200, { universeId: 2000 });
    if (request.includes('games.roblox.com/v1/games?universeIds=1000%2C2000')) return response(200, {
      data: [
        { id: 1000, rootPlaceId: 100, name: 'First fallback game', description: 'First', playing: 900 },
        { id: 2000, rootPlaceId: 200, name: 'Second fallback game', description: 'Second', playing: 400 }
      ]
    });
    throw new Error(`unexpected URL: ${request}`);
  };
  const client = new RobloxApiClient({ fetchImpl, cache: new TtlCache() });
  const provider = new ExperienceDiscoveryProvider(client, new ExperienceRepository(client), { chartFallbackEnabled: true });
  const page = await provider.topCharts();
  assert.equal(page.source, 'rolimons-fallback');
  assert.deepEqual(page.results.map((item) => [item.universeId, item.rootPlaceId, item.playerCount]), [['1000', '100', 900], ['2000', '200', 400]]);
  assert.match(requests.find((request) => request.includes('api.rolimons.com')), /gamelist/);
});

test('flattens nested discovery payloads without leaking malformed entries', () => {
  const result = flattenDiscoveryResults({ gameSet: [{ game: { universeId: 1, rootPlaceId: 2, name: 'Nested' } }, { universeId: 3, rootPlaceId: 4, name: 'Direct' }, { universeId: 5 }] });
  assert.deepEqual(result.map((item) => item.universeId), ['1', '3']);
});

test('retries one CSRF challenge for a mutation and then succeeds', async () => {
  let calls = 0;
  let csrfHeader;
  const fetchImpl = async (_url, options) => {
    calls += 1;
    csrfHeader = options.headers['x-csrf-token'];
    return calls === 1 ? response(403, { errors: [{ message: 'token validation failed' }] }, { 'x-csrf-token': 'csrf-1' }) : response(200, { id: 7, name: 'Renamed' });
  };
  const client = new RobloxApiClient({ fetchImpl });
  const result = await client.request('https://games.roblox.com', '/v1/vip-servers/7', { method: 'PATCH', body: { name: 'Renamed' }, csrf: true });
  assert.equal(calls, 2);
  assert.equal(csrfHeader, 'csrf-1');
  assert.deepEqual(result, { id: 7, name: 'Renamed' });
});

test('blocks unapproved request hosts before invoking fetch', async () => {
  let called = false;
  const client = new RobloxApiClient({ fetchImpl: async () => { called = true; return response(200, {}); } });
  await assert.rejects(() => client.request('https://example.com', '/anything'), (error) => error.code === 'HOST_NOT_ALLOWED');
  assert.equal(called, false);
});

test('normalizes public server pages and ignores malformed entries', async () => {
  const fetchImpl = async () => response(200, {
    previousPageCursor: null,
    nextPageCursor: 'next',
    data: [
      { id: 'f5b4b707-d397-4c6d-8484-50847584c1b8', maxPlayers: 8, playing: 2, ping: 40, fps: 60 },
      { id: 'bad id', maxPlayers: 8, playing: 2 }
    ]
  });
  const repository = new ServerRepository(new RobloxApiClient({ fetchImpl }));
  const page = await repository.listPublic({ placeId: '1818', limit: 25 });
  assert.equal(page.data.length, 1);
  assert.equal(page.data[0].playing, 2);
  assert.equal(page.nextPageCursor, 'next');
});

test('falls back to search metadata when details returns a restricted placeholder', async () => {
  const fetchImpl = async (url) => {
    const request = String(url);
    if (request.includes('games.roblox.com/v1/games?')) return response(200, { data: [{ id: 0, rootPlaceId: 0, name: '[TITLE UNAVAILABLE]', isContentRestricted: true }] });
    if (request.includes('thumbnails.roblox.com')) return response(200, { data: [] });
    throw new Error('unexpected URL');
  };
  const repository = new (require('../src/main/roblox-client').ExperienceRepository)(new RobloxApiClient({ fetchImpl }));
  const result = await repository.getOne('123', { universeId: '123', rootPlaceId: '456', name: 'Search result', description: 'Fallback' });
  assert.equal(result.universeId, '123');
  assert.equal(result.rootPlaceId, '456');
  assert.equal(result.name, 'Search result');
});

test('uses the signed-in Games API when anonymous details are restricted', async () => {
  const anonymousFetch = async (url) => {
    const request = String(url);
    if (request.includes('games.roblox.com/v1/games?')) return response(200, { data: [{ id: 0, rootPlaceId: 0, name: '[TITLE UNAVAILABLE]', isContentRestricted: true }] });
    if (request.includes('thumbnails.roblox.com')) return response(200, { data: [] });
    throw new Error(`unexpected anonymous URL: ${request}`);
  };
  const authenticatedFetch = async (url) => {
    const request = String(url);
    if (request.includes('games.roblox.com/v1/games?')) return response(200, { data: [{ id: 123, rootPlaceId: 456, name: 'Full details', description: 'A playable experience', playing: 42, visits: 9000, maxPlayers: 12 }] });
    throw new Error(`unexpected authenticated URL: ${request}`);
  };
  const authSession = { cookies: { get: async () => [{ name: '.ROBLOSECURITY' }] } };
  const repository = new ExperienceRepository(
    new RobloxApiClient({ fetchImpl: anonymousFetch }),
    new RobloxApiClient({ fetchImpl: authenticatedFetch, session: authSession })
  );
  const result = await repository.getOne('123', undefined, { cache: false });
  assert.equal(result.name, 'Full details');
  assert.equal(result.playerCount, 42);
  assert.equal(result.visits, 9000);
  assert.equal(result.maxPlayers, 12);
});

test('hydrates a recent item from search when both Games responses are restricted', async () => {
  const fetchImpl = async (url) => {
    const request = String(url);
    if (request.includes('games.roblox.com/v1/games?')) return response(200, { data: [{ id: 0, rootPlaceId: 0, name: '[TITLE UNAVAILABLE]', isContentRestricted: true }] });
    if (request.includes('thumbnails.roblox.com')) return response(200, { data: [] });
    throw new Error(`unexpected URL: ${request}`);
  };
  const searchProvider = {
    search: async ({ query }) => ({ results: [{ universeId: '123', rootPlaceId: query, name: 'Recovered experience', description: 'Recovered metadata', playerCount: 17 }] })
  };
  const repository = new ExperienceRepository(new RobloxApiClient({ fetchImpl }), undefined, searchProvider);
  const result = await repository.getOne('123', { universeId: '123', rootPlaceId: '456', name: 'Recent card' }, { cache: false });
  assert.equal(result.name, 'Recovered experience');
  assert.equal(result.rootPlaceId, '456');
  assert.equal(result.playerCount, 17);
});

test('stores private join codes encrypted when safeStorage is available', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'roblox-nav-'));
  const file = path.join(directory, 'state.json');
  const secureStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`encrypted:${value}`),
    decryptString: (value) => String(value).replace(/^encrypted:/, '')
  };
  const store = new LocalStore(file, secureStorage);
  const saved = store.savePrivateJoin({ label: 'My server', placeId: '1818', kind: 'linkCode', code: 'secret-code' });
  assert.equal(store.getPrivateJoinSecret(saved.id), 'secret-code');
  assert.equal(store.listPrivateJoins()[0].label, 'My server');
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /secret-code/);
  store.deletePrivateJoin(saved.id);
  assert.equal(store.listPrivateJoins().length, 0);
  fs.rmSync(directory, { recursive: true, force: true });
});

test('clears browsing history separately from saved private joins', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'roblox-nav-'));
  const store = new LocalStore(path.join(directory, 'state.json'));
  store.recordRecent({ universeId: '1', rootPlaceId: '2', name: 'Recent' });
  store.savePrivateJoin({ label: 'Saved', placeId: '2', kind: 'linkCode', code: 'secret' });
  store.clearBrowsingData();
  assert.equal(store.snapshot().recents.length, 0);
  assert.equal(store.listPrivateJoins().length, 1);
  store.forgetSavedPrivateJoins();
  assert.equal(store.listPrivateJoins().length, 0);
  fs.rmSync(directory, { recursive: true, force: true });
});

test('persists and clears the login proxy setting without exposing credentials', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'roblox-nav-'));
  const file = path.join(directory, 'state.json');
  const store = new LocalStore(file);
  store.setAuthProxy('socks5://127.0.0.1:1080');
  assert.equal(store.getAuthProxy(), 'socks5://127.0.0.1:1080');
  assert.match(fs.readFileSync(file, 'utf8'), /socks5:\/\/127\.0\.0\.1:1080/);
  store.setAuthProxy(undefined);
  assert.equal(store.getAuthProxy(), undefined);
  assert.equal(new LocalStore(file).getAuthProxy(), undefined);
  fs.rmSync(directory, { recursive: true, force: true });
});

test('maps authentication failures to a safe, renderer-friendly error', async () => {
  const client = new RobloxApiClient({ fetchImpl: async () => response(401, { errors: [{ message: 'missing auth' }] }) });
  await assert.rejects(() => client.request('https://games.roblox.com', '/v1/private-servers/my-private-servers'), (error) => {
    assert.equal(error.code, 'AUTH_REQUIRED');
    assert.equal(error.safeMessage, 'Roblox sign-in is required for this operation');
    return error instanceof RobloxApiError;
  });
});

test('includes the isolated session cookie jar for authenticated requests', async () => {
  let requestOptions;
  const authSession = {
    fetch: async (_url, options) => {
      requestOptions = options;
      return response(200, { data: [] });
    }
  };
  const client = new RobloxApiClient({ session: authSession });
  await client.request('https://games.roblox.com', '/v1/private-servers/my-private-servers', { retry: false });
  assert.equal(requestOptions.credentials, 'include');
});

test('requires confirmation before regenerating a private-server link', async () => {
  let body;
  const fetchImpl = async (_url, options) => { body = JSON.parse(options.body); return response(200, { id: 9, name: 'Server', linkCode: 'new-code' }); };
  const repository = new ServerRepository(new RobloxApiClient({ fetchImpl }));
  await assert.rejects(() => repository.updatePrivate({ vipServerId: '9', operation: 'regenerate-link-code', payload: {} }), /explicit confirmation/);
  const result = await repository.updatePrivate({ vipServerId: '9', operation: 'regenerate-link-code', payload: { confirm: true } });
  assert.deepEqual(body, { newJoinCode: true });
  assert.equal(result.id, '9');
  assert.equal(result.linkCode, 'new-code');
});

test('creates a private server for the selected experience', async () => {
  let requestedUrl;
  let requestedOptions;
  const fetchImpl = async (url, options) => {
    requestedUrl = String(url);
    requestedOptions = options;
    return response(200, { id: 9, universeId: 77, placeId: 1818, name: 'Mine' });
  };
  const repository = new ServerRepository(new RobloxApiClient({ fetchImpl }));
  const result = await repository.createPrivate({ universeId: '77', body: { name: 'Mine', expectedPrice: 0 }, confirmPurchase: true });
  assert.match(requestedUrl, /games\.roblox\.com\/v1\/games\/vip-servers\/77$/);
  assert.equal(requestedOptions.method, 'POST');
  assert.deepEqual(JSON.parse(requestedOptions.body), { name: 'Mine', expectedPrice: 0 });
  assert.equal(result.id, '9');
  assert.equal(result.universeId, '77');
});

test('serializes owned private-server access changes', async () => {
  let requestedOptions;
  const fetchImpl = async (_url, options) => {
    requestedOptions = options;
    return response(200, { id: 9, placeId: 1818, friendsAllowed: true });
  };
  const repository = new ServerRepository(new RobloxApiClient({ fetchImpl }));
  await repository.updatePrivate({ vipServerId: '9', operation: 'permissions', payload: { friendsAllowed: true, usersToAdd: ['11'], usersToRemove: ['12'] } });
  assert.equal(requestedOptions.method, 'PATCH');
  assert.deepEqual(JSON.parse(requestedOptions.body), { friendsAllowed: true, usersToAdd: ['11'], usersToRemove: ['12'] });
});

test('redacts private-server join codes from renderer DTOs', () => {
  const safe = redactPrivateServer({ id: '9', placeId: '1818', linkCode: 'secret-link', accessCode: 'secret-access', name: 'Server' });
  assert.equal(safe.hasLinkCode, true);
  assert.equal(safe.hasAccessCode, true);
  assert.equal('linkCode' in safe, false);
  assert.equal('accessCode' in safe, false);
  const page = redactPrivatePage({ data: [{ id: '9', privateServerLinkCode: 'secret-link', raw: { accessCode: 'secret-access' } }], nextPageCursor: 'next' });
  assert.deepEqual(page.data, [{ id: '9', hasLinkCode: true, hasAccessCode: false }]);
  assert.equal(page.nextPageCursor, 'next');
});

test('resolves a private-server join code in the main-process repository', async () => {
  const fetchImpl = async () => response(200, { id: 9, placeId: 1818, linkCode: 'private-link' });
  const repository = new ServerRepository(new RobloxApiClient({ fetchImpl }));
  const result = await repository.joinPrivate({ vipServerId: '9' });
  assert.deepEqual(result.intent, { placeId: '1818', linkCode: 'private-link' });
});

test('joins from the latest private-server list when metadata is forbidden', async () => {
  const requests = [];
  const fetchImpl = async (url) => {
    requests.push(String(url));
    return response(200, { data: [{ id: 9, placeId: 1818, name: 'Accessible server', privateServerLinkCode: 'list-link' }] });
  };
  const repository = new ServerRepository(new RobloxApiClient({ fetchImpl }));
  await repository.listPrivateByPlace('1818');
  const result = await repository.joinPrivate({ vipServerId: '9' });
  assert.deepEqual(result.intent, { placeId: '1818', linkCode: 'list-link' });
  // Joining uses the code already returned by the list instead of requesting
  // /v1/vip-servers/{id}, which may return 403 for an otherwise joinable row.
  assert.equal(requests.length, 1);
});

test('accepts alternate private-server access-code field names', async () => {
  const fetchImpl = async () => response(200, { data: [{ id: 9, placeId: 1818, privateServerAccessCode: 'access-code' }] });
  const repository = new ServerRepository(new RobloxApiClient({ fetchImpl }));
  await repository.listPrivateByPlace('1818');
  const result = await repository.joinPrivate({ vipServerId: '9' });
  assert.deepEqual(result.intent, { placeId: '1818', accessCode: 'access-code' });
});

test('merges concurrent private-list records without losing a join code', async () => {
  const requests = [];
  const fetchImpl = async (url) => {
    const request = String(url);
    requests.push(request);
    if (request.includes('/v1/games/')) return response(200, { data: [{ id: 9, placeId: 1818, privateServerLinkCode: 'list-link' }] });
    if (request.includes('/v1/private-servers/my-private-servers')) return response(200, { data: [{ id: 9, placeId: 1818, name: 'Owned row without code' }] });
    throw new Error(`unexpected URL: ${request}`);
  };
  const repository = new ServerRepository(new RobloxApiClient({ fetchImpl }));
  await Promise.all([repository.listPrivateByPlace('1818'), repository.listMine()]);
  const result = await repository.joinPrivate({ vipServerId: '9' });
  assert.deepEqual(result.intent, { placeId: '1818', linkCode: 'list-link' });
  assert.equal(requests.length, 2);
});

test('waits for an in-flight private list before resolving a join', async () => {
  const requests = [];
  let releaseOwned;
  const ownedGate = new Promise((resolve) => { releaseOwned = resolve; });
  const fetchImpl = async (url) => {
    const request = String(url);
    requests.push(request);
    if (request.includes('/v1/games/')) return response(200, { data: [{ id: 9, placeId: 1818, privateServerLinkCode: 'list-link' }] });
    if (request.includes('/v1/private-servers/my-private-servers')) {
      await ownedGate;
      return response(200, { data: [{ id: 9, placeId: 1818, name: 'Owned row without code' }] });
    }
    throw new Error(`unexpected URL: ${request}`);
  };
  const repository = new ServerRepository(new RobloxApiClient({ fetchImpl }));
  await repository.listPrivateByPlace('1818');
  const ownedLoad = repository.listMine();
  const join = repository.joinPrivate({ vipServerId: '9' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests.some((request) => request.includes('/v1/vip-servers/9')), false);
  releaseOwned();
  await ownedLoad;
  const result = await join;
  assert.deepEqual(result.intent, { placeId: '1818', linkCode: 'list-link' });
});

test('refuses a private join when Roblox exposes no private-session code', async () => {
  const requests = [];
  const fetchImpl = async (url) => {
    const request = String(url);
    requests.push(request);
    if (request.includes('/private-servers?')) return response(200, { data: [{ id: 9, placeId: 1818, name: 'Accessible server' }] });
    return response(200, { data: { id: 9, placeId: 1818, name: 'Accessible server' } });
  };
  const repository = new ServerRepository(new RobloxApiClient({ fetchImpl }));
  await repository.listPrivateByPlace('1818');
  await assert.rejects(() => repository.joinPrivate({ vipServerId: '9' }), (error) => {
    assert.equal(error.code, 'PRIVATE_SESSION_UNAVAILABLE');
    assert.match(error.message, /No public server was opened/);
    return true;
  });
  assert.equal(requests.length, 2);
});

test('does not launch matchmaking when only a private row place ID is supplied', async () => {
  let called = false;
  const repository = new ServerRepository(new RobloxApiClient({ fetchImpl: async () => { called = true; return response(403, {}); } }));
  await assert.rejects(() => repository.joinPrivate({ vipServerId: '9', placeId: '1818' }), (error) => error.code === 'PRIVATE_SESSION_UNAVAILABLE');
  assert.equal(called, true);
});

test('does not treat a private-server UUID as a join session', async () => {
  const fetchImpl = async () => response(200, { data: [{ id: 9, placeId: 1818, privateServerId: 'f5b4b707-d397-4c6d-8484-50847584c1b8' }] });
  const repository = new ServerRepository(new RobloxApiClient({ fetchImpl }));
  await repository.listPrivateByPlace('1818');
  await assert.rejects(() => repository.joinPrivate({ vipServerId: '9' }), (error) => error.code === 'PRIVATE_SESSION_UNAVAILABLE');
});

test('does not automatically retry subscription mutations', async () => {
  let calls = 0;
  let retryOption;
  const fetchImpl = async (_url, options) => {
    calls += 1;
    retryOption = options;
    return response(503, { errors: [{ message: 'temporarily unavailable' }] });
  };
  const repository = new ServerRepository(new RobloxApiClient({ fetchImpl }));
  await assert.rejects(() => repository.updatePrivate({ vipServerId: '9', operation: 'subscription', payload: { active: false } }), (error) => error.code === 'SERVICE_UNAVAILABLE');
  assert.equal(calls, 1);
  assert.equal(retryOption.method, 'PATCH');
});

test('requires confirmation before subscription renewal', async () => {
  const repository = new ServerRepository(new RobloxApiClient({ fetchImpl: async () => response(200, {}) }));
  await assert.rejects(() => repository.updatePrivate({ vipServerId: '9', operation: 'subscription', payload: { active: true } }), /explicit confirmation/);
});

test('falls back to the legacy owned-private-server route on route drift', async () => {
  const requests = [];
  const fetchImpl = async (url) => {
    requests.push(String(url));
    if (requests.length === 1) return response(501, { errors: [{ message: 'route unavailable' }] });
    return response(200, { data: [{ id: 9, name: 'Owned server', placeId: 1818 }] });
  };
  const repository = new ServerRepository(new RobloxApiClient({ fetchImpl }));
  const page = await repository.listMine();
  assert.equal(page.data[0].id, '9');
  assert.match(requests[1], /vip-servers\/my-private-servers/);
});
