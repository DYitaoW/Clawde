const { app, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

class SecureStore {
  constructor() {
    const userDataPath = app && typeof app.getPath === 'function'
      ? app.getPath('userData')
      : path.join(os.homedir(), '.UsageMonitor');
    this.storePath = path.join(userDataPath, 'user_state.json');
    // Session cookies are encrypted at rest with safeStorage (macOS Keychain).
    // safeStorage is only reliable after app 'ready', so decryption is lazy.
    this._encryptedSessions = null; // base64 blob not yet decrypted
    this._needsEncryption = false;  // legacy plaintext sessions to migrate
    this.data = this._load();
  }

  _canEncrypt() {
    try {
      return app.isReady() && safeStorage.isEncryptionAvailable();
    } catch {
      return false;
    }
  }

  // Decrypts sessions on first access (after app ready)
  _ensureSessions() {
    if (this._encryptedSessions && this._canEncrypt()) {
      try {
        const json = safeStorage.decryptString(Buffer.from(this._encryptedSessions, 'base64'));
        this.data.sessions = JSON.parse(json);
      } catch (err) {
        // Keychain key changed (e.g. different build) - user just signs in again
        console.warn('[SecureStore] Could not decrypt saved sessions:', err.message);
        this.data.sessions = {};
      }
      this._encryptedSessions = null;
    }
    if (!this.data.sessions) this.data.sessions = {};
    if (this._needsEncryption && this._canEncrypt()) {
      this._needsEncryption = false;
      this._save(); // migrate legacy plaintext sessions to encrypted storage
    }
  }

  _load() {
    try {
      if (fs.existsSync(this.storePath)) {
        const raw = fs.readFileSync(this.storePath, 'utf8');
        const data = JSON.parse(raw);
        if (typeof data.sessionsEncrypted === 'string') {
          this._encryptedSessions = data.sessionsEncrypted;
          delete data.sessionsEncrypted;
          data.sessions = {};
        } else if (data.sessions && Object.keys(data.sessions).length > 0) {
          this._needsEncryption = true;
        }
        return data;
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
      const { sessions, ...rest } = this.data;
      const out = { ...rest };
      if (this._encryptedSessions) {
        // Not decrypted yet: keep the existing encrypted blob untouched
        out.sessionsEncrypted = this._encryptedSessions;
      } else if (this._canEncrypt()) {
        out.sessionsEncrypted = safeStorage.encryptString(JSON.stringify(sessions || {})).toString('base64');
      } else {
        // Before app ready / no Keychain: keep plaintext and encrypt on the next save
        out.sessions = sessions || {};
        if (sessions && Object.keys(sessions).length > 0) this._needsEncryption = true;
      }
      fs.writeFileSync(this.storePath, JSON.stringify(out, null, 2), { encoding: 'utf8', mode: 0o600 });
      fs.chmodSync(this.storePath, 0o600); // owner-only, also for files created by older versions
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
    // Called on every poll: skip the disk write + Keychain encryption when nothing changed
    const current = this.data.providers[provider];
    if (current && current.loggedIn === loggedIn && Object.keys(meta).length === 0) return;
    this.data.providers[provider] = {
      loggedIn,
      lastLogin: loggedIn ? new Date().toISOString() : null,
      ...meta
    };
    this._save();
  }

  saveSession(provider, sessionData) {
    this._ensureSessions();
    this.data.sessions[provider] = {
      data: sessionData,
      updatedAt: new Date().toISOString()
    };
    this.setProviderLoggedIn(provider, true);
    this._save();
  }

  getSession(provider) {
    this._ensureSessions();
    if (!this.data.sessions[provider]) return null;
    return this.data.sessions[provider].data;
  }

  clearSession(provider) {
    this._ensureSessions();
    if (this.data.sessions[provider]) {
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
      pacingEnabled: true,
      theme: 'system',
      resetAlertsEnabled: true,
      historyEnabled: true,
      trayShowClaude: true,
      trayShowAntigravity: true,
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
