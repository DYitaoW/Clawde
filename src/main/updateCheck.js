const { app, net, shell } = require('electron');

// Checks GitHub Releases for a newer version of Clawde.
// Unsigned apps can't auto-update on macOS, so this only notifies and links
// to the release page where the user downloads the new DMG.

const REPO = 'DYitaoW/clawde';
const RELEASES_API = `https://api.github.com/repos/${REPO}/releases/latest`;
const RELEASES_PAGE = `https://github.com/${REPO}/releases/latest`;
const CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000; // twice a day
const STARTUP_DELAY_MS = 15 * 1000;

let status = {
  currentVersion: app.getVersion(),
  latestVersion: null,
  updateAvailable: false,
  releaseUrl: RELEASES_PAGE,
  checkedAt: null,
  error: null
};
let listener = null;
let timer = null;

// "v1.2.0" -> [1, 2, 0]; ignores pre-release suffixes like "-beta.1"
function parseVersion(v) {
  return String(v || '')
    .replace(/^v/i, '')
    .split('-')[0]
    .split('.')
    .map(n => parseInt(n, 10) || 0);
}

function isNewer(latest, current) {
  const a = parseVersion(latest), b = parseVersion(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] || 0, y = b[i] || 0;
    if (x !== y) return x > y;
  }
  return false;
}

async function checkForUpdates() {
  try {
    const res = await net.fetch(RELEASES_API, {
      headers: {
        'Accept': 'application/vnd.github+json',
        'User-Agent': `Clawde/${status.currentVersion}`
      }
    });
    if (res.status === 404) {
      // No published releases yet
      status = { ...status, latestVersion: null, updateAvailable: false, checkedAt: Date.now(), error: null };
    } else if (!res.ok) {
      throw new Error(`GitHub responded ${res.status}`);
    } else {
      const release = await res.json();
      const latest = String(release.tag_name || '').replace(/^v/i, '');
      status = {
        ...status,
        latestVersion: latest || null,
        updateAvailable: Boolean(latest) && !release.draft && !release.prerelease && isNewer(latest, status.currentVersion),
        releaseUrl: release.html_url || RELEASES_PAGE,
        checkedAt: Date.now(),
        error: null
      };
    }
  } catch (err) {
    status = { ...status, checkedAt: Date.now(), error: err.message };
  }
  if (listener) listener(status);
  return status;
}

function startUpdateChecks(onStatus) {
  listener = onStatus;
  setTimeout(checkForUpdates, STARTUP_DELAY_MS);
  clearInterval(timer);
  timer = setInterval(checkForUpdates, CHECK_INTERVAL_MS);
}

function getUpdateStatus() {
  return status;
}

function openReleasePage() {
  // Only ever open our own GitHub release URL
  const url = String(status.releaseUrl || '');
  shell.openExternal(url.startsWith(`https://github.com/${REPO}/`) ? url : RELEASES_PAGE);
}

module.exports = { startUpdateChecks, checkForUpdates, getUpdateStatus, openReleasePage };
