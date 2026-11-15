const { session } = require('electron');
const secureStore = require('../secureStore');

const GEMINI_PARTITION = 'persist:gemini';

class GeminiProvider {
  constructor() {
    this.name = 'Gemini';
    this.id = 'gemini';
  }

  getSession() {
    return session.fromPartition(GEMINI_PARTITION);
  }

  async restoreSession() {
    try {
      const ses = this.getSession();
      const cookies = await ses.cookies.get({});
      const hasGoogleAuth = cookies.some(c => c.name === 'SID' || c.name === '__Secure-1PSID');

      if (!hasGoogleAuth) {
        const savedSession = secureStore.getSession('gemini');
        if (savedSession && Array.isArray(savedSession.cookies) && savedSession.cookies.length > 0) {
          console.log('[GeminiProvider] Restoring persistent Google session from local store...');
          const oneYearExpiry = Math.floor(Date.now() / 1000) + (365 * 24 * 3600);

          for (const c of savedSession.cookies) {
            try {
              const cookieObj = {
                url: 'https://gemini.google.com',
                name: c.name,
                value: c.value,
                path: c.path || '/'
              };
              if (c.domain && !c.domain.startsWith('.')) {
                cookieObj.domain = c.domain;
              }
              if (c.secure !== undefined) cookieObj.secure = c.secure;
              if (c.httpOnly !== undefined) cookieObj.httpOnly = c.httpOnly;
              cookieObj.expirationDate = c.expirationDate || oneYearExpiry;

              await ses.cookies.set(cookieObj);
            } catch (err) {}
          }
          await ses.cookies.flushStore();
          console.log('[GeminiProvider] Persistent Gemini session restored.');
          return true;
        }
      } else {
        await ses.cookies.flushStore();
        return true;
      }
    } catch (e) {
      console.warn('[GeminiProvider] Session restore warning:', e.message);
    }
    return false;
  }

  async checkAuth() {
    // 1. Check partition cookies
    try {
      const ses = this.getSession();
      let cookies = await ses.cookies.get({});
      let hasAuth = cookies.some(c => c.name === 'SID' || c.name === '__Secure-1PSID');

      if (!hasAuth) {
        await this.restoreSession();
        cookies = await ses.cookies.get({});
        hasAuth = cookies.some(c => c.name === 'SID' || c.name === '__Secure-1PSID');
      }

      if (hasAuth) return true;
    } catch (e) {}

    // 2. Check saved session state
    const sessionData = secureStore.getSession('gemini');
    if (sessionData && sessionData.connectedAt) {
      return true;
    }

    return false;
  }

  async fetchUsage() {
    try {
      const isAuth = await this.checkAuth();
      if (!isAuth) {
        secureStore.setProviderLoggedIn('gemini', false);
        return {
          provider: 'gemini',
          name: 'Gemini',
          loggedIn: false,
          percentUsed: 0,
          resetInText: 'Not Logged In',
          status: 'disconnected',
          detail: 'Sign in to connect Gemini web account'
        };
      }

      secureStore.setProviderLoggedIn('gemini', true);

      return {
        provider: 'gemini',
        name: 'Gemini',
        loggedIn: true,
        percentUsed: 0,
        resetInText: 'Active',
        status: 'ok',
        detail: 'Personal Google Gemini Connected'
      };

    } catch (err) {
      console.error('[GeminiProvider] Fetch error:', err.message);
      return {
        provider: 'gemini',
        name: 'Gemini',
        loggedIn: true,
        percentUsed: 0,
        resetInText: 'Connected',
        status: 'ok',
        detail: 'Google Account Connected'
      };
    }
  }

  async logout() {
    try {
      const ses = this.getSession();
      await ses.clearStorageData();
    } catch (e) {}
    secureStore.clearSession('gemini');
  }
}

module.exports = new GeminiProvider();
