/* global robloxNavigator */

const api = window.robloxNavigator;
const state = {
  query: '',
  searchSessionId: undefined,
  searchPageToken: undefined,
  selected: undefined,
  details: undefined,
  publicCursor: undefined,
  parsedPrivate: undefined,
  auth: { authenticated: false },
  authProxy: { authProxy: '', source: 'system', configured: false, active: false, valid: true },
  favorites: new Set(),
  savedJoins: [],
  permissionsServerId: undefined
};
state.searchResults = new Map();

const $ = (id) => document.getElementById(id);
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[char]);
const formatNumber = (value) => Number(value || 0).toLocaleString();
const formatDate = (value) => value ? new Date(value).toLocaleDateString() : '';

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
  node.textContent = message || '';
  node.className = `message ${message ? kind : 'hidden'}`;
  if (message) showToast(message, kind);
}

function showSection(id, visible) { $(id).classList.toggle('hidden', !visible); }

function button(label, className, attrs = '') { return `<button class="button ${className}" ${attrs}>${escapeHtml(label)}</button>`; }

function imageOrPlaceholder(url, alt, className = 'game-art') {
  if (!url) return `<div class="${className}" role="img" aria-label="No image available"></div>`;
  return `<img class="${className}" src="${escapeHtml(url)}" alt="${escapeHtml(alt)}" loading="lazy" referrerpolicy="no-referrer" />`;
}

function selectedLaunchFormat() {
  return $('launch-format')?.value === 'legacy' ? 'legacy' : 'modern';
}

function renderResults(page, append = false) {
  const grid = $('results-grid');
  if (!append && !page.results.length) {
    grid.className = 'card-grid empty-state';
    grid.innerHTML = '<div class="empty-icon">⌕</div><p>No experiences matched that search.</p>';
  } else {
    if (!append) { grid.className = 'card-grid'; grid.innerHTML = ''; }
    for (const game of page.results) {
      state.searchResults.set(game.universeId, game);
      const card = document.createElement('article');
      card.className = 'game-card';
      card.dataset.universeId = game.universeId;
      card.innerHTML = `${imageOrPlaceholder(game.iconUrl, game.name)}<div class="game-card-body"><h3 title="${escapeHtml(game.name)}">${escapeHtml(game.name)}</h3><p>${escapeHtml(game.description || 'No description available.')}</p><div class="game-meta"><span>◉ ${formatNumber(game.playerCount)} playing</span><span>${escapeHtml(game.creator?.name || 'Unknown creator')}</span></div><div class="card-actions">${button('Details', 'secondary', `data-action="details" data-id="${game.universeId}"`)}${button('Play', 'primary', `data-action="play" data-place-id="${game.rootPlaceId}"`)}</div></div>`;
      grid.appendChild(card);
    }
  }
  $('results-title').textContent = state.query ? `Results for “${state.query}”` : 'Search for an experience';
  $('load-more-button').classList.toggle('hidden', !page.nextPageToken);
}

async function search(query, append = false) {
  if (!query.trim()) { setMessage('Enter a search term first.'); return; }
  setMessage('');
  if (!append) { state.query = query.trim(); state.searchSessionId = undefined; state.searchPageToken = undefined; $('results-grid').innerHTML = '<div class="empty-state"><p>Searching…</p></div>'; }
  try {
    const page = await api.searchExperiences({ query: state.query, sessionId: state.searchSessionId, pageToken: state.searchPageToken });
    state.searchSessionId = page.sessionId;
    state.searchPageToken = page.nextPageToken;
    renderResults(page, append);
  } catch (error) { renderResults({ results: [], nextPageToken: undefined }); setMessage(error.message || 'Search failed.'); }
}

async function selectExperience(universeId) {
  setMessage('');
  closePermissionsEditor();
  try {
    state.details = await api.getExperience({ universeId, fallback: state.searchResults.get(universeId) });
    state.selected = state.details;
    $('experience-title').textContent = state.details.name;
    renderExperience();
    showSection('results-section', false);
    showSection('experience-section', true);
    showSection('servers-section', true);
    showSection('my-private-section', state.auth.authenticated);
    showSection('owned-private-section', state.auth.authenticated);
    await listPublicServers();
    if (state.auth.authenticated) await listOwnedPrivateServers();
  } catch (error) { setMessage(error.message || 'Could not load that experience.'); }
}

function renderExperience() {
  const game = state.details;
  const favorite = state.favorites.has(game.universeId);
  $('experience-detail').innerHTML = `<div>${imageOrPlaceholder(game.thumbnailUrls?.[0] || game.iconUrl, game.name, 'experience-art')}</div><div class="detail-card"><h3>${escapeHtml(game.name)}</h3><p class="muted">by ${escapeHtml(game.creator?.name || 'Unknown creator')} ${game.contentMaturity ? `· ${escapeHtml(game.contentMaturity)}` : ''}</p><p class="detail-description">${escapeHtml(game.description || 'No description available.')}</p><div class="stat-row"><div class="stat"><strong>${formatNumber(game.playerCount)}</strong><span>playing</span></div><div class="stat"><strong>${formatNumber(game.visits)}</strong><span>visits</span></div><div class="stat"><strong>${formatNumber(game.maxPlayers)}</strong><span>server size</span></div></div><div class="detail-actions">${button('Play', 'primary', `data-action="play" data-place-id="${game.rootPlaceId}"`)}${button(favorite ? '★ Favorited' : '☆ Favorite', 'secondary', `data-action="favorite" data-id="${game.universeId}"`)}${button('List private servers', 'ghost', 'data-action="private-for-place"')}</div></div>`;
}

async function listPublicServers(cursor) {
  if (!state.selected) return;
  const list = $('servers-list');
  if (!cursor) { list.innerHTML = '<p class="muted">Loading live servers…</p>'; state.publicCursor = undefined; }
  try {
    const page = await api.listPublicServers({ placeId: state.selected.rootPlaceId, cursor, excludeFullGames: $('exclude-full-checkbox').checked, limit: 25, sortOrder: 'Asc' });
    state.publicCursor = page.nextPageCursor;
    if (!page.data.length) list.innerHTML = '<p class="muted">No public servers are visible right now.</p>';
    else {
      if (!cursor) list.innerHTML = '';
      for (const server of page.data) {
        const row = document.createElement('div'); row.className = 'server-row';
        row.innerHTML = `<div><strong>${escapeHtml(server.id.slice(0, 8))}…</strong><small>${escapeHtml(server.id)}</small></div><div class="server-metric">${server.playing}/${server.maxPlayers}<small>players</small></div><div class="server-metric">${server.ping ?? '—'} ms<small>ping</small></div><div class="server-metric">${server.fps ? Math.round(server.fps) : '—'}<small>FPS</small></div>${button('Join', 'primary', `data-action="server-join" data-job-id="${escapeHtml(server.id)}" data-place-id="${state.selected.rootPlaceId}"`)}`;
        list.appendChild(row);
      }
    }
    $('server-summary').textContent = `${page.data.length} server${page.data.length === 1 ? '' : 's'} shown · refreshes are deliberately gentle`;
    $('load-more-servers-button').classList.toggle('hidden', !page.nextPageCursor);
  } catch (error) { list.innerHTML = `<p class="muted">${escapeHtml(error.message || 'Could not load servers.')}</p>`; setMessage(error.message || 'Could not load servers.'); }
}

async function launch(intent) {
  setMessage('');
  try {
    const result = await api.join({ ...intent, format: selectedLaunchFormat() });
    setMessage('Sent to Roblox Player. It will apply your account permissions and join rules.', 'ok');
    if (result?.kind === 'private-link' || result?.kind === 'private-access') setTimeout(() => setMessage('If Player did not open, check that Roblox is installed and registered for the roblox: protocol.'), 3500);
  } catch (error) { setMessage(error.message || 'Could not hand off to Roblox Player.'); }
}

function renderSavedJoins() {
  const node = $('saved-private-list');
  if (!state.savedJoins.length) { node.innerHTML = '<p class="muted">No saved codes yet.</p>'; return; }
  node.innerHTML = state.savedJoins.map((entry) => `<div class="saved-entry"><div><strong>${escapeHtml(entry.label)}</strong><span>${escapeHtml(entry.kind)}${entry.placeId ? ` · place ${escapeHtml(entry.placeId)}` : ''}</span></div><div class="saved-entry-actions">${button('Join', 'secondary', `data-action="saved-join" data-id="${escapeHtml(entry.id)}"`)}<button class="button danger" data-action="saved-delete" data-id="${escapeHtml(entry.id)}">×</button></div></div>`).join('');
}

async function refreshSavedJoins() { try { state.savedJoins = await api.listSavedPrivateJoins(); renderSavedJoins(); } catch (error) { setMessage(error.message || 'Could not load saved links.'); } }

function renderAuth() {
  $('auth-button').textContent = state.auth.authenticated ? 'Signed in' : 'Sign in';
  $('auth-button').classList.toggle('primary', state.auth.authenticated);
  $('auth-button').classList.toggle('secondary', !state.auth.authenticated);
  showSection('my-private-section', state.auth.authenticated && Boolean(state.selected));
  showSection('owned-private-section', state.auth.authenticated && Boolean(state.selected));
  if (!state.auth.authenticated) closePermissionsEditor();
  renderOwnedPrivateSectionState();
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
  help.textContent = enabled
    ? 'Creation is enabled. Roblox will show the final price and apply its purchase rules.'
    : 'Creation is disabled until the current Roblox purchase contract is enabled.';
}

function closePermissionsEditor() {
  state.permissionsServerId = undefined;
  $('permissions-private-form')?.classList.add('hidden');
}

function openPermissionsEditor(target) {
  if (!target?.dataset?.id) return;
  state.permissionsServerId = target.dataset.id;
  $('permissions-private-name').textContent = `Editing access for ${target.dataset.name || 'your private server'}.`;
  $('permissions-private-friends').checked = target.dataset.friendsAllowed === 'true';
  $('permissions-private-add').value = '';
  $('permissions-private-remove').value = '';
  $('permissions-private-form').classList.remove('hidden');
  $('permissions-private-form').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function refreshAuth() {
  try { state.auth = await api.getAuthStatus(); renderAuth(); } catch { state.auth = { authenticated: false }; renderAuth(); }
}

function handleAuthStateChanged(status) {
  if (!status || typeof status !== 'object') return;
  const wasAuthenticated = state.auth.authenticated === true;
  state.auth = status;
  renderAuth();
  void refreshAuthProxyConfig();
  if (!wasAuthenticated && state.auth.authenticated) {
    setMessage('Signed in to Roblox.', 'ok');
    if (state.selected) {
      void listPrivateServers();
      void listOwnedPrivateServers();
    }
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
  $('auth-proxy-help').textContent = config.valid === false
    ? (config.error || 'Enter an HTTP(S), SOCKS4, or SOCKS5 proxy URL without credentials or a path.')
    : 'Leave empty to use the operating-system proxy. A saved proxy is used only while the isolated Roblox sign-in window is open, then the session switches back to direct networking.';
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
  } catch (error) {
    setMessage(error.message || 'Could not save the login proxy.');
  }
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
  return '<button class="button ghost" disabled title="Renewal is disabled until its current Robux request contract is verified">Renew unavailable</button>';
}

function renderPrivateServerEntry(server, manage = false) {
  const subscription = server.subscription;
  const subscriptionSummary = subscription?.expirationDate ? ` · expires ${formatDate(subscription.expirationDate)}` : (subscription?.renewalDate ? ` · renewal ${formatDate(subscription.renewalDate)}` : '');
  const actions = [privateJoinButton(server)];
  if (manage) {
    const permissionAttrs = `data-action="permissions-private" data-id="${escapeHtml(server.id)}" data-name="${escapeHtml(server.name)}" data-friends-allowed="${server.friendsAllowed === true ? 'true' : 'false'}"`;
    actions.push(button('Manage access', 'ghost', permissionAttrs), privateSubscriptionAction(server));
  }
  return `<div class="private-entry"><div><strong>${escapeHtml(server.name)}</strong><span>${server.placeId ? `place ${escapeHtml(server.placeId)}` : ''}${server.active === false ? ' · inactive' : ''}${server.friendsAllowed === true ? ' · friends allowed' : ''}${subscriptionSummary}</span></div><div class="saved-entry-actions">${actions.join('')}</div></div>`;
}

function renderPrivateServers(page) {
  const node = $('my-private-list');
  if (!page?.data?.length) { node.innerHTML = '<p class="muted">No private servers were returned for this selection.</p>'; return; }
  node.innerHTML = page.data.map((server) => renderPrivateServerEntry(server)).join('');
}

function renderOwnedPrivateServers(page) {
  const node = $('owned-private-list');
  const selected = state.selected;
  const data = Array.isArray(page?.data) ? page.data.filter((server) => selected && (server.placeId === selected.rootPlaceId || server.universeId === selected.universeId)) : [];
  if (!data.length) {
    node.innerHTML = '<p class="muted">You do not own a private server for this experience yet.</p>';
    return;
  }
  node.innerHTML = data.map((server) => renderPrivateServerEntry(server, true)).join('');
}

async function listPrivateServers() {
  if (!state.auth.authenticated) { setMessage('Sign in to list private servers.'); return; }
  if (!state.selected) { setMessage('Choose an experience first.'); return; }
  try { const page = await api.listPrivateServers({ placeId: state.selected.rootPlaceId }); renderPrivateServers(page); showSection('my-private-section', true); }
  catch (error) { setMessage(error.message || 'Could not list private servers.'); }
}

async function listOwnedPrivateServers() {
  if (!state.auth.authenticated || !state.selected) return;
  closePermissionsEditor();
  const node = $('owned-private-list');
  node.innerHTML = '<p class="muted">Loading your private servers…</p>';
  try {
    const page = await api.listPrivateServers({ mine: true });
    renderOwnedPrivateServers(page);
    showSection('owned-private-section', true);
  } catch (error) {
    node.innerHTML = '<p class="muted">Your owned private servers are unavailable right now.</p>';
    setMessage(error.message || 'Could not load your private servers.');
  }
}

async function runDiagnostics() {
  $('diagnostics').innerHTML = '<p class="muted">Running read-only checks…</p>';
  try {
    const report = await api.runConnectivityCheck();
    $('diagnostics').innerHTML = report.checks.map((check) => `<div class="diagnostic-row"><strong>${escapeHtml(check.name)}</strong><span class="${check.status === 'ok' ? 'ok' : 'error'}">${check.status === 'ok' ? `OK · ${check.latencyMs} ms` : escapeHtml(check.error?.message || 'Unavailable')}</span></div>`).join('') + `<div class="diagnostic-row"><strong>Roblox web session</strong><span>${report.auth.authenticated ? 'Authenticated' : 'Not signed in'}</span></div>`;
    state.auth = report.auth;
    renderAuth();
    const allOk = report.checks.every((check) => check.status === 'ok');
    $('connection-pill').textContent = allOk ? 'APIs reachable' : 'Some APIs unavailable';
    $('connection-pill').className = `status-pill ${allOk ? 'ok' : 'warn'}`;
  } catch (error) { setMessage(error.message || 'Diagnostics failed.'); }
}

document.addEventListener('click', async (event) => {
  const target = event.target.closest('[data-action]');
  if (!target) return;
  const action = target.dataset.action;
  if (action === 'details') await selectExperience(target.dataset.id);
  else if (action === 'play') await launch({ placeId: target.dataset.placeId });
  else if (action === 'server-join') await launch({ placeId: target.dataset.placeId, gameInstanceId: target.dataset.jobId });
  else if (action === 'favorite') { try { const response = await api.toggleFavorite({ universeId: target.dataset.id }); if (response.favorited) state.favorites.add(target.dataset.id); else state.favorites.delete(target.dataset.id); renderExperience(); setMessage(response.favorited ? 'Added to favorites.' : 'Removed from favorites.', 'ok'); } catch (error) { setMessage(error.message); } }
  else if (action === 'private-for-place') await listPrivateServers();
  else if (action === 'saved-join') { try { await api.useSavedPrivateJoin({ id: target.dataset.id, format: selectedLaunchFormat() }); setMessage('Sent to Roblox Player.', 'ok'); } catch (error) { setMessage(error.message); } }
  else if (action === 'saved-delete') { try { await api.deleteSavedPrivateJoin({ id: target.dataset.id }); await refreshSavedJoins(); setMessage('Saved private server removed.', 'ok'); } catch (error) { setMessage(error.message); } }
  else if (action === 'private-entry-join') {
    try {
      await api.joinPrivateServer({ vipServerId: target.dataset.id, format: selectedLaunchFormat(), ...(target.dataset.placeId ? { placeId: target.dataset.placeId } : {}) });
      setMessage('Sent to Roblox Player. It will apply your account permissions and join rules.', 'ok');
    } catch (error) { setMessage(error.message || 'Could not hand off to Roblox Player.'); }
  }
  else if (action === 'permissions-private') openPermissionsEditor(target);
  else if (action === 'subscription-private') {
    const active = target.dataset.active !== 'true';
    const warning = active ? 'Renew this private-server subscription? Roblox may charge Robux.' : 'Cancel this private-server subscription?';
    if (!window.confirm(warning)) return;
    try { await api.updatePrivateServer({ vipServerId: target.dataset.id, operation: 'subscription', payload: { active, ...(active ? { confirmPurchase: true } : {}) } }); await listOwnedPrivateServers(); setMessage(active ? 'Private-server subscription renewed.' : 'Private-server subscription cancelled.', 'ok'); } catch (error) { setMessage(error.message || 'Could not update subscription.'); }
  }
});

$('search-form').addEventListener('submit', (event) => { event.preventDefault(); search($('search-input').value); });
$('load-more-button').addEventListener('click', () => search(state.query, true));
$('back-results-button').addEventListener('click', () => { closePermissionsEditor(); showSection('experience-section', false); showSection('servers-section', false); showSection('my-private-section', false); showSection('owned-private-section', false); showSection('results-section', true); });
$('refresh-servers-button').addEventListener('click', () => listPublicServers());
$('exclude-full-checkbox').addEventListener('change', () => listPublicServers());
$('load-more-servers-button').addEventListener('click', () => listPublicServers(state.publicCursor));
$('refresh-saved-button').addEventListener('click', refreshSavedJoins);
$('list-place-private-button').addEventListener('click', listPrivateServers);
$('refresh-owned-private-button').addEventListener('click', listOwnedPrivateServers);
$('settings-button').addEventListener('click', () => { showSection('settings-section', true); void refreshAuthProxyConfig(); $('settings-section').scrollIntoView({ behavior: 'smooth' }); });
$('auth-proxy-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  await saveAuthProxy($('auth-proxy-input').value.trim());
});
$('clear-auth-proxy-button').addEventListener('click', async () => {
  $('auth-proxy-input').value = '';
  await saveAuthProxy('');
});
$('run-diagnostics-button').addEventListener('click', runDiagnostics);
$('clear-browsing-button').addEventListener('click', async () => {
  if (!window.confirm('Clear recent experience history and in-memory API cache? Favorites and saved private servers will stay.')) return;
  try { await api.clearBrowsingData(); setMessage('Browsing history and API cache cleared.', 'ok'); } catch (error) { setMessage(error.message || 'Could not clear browsing data.'); }
});
$('forget-private-button').addEventListener('click', async () => {
  if (!window.confirm('Forget every saved private-server code from this app?')) return;
  try { state.savedJoins = await api.forgetSavedPrivateJoins(); renderSavedJoins(); setMessage('Saved private-server codes forgotten.', 'ok'); } catch (error) { setMessage(error.message || 'Could not forget saved private servers.'); }
});
$('clear-session-button').addEventListener('click', async () => { if (!window.confirm('Sign out and clear the Roblox web session for this app?')) return; try { state.auth = await api.signOut(); renderAuth(); setMessage('Roblox session cleared.', 'ok'); } catch (error) { setMessage(error.message); } });
$('auth-button').addEventListener('click', async () => { try { if (state.auth.authenticated) { state.auth = await api.signOut(); setMessage('Roblox session cleared.', 'ok'); } else { await api.beginSignIn(); setMessage('Complete sign-in in the Roblox window, then return here.', 'ok'); } await refreshAuth(); await refreshAuthProxyConfig(); } catch (error) { setMessage(error.message || 'Could not open sign-in.'); } });
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
  try {
    await api.createPrivateServer({ universeId: state.selected.universeId, body, confirmPurchase: true });
    $('create-private-form').reset();
    setMessage('Private server created. Refreshing your owned servers…', 'ok');
    await listOwnedPrivateServers();
  } catch (error) {
    setMessage(error.message || 'Could not create the private server.');
  } finally {
    renderOwnedPrivateSectionState();
  }
});
$('permissions-private-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!state.permissionsServerId) return;
  const parseIds = (value) => value ? value.split(',').map((item) => item.trim()).filter(Boolean) : [];
  try {
    await api.updatePrivateServer({
      vipServerId: state.permissionsServerId,
      operation: 'permissions',
      payload: {
        friendsAllowed: $('permissions-private-friends').checked,
        usersToAdd: parseIds($('permissions-private-add').value),
        usersToRemove: parseIds($('permissions-private-remove').value)
      }
    });
    closePermissionsEditor();
    await listOwnedPrivateServers();
    setMessage('Private-server access updated.', 'ok');
  } catch (error) {
    setMessage(error.message || 'Could not update private-server access.');
  }
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
  } catch (error) { setMessage(error.message || 'Could not parse that private link.'); }
});
$('join-private-button').addEventListener('click', async () => {
  if (!state.parsedPrivate?.placeId) return;
  const parsed = state.parsedPrivate;
  const intent = { placeId: parsed.placeId, ...(parsed.kind === 'accessCode' ? { accessCode: parsed.code } : { linkCode: parsed.code }) };
  await launch(intent);
  if ($('remember-private-checkbox').checked) {
    try { await api.savePrivateJoin({ label: $('private-label-input').value.trim() || 'Saved private server', placeId: parsed.placeId, kind: parsed.kind, code: parsed.code }); await refreshSavedJoins(); setMessage('Private-server code saved.', 'ok'); } catch (error) { setMessage(error.message || 'Could not save private code.'); }
  }
});

if (typeof api.onAuthStateChanged === 'function') api.onAuthStateChanged(handleAuthStateChanged);

async function init() {
  try {
    const local = await api.getLocalState();
    state.favorites = new Set(local.favorites || []);
    state.savedJoins = local.privateJoins || [];
    renderSavedJoins();
  } catch { /* local state is optional */ }
  await refreshAuth();
  await refreshAuthProxyConfig();
  runDiagnostics();
}

init();
