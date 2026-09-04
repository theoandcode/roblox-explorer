const fs = require('node:fs');
const path = require('node:path');
const { isId } = require('./validation');

function normalizeRecent(value) {
  if (!value || typeof value !== 'object' || !isId(value.universeId) || !isId(value.rootPlaceId)) return null;
  return {
    universeId: value.universeId,
    rootPlaceId: value.rootPlaceId,
    name: typeof value.name === 'string' ? value.name.slice(0, 200) : 'Untitled experience',
    iconUrl: typeof value.iconUrl === 'string' ? value.iconUrl : undefined
  };
}

function normalizeSettings(value) {
  const proxy = value && typeof value === 'object' && typeof value.authProxy === 'string'
    ? value.authProxy.trim().slice(0, 512)
    : '';
  return { authProxy: proxy || undefined };
}

class LocalStore {
  constructor(filePath, secureStorage) {
    this.filePath = filePath;
    this.secureStorage = secureStorage;
    this.state = this.read();
  }

  read() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      return {
        favorites: Array.isArray(parsed.favorites) ? parsed.favorites.filter(isId).slice(0, 200) : [],
        recents: Array.isArray(parsed.recents) ? parsed.recents.map(normalizeRecent).filter(Boolean).slice(0, 50) : [],
        privateJoins: Array.isArray(parsed.privateJoins) ? parsed.privateJoins.filter((entry) => entry && typeof entry === 'object' && typeof entry.id === 'string' && ['linkCode', 'accessCode'].includes(entry.kind)).slice(0, 100) : [],
        settings: normalizeSettings(parsed.settings)
      };
    } catch {
      return { favorites: [], recents: [], privateJoins: [], settings: normalizeSettings() };
    }
  }

  write() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    fs.renameSync(temporaryPath, this.filePath);
  }

  listPrivateJoins() {
    return this.state.privateJoins.map((entry) => ({
      id: entry.id,
      label: entry.label,
      placeId: entry.placeId,
      kind: entry.kind,
      createdAt: entry.createdAt,
      lastUsedAt: entry.lastUsedAt
    }));
  }

  getPrivateJoinSecret(id) {
    const entry = this.state.privateJoins.find((candidate) => candidate.id === id);
    if (!entry) return null;
    if (entry.encryptedCode && this.secureStorage?.isEncryptionAvailable?.()) {
      try { return this.secureStorage.decryptString(Buffer.from(entry.encryptedCode, 'base64')); } catch { return null; }
    }
    return typeof entry.code === 'string' ? entry.code : null;
  }

  savePrivateJoin(input) {
    const now = new Date().toISOString();
    const id = input.id || `${input.kind}-${input.placeId || 'unknown'}-${Date.now()}`;
    const entry = {
      id,
      label: input.label || 'Saved private server',
      placeId: input.placeId,
      kind: input.kind,
      createdAt: input.createdAt || now,
      lastUsedAt: now
    };
    if (this.secureStorage?.isEncryptionAvailable?.()) {
      entry.encryptedCode = this.secureStorage.encryptString(input.code).toString('base64');
    } else {
      entry.code = input.code;
    }
    const index = this.state.privateJoins.findIndex((candidate) => candidate.id === id);
    if (index >= 0) this.state.privateJoins[index] = { ...this.state.privateJoins[index], ...entry };
    else this.state.privateJoins.unshift(entry);
    this.state.privateJoins = this.state.privateJoins.slice(0, 100);
    this.write();
    return { id, label: entry.label, placeId: entry.placeId, kind: entry.kind, createdAt: entry.createdAt, lastUsedAt: entry.lastUsedAt };
  }

  touchPrivateJoin(id) {
    const entry = this.state.privateJoins.find((candidate) => candidate.id === id);
    if (!entry) return;
    entry.lastUsedAt = new Date().toISOString();
    this.write();
  }

  deletePrivateJoin(id) {
    this.state.privateJoins = this.state.privateJoins.filter((entry) => entry.id !== id);
    this.write();
  }

  forgetSavedPrivateJoins() {
    this.state.privateJoins = [];
    this.write();
  }

  getAuthProxy() {
    return this.state.settings?.authProxy;
  }

  setAuthProxy(value) {
    this.state.settings = normalizeSettings({ authProxy: value });
    this.write();
  }

  toggleFavorite(universeId) {
    const index = this.state.favorites.indexOf(universeId);
    if (index >= 0) this.state.favorites.splice(index, 1);
    else this.state.favorites.unshift(universeId);
    this.state.favorites = this.state.favorites.slice(0, 200);
    this.write();
    return this.state.favorites.includes(universeId);
  }

  recordRecent(experience) {
    const recent = normalizeRecent(experience);
    if (!recent) return;
    this.state.recents = [recent, ...this.state.recents.filter((item) => item.universeId !== recent.universeId)].slice(0, 50);
    this.write();
  }

  clearBrowsingData() {
    this.state.recents = [];
    this.write();
  }

  snapshot() {
    return { favorites: [...this.state.favorites], recents: [...this.state.recents], privateJoins: this.listPrivateJoins() };
  }
}

module.exports = { LocalStore };
