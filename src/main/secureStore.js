const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

class SecureStore {
  constructor() {
    const userDataPath = app && typeof app.getPath === 'function'
      ? app.getPath('userData')
      : path.join(os.homedir(), '.UsageMonitor');
    this.storePath = path.join(userDataPath, 'user_state.json');
    this.data = this._load();
  }

  _load() {
    try {
      if (fs.existsSync(this.storePath)) {
        const raw = fs.readFileSync(this.storePath, 'utf8');
        return JSON.parse(raw);
      }
    } catch (err) {
      console.error('[SecureStore] Load error:', err.message);
    }
    return {
      providers: {
        claude: { loggedIn: false },
        antigravity: { loggedIn: false }
      },
      sessions: {},
      settings: {
        refreshIntervalMinutes: 5,
        notifyThreshold: 80,
        notificationsEnabled: true
      }
    };
  }

  _save() {
    try {
      fs.mkdirSync(path.dirname(this.storePath), { recursive: true });
      fs.writeFileSync(this.storePath, JSON.stringify(this.data, null, 2), 'utf8');
    } catch (err) {
      console.error('[SecureStore] Save error:', err.message);
    }
  }

  getProviderState(provider) {
    if (!this.data.providers) this.data.providers = {};
    return this.data.providers[provider] || { loggedIn: false };
  }

  setProviderLoggedIn(provider, loggedIn, meta = {}) {
    if (!this.data.providers) this.data.providers = {};
    this.data.providers[provider] = {
      loggedIn,
      lastLogin: loggedIn ? new Date().toISOString() : null,
      ...meta
    };
    this._save();
  }

  saveSession(provider, sessionData) {
    if (!this.data.sessions) this.data.sessions = {};
    this.data.sessions[provider] = {
      data: sessionData,
      updatedAt: new Date().toISOString()
    };
    this.setProviderLoggedIn(provider, true);
    this._save();
  }

  getSession(provider) {
    if (!this.data.sessions || !this.data.sessions[provider]) return null;
    return this.data.sessions[provider].data;
  }

  clearSession(provider) {
    if (this.data.sessions && this.data.sessions[provider]) {
      delete this.data.sessions[provider];
    }
    this.setProviderLoggedIn(provider, false);
    this._save();
  }

  getSettings() {
    if (!this.data.settings) this.data.settings = {};
    return {
      refreshIntervalMinutes: 5,
      notifyThreshold: 80,
      notificationsEnabled: true,
      systemStatsEnabled: true,
      refreshButtonEnabled: true,
      trayWeeklyRing: true,
      ...this.data.settings
    };
  }

  updateSettings(settings) {
    if (!this.data.settings) this.data.settings = {};
    this.data.settings = { ...this.data.settings, ...settings };
    this._save();
    return this.getSettings();
  }
}

module.exports = new SecureStore();
