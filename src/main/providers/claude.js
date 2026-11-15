const { session, net, BrowserWindow } = require('electron');
const secureStore = require('../secureStore');

const CLAUDE_PARTITION = 'persist:claude';

function formatResetRemaining(diffMs) {
  if (diffMs <= 0) return 'Resetting shortly';
  const totalMinutes = Math.floor(diffMs / 60000);
  const d = Math.floor(totalMinutes / (24 * 60));
  const h = Math.floor((totalMinutes % (24 * 60)) / 60);
  const m = totalMinutes % 60;

  const parts = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0 || (d > 0 && m > 0)) parts.push(`${h}h`);
  if (m > 0 || (d === 0 && h === 0)) parts.push(`${m}m`);

  return `Resets in ${parts.join(' ')}`;
}

class ClaudeProvider {
  constructor() {
    this.name = 'Claude';
    this.id = 'claude';
    this.bgWindow = null;
    this.cachedUsage = null;
  }

  getSession() {
    return session.fromPartition(CLAUDE_PARTITION);
  }

  ensureBackgroundWorker() {
    if (this.bgWindow && !this.bgWindow.isDestroyed()) return;

    this.bgWindow = new BrowserWindow({
      width: 100,
      height: 100,
      show: false,
      webPreferences: {
        partition: CLAUDE_PARTITION,
        nodeIntegration: false,
        contextIsolation: true
      }
    });

    this.bgWindow.loadURL('https://claude.ai/new');
  }

  async restoreSession() {
    try {
      const ses = this.getSession();
      const allCookies = await ses.cookies.get({});
      const hasKey = allCookies.some(c => c.name === 'sessionKey' && c.value && c.value.length > 5);

      if (!hasKey) {
        const savedSession = secureStore.getSession('claude');
        if (savedSession && Array.isArray(savedSession.cookies)) {
          console.log('[ClaudeProvider] Restoring persistent Claude session from local store...');
          const oneYearExpiry = Math.floor(Date.now() / 1000) + (365 * 24 * 3600);

          for (const c of savedSession.cookies) {
            try {
              const cookieObj = {
                url: 'https://claude.ai',
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
          console.log('[ClaudeProvider] Persistent session restored.');
          this.ensureBackgroundWorker();
          return true;
        }
      } else {
        await ses.cookies.flushStore();
        this.ensureBackgroundWorker();
        return true;
      }
    } catch (e) {
      console.warn('[ClaudeProvider] Session restore warning:', e.message);
    }
    return false;
  }

  async checkAuth() {
    try {
      const ses = this.getSession();
      let cookies = await ses.cookies.get({});
      let hasKey = cookies.some(c => c.name === 'sessionKey' && c.value && c.value.length > 5);

      if (!hasKey) {
        await this.restoreSession();
        cookies = await ses.cookies.get({});
        hasKey = cookies.some(c => c.name === 'sessionKey' && c.value && c.value.length > 5);
      }

      return hasKey;
    } catch (e) {
      return false;
    }
  }

  async fetchViaInPage() {
    if (!this.bgWindow || this.bgWindow.isDestroyed()) {
      this.ensureBackgroundWorker();
      return null;
    }

    try {
      const scriptPromise = this.bgWindow.webContents.executeJavaScript(`
        (async () => {
          try {
            const orgsRes = await fetch('/api/organizations');
            if (!orgsRes.ok) return { error: 'orgs_' + orgsRes.status };
            const orgs = await orgsRes.json();
            if (!orgs || !orgs[0]) return { error: 'no_orgs' };
            const orgId = orgs[0].uuid;
            const usageRes = await fetch('/api/organizations/' + orgId + '/usage');
            const usage = usageRes.ok ? await usageRes.json() : null;
            return { success: true, orgId, usage };
          } catch (e) {
            return { error: e.message };
          }
        })()
      `).catch(() => null);

      const timeoutPromise = new Promise(resolve => setTimeout(() => resolve(null), 3000));
      const result = await Promise.race([scriptPromise, timeoutPromise]);

      if (result && result.success && result.usage) {
        return result.usage;
      }
    } catch (e) {}

    return null;
  }

  async fetchUsage() {
    try {
      const isAuth = await this.checkAuth();
      if (!isAuth) {
        secureStore.setProviderLoggedIn('claude', false);
        return {
          provider: 'claude',
          name: 'Claude',
          loggedIn: false,
          percentUsed: 0,
          windowPercent: 0,
          weeklyPercent: 0,
          resetInText: 'Not Logged In',
          status: 'disconnected',
          detail: 'Sign in to track web chat limits'
        };
      }

      secureStore.setProviderLoggedIn('claude', true);
      this.ensureBackgroundWorker();

      let usageData = await this.fetchViaInPage();

      // Check cached usage from loginWindow or secureStore
      if (!usageData) {
        const savedSession = secureStore.getSession('claude');
        if (savedSession && savedSession.lastUsage) {
          usageData = savedSession.lastUsage;
        }
      }

      // Fallback: If still warming up, use net.fetch with partition cookies
      if (!usageData) {
        const ses = this.getSession();
        const cookies = await ses.cookies.get({});
        const cookieHeader = cookies
          .filter(c => (c.domain && c.domain.includes('claude.ai')) || c.name === 'sessionKey')
          .map(c => `${c.name}=${c.value}`)
          .join('; ');

        const fetchFn = (net && typeof net.fetch === 'function') ? net.fetch.bind(net) : globalThis.fetch;
        const headers = {
          'Accept': 'application/json, text/plain, */*',
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
          'Cookie': cookieHeader,
          'Referer': 'https://claude.ai/'
        };

        try {
          const orgsRes = await fetchFn('https://claude.ai/api/organizations', { headers });
          if (orgsRes.ok) {
            const orgs = await orgsRes.json();
            if (Array.isArray(orgs) && orgs.length > 0) {
              const orgId = orgs[0].uuid;
              const usageRes = await fetchFn(`https://claude.ai/api/organizations/${orgId}/usage`, { headers });
              if (usageRes.ok) {
                usageData = await usageRes.json();
              }
            }
          }
        } catch (e) {}
      }

      let percentUsed = 0;
      let fiveHourPercent = 0;
      let sevenDayPercent = 0;
      let windowResetInText = 'Full Quota Available';
      let weeklyResetInText = 'Full Quota Available';
      let resetInText = 'Full Quota Available';
      let detail = 'Claude Pro / Free (Active)';

      if (usageData) {
        console.log('[ClaudeProvider] Usage payload:', JSON.stringify(usageData));
        this.cachedUsage = usageData;

        let fiveHour = usageData.five_hour || usageData.session || {};
        let sevenDay = usageData.seven_day || usageData.weekly || {};

        if (Array.isArray(usageData.limits)) {
          const sessionLimit = usageData.limits.find(l => l.kind === 'session' || l.group === 'session');
          if (sessionLimit) {
            fiveHour = { ...fiveHour, ...sessionLimit };
          }
          const weeklyLimit = usageData.limits.find(l => l.kind === 'weekly_all' || l.kind === 'weekly' || l.group === 'weekly');
          if (weeklyLimit) {
            sevenDay = { ...sevenDay, ...weeklyLimit };
          }
        }

        if (fiveHour.utilization !== undefined && fiveHour.utilization !== null) {
          const val = Number(fiveHour.utilization);
          fiveHourPercent = Math.round(val <= 1.0 && val > 0 ? val * 100 : val);
        } else if (fiveHour.percent_used !== undefined) {
          fiveHourPercent = Math.round(Number(fiveHour.percent_used));
        } else if (fiveHour.percent !== undefined) {
          fiveHourPercent = Math.round(Number(fiveHour.percent));
        }

        if (sevenDay.utilization !== undefined && sevenDay.utilization !== null) {
          const val = Number(sevenDay.utilization);
          sevenDayPercent = Math.round(val <= 1.0 && val > 0 ? val * 100 : val);
        } else if (sevenDay.percent_used !== undefined) {
          sevenDayPercent = Math.round(Number(sevenDay.percent_used));
        } else if (sevenDay.percent !== undefined) {
          sevenDayPercent = Math.round(Number(sevenDay.percent));
        }

        percentUsed = fiveHourPercent;

        const fiveHourReset = fiveHour.resets_at || fiveHour.resetsAt || fiveHour.reset_at || fiveHour.resetAt || usageData.resets_at || usageData.resetsAt;
        if (fiveHourReset) {
          const diffMs = new Date(fiveHourReset).getTime() - Date.now();
          if (diffMs > 0) {
            windowResetInText = formatResetRemaining(diffMs);
          } else if (diffMs >= -120000) {
            windowResetInText = 'Resetting shortly';
          } else {
            fiveHourPercent = 0;
            percentUsed = 0;
            windowResetInText = 'Full Quota Available';
          }
        } else if (fiveHourPercent === 0) {
          windowResetInText = 'Full Quota Available';
        } else {
          windowResetInText = 'Resets in 5h';
        }

        const sevenDayReset = sevenDay.resets_at || sevenDay.resetsAt || sevenDay.reset_at || sevenDay.resetAt;
        if (sevenDayReset) {
          const diffMs = new Date(sevenDayReset).getTime() - Date.now();
          if (diffMs > 0) {
            weeklyResetInText = formatResetRemaining(diffMs);
          } else if (diffMs >= -120000) {
            weeklyResetInText = 'Resetting shortly';
          } else {
            sevenDayPercent = 0;
            weeklyResetInText = 'Full Quota Available';
          }
        } else if (sevenDayPercent === 0) {
          weeklyResetInText = 'Full Quota Available';
        } else {
          weeklyResetInText = 'Resets in 7d';
        }

        resetInText = windowResetInText !== 'Full Quota Available' ? windowResetInText : weeklyResetInText;

        if (sevenDayPercent > 0) {
          detail = `5h: ${fiveHourPercent}% · Weekly: ${sevenDayPercent}%`;
        } else if (fiveHourPercent === 0) {
          detail = '5-Hour Window (100% available)';
        } else {
          detail = `5-Hour Window (${fiveHourPercent}% used)`;
        }

        try {
          const currentSession = secureStore.getSession('claude') || {};
          secureStore.saveSession('claude', {
            ...currentSession,
            lastUsage: usageData
          });
        } catch (e) {}
      }

      const status = percentUsed >= 90 ? 'critical' : percentUsed >= 70 ? 'warning' : 'ok';

      return {
        provider: 'claude',
        name: 'Claude',
        loggedIn: true,
        percentUsed,
        windowPercent: fiveHourPercent,
        weeklyPercent: sevenDayPercent,
        windowResetInText,
        weeklyResetInText,
        resetInText,
        status,
        detail
      };

    } catch (err) {
      console.error('[ClaudeProvider] Usage fetch error:', err.message);
      return {
        provider: 'claude',
        name: 'Claude',
        loggedIn: true,
        percentUsed: 0,
        windowPercent: 0,
        weeklyPercent: 0,
        windowResetInText: 'Full Quota Available',
        weeklyResetInText: 'Full Quota Available',
        resetInText: 'Full Quota Available',
        status: 'ok',
        detail: 'Claude Account Connected'
      };
    }
  }

  async logout() {
    try {
      if (this.bgWindow && !this.bgWindow.isDestroyed()) {
        this.bgWindow.close();
        this.bgWindow = null;
      }
      const ses = this.getSession();
      await ses.clearStorageData();
    } catch (e) {}
    secureStore.clearSession('claude');
  }
}

module.exports = new ClaudeProvider();
