const claudeContent = document.getElementById('claude-content');
const antigravityContent = document.getElementById('antigravity-content');
const claudeBadge = document.getElementById('claude-status-badge');
const antigravityBadge = document.getElementById('antigravity-status-badge');
const refreshBtn = document.getElementById('refresh-btn');
const lastUpdatedText = document.getElementById('last-updated-text');
const quitBtn = document.getElementById('quit-btn');
const settingsBtn = document.getElementById('settings-btn');
const settingsBackBtn = document.getElementById('settings-back-btn');
const mainView = document.getElementById('main-view');
const settingsView = document.getElementById('settings-view');

let lastFetchTime = null;
let lastUsage = [];
const popoverContainer = document.querySelector('.popover-container');
let pacingEnabled = true; // show the pace (%/h) badge on each card

// Popover gauge: outer ring = 5-hour window, inner ring = weekly quota
const OUTER_RADIUS = 25;
const INNER_RADIUS = 19;
const OUTER_CIRCUMFERENCE = 2 * Math.PI * OUTER_RADIUS;
const INNER_CIRCUMFERENCE = 2 * Math.PI * INNER_RADIUS;

function statusFor(percent) {
  if (percent >= 90) return 'critical';
  if (percent >= 70) return 'warning';
  return 'ok';
}

function dashOffset(percent, circumference) {
  const normalized = Math.min(100, Math.max(0, percent));
  return circumference - (normalized / 100) * circumference;
}

function formatResetTime(resetStr) {
  if (!resetStr || typeof resetStr !== 'string' || resetStr === 'Active') return 'Full Quota';
  if (resetStr.startsWith('Resets in ')) {
    return resetStr.replace('Resets in ', '');
  }
  if (resetStr === 'Full Quota Available') {
    return 'Full Quota';
  }
  if (resetStr === 'Resetting shortly') {
    return 'Resetting';
  }
  return resetStr;
}

function renderProviderCard(provider, data) {
  const isClaude = provider === 'claude';
  const contentEl = isClaude ? claudeContent : antigravityContent;
  const badgeEl = isClaude ? claudeBadge : antigravityBadge;

  if (!contentEl || !badgeEl) return;

  if (!data || !data.loggedIn) {
    badgeEl.innerHTML = `<span class="badge-tag disconnected">Disconnected</span>`;

    const loginBtnText = isClaude ? 'Sign in to Claude' : 'Connect Antigravity';
    const manualPromptHtml = !isClaude ? `
      <div id="antigravity-manual-prompt" class="manual-code-box" style="display: none;">
        <input type="text" id="antigravity-code-input" class="manual-code-input" placeholder="Paste callback URL or code..." />
        <button class="manual-code-submit" onclick="submitAntigravityManualCode()">OK</button>
      </div>
      <button class="paste-code-link" onclick="toggleAntigravityManualPrompt()">Paste callback URL</button>
    ` : '';

    contentEl.innerHTML = `
      <div class="unauth-state">
        <button class="login-btn ${isClaude ? 'login-btn-claude' : 'login-btn-antigravity'}" onclick="handleLogin('${provider}')">
          <span>${loginBtnText}</span>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3"/>
          </svg>
        </button>
        ${manualPromptHtml}
      </div>
    `;
    return;
  }

  const burn = data.burnRate;
  // Strip any emoji/symbol prefix and show a simple trend icon instead
  const burnText = burn && burn.text ? burn.text.replace(/^[^\w+.-]+/u, '').trim() : '';
  const burnBadgeHtml = (pacingEnabled && burnText) ? `
    <span class="burn-rate-badge ${burn.status || 'idle'}" title="Usage pace: ${burnText}">
      <svg class="burn-rate-icon" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">
        <path d="M3 17l6-6 4 4 8-8"/><path d="M15 7h6v6"/>
      </svg>
      ${burnText}
    </span>
  ` : '';

  // Top-right of the card shows only the pacing (burn rate); disconnecting lives in Settings
  badgeEl.innerHTML = `<div class="card-header-right">${burnBadgeHtml}</div>`;

  const percent = typeof data.percentUsed === 'number' ? data.percentUsed : 0;
  const windowPercent = typeof data.windowPercent === 'number' ? data.windowPercent : percent;
  const weeklyPercent = typeof data.weeklyPercent === 'number' ? data.weeklyPercent : 0;
  const windowResetDisplay = formatResetTime(data.windowResetInText || data.resetInText);
  const weeklyResetDisplay = formatResetTime(data.weeklyResetInText || data.resetInText);

  const windowStatus = statusFor(windowPercent);
  const weeklyStatus = statusFor(weeklyPercent);

  contentEl.innerHTML = `
    <div class="card-metric-row">
      <div class="circle-gauge-wrap">
        <svg class="circle-gauge-svg" viewBox="0 0 58 58">
          <circle class="circle-track" cx="29" cy="29" r="${OUTER_RADIUS}"></circle>
          <circle class="circle-fill-path ${provider} ${windowStatus}" cx="29" cy="29" r="${OUTER_RADIUS}"
            stroke-dasharray="${OUTER_CIRCUMFERENCE}"
            stroke-dashoffset="${dashOffset(windowPercent, OUTER_CIRCUMFERENCE)}"></circle>
          <circle class="circle-track inner" cx="29" cy="29" r="${INNER_RADIUS}"></circle>
          <circle class="circle-fill-path inner ${provider} ${weeklyStatus}" cx="29" cy="29" r="${INNER_RADIUS}"
            stroke-dasharray="${INNER_CIRCUMFERENCE}"
            stroke-dashoffset="${dashOffset(weeklyPercent, INNER_CIRCUMFERENCE)}"></circle>
        </svg>
        <div class="circle-center-label">
          <span class="circle-percent-val ${windowStatus}">${windowPercent}</span>
        </div>
      </div>

      <div class="metrics-right-col">
        <span class="metric-compact-label"><span class="metric-dot session ${provider} ${windowStatus}"></span>Session</span>
        <span class="metric-compact-pct ${windowStatus}">${windowPercent}%</span>
        <span class="metric-compact-time">${windowResetDisplay}</span>
        <span class="metric-compact-label"><span class="metric-dot weekly ${provider} ${weeklyStatus}"></span>Weekly</span>
        <span class="metric-compact-pct ${weeklyStatus}">${weeklyPercent}%</span>
        <span class="metric-compact-time">${weeklyResetDisplay}</span>
      </div>
    </div>
  `;
}

function renderCards(usageList) {
  for (const item of usageList) {
    if (!item) continue;
    if (item.provider === 'claude') {
      renderProviderCard('claude', item);
    } else if (item.provider === 'antigravity' || item.provider === 'gemini') {
      renderProviderCard('antigravity', item);
    }
  }
}

function updateUI(usageList) {
  if (!Array.isArray(usageList) || usageList.length === 0) return;
  lastUsage = usageList;

  renderCards(usageList);

  renderSettings();

  lastFetchTime = Date.now();
  updateNextRefreshText();
}

const POLL_INTERVAL_SEC = 300; // 5 minutes

function updateNextRefreshText() {
  if (!lastFetchTime) {
    lastUpdatedText.textContent = 'Updating...';
    return;
  }
  const elapsedSec = Math.floor((Date.now() - lastFetchTime) / 1000);
  const remainingSec = Math.max(0, POLL_INTERVAL_SEC - elapsedSec);

  if (remainingSec === 0) {
    lastUpdatedText.textContent = 'Updating...';
  } else if (remainingSec < 60) {
    lastUpdatedText.textContent = `Next update in ${remainingSec}s`;
  } else {
    const mins = Math.floor(remainingSec / 60);
    const secs = remainingSec % 60;
    if (secs === 0) {
      lastUpdatedText.textContent = `Next update in ${mins}m`;
    } else {
      lastUpdatedText.textContent = `Next update in ${mins}m ${secs}s`;
    }
  }
}

// Handlers
async function handleLogin(provider) {
  const badgeEl = provider === 'claude' ? claudeBadge : antigravityBadge;
  if (badgeEl) badgeEl.innerHTML = `<span class="badge-tag connecting">Connecting...</span>`;

  try {
    const result = await window.api.login(provider);
    if (result && result.usage) {
      updateUI(result.usage);
    } else {
      const data = await window.api.getUsage();
      updateUI(data);
    }
  } catch (err) {
    console.error('Login error:', err);
  } finally {
  }
}

function toggleAntigravityManualPrompt() {
  const box = document.getElementById('antigravity-manual-prompt');
  if (box) {
    box.style.display = box.style.display === 'none' ? 'flex' : 'none';
    if (box.style.display === 'flex') {
      const input = document.getElementById('antigravity-code-input');
      if (input) input.focus();
    }
  }
}

async function submitAntigravityManualCode() {
  const input = document.getElementById('antigravity-code-input');
  if (!input || !input.value.trim()) return;

  if (antigravityBadge) antigravityBadge.innerHTML = `<span class="badge-tag connecting">Connecting...</span>`;

  try {
    const res = await window.api.submitAntigravityCode(input.value.trim());
    if (res && res.success) {
      if (res.usage) {
        updateUI(res.usage);
      } else {
        const data = await window.api.getUsage();
        updateUI(data);
      }
    } else {
      alert(`Connection error: ${res.error || 'Failed to exchange code'}`);
      const data = await window.api.getUsage();
      updateUI(data);
    }
  } catch (e) {
    console.error('Manual code exchange error:', e);
  } finally {
  }
}

async function handleLogout(provider) {
  try {
    const updated = await window.api.logout(provider);
    if (updated) {
      updateUI(updated);
    }
  } catch (err) {
    console.error('Logout error:', err);
  } finally {
  }
}

async function handleRefresh() {
  refreshBtn.classList.add('spinning');
  try {
    const updated = await window.api.refresh();
    updateUI(updated);
  } catch (err) {
    console.error('Refresh error:', err);
  } finally {
    setTimeout(() => {
      refreshBtn.classList.remove('spinning');
    }, 400);
  }
}

// Settings view
function findUsage(provider) {
  return lastUsage.find(u => u && (u.provider === provider ||
    (provider === 'antigravity' && u.provider === 'gemini')));
}

async function renderSettings() {
  for (const provider of ['claude', 'antigravity']) {
    const item = findUsage(provider);
    const connected = Boolean(item && item.loggedIn);
    const statusEl = document.getElementById(`settings-${provider}-status`);
    const btn = document.getElementById(`settings-${provider}-btn`);
    if (statusEl) {
      statusEl.textContent = connected ? 'Connected' : 'Not connected';
      statusEl.classList.toggle('connected', connected);
    }
    if (btn) {
      btn.textContent = connected ? 'Disconnect' : 'Connect';
      btn.classList.toggle('danger', connected);
      btn.disabled = false;
    }
  }

  try {
    const settings = await window.api.getSettings();
    if (settings) {
      const autostartToggle = document.getElementById('settings-autostart-toggle');
      const notifyToggle = document.getElementById('settings-notify-toggle');
      const thresholdInput = document.getElementById('settings-threshold-input');
      const thresholdRow = document.getElementById('settings-threshold-row');

      if (autostartToggle) autostartToggle.checked = Boolean(settings.autostart);
      const systemToggle = document.getElementById('settings-system-toggle');
      if (systemToggle) systemToggle.checked = settings.systemStatsEnabled !== false;
      const trayWeeklyToggle = document.getElementById('settings-tray-weekly-toggle');
      if (trayWeeklyToggle) trayWeeklyToggle.checked = settings.trayWeeklyRing !== false;
      const pacingToggle = document.getElementById('settings-pacing-toggle');
      if (pacingToggle) pacingToggle.checked = settings.pacingEnabled !== false;
      const refreshToggle = document.getElementById('settings-refresh-toggle');
      if (refreshToggle) refreshToggle.checked = settings.refreshButtonEnabled !== false;
      if (notifyToggle) {
        notifyToggle.checked = settings.notificationsEnabled !== false;
        if (thresholdRow) {
          thresholdRow.style.opacity = notifyToggle.checked ? '1' : '0.4';
          thresholdRow.style.pointerEvents = notifyToggle.checked ? 'auto' : 'none';
        }
      }
      if (thresholdInput) thresholdInput.value = settings.notifyThreshold || 80;
    }
  } catch (e) {
    console.warn('Failed to load settings:', e);
  }
}

const MAIN_WIDTH = 310;
const SETTINGS_WIDTH = 600; // two columns
let popoverWidth = MAIN_WIDTH;

let switchingView = false;
const VIEW_FADE_MS = 110;
const waitMs = (ms) => new Promise(r => setTimeout(r, ms));
const nextFrame = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

// Lay out at the target width even before the window has resized
popoverContainer.style.width = `${popoverWidth}px`;

function reportPopoverSize() {
  if (switchingView) return; // the view switch sizes the window itself
  window.api.resizePopover(popoverContainer.getBoundingClientRect().height, popoverWidth);
}

// Fade out → swap views and resize the window while hidden → fade in
async function showSettings(show) {
  if (switchingView || show === !settingsView.hidden) return;
  switchingView = true;
  settingsBtn.classList.toggle('active', show);
  try {
    popoverContainer.classList.add('view-hidden');
    await waitMs(VIEW_FADE_MS);

    settingsView.hidden = !show;
    mainView.hidden = show;
    if (show) renderSettings();
    popoverWidth = show ? SETTINGS_WIDTH : MAIN_WIDTH;
    popoverContainer.style.width = `${popoverWidth}px`;

    await window.api.resizePopover(popoverContainer.getBoundingClientRect().height, popoverWidth);
    await nextFrame(); // let the resized window repaint before showing content
  } finally {
    popoverContainer.classList.remove('view-hidden');
    switchingView = false;
  }
  reportPopoverSize(); // catch any content change during the switch
}

async function handleSettingsAction(provider) {
  const btn = document.getElementById(`settings-${provider}-btn`);
  const item = findUsage(provider);
  if (item && item.loggedIn) {
    if (btn) { btn.disabled = true; btn.textContent = 'Disconnecting...'; }
    await handleLogout(provider);
    renderSettings();
  } else {
    showSettings(false);
    await handleLogin(provider);
  }
}

// Global actions
refreshBtn.addEventListener('click', handleRefresh);
settingsBtn.addEventListener('click', () => showSettings(settingsView.hidden));
settingsBackBtn.addEventListener('click', () => showSettings(false));
document.getElementById('settings-claude-btn').addEventListener('click', () => handleSettingsAction('claude'));
document.getElementById('settings-antigravity-btn').addEventListener('click', () => handleSettingsAction('antigravity'));
quitBtn.addEventListener('click', () => {
  window.api.quit();
});

// Preferences listeners
const autostartToggle = document.getElementById('settings-autostart-toggle');
if (autostartToggle) {
  autostartToggle.addEventListener('change', (e) => {
    window.api.updateSettings({ autostart: e.target.checked });
  });
}

const notifyToggle = document.getElementById('settings-notify-toggle');
const thresholdRow = document.getElementById('settings-threshold-row');
if (notifyToggle) {
  notifyToggle.addEventListener('change', (e) => {
    const enabled = e.target.checked;
    if (thresholdRow) {
      thresholdRow.style.opacity = enabled ? '1' : '0.4';
      thresholdRow.style.pointerEvents = enabled ? 'auto' : 'none';
    }
    window.api.updateSettings({ notificationsEnabled: enabled });
  });
}

const thresholdInput = document.getElementById('settings-threshold-input');
if (thresholdInput) {
  thresholdInput.addEventListener('change', (e) => {
    let val = parseInt(e.target.value, 10);
    if (isNaN(val) || val < 10) val = 10;
    if (val > 100) val = 100;
    e.target.value = val;
    window.api.updateSettings({ notifyThreshold: val });
  });
}

// System stats (CPU / MEM) in the header, polled only while the popover is open
const SYSTEM_POLL_MS = 2000;
const systemStatsEl = document.getElementById('system-stats');
const systemCpuEl = document.getElementById('system-cpu');
const systemMemEl = document.getElementById('system-mem');
let systemStatsEnabled = true;
let systemPollTimer = null;

function statLevel(pct) {
  if (pct >= 90) return 'critical';
  if (pct >= 75) return 'warning';
  return 'ok';
}

function setStat(el, pct) {
  el.textContent = `${pct}%`;
  el.classList.remove('ok', 'warning', 'critical');
  el.classList.add(statLevel(pct));
}

async function pollSystemStats() {
  try {
    const stats = await window.api.getSystemStats();
    if (stats && systemStatsEnabled) {
      setStat(systemCpuEl, stats.cpu);
      setStat(systemMemEl, stats.mem);
    }
  } catch (e) {
    console.warn('System stats error:', e);
  }
}

function startSystemPolling() {
  if (!systemStatsEnabled || systemPollTimer) return;
  pollSystemStats();
  systemPollTimer = setInterval(pollSystemStats, SYSTEM_POLL_MS);
}

function stopSystemPolling() {
  clearInterval(systemPollTimer);
  systemPollTimer = null;
}

function applySystemStatsEnabled(enabled) {
  systemStatsEnabled = enabled;
  systemStatsEl.hidden = !enabled;
  if (enabled && document.hasFocus()) startSystemPolling();
  else stopSystemPolling();
}

// The popover hides on blur, so focus/blur mark when it is open
window.addEventListener('focus', startSystemPolling);
window.addEventListener('blur', stopSystemPolling);

const systemToggle = document.getElementById('settings-system-toggle');
if (systemToggle) {
  systemToggle.addEventListener('change', (e) => {
    applySystemStatsEnabled(e.target.checked);
    window.api.updateSettings({ systemStatsEnabled: e.target.checked });
  });
}

// Weekly ring in the menu bar icon (main process redraws the tray on change)
const trayWeeklyToggle = document.getElementById('settings-tray-weekly-toggle');
if (trayWeeklyToggle) {
  trayWeeklyToggle.addEventListener('change', (e) => {
    window.api.updateSettings({ trayWeeklyRing: e.target.checked });
  });
}

// Refresh button visibility
function applyRefreshButtonEnabled(enabled) {
  refreshBtn.hidden = !enabled;
}

const refreshToggle = document.getElementById('settings-refresh-toggle');
if (refreshToggle) {
  refreshToggle.addEventListener('change', (e) => {
    applyRefreshButtonEnabled(e.target.checked);
    window.api.updateSettings({ refreshButtonEnabled: e.target.checked });
  });
}

// Appearance: 'system' follows macOS, or force 'light' / 'dark'
const themeControl = document.getElementById('settings-theme');
const systemDarkQuery = window.matchMedia('(prefers-color-scheme: dark)');
let themePreference = 'system';

function applyTheme(pref) {
  themePreference = ['light', 'dark'].includes(pref) ? pref : 'system';
  const dark = themePreference === 'dark' || (themePreference === 'system' && systemDarkQuery.matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  for (const btn of themeControl.querySelectorAll('button')) {
    const active = btn.dataset.themeValue === themePreference;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-checked', String(active));
  }
  // Match the native window background so resizes don't flash the other theme
  window.api.setPopoverBackground(getComputedStyle(document.body).backgroundColor);
}

systemDarkQuery.addEventListener('change', () => {
  if (themePreference === 'system') applyTheme('system');
});

themeControl.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-theme-value]');
  if (!btn) return;
  applyTheme(btn.dataset.themeValue);
  window.api.updateSettings({ theme: themePreference });
});

applyTheme('system'); // until saved settings load

// Pacing badge visibility
function applyPacingEnabled(enabled) {
  pacingEnabled = enabled;
  renderCards(lastUsage);
}

const pacingToggle = document.getElementById('settings-pacing-toggle');
if (pacingToggle) {
  pacingToggle.addEventListener('change', (e) => {
    applyPacingEnabled(e.target.checked);
    window.api.updateSettings({ pacingEnabled: e.target.checked });
  });
}

window.api.getSettings()
  .then(s => {
    applySystemStatsEnabled(!s || s.systemStatsEnabled !== false);
    applyRefreshButtonEnabled(!s || s.refreshButtonEnabled !== false);
    applyPacingEnabled(!s || s.pacingEnabled !== false);
    applyTheme(s && s.theme);
  })
  .catch(() => {
    applySystemStatsEnabled(true);
    applyRefreshButtonEnabled(true);
  });

// Update check (GitHub Releases)
const updatePill = document.getElementById('update-pill');
const updateBtn = document.getElementById('settings-update-btn');
const updateStatusEl = document.getElementById('settings-update-status');
const versionNameEl = document.getElementById('settings-version-name');
let updateStatus = null;

function renderUpdateStatus(status) {
  if (!status) return;
  updateStatus = status;
  versionNameEl.textContent = `Clawde v${status.currentVersion}`;
  const v = status.latestVersion;
  // Footer pill only when there's something to click
  updatePill.hidden = !(status.readyToInstall || status.state === 'available');
  updatePill.textContent = status.readyToInstall ? 'Restart to update' : `Update v${v}`;
  updatePill.title = status.readyToInstall ? `Restart Clawde to install v${v}` : 'Download the new version';
  updateStatusEl.classList.toggle('connected', status.updateAvailable);
  updateBtn.disabled = false;
  if (status.readyToInstall) {
    updateStatusEl.textContent = `Version ${v} is ready to install`;
    updateBtn.textContent = 'Restart';
  } else if (status.state === 'downloading') {
    updateStatusEl.textContent = `Downloading ${v}… ${status.progress || 0}%`;
    updateBtn.textContent = 'Check';
    updateBtn.disabled = true;
  } else if (status.state === 'available') {
    updateStatusEl.textContent = `Version ${v} is available`;
    updateBtn.textContent = 'Download';
  } else if (status.state === 'checking') {
    updateStatusEl.textContent = 'Checking for updates…';
    updateBtn.textContent = 'Checking...';
    updateBtn.disabled = true;
  } else {
    updateStatusEl.textContent = status.state === 'error'
      ? 'Could not check for updates'
      : status.checkedAt ? 'You are up to date' : 'Not checked yet';
    updateBtn.textContent = 'Check';
  }
}

function handleUpdateAction() {
  if (!updateStatus) return false;
  if (updateStatus.readyToInstall) { window.api.installUpdate(); return true; }
  if (updateStatus.state === 'available') { window.api.openReleasePage(); return true; }
  return false;
}

updatePill.addEventListener('click', handleUpdateAction);
updateBtn.addEventListener('click', async () => {
  if (handleUpdateAction()) return;
  updateBtn.disabled = true;
  updateBtn.textContent = 'Checking...';
  renderUpdateStatus(await window.api.checkForUpdates());
});
window.api.onUpdateStatus(renderUpdateStatus);
window.api.getUpdateStatus().then(renderUpdateStatus).catch(() => {});

// Keep the popover window exactly as tall as its content
new ResizeObserver(reportPopoverSize).observe(popoverContainer);

// Live countdown ticker
setInterval(updateNextRefreshText, 1000);

// IPC Listener
window.api.onUsageUpdated((data) => {
  updateUI(data);
});

// Initial fetch on mount
window.api.getUsage().then(data => {
  updateUI(data);
}).catch(err => {
  console.error('Failed to get initial usage:', err);
});
