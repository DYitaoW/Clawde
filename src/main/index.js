const { app, ipcMain, Notification, shell } = require('electron');
const path = require('path');
const fs = require('fs');

// App was renamed to "Clawde". Keep using the old data folder if it exists so
// existing logins and settings survive; new installs use "Clawde".
// Must run before any module that reads app.getPath('userData').
{
  const legacyUserData = path.join(app.getPath('appData'), 'ai-usage-monitor');
  app.setName('Clawde');
  app.setPath('userData', fs.existsSync(legacyUserData)
    ? legacyUserData
    : path.join(app.getPath('appData'), 'Clawde'));
}

// Only one copy may run: two copies sharing the data folder corrupt Chromium's
// site storage (e.g. claude.ai IndexedDB). A second launch just opens the popover.
if (!app.requestSingleInstanceLock()) {
  app.exit(0);
}

// Clean User-Agent fallback
const chromeVersion = process.versions.chrome || '131.0.0.0';
const cleanUserAgent = process.platform === 'darwin'
  ? `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`
  : `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;

app.userAgentFallback = cleanUserAgent;

const { createTray, updateTrayTitle, getPopoverWindow, showWindow, showSettingsWindow, resizePopover } = require('./tray');
const { openLogin } = require('./loginWindow');
const claudeProvider = require('./providers/claude');
const antigravityProvider = require('./providers/antigravity');
const secureStore = require('./secureStore');
const { getSystemStats } = require('./systemStats');
const updateCheck = require('./updateCheck');
const history = require('./history');

const HISTORY_WINDOW_MS = 24 * 60 * 60 * 1000; // charts on the cards show the last 24h

let currentUsage = [];
let refreshTimer = null;

// Track history for burn rate velocity calculation
const usageHistory = {
  claude: [],
  antigravity: []
};

// Anti-spam state for notifications
const notifiedState = {
  claude: false,
  antigravity: false
};

function computeBurnRate(provider, currentPercent) {
  if (typeof currentPercent !== 'number' || currentPercent <= 0) {
    return { ratePerHour: 0, text: 'Idle (0%/h)', status: 'idle' };
  }

  const history = usageHistory[provider] || [];
  const now = Date.now();

  // Record current reading
  history.push({ timestamp: now, percent: currentPercent });

  // Retain past 2 hours of data points
  usageHistory[provider] = history.filter(p => now - p.timestamp <= 2 * 3600 * 1000);

  if (usageHistory[provider].length < 2) {
    return { ratePerHour: 0, text: 'Pacing...', status: 'idle' };
  }

  // Find baseline entry (earliest entry between 10m to 60m ago, or earliest available)
  const candidates = usageHistory[provider].filter(p => now - p.timestamp >= 10 * 60 * 1000);
  const baseline = candidates.length > 0 ? candidates[0] : usageHistory[provider][0];

  const diffHours = (now - baseline.timestamp) / (3600 * 1000);
  if (diffHours < (3 / 60)) {
    return { ratePerHour: 0, text: 'Pacing...', status: 'idle' };
  }

  const diffPercent = currentPercent - baseline.percent;

  if (diffPercent <= 0) {
    return { ratePerHour: 0, text: '0%/h', status: 'idle' };
  }

  const ratePerHour = Math.max(1, Math.round(diffPercent / diffHours));
  const status = ratePerHour >= 25 ? 'fast' : ratePerHour >= 10 ? 'moderate' : 'slow';
  return { ratePerHour, text: `+${ratePerHour}%/h`, status };
}

function checkAndNotifyUsage(items) {
  try {
    const settings = secureStore.getSettings();
    if (settings.notificationsEnabled === false) return;
    if (!Notification || !Notification.isSupported()) return;

    const threshold = Number(settings.notifyThreshold) || 80;

    for (const item of items) {
      if (!item || !item.loggedIn) continue;
      const pct = typeof item.windowPercent === 'number' ? item.windowPercent : item.percentUsed;
      const provider = item.provider;

      if (pct >= threshold) {
        if (!notifiedState[provider]) {
          notifiedState[provider] = true;
          const notification = new Notification({
            title: `⚠️ ${item.name} Quota Alert (${pct}%)`,
            body: `${item.name} usage reached ${pct}% (threshold: ${threshold}%). Reset in ${item.windowResetInText || 'soon'}.`,
            silent: false
          });
          notification.show();
        }
      } else if (pct < threshold - 5) {
        // Reset notification trigger once usage clears/resets below threshold
        notifiedState[provider] = false;
      }
    }
  } catch (err) {
    console.warn('[Notifications] Error triggering notification:', err.message);
  }
}

// "Session reset" alert: last fresh session % per provider
const lastSessionPercent = {};
const RESET_FROM_PERCENT = 20; // only worth an alert if the window was actually in use
const RESET_TO_PERCENT = 5;

function checkResetNotifications(items) {
  try {
    const settings = secureStore.getSettings();
    for (const item of items) {
      if (!item || !item.loggedIn || item.stale) continue;
      const pct = typeof item.windowPercent === 'number' ? item.windowPercent : item.percentUsed;
      const prev = lastSessionPercent[item.provider];
      lastSessionPercent[item.provider] = pct;
      if (settings.resetAlertsEnabled === false) continue;
      if (!Notification || !Notification.isSupported()) continue;
      if (typeof prev === 'number' && prev >= RESET_FROM_PERCENT && pct <= RESET_TO_PERCENT) {
        new Notification({
          title: `${item.name} session reset`,
          body: `Your 5-hour ${item.name} limit has reset. Full quota available.`,
          silent: false
        }).show();
      }
    }
  } catch (err) {
    console.warn('[Notifications] Reset alert error:', err.message);
  }
}

if (process.platform === 'darwin') {
  app.dock.hide();
}

async function collectAllUsage() {
  const [claudeResult, antigravityResult] = await Promise.allSettled([
    claudeProvider.fetchUsage(),
    antigravityProvider.fetchUsage()
  ]);

  const prevClaude = currentUsage.find(u => u.provider === 'claude');
  const prevAnti = currentUsage.find(u => u.provider === 'antigravity');

  // A failed fetch keeps the previous numbers, marked as stale
  const asStale = (prev) => prev && { ...prev, stale: true };

  const claudeData = (claudeResult.status === 'fulfilled' && claudeResult.value)
    ? claudeResult.value
    : (asStale(prevClaude) || {
        provider: 'claude',
        name: 'Claude',
        loggedIn: false,
        percentUsed: 0,
        windowPercent: 0,
        weeklyPercent: 0,
        resetInText: 'Not Logged In',
        status: 'disconnected'
      });

  const antigravityData = (antigravityResult.status === 'fulfilled' && antigravityResult.value)
    ? antigravityResult.value
    : (asStale(prevAnti) || {
        provider: 'antigravity',
        name: 'Antigravity',
        loggedIn: false,
        percentUsed: 0,
        windowPercent: 0,
        weeklyPercent: 0,
        resetInText: 'Not Connected',
        status: 'disconnected'
      });

  for (const data of [claudeData, antigravityData]) {
    if (!data.loggedIn) continue;
    if (!data.stale) {
      // Pace and history only from fresh readings
      data.burnRate = computeBurnRate(data.provider, data.windowPercent);
      history.record(data.provider, data.windowPercent, data.weeklyPercent);
    } else {
      data.burnRate = null;
    }
    data.history = history.get(data.provider, Date.now() - HISTORY_WINDOW_MS);
  }

  currentUsage = [claudeData, antigravityData];
  updateTrayTitle(currentUsage);
  checkAndNotifyUsage(currentUsage.filter(u => !u.stale));
  checkResetNotifications(currentUsage);

  const popover = getPopoverWindow();
  if (popover && !popover.isDestroyed()) {
    popover.webContents.send('usage-updated', currentUsage);
  }

  return currentUsage;
}

function startPolling() {
  if (refreshTimer) clearInterval(refreshTimer);
  const minutes = secureStore.getSettings().refreshIntervalMinutes || 5;
  refreshTimer = setInterval(() => {
    collectAllUsage();
  }, minutes * 60 * 1000);
}

app.whenReady().then(async () => {
  createTray({
    onRefresh: () => collectAllUsage().catch(() => {}),
    onCheckUpdates: () => { showSettingsWindow(); updateCheck.checkForUpdates(); },
    onQuit: () => app.quit()
  });

  updateCheck.startUpdateChecks((status) => {
    const popover = getPopoverWindow();
    if (popover && !popover.isDestroyed()) popover.webContents.send('update-status', status);
  });

  // Restore sessions across app restarts / reloads
  await Promise.all([
    claudeProvider.restoreSession(),
    antigravityProvider.restoreSession()
  ]);

  await collectAllUsage();
  startPolling();
});

// IPC Handlers
ipcMain.handle('get-usage', async () => {
  if (currentUsage.length === 0) {
    return await collectAllUsage();
  }
  // Return cached data immediately so UI renders with 0 delay, then refresh in background
  collectAllUsage().catch(() => {});
  return currentUsage;
});

ipcMain.handle('refresh-usage', async () => {
  return await collectAllUsage();
});

// Provider login
ipcMain.handle('log-in', async (_event, provider) => {
  return new Promise((resolve) => {
    if (provider === 'antigravity') {
      antigravityProvider.startOAuthLogin(
        async () => {
          const updated = await collectAllUsage();
          resolve({ success: true, usage: updated });
        },
        () => {
          resolve({ success: false });
        }
      );
    } else {
      openLogin(
        provider,
        async () => {
          const updated = await collectAllUsage();
          resolve({ success: true, usage: updated });
        },
        () => {
          resolve({ success: false });
        }
      );
    }
  });
});

ipcMain.handle('antigravity-submit-code', async (_event, code) => {
  const res = await antigravityProvider.handleManualCode(code);
  if (res && res.success) {
    const updated = await collectAllUsage();
    return { success: true, usage: updated };
  }
  return { success: false, error: (res && res.error) || 'Failed to exchange code' };
});

ipcMain.handle('log-out', async (_event, provider) => {
  if (provider === 'claude') {
    await claudeProvider.logout();
  } else if (provider === 'antigravity') {
    await antigravityProvider.logout();
  }
  if (provider === 'claude' || provider === 'antigravity') {
    history.clear(provider);
    delete lastSessionPercent[provider];
  }
  return await collectAllUsage();
});

ipcMain.handle('get-settings', () => {
  const settings = secureStore.getSettings();
  let autostart = false;
  try {
    autostart = app.getLoginItemSettings().openAtLogin;
  } catch (e) {}
  return { ...settings, autostart };
});

ipcMain.handle('update-settings', (_event, updates) => {
  if (updates && typeof updates.autostart === 'boolean') {
    try {
      app.setLoginItemSettings({
        openAtLogin: updates.autostart,
        openAsHidden: true
      });
    } catch (e) {
      console.warn('Failed to set login item settings:', e.message);
    }
  }
  const result = secureStore.updateSettings(updates);
  if (updates && ['trayWeeklyRing', 'trayShowClaude', 'trayShowAntigravity'].some(k => typeof updates[k] === 'boolean')) {
    updateTrayTitle(currentUsage); // redraw the menu bar icon right away
  }
  return result;
});

ipcMain.handle('get-system-stats', () => getSystemStats());

ipcMain.handle('get-update-status', () => updateCheck.getUpdateStatus());
ipcMain.handle('check-for-updates', () => updateCheck.checkForUpdates());
ipcMain.handle('open-release-page', () => updateCheck.openReleasePage());
ipcMain.handle('install-update', () => updateCheck.installUpdate());

// Card click: open where each service shows its usage
const USAGE_PAGES = {
  claude: 'https://claude.ai/settings/usage',
  antigravity: 'https://antigravity.google/'
};
ipcMain.handle('open-usage-page', (_event, provider) => {
  const url = USAGE_PAGES[provider];
  if (url) shell.openExternal(url);
});

ipcMain.handle('quit-app', () => {
  app.quit();
});

// Popover theme changed: match the native window background (avoids flashes on resize)
ipcMain.handle('set-popover-background', (_event, color) => {
  const win = getPopoverWindow();
  const m = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(String(color || ''));
  if (!win || win.isDestroyed() || !m) return;
  const hex = '#' + m.slice(1, 4).map(n => Number(n).toString(16).padStart(2, '0')).join('');
  win.setBackgroundColor(hex);
});

// Popover reports its content height so the window hugs the content (no empty space)
ipcMain.handle('resize-popover', (_event, height, width) => {
  const h = Math.max(120, Math.min(800, Math.ceil(Number(height) || 0)));
  const w = Math.max(280, Math.min(720, Math.round(Number(width) || 310)));
  resizePopover(w, h);
});

app.on('second-instance', () => showWindow());

app.on('before-quit', () => history.flush());

app.on('window-all-closed', (e) => {
  e.preventDefault();
});
