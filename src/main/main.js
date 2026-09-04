const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { randomUUID } = require('node:crypto');
const {
  app,
  BrowserWindow,
  ipcMain,
  net,
  protocol,
  safeStorage,
  session,
  shell
} = require('electron');

const { LocalStore } = require('./persistence');
const { buildLaunchUri, classifyJoinIntent } = require('./launch-uri');
const { parsePrivateServerLink } = require('./private-link');
const {
  RobloxApiError,
  createApiClients,
  redactPrivatePage,
  redactPrivateServer
} = require('./roblox-client');
const {
  ValidationError,
  assertPlainObject,
  boundedString,
  optionalBoolean,
  requireCode,
  requireId
} = require('./validation');

const APP_SCHEME = 'app';
const APP_HOST = 'ui';
const APP_NAME = 'Roblox Explorer';
const AUTH_PARTITION = 'persist:roblox-auth';
// Legacy private-server endpoints can drift independently of anonymous APIs.
// Keep a deployment-time kill switch so a broken contract can be disabled
// without changing the renderer or accepting unsafe fallback behavior.
const PRIVATE_SERVER_MANAGEMENT_ENABLED = process.env.ROBLOX_NAVIGATOR_PRIVATE_SERVERS !== '0';
// Creation and renewal can spend Robux. They remain opt-in until a current
// authenticated contract test has verified the exact request and price flow.
const PRIVATE_SERVER_PURCHASES_ENABLED = process.env.ROBLOX_NAVIGATOR_PRIVATE_PURCHASES === '1';
const AUTH_PROXY_ENV = 'ROBLOX_NAVIGATOR_AUTH_PROXY';
const AUTH_ORIGINS = new Set([
  'www.roblox.com',
  'auth.roblox.com',
  'apis.roblox.com',
  'games.roblox.com',
  'users.roblox.com',
  'accountinformation.roblox.com',
  'create.roblox.com'
]);

protocol.registerSchemesAsPrivileged([{
  scheme: APP_SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: false, stream: true }
}]);

let mainWindow;
let authWindow;
let authSession;
let store;
let clients;
let authProxyApplied = false;
let authProxyWatchTimer;
let authProxyCookieListener;

function safeError(error) {
  if (error instanceof ValidationError || error instanceof RobloxApiError) {
    return { code: error.code || 'ERROR', message: error.safeMessage || error.message, status: error.status, host: error.host, retryAfterMs: error.retryAfterMs };
  }
  return { code: 'INTERNAL_ERROR', message: 'The operation could not be completed' };
}

function trustedSender(event) {
  try {
    const frameUrl = event.senderFrame?.url;
    const parsed = new URL(frameUrl);
    return parsed.protocol === `${APP_SCHEME}:` && parsed.hostname === APP_HOST;
  } catch {
    return false;
  }
}

function registerHandler(channel, handler) {
  ipcMain.handle(channel, async (event, input) => {
    if (!trustedSender(event)) throw safeError(new ValidationError('untrusted IPC sender'));
    try {
      return await handler(input, event);
    } catch (error) {
      throw safeError(error);
    }
  });
}

function isAllowedAuthUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    return parsed.protocol === 'https:' && AUTH_ORIGINS.has(parsed.hostname);
  } catch {
    return false;
  }
}

function storedAuthProxy() {
  return store?.getAuthProxy?.();
}

function configuredAuthProxy() {
  const saved = storedAuthProxy();
  return saved !== undefined ? saved : process.env[AUTH_PROXY_ENV];
}

function authProxyRules(raw = configuredAuthProxy()) {
  if (!raw) return undefined;
  if (typeof raw !== 'string' || raw.length > 512 || /[\u0000-\u001f\u007f]/.test(raw)) {
    throw new ValidationError(`${AUTH_PROXY_ENV} is invalid`);
  }
  let parsed;
  try { parsed = new URL(raw); } catch { throw new ValidationError(`${AUTH_PROXY_ENV} must be a proxy URL`); }
  // WHATWG URL leaves the path empty for bare SOCKS endpoints (for example
  // socks4://127.0.0.1:1080), while HTTP URLs are normalized to "/".
  const rootPath = parsed.pathname === '' || parsed.pathname === '/';
  if (!['http:', 'https:', 'socks4:', 'socks5:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password || !rootPath || parsed.search || parsed.hash) {
    throw new ValidationError(`${AUTH_PROXY_ENV} must be an HTTP(S) or SOCKS proxy URL without credentials or a path`);
  }
  return raw;
}

async function configureAuthSessionProxy(targetSession) {
  const proxyRules = authProxyRules();
  if (!proxyRules) {
    if (authProxyApplied) await disableAuthSessionProxy();
    return false;
  }
  if (typeof targetSession.setProxy !== 'function') throw new RobloxApiError('This Electron build does not support auth-session proxy configuration', { code: 'AUTH_PROXY_UNSUPPORTED' });
  await targetSession.setProxy({ mode: 'fixed_servers', proxyRules });
  authProxyApplied = true;
  return true;
}

function stopAuthProxyWatch() {
  if (authProxyWatchTimer) clearInterval(authProxyWatchTimer);
  authProxyWatchTimer = undefined;
}

function notifyAuthState(status) {
  if (!mainWindow || mainWindow.isDestroyed?.()) return;
  mainWindow.webContents.send('auth-state-changed', status);
}

function completeAuth(status) {
  if (status.authenticated && authWindow && !authWindow.isDestroyed()) authWindow.close();
  notifyAuthState(status);
}

async function disableAuthSessionProxy() {
  stopAuthProxyWatch();
  if (!authProxyApplied || !authSession) return;
  if (typeof authSession.setProxy !== 'function') {
    authProxyApplied = false;
    return;
  }
  try {
    await authSession.setProxy({ mode: 'direct' });
    authProxyApplied = false;
    // Electron may retain pooled sockets after a proxy change. Close them so
    // subsequent private-server requests cannot reuse the login proxy.
    if (typeof authSession.closeAllConnections === 'function') await authSession.closeAllConnections();
  } catch (error) {
    console.warn('Could not restore direct auth-session networking:', error?.message || error);
  }
}

function startAuthProxyWatch() {
  stopAuthProxyWatch();
  authProxyWatchTimer = setInterval(() => {
    if (!authProxyApplied) return stopAuthProxyWatch();
    void authStatus().then((status) => {
      if (status.authenticated) completeAuth(status);
      return undefined;
    }).catch(() => undefined);
  }, 1000);
}

function watchAuthCookie() {
  const cookies = authSession?.cookies;
  if (!cookies || typeof cookies.on !== 'function' || authProxyCookieListener) return;
  authProxyCookieListener = (_event, cookie, _cause, _removed) => {
    if (cookie?.name !== '.ROBLOSECURITY') return;
    void authStatus().then((status) => {
      // Completing the official login flow is the one case where the
      // sign-in window should dismiss itself. Other focus changes never do.
      completeAuth(status);
      return undefined;
    }).catch(() => undefined);
  };
  cookies.on('changed', authProxyCookieListener);
}

function authProxyConfig() {
  const saved = storedAuthProxy();
  const environment = process.env[AUTH_PROXY_ENV];
  const effective = saved !== undefined ? saved : environment;
  let valid = true;
  let error;
  if (effective) {
    try { authProxyRules(effective); }
    catch (validationError) { valid = false; error = safeError(validationError).message; }
  }
  return {
    // Never echo an invalid persisted value (which could contain credentials)
    // back across IPC. The user can clear it and enter a validated URL.
    authProxy: valid && saved ? saved : '',
    source: saved !== undefined ? 'saved' : environment ? 'environment' : 'system',
    configured: Boolean(effective),
    active: authProxyApplied,
    valid,
    error
  };
}

function configureAuthWindowSecurity(window) {
  window.webContents.setWindowOpenHandler(({ url }) => {
    // Do not allow auth content to open arbitrary external applications/windows.
    // A future OAuth flow can explicitly add a verified callback destination.
    void url;
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (!isAllowedAuthUrl(url)) event.preventDefault();
  });
  window.webContents.on('will-redirect', (event, url) => {
    if (!isAllowedAuthUrl(url)) event.preventDefault();
  });
}

async function authStatus() {
  if (!authSession) return { authenticated: false, mode: 'unavailable', privatePurchasesEnabled: PRIVATE_SERVER_PURCHASES_ENABLED };
  try {
    const cookies = await authSession.cookies.get({ url: 'https://www.roblox.com', name: '.ROBLOSECURITY' });
    const authenticated = cookies.length > 0;
    // Make every auth-status check a direct-network boundary after login so
    // an API call cannot race the cookie watcher and reuse the login proxy.
    if (authenticated && authProxyApplied) await disableAuthSessionProxy();
    return { authenticated, mode: 'legacy-web-session', privatePurchasesEnabled: PRIVATE_SERVER_PURCHASES_ENABLED };
  } catch {
    return { authenticated: false, mode: 'legacy-web-session', privatePurchasesEnabled: PRIVATE_SERVER_PURCHASES_ENABLED };
  }
}

async function createAuthWindow() {
  if (authWindow && !authWindow.isDestroyed()) {
    authWindow.focus();
    return authStatus();
  }
  authSession = session.fromPartition(AUTH_PARTITION);
  watchAuthCookie();
  if ((await authStatus()).authenticated) await disableAuthSessionProxy();
  else if (await configureAuthSessionProxy(authSession)) startAuthProxyWatch();
  clients = createApiClients({ fetchImpl: net.fetch.bind(net), authFetch: authSession.fetch.bind(authSession), authSession });
  authWindow = new BrowserWindow({
    width: 560,
    height: 760,
    parent: mainWindow,
    // Keep the login window attached to the main window but non-modal so the
    // app remains usable while sign-in is in progress. It is dismissed only
    // through its native window controls (or the explicit sign-out cleanup).
    modal: false,
    title: 'Sign in to Roblox',
    icon: path.resolve(__dirname, '../../avatar.jpeg'),
    webPreferences: {
      session: authSession,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webviewTag: false,
      devTools: false
    }
  });
  configureAuthWindowSecurity(authWindow);
  authWindow.on('closed', () => {
    authWindow = undefined;
    void disableAuthSessionProxy();
  });
  try {
    await authWindow.loadURL('https://www.roblox.com/login');
  } catch {
    await disableAuthSessionProxy();
    if (authWindow && !authWindow.isDestroyed()) authWindow.close();
    throw new RobloxApiError(`Roblox web login is unreachable from this network. Use a network/VPN/proxy that permits www.roblox.com, then try again. A trusted local proxy can be configured with ${AUTH_PROXY_ENV}.`, { code: 'AUTH_WEB_UNAVAILABLE', host: 'www.roblox.com' });
  }
  return authStatus();
}

async function clearAuthSession() {
  if (!authSession) {
    authSession = session.fromPartition(AUTH_PARTITION);
    configureAuthSessionSecurity(authSession);
  }
  await authSession.clearStorageData({ storages: ['cookies', 'localstorage', 'indexdb', 'serviceworkers', 'cachestorage', 'shadercache'] });
  if (typeof authSession.clearCache === 'function') await authSession.clearCache();
  await disableAuthSessionProxy();
  clients?.servers?.clearPrivateCache?.();
  if (authWindow && !authWindow.isDestroyed()) authWindow.close();
  clients = createApiClients({ fetchImpl: net.fetch.bind(net), authFetch: authSession.fetch.bind(authSession), authSession });
}

async function handoffToPlayer(uri) {
  try {
    await shell.openExternal(uri);
  } catch {
    throw new RobloxApiError('Roblox Player is not registered for the roblox: protocol on this device', { code: 'PROTOCOL_UNAVAILABLE' });
  }
}

function registerAppProtocol() {
  const rendererRoot = path.resolve(__dirname, '../renderer');
  const avatarPath = path.resolve(__dirname, '../../avatar.jpeg');
  protocol.handle(APP_SCHEME, async (request) => {
    let parsed;
    try { parsed = new URL(request.url); } catch { return new Response('Bad request', { status: 400 }); }
    if (parsed.hostname !== APP_HOST) return new Response('Not found', { status: 404 });
    let requestedPath;
    try { requestedPath = decodeURIComponent(parsed.pathname === '/' ? '/index.html' : parsed.pathname); } catch { return new Response('Bad request', { status: 400 }); }
    const isPublicAsset = requestedPath === '/avatar.jpeg';
    const candidate = isPublicAsset ? avatarPath : path.resolve(rendererRoot, `.${requestedPath}`);
    if (!isPublicAsset && !candidate.startsWith(`${rendererRoot}${path.sep}`)) return new Response('Forbidden', { status: 403 });
    try { return await net.fetch(pathToFileURL(candidate).toString()); } catch { return new Response('Not found', { status: 404 }); }
  });
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    title: APP_NAME,
    icon: path.resolve(__dirname, '../../avatar.jpeg'),
    backgroundColor: '#0f1117',
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webviewTag: false,
      devTools: true
    }
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(`${APP_SCHEME}://${APP_HOST}/`)) event.preventDefault();
  });
  mainWindow.loadURL(`${APP_SCHEME}://${APP_HOST}/index.html`);
}

function configurePermissions() {
  const deny = (_webContents, _permission, callback) => callback(false);
  session.defaultSession.setPermissionRequestHandler(deny);
  session.defaultSession.setPermissionCheckHandler(() => false);
  if (typeof session.defaultSession.on === 'function') session.defaultSession.on('will-download', (_event, item) => item.cancel());
}

function configureAuthSessionSecurity(targetSession) {
  const deny = (_webContents, _permission, callback) => callback(false);
  targetSession.setPermissionRequestHandler(deny);
  targetSession.setPermissionCheckHandler(() => false);
  targetSession.on('will-download', (_event, item) => item.cancel());
}

function validateSearchInput(input) {
  assertPlainObject(input, 'search input');
  const query = boundedString(input.query, 'query', 200).trim();
  if (!query) throw new ValidationError('Search query cannot be empty');
  return { query, sessionId: input.sessionId ? boundedString(input.sessionId, 'sessionId', 128) : undefined, pageToken: input.pageToken ? boundedString(input.pageToken, 'pageToken', 2048) : undefined };
}

function validateJoinIntent(input) {
  assertPlainObject(input, 'join intent');
  const format = validateLaunchFormat(input.format);
  const intent = {
    placeId: requireId(String(input.placeId ?? ''), 'placeId'),
    gameInstanceId: input.gameInstanceId,
    linkCode: input.linkCode,
    accessCode: input.accessCode,
    userId: input.userId,
    launchData: input.launchData,
    joinAttemptId: input.joinAttemptId,
    joinAttemptOrigin: input.joinAttemptOrigin
  };
  classifyJoinIntent(intent);
  return { intent, format };
}

function validateLaunchFormat(value) {
  if (value !== undefined && !['modern', 'legacy'].includes(value)) throw new ValidationError('join format is invalid');
  return value || 'modern';
}

function validateAuthProxyInput(input) {
  assertPlainObject(input, 'auth proxy input');
  const raw = input.proxy === undefined ? '' : boundedString(input.proxy, 'proxy', 512).trim();
  if (raw) authProxyRules(raw);
  return raw || undefined;
}

function requirePrivateServerManagement() {
  if (!PRIVATE_SERVER_MANAGEMENT_ENABLED) {
    throw new RobloxApiError('Private-server management is disabled while the Roblox API contract is being verified', { code: 'FEATURE_DISABLED' });
  }
}

function requirePrivatePurchaseOperations() {
  if (!PRIVATE_SERVER_PURCHASES_ENABLED) {
    throw new RobloxApiError('Private-server creation and renewal are disabled until the current Robux request contract is verified', { code: 'FEATURE_DISABLED' });
  }
}

function setupIpc() {
  registerHandler('search-experiences', async (input) => clients.search.search(validateSearchInput(input)));
  registerHandler('get-experience', async (input) => {
    assertPlainObject(input, 'experience input');
    const universeId = requireId(String(input.universeId ?? ''), 'universeId');
    optionalBoolean(input.cache, 'cache');
    const fallback = input.fallback && typeof input.fallback === 'object' ? input.fallback : undefined;
    const experience = await clients.experiences.getOne(universeId, fallback, { cache: input.cache !== false });
    if (input.recordRecent !== false) store.recordRecent(experience);
    return experience;
  });
  registerHandler('get-experience-thumbnails', async (input) => {
    assertPlainObject(input, 'thumbnail input');
    return clients.experiences.getThumbnails(requireId(String(input.universeId ?? ''), 'universeId'));
  });
  registerHandler('get-top-charts', async () => clients.discovery.topCharts());
  registerHandler('list-public-servers', async (input) => {
    assertPlainObject(input, 'server input');
    return clients.servers.listPublic({
      placeId: requireId(String(input.placeId ?? ''), 'placeId'),
      sortOrder: input.sortOrder,
      limit: input.limit === undefined ? 25 : Number(input.limit),
      cursor: input.cursor,
      excludeFullGames: input.excludeFullGames !== false
    });
  });
  registerHandler('join', async (input) => {
    const { intent, format } = validateJoinIntent(input);
    const uri = buildLaunchUri(intent, format);
    await handoffToPlayer(uri);
    return { accepted: true, format, kind: classifyJoinIntent(intent), uri: uri.replace(/(linkCode|accessCode)=[^&]+/g, '$1=[redacted]') };
  });
  registerHandler('parse-private-link', async (input) => {
    if (typeof input !== 'string') throw new ValidationError('private link input must be text');
    return parsePrivateServerLink(input);
  });
  registerHandler('list-saved-private-joins', async () => store.listPrivateJoins());
  registerHandler('save-private-join', async (input) => {
    assertPlainObject(input, 'saved private join');
    if (!['linkCode', 'accessCode'].includes(input.kind)) throw new ValidationError('private-server code kind is invalid');
    const kind = input.kind;
    return store.savePrivateJoin({
      id: input.id === undefined ? undefined : boundedString(input.id, 'saved join id', 200),
      label: input.label ? boundedString(input.label, 'label', 100) : 'Saved private server',
      placeId: input.placeId ? requireId(String(input.placeId), 'placeId') : undefined,
      kind,
      code: requireCode(input.code, 'private-server code')
    });
  });
  registerHandler('delete-saved-private-join', async (input) => {
    assertPlainObject(input, 'saved private join');
    store.deletePrivateJoin(boundedString(input.id, 'saved join id', 200));
    return store.listPrivateJoins();
  });
  registerHandler('use-saved-private-join', async (input) => {
    assertPlainObject(input, 'saved private join');
    const format = validateLaunchFormat(input.format);
    const id = boundedString(input.id, 'saved join id', 200);
    const entry = store.listPrivateJoins().find((candidate) => candidate.id === id);
    if (!entry) throw new ValidationError('saved private server was not found');
    const code = store.getPrivateJoinSecret(id);
    if (!code) throw new ValidationError('saved private server code is unavailable; save it again');
    store.touchPrivateJoin(id);
    if (!entry.placeId) throw new ValidationError('this saved code needs a place ID before it can be joined');
    const intent = entry.kind === 'accessCode' ? { placeId: entry.placeId, accessCode: code } : { placeId: entry.placeId, linkCode: code };
    const uri = buildLaunchUri(intent, format);
    await handoffToPlayer(uri);
    return { accepted: true, format, kind: entry.kind };
  });
  registerHandler('toggle-favorite', async (input) => {
    assertPlainObject(input, 'favorite input');
    return { favorited: store.toggleFavorite(requireId(String(input.universeId), 'universeId')) };
  });
  registerHandler('get-local-state', async () => store.snapshot());
  registerHandler('get-auth-status', async () => authStatus());
  registerHandler('get-auth-config', async () => authProxyConfig());
  registerHandler('set-auth-proxy', async (input) => {
    const nextProxy = validateAuthProxyInput(input);
    const previousProxy = store.getAuthProxy();
    store.setAuthProxy(nextProxy);
    try {
      // Keep API traffic direct. If a login window is currently using the
      // proxy, update that session immediately; otherwise this applies on
      // the next sign-in attempt.
      if (authProxyApplied) await configureAuthSessionProxy(authSession);
      return authProxyConfig();
    } catch (error) {
      store.setAuthProxy(previousProxy);
      if (authProxyApplied) {
        try { await configureAuthSessionProxy(authSession); } catch { /* preserve the original error */ }
      }
      throw error;
    }
  });
  registerHandler('begin-sign-in', async () => createAuthWindow());
  registerHandler('sign-out', async () => { await clearAuthSession(); return authStatus(); });
  registerHandler('clear-browsing-data', async () => {
    store.clearBrowsingData();
    clients.anonymous.clearCache();
    clients.authenticated.clearCache();
    clients.servers.clearPrivateCache();
    if (typeof session.defaultSession.clearCache === 'function') await session.defaultSession.clearCache();
    return store.snapshot();
  });
  registerHandler('forget-saved-private-joins', async () => {
    store.forgetSavedPrivateJoins();
    return store.listPrivateJoins();
  });
  registerHandler('list-private-servers', async (input) => {
    assertPlainObject(input, 'private server input');
    requirePrivateServerManagement();
    optionalBoolean(input.mine, 'mine');
    const status = await authStatus();
    if (!status.authenticated) throw new RobloxApiError('Sign in to Roblox to list private servers', { code: 'AUTH_REQUIRED', status: 401 });
    const page = input.mine ? await clients.servers.listMine() : await clients.servers.listPrivateByPlace(requireId(String(input.placeId ?? ''), 'placeId'));
    return redactPrivatePage(page);
  });
  registerHandler('get-private-server', async (input) => {
    assertPlainObject(input, 'private server input');
    requirePrivateServerManagement();
    optionalBoolean(input.cache, 'cache');
    const status = await authStatus();
    if (!status.authenticated) throw new RobloxApiError('Sign in to Roblox to view private servers', { code: 'AUTH_REQUIRED', status: 401 });
    const server = await clients.servers.getPrivate(requireId(String(input.vipServerId ?? ''), 'vipServerId'), { cache: input.cache !== false });
    return redactPrivateServer(server);
  });
  registerHandler('join-private-server', async (input) => {
    assertPlainObject(input, 'private server input');
    requirePrivateServerManagement();
    const status = await authStatus();
    if (!status.authenticated) throw new RobloxApiError('Sign in to Roblox to join this private server', { code: 'AUTH_REQUIRED', status: 401 });
    const vipServerId = requireId(String(input.vipServerId ?? ''), 'vipServerId');
    const placeId = input.placeId === undefined ? undefined : requireId(String(input.placeId), 'placeId');
    const format = validateLaunchFormat(input.format);
    const { intent } = await clients.servers.joinPrivate({ vipServerId, placeId });
    const uri = buildLaunchUri(intent, format);
    await handoffToPlayer(uri);
    return { accepted: true, format, kind: classifyJoinIntent(intent), uri: uri.replace(/(linkCode|accessCode)=[^&]+/g, '$1=[redacted]') };
  });
  registerHandler('create-private-server', async (input) => {
    assertPlainObject(input, 'private server input');
    requirePrivateServerManagement();
    requirePrivatePurchaseOperations();
    const status = await authStatus();
    if (!status.authenticated) throw new RobloxApiError('Sign in to Roblox to create private servers', { code: 'AUTH_REQUIRED', status: 401 });
    if (input.confirmPurchase !== true) throw new ValidationError('Creating a private server requires explicit confirmation');
    return redactPrivateServer(await clients.servers.createPrivate(input));
  });
  registerHandler('update-private-server', async (input) => {
    assertPlainObject(input, 'private server update');
    requirePrivateServerManagement();
    if (input.operation === 'subscription' && input.payload?.active === true) requirePrivatePurchaseOperations();
    const status = await authStatus();
    if (!status.authenticated) throw new RobloxApiError('Sign in to Roblox to update private servers', { code: 'AUTH_REQUIRED', status: 401 });
    return redactPrivateServer(await clients.servers.updatePrivate(input));
  });
  registerHandler('run-connectivity-check', async () => runConnectivityCheck());
}

async function runConnectivityCheck() {
  const checks = [];
  const probes = [
    ['search-api', () => clients.anonymous.request('https://apis.roblox.com', `/search-api/omni-search?searchQuery=obby&sessionId=${randomUUID()}&pageType=all`, { timeoutMs: 10000 })],
    ['games-api', () => clients.anonymous.request('https://games.roblox.com', '/v1/games?universeIds=920587237', { timeoutMs: 10000 })],
    ['thumbnail-api', () => clients.anonymous.request('https://thumbnails.roblox.com', '/v1/games/icons?universeIds=13058&returnPolicy=PlaceHolder&size=150x150&format=Png&isCircular=false', { timeoutMs: 10000 })]
  ];
  for (const [name, probe] of probes) {
    const startedAt = Date.now();
    try { await probe(); checks.push({ name, status: 'ok', latencyMs: Date.now() - startedAt }); }
    catch (error) { checks.push({ name, status: 'error', latencyMs: Date.now() - startedAt, error: safeError(error) }); }
  }
  const auth = await authStatus();
  return { checks, auth, generatedAt: new Date().toISOString() };
}

async function bootstrap() {
  await app.whenReady();
  app.setName(APP_NAME);
  const avatarPath = path.resolve(__dirname, '../../avatar.jpeg');
  if (typeof app.setAboutPanelOptions === 'function') app.setAboutPanelOptions({ applicationName: APP_NAME, applicationIcon: avatarPath });
  if (process.platform === 'darwin' && app.dock && typeof app.dock.setIcon === 'function') app.dock.setIcon(avatarPath);
  registerAppProtocol();
  configurePermissions();
  store = new LocalStore(path.join(app.getPath('userData'), 'state.json'), safeStorage);
  authSession = session.fromPartition(AUTH_PARTITION);
  configureAuthSessionSecurity(authSession);
  watchAuthCookie();
  clients = createApiClients({ fetchImpl: net.fetch.bind(net), authFetch: authSession.fetch.bind(authSession), authSession });
  setupIpc();
  createMainWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createMainWindow(); });
}

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
bootstrap().catch((error) => {
  console.error(`Failed to start ${APP_NAME}:`, safeError(error));
  app.quit();
});

module.exports = { trustedSender, safeError, validateJoinIntent, validateSearchInput, isAllowedAuthUrl };
