const { contextBridge, ipcRenderer } = require('electron');

function invoke(channel, input) {
  return ipcRenderer.invoke(channel, input);
}

function onAuthStateChanged(callback) {
  if (typeof callback !== 'function') return () => {};
  const listener = (_event, status) => callback(status);
  ipcRenderer.on('auth-state-changed', listener);
  return () => ipcRenderer.removeListener('auth-state-changed', listener);
}

contextBridge.exposeInMainWorld('robloxNavigator', {
  searchExperiences: (input) => invoke('search-experiences', input),
  getExperience: (input) => invoke('get-experience', input),
  getExperienceThumbnails: (input) => invoke('get-experience-thumbnails', input),
  getTopCharts: () => invoke('get-top-charts'),
  listOnlineFriends: (input) => invoke('list-online-friends', input),
  listPublicServers: (input) => invoke('list-public-servers', input),
  join: (input) => invoke('join', input),
  parsePrivateLink: (input) => invoke('parse-private-link', input),
  listSavedPrivateJoins: () => invoke('list-saved-private-joins'),
  savePrivateJoin: (input) => invoke('save-private-join', input),
  deleteSavedPrivateJoin: (input) => invoke('delete-saved-private-join', input),
  useSavedPrivateJoin: (input) => invoke('use-saved-private-join', input),
  toggleFavorite: (input) => invoke('toggle-favorite', input),
  getLocalState: () => invoke('get-local-state'),
  getAuthStatus: () => invoke('get-auth-status'),
  onAuthStateChanged,
  getAuthConfig: () => invoke('get-auth-config'),
  setAuthProxy: (input) => invoke('set-auth-proxy', input),
  beginSignIn: () => invoke('begin-sign-in'),
  signOut: () => invoke('sign-out'),
  clearBrowsingData: () => invoke('clear-browsing-data'),
  forgetSavedPrivateJoins: () => invoke('forget-saved-private-joins'),
  listPrivateServers: (input) => invoke('list-private-servers', input),
  getPrivateServer: (input) => invoke('get-private-server', input),
  joinPrivateServer: (input) => invoke('join-private-server', input),
  createPrivateServer: (input) => invoke('create-private-server', input),
  updatePrivateServer: (input) => invoke('update-private-server', input),
  runConnectivityCheck: () => invoke('run-connectivity-check')
});
