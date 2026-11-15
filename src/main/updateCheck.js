const { app, net, shell } = require('electron');

// Keeps Clawde up to date from GitHub Releases.
// Installed (signed) app: electron-updater checks latest-mac.yml, downloads the
// new ZIP in the background and installs it on restart (or on the next quit).
// Development (npm start): can't self-update, so it only checks the GitHub API
// and links to the release page.

const REPO = 'DYitaoW/clawde';
const RELEASES_API = `https://api.github.com/repos/${REPO}/releases/latest`;
const RELEASES_PAGE = `https://github.com/${REPO}/releases/latest`;
const CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000; // twice a day
const STARTUP_DELAY_MS = 15 * 1000;

// state: idle | checking | up-to-date | available | downloading | ready | error
let status = {
  currentVersion: app.getVersion(),
  latestVersion: null,
  state: 'idle',
  updateAvailable: false, // a newer version exists (downloading or ready)
  readyToInstall: false,  // downloaded, restart to install
  canAutoUpdate: app.isPackaged,
  progress: 0,
  releaseUrl: RELEASES_PAGE,
  checkedAt: null,
  error: null
};
let listener = null;
let timer = null;
let autoUpdater = null;

function setStatus(patch) {
  status = { ...status, ...patch };
  if (listener) listener(status);
  return status;
}

function setupAutoUpdater() {
  if (!app.isPackaged || autoUpdater) return;
  ({ autoUpdater } = require('electron-updater'));
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;
  autoUpdater.logger = null;

  autoUpdater.on('checking-for-update', () => setStatus({ state: 'checking', error: null }));
  autoUpdater.on('update-not-available', () => setStatus({
    state: 'up-to-date', updateAvailable: false, checkedAt: Date.now(), error: null
  }));
  autoUpdater.on('update-available', (info) => setStatus({
    state: 'downloading', updateAvailable: true, latestVersion: info.version, progress: 0, checkedAt: Date.now()
  }));
  autoUpdater.on('download-progress', (p) => {
    const progress = Math.round(p.percent || 0);
    if (progress !== status.progress) setStatus({ state: 'downloading', progress });
  });
  autoUpdater.on('update-downloaded', (info) => setStatus({
    state: 'ready', updateAvailable: true, readyToInstall: true, latestVersion: info.version, progress: 100
  }));
  autoUpdater.on('error', (err) => {
    // Keep a finished download usable even if a later check fails
    if (status.readyToInstall) return;
    setStatus({ state: 'error', checkedAt: Date.now(), error: err ? err.message : 'Update failed' });
  });
}

// "v1.2.0" -> [1, 2, 0]; ignores pre-release suffixes like "-beta.1"
function parseVersion(v) {
  return String(v || '').replace(/^v/i, '').split('-')[0].split('.').map(n => parseInt(n, 10) || 0);
}

function isNewer(latest, current) {
  const a = parseVersion(latest), b = parseVersion(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] || 0, y = b[i] || 0;
    if (x !== y) return x > y;
  }
  return false;
}

// Development fallback: notify only
async function checkViaApi() {
  setStatus({ state: 'checking', error: null });
  try {
    const res = await net.fetch(RELEASES_API, {
      headers: { 'Accept': 'application/vnd.github+json', 'User-Agent': `Clawde/${status.currentVersion}` }
    });
    if (res.status === 404) {
      return setStatus({ state: 'up-to-date', updateAvailable: false, checkedAt: Date.now() });
    }
    if (!res.ok) throw new Error(`GitHub responded ${res.status}`);
    const release = await res.json();
    const latest = String(release.tag_name || '').replace(/^v/i, '');
    const newer = Boolean(latest) && !release.draft && !release.prerelease && isNewer(latest, status.currentVersion);
    return setStatus({
      state: newer ? 'available' : 'up-to-date',
      latestVersion: latest || null,
      updateAvailable: newer,
      releaseUrl: release.html_url || RELEASES_PAGE,
      checkedAt: Date.now()
    });
  } catch (err) {
    return setStatus({ state: 'error', checkedAt: Date.now(), error: err.message });
  }
}

async function checkForUpdates() {
  if (!autoUpdater) return checkViaApi();
  // Already downloading or downloaded: nothing new to do
  if (status.state === 'downloading' || status.readyToInstall) return status;
  try {
    await autoUpdater.checkForUpdates();
  } catch (err) {
    setStatus({ state: 'error', checkedAt: Date.now(), error: err.message });
  }
  return status;
}

function startUpdateChecks(onStatus) {
  listener = onStatus;
  setupAutoUpdater();
  setTimeout(checkForUpdates, STARTUP_DELAY_MS);
  clearInterval(timer);
  timer = setInterval(checkForUpdates, CHECK_INTERVAL_MS);
}

function getUpdateStatus() {
  return status;
}

// Restart into the downloaded version
function installUpdate() {
  if (autoUpdater && status.readyToInstall) {
    setImmediate(() => autoUpdater.quitAndInstall());
    return true;
  }
  return false;
}

function openReleasePage() {
  // Only ever open our own GitHub release URL
  const url = String(status.releaseUrl || '');
  shell.openExternal(url.startsWith(`https://github.com/${REPO}/`) ? url : RELEASES_PAGE);
}

module.exports = { startUpdateChecks, checkForUpdates, getUpdateStatus, installUpdate, openReleasePage };
