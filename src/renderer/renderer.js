/* global robloxNavigator */

const api = window.robloxNavigator;
const state = {
  query: '',
  searchSessionId: undefined,
  searchPageToken: undefined,
  searchRouteQuery: undefined,
  searchRequestId: 0,
  selected: undefined,
  details: undefined,
  publicCursor: undefined,
  parsedPrivate: undefined,
  auth: { authenticated: false },
  authProxy: { authProxy: '', source: 'system', configured: false, active: false, valid: true },
  favorites: new Set(),
  recents: [],
  savedJoins: [],
  privateAccessible: [],
  privateOwned: [],
  privateLoading: false,
  permissionsServerId: undefined,
  permissionsOriginalUsers: [],
  permissionsSettingsLoaded: false,
  experienceCache: new Map(),
  thumbnailCache: new Map(),
  thumbnailPromises: new Map(),
  charts: [],
  chartsLoaded: false,
  chartsError: undefined,
  homeLoadPromise: undefined,
  routeRequest: 0
};
state.searchResults = new Map();

const $ = (id) => document.getElementById(id);
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[char]);
const formatNumber = (value) => Number(value || 0).toLocaleString();
const formatDate = (value) => {
  if (!value) return '';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toLocaleDateString();
};

const IPC_ERROR_PREFIX = /^Error invoking remote method ['"][^'"]+['"]:\s*/i;

function cleanErrorText(value) {
  if (typeof value !== 'string') return '';
  const text = value.replace(IPC_ERROR_PREFIX, '').trim();
  return text && !/^\[object Object\]$/i.test(text) ? text : '';
}

function readableError(error, fallback = 'The operation could not be completed.', depth = 0) {
  if (depth > 3) return fallback;
  if (typeof error === 'string') return cleanErrorText(error) || fallback;
  if (!error || typeof error !== 'object') return fallback;
  const candidates = [
    error.safeMessage,
    error.message,
    error.error?.safeMessage,
    error.error?.message,
    error.details?.message
  ];
  for (const candidate of candidates) {
    const text = cleanErrorText(candidate);
    if (text) return text;
    if (candidate && typeof candidate === 'object') {
      const nested = readableError(candidate, '', depth + 1);
      if (nested) return nested;
    }
  }
  return fallback;
}

function showToast(message, kind = 'info', durationMs = 4200) {
  if (!message) return;
  const region = $('toast-region');
  if (!region) return;
  while (region.children.length >= 4) region.firstElementChild?.remove();
  const toast = document.createElement('div');
  const safeKind = ['ok', 'warn', 'error', 'info'].includes(kind) ? kind : 'info';
  toast.className = `toast ${safeKind}`;
  toast.setAttribute('role', safeKind === 'warn' || safeKind === 'error' ? 'alert' : 'status');
  const text = document.createElement('span');
  text.className = 'toast-text';
  text.textContent = message;
  const dismissButton = document.createElement('button');
  dismissButton.type = 'button';
  dismissButton.className = 'toast-dismiss';
  dismissButton.setAttribute('aria-label', 'Dismiss notification');
  dismissButton.textContent = '×';
  toast.append(text, dismissButton);
  region.appendChild(toast);

  let dismissed = false;
  let timer = setTimeout(dismiss, durationMs);
  function dismiss() {
    if (dismissed) return;
    dismissed = true;
    clearTimeout(timer);
    toast.classList.add('leaving');
    setTimeout(() => toast.remove(), 180);
  }
  dismissButton.addEventListener('click', dismiss);
  toast.addEventListener('mouseenter', () => clearTimeout(timer));
  toast.addEventListener('mouseleave', () => { if (!dismissed) timer = setTimeout(dismiss, durationMs); });
}

function setMessage(message, kind = 'warn') {
  const node = $('global-message');
  const displayMessage = message === undefined || message === null || message === ''
    ? ''
    : readableError(message);
  node.textContent = displayMessage;
  node.className = `message ${displayMessage ? kind : 'hidden'}`;
  if (displayMessage) showToast(displayMessage, kind);
}

function showSection(id, visible) {
  const node = $(id);
  if (node) node.classList.toggle('hidden', !visible);
}

function button(label, className, attrs = '') {
  return `<button class="button ${className}" type="button" ${attrs}>${escapeHtml(label)}</button>`;
}

function selectedLaunchFormat() {
  return $('launch-format')?.value === 'legacy' ? 'legacy' : 'modern';
}

function openDialog(id) {
  const dialog = $(id);
  if (!dialog) return;
  for (const other of document.querySelectorAll('dialog[open]')) {
    if (other === dialog) continue;
    if (typeof other.close === 'function') other.close();
    else other.removeAttribute('open');
  }
  if (!dialog.open) {
    try { dialog.showModal(); } catch { dialog.setAttribute('open', ''); }
  }
}

function closeDialog(id) {
  const dialog = $(id);
  if (!dialog) return;
  if (dialog.open && typeof dialog.close === 'function') dialog.close();
  else dialog.removeAttribute('open');
}

function closeAllDialogs() {
  for (const dialog of document.querySelectorAll('dialog[open]')) {
    if (typeof dialog.close === 'function') dialog.close();
    else dialog.removeAttribute('open');
  }
}

function parseRoute() {
  const raw = window.location.hash.replace(/^#/, '') || '/home';
  const [path, queryString = ''] = raw.split('?');
  const parts = path.split('/').filter(Boolean);
  if (parts[0] === 'search') {
    return { name: 'search', query: new URLSearchParams(queryString).get('q')?.trim() || '' };
  }
  if (parts[0] === 'experience' && /^[1-9][0-9]{0,19}$/.test(parts[1] || '')) {
    return { name: 'experience', universeId: parts[1] };
  }
  return { name: 'home' };
}

function navigate(path, { replace = false } = {}) {
  const next = path.startsWith('#') ? path : `#${path.startsWith('/') ? path : `/${path}`}`;
  if (window.location.hash === next) void renderRoute();
  else if (replace) window.location.replace(next);
  else window.location.hash = next;
}

function setActivePage(name) {
  for (const id of ['home-page', 'search-page', 'details-page']) showSection(id, id === `${name}-page` || (name === 'experience' && id === 'details-page'));
  $('nav-home-button')?.classList.toggle('active', name === 'home');
}

function experienceImageMarkup(game, className = 'tile-art') {
  const imageUrl = game?.thumbnailUrls?.[0] || game?.iconUrl;
  if (imageUrl) return `<img class="${className}" src="${escapeHtml(imageUrl)}" alt="${escapeHtml(game.name)}" loading="lazy" referrerpolicy="no-referrer" />`;
  return `<div class="${className} image-placeholder" data-thumb-id="${escapeHtml(game?.universeId || '')}" role="img" aria-label="No thumbnail available"></div>`;
}

function attachImageFallbacks(container) {
  if (!container) return;
  for (const image of container.querySelectorAll('img:not([data-image-bound])')) {
    image.dataset.imageBound = 'true';
    image.addEventListener('error', () => {
      const placeholder = document.createElement('div');
      placeholder.className = `${image.className} image-placeholder`;
      placeholder.setAttribute('role', 'img');
      placeholder.setAttribute('aria-label', 'Thumbnail unavailable');
      placeholder.dataset.thumbFailed = 'true';
      image.replaceWith(placeholder);
    }, { once: true });
  }
}

function replaceThumbnailPlaceholders(container, universeId, url, alt) {
  if (!container || !url) return;
  for (const placeholder of container.querySelectorAll('[data-thumb-id]')) {
    if (placeholder.dataset.thumbId !== String(universeId)) continue;
    const image = document.createElement('img');
    image.className = placeholder.className.replace(/\bimage-placeholder\b/g, '').trim() || 'tile-art';
    image.src = url;
    image.alt = alt || 'Experience thumbnail';
    image.loading = 'lazy';
    image.referrerPolicy = 'no-referrer';
    placeholder.replaceWith(image);
  }
  attachImageFallbacks(container);
}

async function ensureThumbnails(universeId, container) {
  const id = String(universeId || '');
  if (!/^[1-9][0-9]{0,19}$/.test(id)) return;
  if (state.thumbnailCache.has(id)) {
    const cached = state.thumbnailCache.get(id);
    replaceThumbnailPlaceholders(container, id, cached.thumbnailUrls?.[0] || cached.iconUrl, state.experienceCache.get(id)?.name);
    return;
  }
  if (state.thumbnailPromises.has(id)) {
    try {
      const pending = await state.thumbnailPromises.get(id);
      replaceThumbnailPlaceholders(container, id, pending?.thumbnailUrls?.[0] || pending?.iconUrl, state.experienceCache.get(id)?.name);
    } catch { /* the original request records a placeholder failure */ }
    return;
  }
  const pending = api.getExperienceThumbnails({ universeId: id });
  state.thumbnailPromises.set(id, pending);
  try {
    const thumbnails = await pending;
    state.thumbnailCache.set(id, thumbnails || {});
    const game = state.experienceCache.get(id);
    if (game && !game.iconUrl && thumbnails?.iconUrl) game.iconUrl = thumbnails.iconUrl;
    if (game && (!Array.isArray(game.thumbnailUrls) || !game.thumbnailUrls.length) && thumbnails?.thumbnailUrls?.length) game.thumbnailUrls = thumbnails.thumbnailUrls;
    replaceThumbnailPlaceholders(container, id, thumbnails?.thumbnailUrls?.[0] || thumbnails?.iconUrl, game?.name);
  } catch {
    for (const placeholder of container?.querySelectorAll?.('[data-thumb-id]') || []) {
      if (placeholder.dataset.thumbId === id) placeholder.dataset.thumbFailed = 'true';
    }
  } finally {
    state.thumbnailPromises.delete(id);
  }
}

function hydrateGridImages(container) {
  if (!container) return;
  attachImageFallbacks(container);
  const ids = [...new Set([...container.querySelectorAll('[data-thumb-id]')].map((node) => node.dataset.thumbId).filter(Boolean))];
  for (const id of ids) void ensureThumbnails(id, container);
}

function experienceTile(game) {
  if (!game?.universeId) return null;
  const id = String(game.universeId);
  state.experienceCache.set(id, game);
  const description = (game.description || 'No description available.').trim();
  const favorite = state.favorites.has(id);
  const tile = document.createElement('article');
  tile.className = 'experience-tile';
  tile.tabIndex = 0;
  tile.dataset.action = 'details';
  tile.dataset.id = id;
  const playAction = game.rootPlaceId ? button('Play', 'primary', `data-action="play" data-place-id="${escapeHtml(game.rootPlaceId)}"`) : '';
  tile.innerHTML = `<div class="tile-media">${experienceImageMarkup(game)}</div><div class="tile-overlay"><div class="tile-copy"><h3 title="${escapeHtml(game.name)}">${escapeHtml(game.name)}</h3><p>${escapeHtml(description)}</p><div class="tile-meta"><span>◉ ${formatNumber(game.playerCount)} playing</span><span>${escapeHtml(game.creator?.name || 'Roblox')}</span></div></div><div class="tile-actions">${button('Details', 'secondary', `data-action="details" data-id="${escapeHtml(id)}"`)}${playAction}${button(favorite ? '★' : '☆', 'icon', `data-action="favorite" data-id="${escapeHtml(id)}" aria-label="${favorite ? 'Remove from favorites' : 'Add to favorites'}"`)}</div></div>`;
  return tile;
}

function hasExperienceDetails(game) {
  if (!game?.universeId || !game?.rootPlaceId) return false;
  if (!game.name || game.name === 'Untitled experience' || /^\[(?:TITLE|DESCRIPTION) UNAVAILABLE\]$/i.test(game.name)) return false;
  const creatorName = game.creator?.name;
  return Boolean((game.description && !/^\[DESCRIPTION UNAVAILABLE\]$/i.test(game.description))
    || (creatorName && creatorName !== 'Unknown creator' && !/^\[UNKNOWN\]$/i.test(creatorName))
    || game.maxPlayers > 0
    || game.playerCount > 0
    || game.visits > 0);
}

function renderTileGrid(node, games, emptyText) {
  if (!node) return;
  const validGames = (games || []).filter((game) => game?.universeId);
  if (!validGames.length) {
    node.className = 'tile-grid empty-state';
    node.innerHTML = `<p class="muted">${escapeHtml(emptyText)}</p>`;
    return;
  }
  node.className = 'tile-grid';
  node.innerHTML = '';
  for (const game of validGames) {
    const tile = experienceTile(game);
    if (tile) node.appendChild(tile);
  }
  hydrateGridImages(node);
}

async function hydrateExperiences(ids, fallbackById = new Map()) {
  const unique = [...new Set((ids || []).map(String).filter((id) => /^[1-9][0-9]{0,19}$/.test(id)))];
  const missing = unique.filter((id) => !hasExperienceDetails(state.experienceCache.get(id)));
  await Promise.all(missing.map(async (id) => {
    try {
      const game = await api.getExperience({ universeId: id, fallback: fallbackById.get(id), recordRecent: false });
      if (game?.universeId) {
        const previous = state.experienceCache.get(String(game.universeId));
        if (!previous || hasExperienceDetails(game) || !hasExperienceDetails(previous)) state.experienceCache.set(String(game.universeId), game);
      }
    } catch {
      const fallback = fallbackById.get(id);
      const previous = state.experienceCache.get(id);
      if (!hasExperienceDetails(previous) && fallback?.universeId && fallback?.rootPlaceId) state.experienceCache.set(id, previous || fallback);
    }
  }));
  return unique.map((id) => state.experienceCache.get(id)).filter(Boolean);
}

function renderHomeRails() {
  const recentFallback = new Map((state.recents || []).map((entry) => [String(entry.universeId), entry]));
  const recents = (state.recents || []).map((entry) => state.experienceCache.get(String(entry.universeId)) || entry);
  const favorites = [...state.favorites].map((id) => state.experienceCache.get(String(id))).filter(Boolean);
  renderTileGrid($('recent-grid'), recents, 'Nothing here yet.');
  renderTileGrid($('favorites-grid'), favorites, 'Favorite an experience to keep it close.');
  const chartMessage = state.chartsError ? `Top charts unavailable: ${state.chartsError}` : (state.chartsLoaded ? 'No chart data is available right now.' : 'Loading charts…');
  renderTileGrid($('charts-grid'), state.charts, chartMessage);
  hydrateGridImages($('recent-grid'));
  hydrateGridImages($('favorites-grid'));
  // Keep this map alive for the next refresh; entries are also useful if a
  // details request has to fall back to the local recent snapshot.
  for (const [id, value] of recentFallback) if (!state.experienceCache.has(id)) state.experienceCache.set(id, value);
}

async function loadHome({ force = false } = {}) {
  if (!force && state.homeLoadPromise) return state.homeLoadPromise;
  state.homeLoadPromise = (async () => {
    const fallback = new Map((state.recents || []).map((entry) => [String(entry.universeId), entry]));
    const ids = [...new Set([...(state.recents || []).map((entry) => entry.universeId), ...state.favorites])];
    await hydrateExperiences(ids, fallback);
    renderHomeRails();
    state.chartsError = undefined;
    try {
      const chartPage = await api.getTopCharts();
      state.charts = Array.isArray(chartPage?.results) ? chartPage.results : [];
    } catch (error) {
      state.charts = [];
      state.chartsError = readableError(error, 'Could not load top charts.');
    }
    state.chartsLoaded = true;
    renderHomeRails();
  })().finally(() => { state.homeLoadPromise = undefined; });
  return state.homeLoadPromise;
}

function renderResults(page, append = false) {
  const grid = $('results-grid');
  const results = Array.isArray(page?.results) ? page.results : [];
  if (!append && !results.length) {
    grid.className = 'tile-grid empty-state';
    grid.innerHTML = '<p class="muted">No experiences matched that search.</p>';
  } else {
    if (!append) { grid.className = 'tile-grid'; grid.innerHTML = ''; }
    for (const game of results) {
      state.searchResults.set(String(game.universeId), game);
      const tile = experienceTile(game);
      if (tile) grid.appendChild(tile);
    }
    hydrateGridImages(grid);
  }
  $('results-title').textContent = state.query ? `Results for “${state.query}”` : 'Experiences';
  const hasMore = Boolean(page?.nextPageToken);
  $('search-pagination').classList.toggle('hidden', !hasMore);
}

async function search(query, append = false) {
  if (!query.trim()) { setMessage('Enter a search term first.'); return; }
  setMessage('');
  const requestId = append ? state.searchRequestId : ++state.searchRequestId;
  if (!append) {
    state.query = query.trim();
    state.searchSessionId = undefined;
    state.searchPageToken = undefined;
    $('results-grid').className = 'tile-grid empty-state';
    $('results-grid').innerHTML = '<p class="muted">Searching…</p>';
  }
  try {
    const page = await api.searchExperiences({ query: state.query, sessionId: state.searchSessionId, pageToken: state.searchPageToken });
    if (requestId !== state.searchRequestId || (!append && state.searchRouteQuery !== state.query)) return;
    state.searchSessionId = page.sessionId;
    state.searchPageToken = page.nextPageToken;
    renderResults(page, append);
  } catch (error) {
    if (requestId !== state.searchRequestId) return;
    renderResults({ results: [], nextPageToken: undefined });
    setMessage(readableError(error, 'Search failed.'));
  }
}

function renderExperienceLoading() {
  $('experience-title').textContent = 'Loading…';
  $('experience-detail').innerHTML = '<div class="loading-card"><span class="spinner"></span><span>Loading experience</span></div>';
  $('private-summary-copy').textContent = 'Loading private-server access…';
  $('servers-list').innerHTML = '<p class="muted">Loading live servers…</p>';
}

function renderExperience() {
  const game = state.details;
  if (!game) return;
  const favorite = state.favorites.has(game.universeId);
  $('experience-title').textContent = game.name;
  $('experience-detail').innerHTML = `<div>${experienceImageMarkup(game, 'experience-art')}</div><div class="detail-card"><h2>${escapeHtml(game.name)}</h2><p class="muted">by ${escapeHtml(game.creator?.name || 'Unknown creator')} ${game.contentMaturity ? `· ${escapeHtml(game.contentMaturity)}` : ''}</p><p class="detail-description">${escapeHtml(game.description || 'No description available.')}</p><div class="stat-row"><div class="stat"><strong>${formatNumber(game.playerCount)}</strong><span>playing</span></div><div class="stat"><strong>${formatNumber(game.visits)}</strong><span>visits</span></div><div class="stat"><strong>${formatNumber(game.maxPlayers)}</strong><span>server size</span></div></div><div class="detail-actions">${button('Play', 'primary', `data-action="play" data-place-id="${escapeHtml(game.rootPlaceId)}"`)}${button(favorite ? '★ Favorited' : '☆ Favorite', 'secondary', `data-action="favorite" data-id="${escapeHtml(game.universeId)}"`)}${button('Private servers', 'ghost', 'data-action="scroll-private"')}</div></div>`;
  hydrateGridImages($('experience-detail'));
  updatePrivateSummary();
}

function updatePrivateSummary() {
  const copy = $('private-summary-copy');
  const open = $('open-private-button');
  if (!copy || !open) return;
  if (!state.selected) {
    copy.textContent = 'Choose an experience to load private servers.';
    open.disabled = true;
    return;
  }
  open.disabled = false;
  if (!state.auth.authenticated) {
    copy.textContent = 'Sign in to load servers for this experience.';
    open.textContent = 'Sign in to manage';
    return;
  }
  open.textContent = 'Your private servers';
  if (state.privateLoading) {
    copy.textContent = 'Loading joinable and owned servers…';
    return;
  }
  const joinable = state.privateAccessible.length;
  const owned = state.privateOwned.length;
  copy.textContent = `${joinable} joinable · ${owned} owned · Roblox checks admission`;
}

async function loadExperienceRoute(universeId) {
  const requestId = ++state.routeRequest;
  state.selected = undefined;
  state.details = undefined;
  state.privateAccessible = [];
  state.privateOwned = [];
  state.privateLoading = false;
  setActivePage('experience');
  showSection('servers-section', true);
  renderExperienceLoading();
  closePermissionsEditor();
  try {
    const fallback = state.searchResults.get(String(universeId)) || state.experienceCache.get(String(universeId));
    // Home cards can come from a compact persisted snapshot. Always refresh
    // the details route so that snapshot fields never mask live metadata or
    // player counts cached by an earlier Home render.
    const details = await api.getExperience({ universeId, fallback, cache: false });
    if (requestId !== state.routeRequest) return;
    state.details = details;
    state.selected = details;
    state.experienceCache.set(String(details.universeId), details);
    showSection('owned-private-section', state.auth.authenticated);
    renderOwnedPrivateSectionState();
    renderExperience();
    await listPublicServers();
    if (state.auth.authenticated) await loadPrivateForSelected();
    else updatePrivateSummary();
  } catch (error) {
    if (requestId !== state.routeRequest) return;
    setMessage(readableError(error, 'Could not load that experience.'));
    navigate('/home');
  }
}

async function listPublicServers(cursor) {
  if (!state.selected) return;
  const selectedUniverseId = state.selected.universeId;
  const selectedPlaceId = state.selected.rootPlaceId;
  const list = $('servers-list');
  if (!cursor) { list.innerHTML = '<p class="muted">Loading live servers…</p>'; state.publicCursor = undefined; }
  try {
    const page = await api.listPublicServers({ placeId: selectedPlaceId, cursor, excludeFullGames: $('exclude-full-checkbox').checked, limit: 25, sortOrder: 'Asc' });
    if (state.selected?.universeId !== selectedUniverseId) return;
    state.publicCursor = page.nextPageCursor;
    if (!page.data.length) list.innerHTML = '<p class="muted">No public servers are visible right now.</p>';
    else {
      if (!cursor) list.innerHTML = '';
      for (const server of page.data) {
        const row = document.createElement('div');
        row.className = 'server-row';
        row.innerHTML = `<div><strong>${escapeHtml(server.id.slice(0, 8))}…</strong><small>${escapeHtml(server.id)}</small></div><div class="server-metric">${server.playing}/${server.maxPlayers}<small>players</small></div><div class="server-metric">${server.ping ?? '—'} ms<small>ping</small></div><div class="server-metric">${server.fps ? Math.round(server.fps) : '—'}<small>FPS</small></div>${button('Join', 'primary', `data-action="server-join" data-job-id="${escapeHtml(server.id)}" data-place-id="${escapeHtml(selectedPlaceId)}"`)}`;
        list.appendChild(row);
      }
    }
    $('server-summary').textContent = `${page.data.length} server${page.data.length === 1 ? '' : 's'} shown`;
    $('load-more-servers-button').classList.toggle('hidden', !page.nextPageCursor);
  } catch (error) {
    if (state.selected?.universeId !== selectedUniverseId) return;
    const message = readableError(error, 'Could not load servers.');
    list.innerHTML = `<p class="muted">${escapeHtml(message)}</p>`;
    setMessage(message);
  }
}

async function launch(intent) {
  setMessage('');
  try {
    const result = await api.join({ ...intent, format: selectedLaunchFormat() });
    setMessage('Sent to Roblox Player. It will apply your account permissions and join rules.', 'ok');
    if (result?.kind === 'private-link' || result?.kind === 'private-access') setTimeout(() => setMessage('If Player did not open, check that Roblox is installed and registered for the roblox: protocol.'), 3500);
  } catch (error) { setMessage(readableError(error, 'Could not hand off to Roblox Player.')); }
}

function renderSavedJoins() {
  const node = $('saved-private-list');
  if (!state.savedJoins.length) { node.innerHTML = '<p class="muted">No saved codes yet.</p>'; return; }
  node.innerHTML = state.savedJoins.map((entry) => `<div class="saved-entry"><div><strong>${escapeHtml(entry.label)}</strong><span>${escapeHtml(entry.kind)}${entry.placeId ? ` · place ${escapeHtml(entry.placeId)}` : ''}</span></div><div class="saved-entry-actions">${button('Join', 'secondary', `data-action="saved-join" data-id="${escapeHtml(entry.id)}"`)}<button class="button danger" type="button" data-action="saved-delete" data-id="${escapeHtml(entry.id)}">×</button></div></div>`).join('');
}

async function refreshSavedJoins() {
  try { state.savedJoins = await api.listSavedPrivateJoins(); renderSavedJoins(); }
  catch (error) { setMessage(readableError(error, 'Could not load saved links.')); }
}

function renderAuth() {
  const signedIn = state.auth.authenticated === true;
  $('auth-button').textContent = signedIn ? 'Signed in' : 'Sign in';
  $('auth-button').classList.toggle('primary', signedIn);
  $('auth-button').classList.toggle('secondary', !signedIn);
  showSection('owned-private-section', signedIn && Boolean(state.selected));
  if (!signedIn) {
    state.privateLoading = false;
    state.privateAccessible = [];
    state.privateOwned = [];
    $('my-private-list').innerHTML = '<p class="muted">Sign in to list private servers.</p>';
    $('owned-private-list').innerHTML = '<p class="muted">Sign in to load your servers.</p>';
    closePermissionsEditor();
  }
  renderOwnedPrivateSectionState();
  updatePrivateSummary();
}

function renderOwnedPrivateSectionState() {
  const selectedName = state.selected?.name || 'the selected experience';
  const note = $('owned-private-experience-note');
  if (note) note.textContent = `Create and manage the private servers you own for ${selectedName}.`;
  const buttonNode = $('create-private-button');
  const help = $('create-private-help');
  if (!buttonNode || !help) return;
  const enabled = state.auth.authenticated && state.auth.privatePurchasesEnabled === true;
  buttonNode.disabled = !enabled;
  buttonNode.title = enabled ? '' : 'Private-server creation is disabled until the current Roblox purchase contract is enabled';
  help.textContent = enabled ? 'Creation is enabled. Roblox will show the final price and apply its purchase rules.' : 'Creation is disabled until the current Roblox purchase contract is enabled.';
}

function closePermissionsEditor() {
  state.permissionsServerId = undefined;
  state.permissionsOriginalUsers = [];
  state.permissionsSettingsLoaded = false;
  $('permissions-private-form')?.classList.add('hidden');
}

function permissionUserIds(value) {
  return (Array.isArray(value) ? value : String(value || '').split(',')).map(String).map((userId) => userId.trim()).filter((userId) => /^[1-9][0-9]{0,19}$/.test(userId));
}

function applyPermissionsEditorState(server) {
  const users = permissionUserIds(server?.users);
  state.permissionsOriginalUsers = [...new Set(users)];
  $('permissions-private-name').textContent = `Editing access for ${server?.name || 'your private server'}.`;
  $('permissions-private-friends').checked = server?.friendsAllowed === true;
  $('permissions-private-add').value = state.permissionsOriginalUsers.join(', ');
  $('permissions-private-remove').value = '';
}

async function openPermissionsEditor(target) {
  if (!target?.dataset?.id) return;
  const serverId = target.dataset.id;
  const form = $('permissions-private-form');
  const fallback = {
    id: serverId,
    name: target.dataset.name || 'your private server',
    friendsAllowed: target.dataset.friendsAllowed === 'true' ? true : target.dataset.friendsAllowed === 'false' ? false : undefined,
    users: permissionUserIds(target.dataset.users)
  };
  state.permissionsServerId = serverId;
  state.permissionsSettingsLoaded = false;
  applyPermissionsEditorState(fallback);
  $('permissions-private-name').textContent = `Loading access for ${fallback.name}…`;
  form.classList.remove('hidden');
  form.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  const controls = [...form.querySelectorAll('input, button[type="submit"]')];
  controls.forEach((control) => { control.disabled = true; });
  try {
    const details = await api.getPrivateServer({ vipServerId: serverId, cache: false });
    if (state.permissionsServerId !== serverId) return;
    const merged = {
      ...fallback,
      ...details,
      friendsAllowed: typeof details?.friendsAllowed === 'boolean' ? details.friendsAllowed : fallback.friendsAllowed,
      users: Array.isArray(details?.users) && (details.users.length || !fallback.users.length) ? details.users : fallback.users
    };
    applyPermissionsEditorState(merged);
    state.permissionsSettingsLoaded = true;
  } catch (error) {
    if (state.permissionsServerId === serverId) setMessage(readableError(error, 'Could not load current private-server settings.'));
  } finally {
    if (state.permissionsServerId === serverId) {
      controls.forEach((control) => { control.disabled = false; });
      if (!state.permissionsSettingsLoaded) form.querySelector('button[type="submit"]')?.setAttribute('disabled', '');
    }
  }
}

async function refreshAuth() {
  try { state.auth = await api.getAuthStatus(); renderAuth(); }
  catch { state.auth = { authenticated: false }; renderAuth(); }
}

function handleAuthStateChanged(status) {
  if (!status || typeof status !== 'object') return;
  const wasAuthenticated = state.auth.authenticated === true;
  state.auth = status;
  renderAuth();
  void refreshAuthProxyConfig();
  if (!wasAuthenticated && state.auth.authenticated) {
    setMessage('Signed in to Roblox.', 'ok');
    if (state.selected) void loadPrivateForSelected();
  }
}

function renderAuthProxyConfig() {
  const config = state.authProxy || {};
  const input = $('auth-proxy-input');
  if (document.activeElement !== input) input.value = config.authProxy || '';
  const status = $('auth-proxy-status');
  const statusText = config.valid === false ? 'Invalid proxy' : config.active ? 'Proxy active for login' : config.source === 'saved' ? 'Saved for sign-in' : config.source === 'environment' ? 'Environment fallback' : 'System proxy';
  status.textContent = statusText;
  status.className = `status-pill ${config.valid === false ? 'error' : config.active ? 'warn' : config.configured ? 'ok' : 'neutral'}`;
  $('auth-proxy-help').textContent = config.valid === false ? (config.error || 'Enter an HTTP(S), SOCKS4, or SOCKS5 proxy URL without credentials or a path.') : 'Leave empty to use the operating-system proxy. A saved proxy is used only while the isolated Roblox sign-in window is open.';
}

async function refreshAuthProxyConfig() {
  try { state.authProxy = await api.getAuthConfig(); renderAuthProxyConfig(); }
  catch { renderAuthProxyConfig(); }
}

async function saveAuthProxy(value) {
  try {
    state.authProxy = await api.setAuthProxy({ proxy: value });
    renderAuthProxyConfig();
    setMessage(value ? 'Login proxy saved for the next Roblox sign-in.' : 'Login proxy cleared; using the system proxy.', 'ok');
  } catch (error) { setMessage(readableError(error, 'Could not save the login proxy.')); }
}

function privateJoinButton(server) {
  const joinPlaceId = server.placeId || state.selected?.rootPlaceId;
  if (!joinPlaceId) return '';
  const joinHint = server.hasLinkCode || server.hasAccessCode ? '' : ' title="Roblox Player will check your account permissions"';
  return button('Join', 'secondary', `data-action="private-entry-join" data-id="${escapeHtml(server.id)}" data-place-id="${escapeHtml(joinPlaceId)}"${joinHint}`);
}

function privateSubscriptionAction(server) {
  if (typeof server.active !== 'boolean') return '';
  if (server.active === true) return button('Cancel', 'ghost', `data-action="subscription-private" data-id="${escapeHtml(server.id)}" data-active="true"`);
  if (state.auth.privatePurchasesEnabled) return button('Renew', 'ghost', `data-action="subscription-private" data-id="${escapeHtml(server.id)}" data-active="false"`);
  return '<button class="button ghost" type="button" disabled title="Renewal is disabled until its current Robux request contract is verified">Renew unavailable</button>';
}

function renderPrivateServerEntry(server, manage = false) {
  const subscription = server.subscription;
  const subscriptionSummary = subscription?.expirationDate ? ` · expires ${formatDate(subscription.expirationDate)}` : (subscription?.renewalDate ? ` · renewal ${formatDate(subscription.renewalDate)}` : '');
  const actions = [privateJoinButton(server)];
  if (manage) {
    const existingUsers = Array.isArray(server.users) ? server.users.map(String).filter((userId) => /^[1-9][0-9]{0,19}$/.test(userId)) : [];
    const friendsAllowed = typeof server.friendsAllowed === 'boolean' ? String(server.friendsAllowed) : '';
    const permissionAttrs = `data-action="permissions-private" data-id="${escapeHtml(server.id)}" data-name="${escapeHtml(server.name)}" data-friends-allowed="${friendsAllowed}" data-users="${escapeHtml(existingUsers.join(', '))}"`;
    actions.push(button('Manage access', 'ghost', permissionAttrs), privateSubscriptionAction(server));
  }
  const userSummary = manage && Array.isArray(server.users) && server.users.length ? ` · ${server.users.length} user${server.users.length === 1 ? '' : 's'} allowed` : '';
  return `<div class="private-entry"><div><strong>${escapeHtml(server.name)}</strong><span>${server.placeId ? `place ${escapeHtml(server.placeId)}` : ''}${server.active === false ? ' · inactive' : ''}${server.friendsAllowed === true ? ' · friends allowed' : ''}${userSummary}${subscriptionSummary}</span></div><div class="saved-entry-actions">${actions.join('')}</div></div>`;
}

function renderPrivateServers(page) {
  const node = $('my-private-list');
  state.privateAccessible = Array.isArray(page?.data) ? page.data : [];
  if (!state.privateAccessible.length) { node.innerHTML = '<p class="muted">No private servers were returned for this experience.</p>'; updatePrivateSummary(); return; }
  node.innerHTML = state.privateAccessible.map((server) => renderPrivateServerEntry(server)).join('');
  updatePrivateSummary();
}

function renderOwnedPrivateServers(page) {
  const node = $('owned-private-list');
  const selected = state.selected;
  state.privateOwned = Array.isArray(page?.data) ? page.data.filter((server) => selected && (server.placeId === selected.rootPlaceId || server.universeId === selected.universeId)) : [];
  if (!state.privateOwned.length) { node.innerHTML = '<p class="muted">You do not own a private server for this experience yet.</p>'; updatePrivateSummary(); return; }
  node.innerHTML = state.privateOwned.map((server) => renderPrivateServerEntry(server, true)).join('');
  updatePrivateSummary();
}

async function listPrivateServers() {
  if (!state.auth.authenticated) { setMessage('Sign in to list private servers.'); return; }
  if (!state.selected) { setMessage('Choose an experience first.'); return; }
  const selectedUniverseId = state.selected.universeId;
  const selectedPlaceId = state.selected.rootPlaceId;
  $('my-private-list').innerHTML = '<p class="muted">Loading joinable servers…</p>';
  try {
    const page = await api.listPrivateServers({ placeId: selectedPlaceId });
    if (state.selected?.universeId !== selectedUniverseId) return;
    renderPrivateServers(page);
  }
  catch (error) {
    if (state.selected?.universeId === selectedUniverseId) {
      state.privateAccessible = [];
      $('my-private-list').innerHTML = `<p class="muted">${escapeHtml(readableError(error, 'Could not list private servers.'))}</p>`;
      updatePrivateSummary();
    }
    setMessage(readableError(error, 'Could not list private servers.'));
  }
}

async function listOwnedPrivateServers() {
  if (!state.auth.authenticated || !state.selected) return;
  const selectedUniverseId = state.selected.universeId;
  closePermissionsEditor();
  $('owned-private-list').innerHTML = '<p class="muted">Loading your private servers…</p>';
  try {
    const page = await api.listPrivateServers({ mine: true });
    if (state.selected?.universeId !== selectedUniverseId) return;
    renderOwnedPrivateServers(page);
    showSection('owned-private-section', true);
  }
  catch (error) {
    if (state.selected?.universeId !== selectedUniverseId) return;
    state.privateOwned = [];
    $('owned-private-list').innerHTML = '<p class="muted">Your owned private servers are unavailable right now.</p>';
    updatePrivateSummary();
    setMessage(readableError(error, 'Could not load your private servers.'));
  }
}

async function loadPrivateForSelected() {
  if (!state.auth.authenticated || !state.selected) return;
  state.privateLoading = true;
  updatePrivateSummary();
  try { await Promise.allSettled([listPrivateServers(), listOwnedPrivateServers()]); }
  finally { state.privateLoading = false; updatePrivateSummary(); }
}

async function runDiagnostics() {
  $('diagnostics').innerHTML = '<p class="muted">Running read-only checks…</p>';
  try {
    const report = await api.runConnectivityCheck();
    $('diagnostics').innerHTML = report.checks.map((check) => `<div class="diagnostic-row"><strong>${escapeHtml(check.name)}</strong><span class="${check.status === 'ok' ? 'ok' : 'error'}">${check.status === 'ok' ? `OK · ${check.latencyMs} ms` : escapeHtml(readableError(check.error, 'Unavailable'))}</span></div>`).join('') + `<div class="diagnostic-row"><strong>Roblox web session</strong><span>${report.auth.authenticated ? 'Authenticated' : 'Not signed in'}</span></div>`;
    state.auth = report.auth;
    renderAuth();
    const allOk = report.checks.every((check) => check.status === 'ok');
    $('connection-pill').textContent = allOk ? 'APIs reachable' : 'Some APIs unavailable';
    $('connection-pill').className = `status-pill ${allOk ? 'ok' : 'warn'}`;
  } catch (error) { setMessage(readableError(error, 'Diagnostics failed.')); }
}

async function renderRoute() {
  const route = parseRoute();
  closeAllDialogs();
  if (route.name === 'search' && !route.query) { navigate('/home', { replace: true }); return; }
  if (route.name === 'home') {
    state.routeRequest += 1;
    state.searchRouteQuery = undefined;
    state.selected = undefined;
    state.details = undefined;
    setActivePage('home');
    await loadHome();
    return;
  }
  if (route.name === 'search') {
    state.routeRequest += 1;
    setActivePage('search');
    state.query = route.query;
    $('search-input').value = route.query;
    if (state.searchRouteQuery !== route.query) {
      state.searchRouteQuery = route.query;
      await search(route.query);
    }
    return;
  }
  if (route.name === 'experience') {
    await loadExperienceRoute(route.universeId);
  }
}

document.addEventListener('click', async (event) => {
  const closeTarget = event.target.closest('[data-close-dialog]');
  if (closeTarget) { closeDialog(closeTarget.dataset.closeDialog); return; }
  const target = event.target.closest('[data-action]');
  if (!target) return;
  const action = target.dataset.action;
  if (action === 'details') navigate(`/experience/${target.dataset.id}`);
  else if (action === 'play') await launch({ placeId: target.dataset.placeId });
  else if (action === 'server-join') await launch({ placeId: target.dataset.placeId, gameInstanceId: target.dataset.jobId });
  else if (action === 'favorite') {
    try {
      const response = await api.toggleFavorite({ universeId: target.dataset.id });
      if (response.favorited) state.favorites.add(target.dataset.id); else state.favorites.delete(target.dataset.id);
      if (state.details) renderExperience();
      renderHomeRails();
      setMessage(response.favorited ? 'Added to favorites.' : 'Removed from favorites.', 'ok');
    } catch (error) { setMessage(readableError(error, 'Could not update favorites.')); }
  } else if (action === 'open-private') {
    if (!state.auth.authenticated) { setMessage('Sign in to manage your private servers.'); return; }
    openDialog('owner-private-dialog');
    void listOwnedPrivateServers();
  } else if (action === 'scroll-private') {
    $('private-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  else if (action === 'saved-join') {
    try { await api.useSavedPrivateJoin({ id: target.dataset.id, format: selectedLaunchFormat() }); setMessage('Sent to Roblox Player.', 'ok'); }
    catch (error) { setMessage(readableError(error)); }
  } else if (action === 'saved-delete') {
    try { await api.deleteSavedPrivateJoin({ id: target.dataset.id }); await refreshSavedJoins(); setMessage('Saved private server removed.', 'ok'); }
    catch (error) { setMessage(readableError(error)); }
  } else if (action === 'private-entry-join') {
    try {
      await api.joinPrivateServer({ vipServerId: target.dataset.id, format: selectedLaunchFormat(), ...(target.dataset.placeId ? { placeId: target.dataset.placeId } : {}) });
      setMessage('Sent to Roblox Player. It will apply your account permissions and join rules.', 'ok');
    } catch (error) { setMessage(readableError(error, 'Could not hand off to Roblox Player.')); }
  } else if (action === 'permissions-private') openPermissionsEditor(target);
  else if (action === 'subscription-private') {
    const active = target.dataset.active !== 'true';
    const warning = active ? 'Renew this private-server subscription? Roblox may charge Robux.' : 'Cancel this private-server subscription?';
    if (!window.confirm(warning)) return;
    try { await api.updatePrivateServer({ vipServerId: target.dataset.id, operation: 'subscription', payload: { active, ...(active ? { confirmPurchase: true } : {}) } }); await listOwnedPrivateServers(); setMessage(active ? 'Private-server subscription renewed.' : 'Private-server subscription cancelled.', 'ok'); }
    catch (error) { setMessage(readableError(error, 'Could not update subscription.')); }
  }
});

document.addEventListener('keydown', (event) => {
  const tile = event.target.closest?.('.experience-tile');
  if (!tile || event.target !== tile || !['Enter', ' '].includes(event.key)) return;
  event.preventDefault();
  navigate(`/experience/${tile.dataset.id}`);
});

$('home-button').addEventListener('click', () => navigate('/home'));
$('nav-home-button').addEventListener('click', () => navigate('/home'));
$('details-home-button').addEventListener('click', () => navigate('/home'));
$('search-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const query = $('search-input').value.trim();
  if (!query) { setMessage('Enter a search term first.'); return; }
  navigate(`/search?q=${encodeURIComponent(query)}`);
});
$('load-more-button').addEventListener('click', () => search(state.query, true));
$('refresh-servers-button').addEventListener('click', () => listPublicServers());
$('exclude-full-checkbox').addEventListener('change', () => listPublicServers());
$('load-more-servers-button').addEventListener('click', () => listPublicServers(state.publicCursor));
$('refresh-charts-button').addEventListener('click', () => { state.chartsLoaded = false; state.chartsError = undefined; renderHomeRails(); void loadHome({ force: true }); });
$('open-private-button').addEventListener('click', () => {
  if (!state.selected) return;
  if (!state.auth.authenticated) { setMessage('Sign in to manage your private servers.'); return; }
  openDialog('owner-private-dialog');
  void listOwnedPrivateServers();
});
$('join-link-button').addEventListener('click', () => { openDialog('join-dialog'); void refreshSavedJoins(); });
$('settings-button').addEventListener('click', () => { openDialog('settings-dialog'); void refreshAuthProxyConfig(); });
$('refresh-saved-button').addEventListener('click', refreshSavedJoins);
$('list-place-private-button').addEventListener('click', listPrivateServers);
$('refresh-owned-private-button').addEventListener('click', listOwnedPrivateServers);
$('auth-proxy-form').addEventListener('submit', async (event) => { event.preventDefault(); await saveAuthProxy($('auth-proxy-input').value.trim()); });
$('clear-auth-proxy-button').addEventListener('click', async () => { $('auth-proxy-input').value = ''; await saveAuthProxy(''); });
$('run-diagnostics-button').addEventListener('click', runDiagnostics);
$('clear-browsing-button').addEventListener('click', async () => {
  if (!window.confirm('Clear recent experience history and in-memory API cache? Favorites and saved private servers will stay.')) return;
  try { await api.clearBrowsingData(); state.recents = []; state.experienceCache.clear(); state.homeLoadPromise = undefined; renderHomeRails(); setMessage('Browsing history and API cache cleared.', 'ok'); }
  catch (error) { setMessage(readableError(error, 'Could not clear browsing data.')); }
});
$('forget-private-button').addEventListener('click', async () => {
  if (!window.confirm('Forget every saved private-server code from this app?')) return;
  try { state.savedJoins = await api.forgetSavedPrivateJoins(); renderSavedJoins(); setMessage('Saved private-server codes forgotten.', 'ok'); }
  catch (error) { setMessage(readableError(error, 'Could not forget saved private servers.')); }
});
$('clear-session-button').addEventListener('click', async () => {
  if (!window.confirm('Sign out and clear the Roblox web session for this app?')) return;
  try { state.auth = await api.signOut(); renderAuth(); setMessage('Roblox session cleared.', 'ok'); }
  catch (error) { setMessage(readableError(error)); }
});
$('auth-button').addEventListener('click', async () => {
  try {
    if (state.auth.authenticated) { state.auth = await api.signOut(); setMessage('Roblox session cleared.', 'ok'); }
    else { await api.beginSignIn(); setMessage('Complete sign-in in the Roblox window, then return here.', 'ok'); }
    await refreshAuth();
    await refreshAuthProxyConfig();
  } catch (error) { setMessage(readableError(error, 'Could not open sign-in.')); }
});
$('create-private-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!state.selected) { setMessage('Choose an experience first.'); return; }
  if (!state.auth.authenticated) { setMessage('Sign in to create a private server.'); return; }
  if (state.auth.privatePurchasesEnabled !== true) { setMessage('Private-server creation is disabled until the current Roblox purchase contract is enabled.'); return; }
  if (!$('create-private-confirm').checked) { setMessage('Confirm that you understand this private server may charge Robux.'); return; }
  const name = $('create-private-name').value.trim();
  const priceText = $('create-private-price').value.trim();
  const body = {};
  if (name) body.name = name;
  if (priceText) {
    const expectedPrice = Number(priceText);
    if (!Number.isSafeInteger(expectedPrice) || expectedPrice < 0) { setMessage('Expected price must be a non-negative whole number.'); return; }
    body.expectedPrice = expectedPrice;
  }
  const createButton = $('create-private-button');
  createButton.disabled = true;
  try { await api.createPrivateServer({ universeId: state.selected.universeId, body, confirmPurchase: true }); $('create-private-form').reset(); setMessage('Private server created. Refreshing your owned servers…', 'ok'); await listOwnedPrivateServers(); }
  catch (error) { setMessage(readableError(error, 'Could not create the private server.')); }
  finally { renderOwnedPrivateSectionState(); }
});
$('permissions-private-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!state.permissionsServerId) return;
  if (!state.permissionsSettingsLoaded) { setMessage('Current private-server settings are unavailable; refresh and try again.'); return; }
  const parseIds = (value) => value ? value.split(',').map((item) => item.trim()).filter(Boolean) : [];
  const allowedUsers = parseIds($('permissions-private-add').value);
  const explicitlyRemoved = parseIds($('permissions-private-remove').value);
  const originalUsers = new Set(state.permissionsOriginalUsers);
  const usersToAdd = [...new Set(allowedUsers.filter((userId) => !originalUsers.has(userId)))];
  const usersToRemove = [...new Set([...explicitlyRemoved, ...state.permissionsOriginalUsers.filter((userId) => !allowedUsers.includes(userId))])];
  try {
    await api.updatePrivateServer({ vipServerId: state.permissionsServerId, operation: 'permissions', payload: { friendsAllowed: $('permissions-private-friends').checked, usersToAdd, usersToRemove } });
    closePermissionsEditor();
    await listOwnedPrivateServers();
    setMessage('Private-server access updated.', 'ok');
  } catch (error) { setMessage(readableError(error, 'Could not update private-server access.')); }
});
$('cancel-permissions-private-button').addEventListener('click', closePermissionsEditor);
$('private-link-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  state.parsedPrivate = undefined;
  $('join-private-button').classList.add('hidden');
  $('private-preview').classList.add('hidden');
  try {
    const source = $('private-link-input').value.trim();
    const parsed = await api.parsePrivateLink(source);
    if (!/^(https?|roblox):\/\//i.test(source)) parsed.kind = $('private-code-kind').value;
    state.parsedPrivate = parsed;
    if (!parsed.placeId && $('private-place-input').value) parsed.placeId = $('private-place-input').value.trim();
    $('private-preview').innerHTML = `<strong>${escapeHtml(parsed.kind)}</strong> parsed${parsed.placeId ? ` for place ${escapeHtml(parsed.placeId)}` : ''}. ${parsed.placeId ? 'Ready to join.' : 'Add a place ID to continue.'}`;
    $('private-preview').classList.remove('hidden');
    $('join-private-button').classList.toggle('hidden', !parsed.placeId);
  } catch (error) { setMessage(readableError(error, 'Could not parse that private link.')); }
});
$('join-private-button').addEventListener('click', async () => {
  if (!state.parsedPrivate?.placeId) return;
  const parsed = state.parsedPrivate;
  const intent = { placeId: parsed.placeId, ...(parsed.kind === 'accessCode' ? { accessCode: parsed.code } : { linkCode: parsed.code }) };
  await launch(intent);
  if ($('remember-private-checkbox').checked) {
    try { await api.savePrivateJoin({ label: $('private-label-input').value.trim() || 'Saved private server', placeId: parsed.placeId, kind: parsed.kind, code: parsed.code }); await refreshSavedJoins(); setMessage('Private-server code saved.', 'ok'); }
    catch (error) { setMessage(readableError(error, 'Could not save private code.')); }
  }
});

if (typeof api.onAuthStateChanged === 'function') api.onAuthStateChanged(handleAuthStateChanged);
window.addEventListener('hashchange', () => { void renderRoute(); });

async function init() {
  try {
    const local = await api.getLocalState();
    state.favorites = new Set(local.favorites || []);
    state.recents = Array.isArray(local.recents) ? local.recents : [];
    state.savedJoins = local.privateJoins || [];
    renderSavedJoins();
  } catch { /* local state is optional */ }
  await refreshAuth();
  await refreshAuthProxyConfig();
  if (!window.location.hash) navigate('/home', { replace: true });
  else await renderRoute();
  void runDiagnostics();
}

void init();
