const { app } = require('electron');
const path = require('path');
const fs = require('fs');

// Local usage history for the 24-hour charts on each card.
// Only percentages and timestamps are stored (no account data), in
// <userData>/usage_history.json, kept for 7 days.

const KEEP_MS = 7 * 24 * 60 * 60 * 1000;
const MIN_SPACING_MS = 60 * 1000; // collapse readings closer than a minute
const PROVIDERS = ['claude', 'antigravity'];

const filePath = path.join(app.getPath('userData'), 'usage_history.json');
let data = null;
let saveTimer = null;

function load() {
  if (data) return data;
  data = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    for (const p of PROVIDERS) {
      data[p] = Array.isArray(parsed[p])
        ? parsed[p].filter(e => e && Number.isFinite(e.t) && Number.isFinite(e.s))
        : [];
    }
  } catch {
    for (const p of PROVIDERS) data[p] = [];
  }
  return data;
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    fs.promises.mkdir(path.dirname(filePath), { recursive: true })
      .then(() => fs.promises.writeFile(filePath, JSON.stringify(data), { mode: 0o600 }))
      .catch(err => console.warn('[History] Save error:', err.message));
  }, 2000);
}

function clamp(n) {
  return Math.max(0, Math.min(100, Math.round(Number(n) || 0)));
}

// Store one fresh reading: s = session %, w = weekly %
function record(provider, sessionPercent, weeklyPercent, t = Date.now()) {
  const d = load();
  if (!d[provider]) return;
  const list = d[provider];
  const entry = { t, s: clamp(sessionPercent), w: clamp(weeklyPercent) };
  const last = list[list.length - 1];
  if (last && t - last.t < MIN_SPACING_MS) list[list.length - 1] = entry;
  else list.push(entry);
  const cutoff = t - KEEP_MS;
  while (list.length && list[0].t < cutoff) list.shift();
  scheduleSave();
}

function get(provider, sinceMs) {
  const list = load()[provider] || [];
  return list.filter(e => e.t >= sinceMs);
}

function clear(provider) {
  const d = load();
  if (!d[provider]) return;
  d[provider] = [];
  scheduleSave();
}

// Write any pending change right away (on quit)
function flush() {
  if (!saveTimer || !data) return;
  clearTimeout(saveTimer);
  saveTimer = null;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data), { mode: 0o600 });
  } catch (err) {
    console.warn('[History] Save error:', err.message);
  }
}

module.exports = { record, get, clear, flush };
