const { app, ipcMain, Notification } = require('electron');
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

// Clean User-Agent fallback
const chromeVersion = process.versions.chrome || '131.0.0.0';
const cleanUserAgent = process.platform === 'darwin'
  ? `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`
  : `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;

app.userAgentFallback = cleanUserAgent;

const { createTray, updateTrayTitle, getPopoverWindow } = require('./tray');
const { openLogin } = require('./loginWindow');
const claudeProvider = require('./providers/claude');
const antigravityProvider = require('./providers/antigravity');
const secureStore = require('./secureStore');
const { getSystemStats } = require('./systemStats');

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

  const claudeData = (claudeResult.status === 'fulfilled' && claudeResult.value)
    ? claudeResult.value
    : (prevClaude || {
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
    : (prevAnti || {
        provider: 'antigravity',
        name: 'Antigravity',
        loggedIn: false,
        percentUsed: 0,
        windowPercent: 0,
        weeklyPercent: 0,
        resetInText: 'Not Connected',
        status: 'disconnected'
      });

  // Calculate real-time burn rate for logged-in providers
  if (claudeData.loggedIn) {
    claudeData.burnRate = computeBurnRate('claude', claudeData.windowPercent);
  }
  if (antigravityData.loggedIn) {
    antigravityData.burnRate = computeBurnRate('antigravity', antigravityData.windowPercent);
  }

  currentUsage = [claudeData, antigravityData];
  updateTrayTitle(currentUsage);
  checkAndNotifyUsage(currentUsage);

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
  createTray();

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
  if (updates && typeof updates.trayWeeklyRing === 'boolean') {
    updateTrayTitle(currentUsage); // redraw the menu bar icon right away
  }
  return result;
});

ipcMain.handle('get-system-stats', () => getSystemStats());

ipcMain.handle('quit-app', () => {
  app.quit();
});

// Popover reports its content height so the window hugs the content (no empty space)
ipcMain.handle('resize-popover', (_event, height) => {
  const win = getPopoverWindow();
  if (!win || win.isDestroyed()) return;
  const h = Math.max(120, Math.min(800, Math.ceil(Number(height) || 0)));
  const [w, current] = win.getContentSize();
  if (current !== h) win.setContentSize(w, h);
});

app.on('window-all-closed', (e) => {
  e.preventDefault();
});
