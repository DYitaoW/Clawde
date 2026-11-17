const http = require('http');
const https = require('https');
const path = require('path');
const fs = require('fs');
const os = require('os');
const cp = require('child_process');
const secureStore = require('../secureStore');

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

class AntigravityProvider {
  constructor() {
    this.name = 'Antigravity';
    this.id = 'antigravity';
    this.cachedUsage = null;
    this.activeServer = null; // Caches working local { port, token, isHttps }
  }

  // ==========================================
  // Method 1: Remote Cloud Code API
  // ==========================================

  // Queries Cloud Code internal quota APIs with an access token found in a local credential file
  async fetchRemoteQuota(accessToken) {
    if (!accessToken) return null;

    const endpoints = [
      'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary',
      'https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary'
    ];

    for (const url of endpoints) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            'User-Agent': 'antigravity/hub/2.24.0 (aidev_client; os_type=darwin; arch=arm64; cl=1000335682)',
            'X-Goog-Api-Client': 'gl-node/18.0.0'
          },
          body: JSON.stringify({}),
          signal: AbortSignal.timeout(10000)
        });

        if (res.ok) {
          const data = await res.json();
          const parsed = this.parseAntigravityQuota(data);
          if (parsed) return parsed;
        } else if (res.status === 401) {
          console.warn(`[AntigravityProvider] Quota endpoint 401 unauthorized (${url})`);
          return { error: 'unauthorized' };
        } else {
          const text = await res.text().catch(() => '');
          console.warn(`[AntigravityProvider] Quota response ${res.status} (${url}):`, text.slice(0, 200));
        }
      } catch (err) {
        console.warn(`[AntigravityProvider] Remote fetch notice (${url}):`, err.message);
      }
    }
    return null;
  }

  // Check local filesystem for existing Google Cloud or Antigravity credentials
  getLocalTokenCandidates() {
    const home = os.homedir();
    const candidatePaths = [
      path.join(home, '.config', 'gcloud', 'application_default_credentials.json'),
      path.join(home, '.gemini', 'antigravity', 'credentials.json'),
      path.join(home, '.gemini', 'antigravity', 'tokens.json'),
      path.join(home, '.gemini', 'antigravity-cli', 'credentials.json'),
      path.join(home, '.config', 'antigravity', 'tokens.json'),
      path.join(home, 'Library', 'Application Support', 'Google', 'CloudCode', 'credentials.json'),
      path.join(home, 'Library', 'Application Support', 'Antigravity', 'tokens.json')
    ];

    const tokens = [];
    for (const p of candidatePaths) {
      try {
        if (fs.existsSync(p)) {
          const raw = fs.readFileSync(p, 'utf8');
          const parsed = JSON.parse(raw);
          if (parsed.access_token) tokens.push(parsed.access_token);
          if (parsed.token) tokens.push(parsed.token);
          if (parsed.refresh_token) tokens.push({ refreshToken: parsed.refresh_token });
          if (parsed.credentials && parsed.credentials.access_token) tokens.push(parsed.credentials.access_token);
        }
      } catch (e) {}
    }
    return tokens;
  }

  // ==========================================
  // Method 2: Local Language Server & Daemon
  // ==========================================

  // The agy hub writes ~/.gemini/antigravity/daemon/hub_<port>.json with its
  // ports and CSRF token. The token is NOT on its command line, so this is the
  // only way to find it, and both change every time the hub restarts.
  getDaemonCandidates() {
    const dir = path.join(os.homedir(), '.gemini', 'antigravity', 'daemon');
    let files = [];
    try {
      files = fs.readdirSync(dir).filter(f => /^hub_\d+\.json$/.test(f));
    } catch (e) {
      return [];
    }

    const candidates = [];
    for (const f of files) {
      try {
        const info = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        if (!info || !info.csrfToken) continue;
        // Skip files left behind by a hub that has since exited
        if (info.pid) {
          try { process.kill(info.pid, 0); } catch (e) { if (e.code === 'ESRCH') continue; }
        }
        if (info.httpsPort > 0) candidates.push({ port: info.httpsPort, token: info.csrfToken, isHttps: true, source: 'daemon' });
        if (info.httpPort > 0) candidates.push({ port: info.httpPort, token: info.csrfToken, isHttps: false, source: 'daemon' });
      } catch (e) {}
    }
    return candidates;
  }

  // Discover candidate (port, token) pairs from daemon files, process table and environment
  async findServerCandidates() {
    const candidates = this.getDaemonCandidates();

    // 1. Check environment variables
    if (process.env.ANTIGRAVITY_LS_ADDRESS && process.env.ANTIGRAVITY_CSRF_TOKEN) {
      const parts = process.env.ANTIGRAVITY_LS_ADDRESS.split(':');
      const port = parseInt(parts[1] || parts[0], 10);
      if (port > 0) {
        candidates.push({ port, token: process.env.ANTIGRAVITY_CSRF_TOKEN, source: 'env' });
      }
    }

    // 2. Process inspection via ps & lsof
    const isWin = process.platform === 'win32';
    const cmd = isWin
      ? 'wmic process where "name like \'%language_server%\'" get commandline,processid'
      : 'ps aux | grep -iE "language_server|codeium|antigravity" | grep -v grep';

    const pidsAndTokens = await new Promise((resolve) => {
      cp.exec(cmd, { timeout: 3000 }, (err, stdout) => {
        if (err || !stdout) return resolve([]);
        const list = [];
        try {
          const lines = stdout.split('\n');
          for (const line of lines) {
            const tokenMatch = line.match(/(?:csrf_token|csrf|auth_token)[=\s]+([a-zA-Z0-9_-]+)/i);
            const token = tokenMatch ? tokenMatch[1] : (process.env.ANTIGRAVITY_CSRF_TOKEN || null);

            const portMatch = line.match(/(?:https_server_port|port)[=\s]+([0-9]+)/i);
            const port = portMatch && parseInt(portMatch[1], 10) > 0 ? parseInt(portMatch[1], 10) : null;

            const pidMatch = line.trim().split(/\s+/)[1];
            const pid = pidMatch && /^\d+$/.test(pidMatch) ? parseInt(pidMatch, 10) : null;

            if (pid || port) {
              list.push({ pid, token, port });
            }
          }
        } catch (e) {}
        resolve(list);
      });
    });

    for (const item of pidsAndTokens) {
      const tokens = [item.token, process.env.ANTIGRAVITY_CSRF_TOKEN].filter(Boolean);
      const ports = item.port ? [item.port] : [];

      if (item.pid && !isWin) {
        try {
          const lsofOut = await new Promise(r => cp.exec(`lsof -nP -p ${item.pid} 2>/dev/null | grep LISTEN`, { timeout: 2000 }, (e, out) => r(out || '')));
          if (lsofOut) {
            const matches = [...lsofOut.matchAll(/:([0-9]+)\s+\(LISTEN\)/g)];
            for (const m of matches) {
              const p = parseInt(m[1], 10);
              if (p > 0 && !ports.includes(p)) ports.push(p);
            }
          }
        } catch (e) {}
      }

      for (const p of ports) {
        for (const t of (tokens.length > 0 ? tokens : [''])) {
          if (!candidates.some(c => c.port === p && c.token === t)) {
            candidates.push({ port: p, token: t, source: 'process' });
          }
        }
      }
    }

    return candidates;
  }

  // Performs a single HTTP/HTTPS Connect-RPC POST request
  requestRpc(isHttps, port, pathUrl, token, payloadObj) {
    return new Promise((resolve) => {
      const mod = isHttps ? https : http;
      const payload = JSON.stringify(payloadObj || {});

      let finished = false;
      function done(val) {
        if (!finished) {
          finished = true;
          resolve(val);
        }
      }

      const timer = setTimeout(() => {
        try { req.destroy(); } catch (e) {}
        done(null);
      }, 2000);

      const headers = {
        'Content-Type': 'application/json',
        'Connect-Protocol-Version': '1',
        'Content-Length': Buffer.byteLength(payload)
      };

      if (token) {
        headers['X-Codeium-Csrf'] = token;
        headers['X-Codeium-Csrf-Token'] = token;
      }

      const req = mod.request({
        hostname: '127.0.0.1',
        port: port,
        path: pathUrl,
        method: 'POST',
        rejectUnauthorized: false,
        headers,
        timeout: 2000
      }, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          clearTimeout(timer);
          try {
            const parsed = JSON.parse(data);
            done(parsed);
          } catch (e) {
            done(null);
          }
        });
      });

      req.on('timeout', () => {
        clearTimeout(timer);
        try { req.destroy(); } catch (e) {}
        done(null);
      });

      req.on('error', () => {
        clearTimeout(timer);
        done(null);
      });

      req.write(payload);
      req.end();
    });
  }

  // Iteratively queries candidate ports and endpoints for live usage
  async queryLiveUsage() {
    const endpoints = [
      '/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary',
      '/exa.language_server_pb.LanguageServerService/GetUserStatus'
    ];

    const payloads = [
      {},
      { metadata: { ideName: 'antigravity', extensionName: 'antigravity', locale: 'en' } }
    ];

    // Check cached working server first
    if (this.activeServer) {
      for (const ep of endpoints) {
        for (const pl of payloads) {
          const res = await this.requestRpc(this.activeServer.isHttps, this.activeServer.port, ep, this.activeServer.token, pl);
          if (res) {
            const parsed = this.parseAntigravityQuota(res);
            if (parsed) return parsed;
          }
        }
      }
      // Cached server stopped answering (hub restarted: new port and token)
      this.activeServer = null;
    }

    const candidates = await this.findServerCandidates();

    for (const c of candidates) {
      const schemes = typeof c.isHttps === 'boolean' ? [c.isHttps] : [true, false];
      for (const isHttps of schemes) {
        for (const ep of endpoints) {
          for (const pl of payloads) {
            const res = await this.requestRpc(isHttps, c.port, ep, c.token, pl);
            if (res) {
              const parsed = this.parseAntigravityQuota(res);
              if (parsed) {
                this.activeServer = { port: c.port, token: c.token, isHttps };
                return parsed;
              }
            }
          }
        }
      }
    }

    return null;
  }

  // ==========================================
  // Quota Parser (Buckets & Cascade Model Configs)
  // ==========================================
  parseAntigravityQuota(data) {
    if (!data) return null;

    function extractUsedPercent(b) {
      if (!b) return null;
      let rem = null;
      let used = null;

      if (b.remainingFraction !== undefined && b.remainingFraction !== null) {
        rem = Number(b.remainingFraction);
      } else if (b.remainingPercentage !== undefined && b.remainingPercentage !== null) {
        rem = Number(b.remainingPercentage) / 100;
      } else if (b.remaining !== undefined && b.remaining !== null) {
        rem = Number(b.remaining);
        if (rem > 1) rem = rem / 100;
      } else if (b.remaining_fraction !== undefined && b.remaining_fraction !== null) {
        rem = Number(b.remaining_fraction);
      }

      if (b.usedFraction !== undefined && b.usedFraction !== null) {
        used = Math.round(Number(b.usedFraction) * 100);
      } else if (b.usedPercentage !== undefined && b.usedPercentage !== null) {
        used = Math.round(Number(b.usedPercentage));
      } else if (b.usedPercent !== undefined && b.usedPercent !== null) {
        used = Math.round(Number(b.usedPercent));
      } else if (b.percentUsed !== undefined && b.percentUsed !== null) {
        used = Math.round(Number(b.percentUsed));
      } else if (b.utilization !== undefined && b.utilization !== null) {
        used = Math.round(Number(b.utilization));
      }

      if (used === null && rem !== null && !isNaN(rem)) {
        used = Math.round((1 - rem) * 100);
      }

      if (used !== null && !isNaN(used)) {
        return Math.max(0, Math.min(100, used));
      }
      return null;
    }

    // 1. Gather all candidate groups and buckets from Google Cloud Code & OpenUsage schemas
    const candidateGroups = [
      ...(data.groups || []),
      ...((data.response && data.response.groups) || []),
      ...((data.userQuotaSummary && data.userQuotaSummary.groups) || []),
      ...(data.quotaGroups || []),
      ...((data.userStatus && data.userStatus.quotaGroups) || [])
    ];

    let geminiBuckets = [];
    let otherBuckets = [];

    if (candidateGroups.length > 0) {
      for (const grp of candidateGroups) {
        const grpName = (grp.displayName || grp.name || grp.id || '').toLowerCase();
        const bList = grp.buckets || grp.quotaBuckets || [];
        if (Array.isArray(bList)) {
          for (const b of bList) {
            const bItem = { ...b, groupName: grpName };
            const fullText = `${b.bucketId || ''} ${b.displayName || ''} ${b.id || ''} ${grpName}`.toLowerCase();
            if (fullText.includes('gemini') || fullText.includes('argon')) {
              geminiBuckets.push(bItem);
            } else {
              otherBuckets.push(bItem);
            }
          }
        }
      }
    }

    // Direct buckets list fallbacks
    const directBuckets = [
      ...(data.buckets || []),
      ...((data.response && data.response.buckets) || []),
      ...((data.userQuotaSummary && data.userQuotaSummary.buckets) || []),
      ...(data.quotaBuckets || [])
    ];

    for (const b of directBuckets) {
      const fullText = `${b.bucketId || ''} ${b.displayName || ''} ${b.id || ''}`.toLowerCase();
      if (fullText.includes('gemini') || fullText.includes('argon')) {
        geminiBuckets.push(b);
      } else {
        otherBuckets.push(b);
      }
    }

    // Target the Gemini-specific buckets first
    const targetBuckets = geminiBuckets.length > 0 ? geminiBuckets : otherBuckets;

    if (targetBuckets.length > 0) {
      let windowPercent = null;
      let weeklyPercent = null;
      let windowReset = null;
      let weeklyReset = null;

      for (const b of targetBuckets) {
        const id = (b.bucketId || b.id || b.name || '').toLowerCase();
        const name = (b.displayName || b.label || '').toLowerCase();
        const win = (b.window || b.windowType || b.period || b.quotaPeriod || b.windowDuration || b.duration || '').toLowerCase();
        const fullDesc = `${id} ${name} ${win}`;

        const used = extractUsedPercent(b);
        if (used === null) continue;

        const resetCandidate = b.resetTime || b.reset_time || b.resetsAt || b.resets_at;

        // 5-Hour rolling window
        const is5h = fullDesc.includes('5h') || fullDesc.includes('five') || fullDesc.includes('session') ||
                     fullDesc.includes('rolling') || b.durationMinutes === 300 || b.windowMinutes === 300;

        // Weekly limit window
        const isWeekly = fullDesc.includes('week') || fullDesc.includes('7d') || fullDesc.includes('7-day') ||
                         fullDesc.includes('seven') || b.durationMinutes === 10080 || b.windowMinutes === 10080;

        if (is5h) {
          if (windowPercent === null || used > windowPercent) {
            windowPercent = used;
            windowReset = resetCandidate;
          }
        } else if (isWeekly) {
          if (weeklyPercent === null || used > weeklyPercent) {
            weeklyPercent = used;
            weeklyReset = resetCandidate;
          }
        } else {
          // If neither is explicitly labeled: in Gemini pool, 2nd bucket is the weekly limit!
          if (windowPercent !== null && weeklyPercent === null) {
            weeklyPercent = used;
            weeklyReset = resetCandidate;
          } else if (windowPercent === null) {
            windowPercent = used;
            windowReset = resetCandidate;
          } else {
            if (weeklyPercent === null || used > weeklyPercent) {
              weeklyPercent = used;
              weeklyReset = resetCandidate;
            }
          }
        }
      }

      // Fallback: check otherBuckets for weekly if still null
      if (weeklyPercent === null && otherBuckets.length > 0) {
        for (const b of otherBuckets) {
          const fullDesc = `${b.bucketId || ''} ${b.displayName || ''} ${b.window || ''}`.toLowerCase();
          const used = extractUsedPercent(b);
          if (used === null) continue;
          if (fullDesc.includes('week') || fullDesc.includes('7d') || b.durationMinutes === 10080) {
            weeklyPercent = used;
            if (!weeklyReset) weeklyReset = b.resetTime || b.reset_time;
            break;
          }
        }
      }

      const effectivePercent = windowPercent !== null ? windowPercent : (weeklyPercent !== null ? weeklyPercent : 0);

      let windowResetInText = 'Full Quota Available';
      if (windowReset) {
        const diffMs = new Date(windowReset).getTime() - Date.now();
        windowResetInText = formatResetRemaining(diffMs);
      } else if (windowPercent === 0) {
        windowResetInText = 'Full Quota Available';
      } else {
        windowResetInText = 'Resets in 5h';
      }

      let weeklyResetInText = 'Full Quota Available';
      if (weeklyReset) {
        const diffMs = new Date(weeklyReset).getTime() - Date.now();
        weeklyResetInText = formatResetRemaining(diffMs);
      } else if (weeklyPercent === 0) {
        weeklyResetInText = 'Full Quota Available';
      } else {
        weeklyResetInText = 'Resets in 7d';
      }

      const resetInText = windowResetInText !== 'Full Quota Available' ? windowResetInText : weeklyResetInText;

      return {
        percentUsed: effectivePercent,
        windowPercent: windowPercent !== null ? windowPercent : 0,
        weeklyPercent: weeklyPercent !== null ? weeklyPercent : 0,
        windowResetInText,
        weeklyResetInText,
        resetInText,
        windowResetsAt: windowReset ? (Date.parse(windowReset) || null) : null,
        modelName: 'Gemini Quotas'
      };
    }

    // 2. Fallback to GetUserStatus cascadeModelConfigData format
    const rawList = [
      ...((data.userStatus && data.userStatus.cascadeModelConfigData && data.userStatus.cascadeModelConfigData.clientModelConfigs) || []),
      ...((data.cascadeModelConfigData && data.cascadeModelConfigData.clientModelConfigs) || []),
      ...((data.userStatus && data.userStatus.clientModelConfigs) || []),
      ...(data.clientModelConfigs || []),
      ...((data.userStatus && data.userStatus.quotaGroups) || []),
      ...(data.quotaGroups || []),
      ...((data.userStatus && data.userStatus.modelQuotas) || []),
      ...(data.modelQuotas || []),
      ...((data.userStatus && data.userStatus.models) || []),
      ...(data.models || [])
    ];

    if (rawList.length > 0) {
      let maxUsed = -1;
      let activeItem = null;
      let weeklyPercent = null;
      let weeklyReset = null;

      for (const item of rawList) {
        const qInfo = item.quotaInfo || item;
        const label = (item.label || item.modelOrAlias || item.name || item.id || '').toLowerCase();
        const period = (item.quotaPeriod || item.period || qInfo.period || qInfo.quotaPeriod || qInfo.window || '').toLowerCase();
        const used = extractUsedPercent(qInfo) !== null ? extractUsedPercent(qInfo) : extractUsedPercent(item);

        if (used !== null) {
          if (used > maxUsed) {
            maxUsed = used;
            activeItem = { ...item, quotaInfo: qInfo, used };
          }
          const isWeeklyConfig = label.includes('week') || label.includes('7d') ||
                                 period.includes('week') || period.includes('7d') ||
                                 qInfo.durationMinutes === 10080;
          if (isWeeklyConfig) {
            if (weeklyPercent === null || used > weeklyPercent) {
              weeklyPercent = used;
              weeklyReset = qInfo.resetTime || qInfo.reset_time || qInfo.resetsAt || item.resetTime;
            }
          }
        }
      }

      if (activeItem) {
        const percentUsed = activeItem.used;
        const qInfo = activeItem.quotaInfo || activeItem;
        const windowReset = qInfo.resetTime || qInfo.reset_time || qInfo.resetsAt;

        let windowResetInText = 'Full Quota Available';
        if (windowReset) {
          const diffMs = new Date(windowReset).getTime() - Date.now();
          windowResetInText = formatResetRemaining(diffMs);
        } else if (percentUsed === 0) {
          windowResetInText = 'Full Quota Available';
        } else {
          windowResetInText = 'Resets in 5h';
        }

        let weeklyResetInText = 'Full Quota Available';
        if (weeklyReset) {
          const diffMs = new Date(weeklyReset).getTime() - Date.now();
          weeklyResetInText = formatResetRemaining(diffMs);
        } else if (weeklyPercent === 0) {
          weeklyResetInText = 'Full Quota Available';
        } else {
          weeklyResetInText = 'Resets in 7d';
        }

        const resetInText = windowResetInText !== 'Full Quota Available' ? windowResetInText : weeklyResetInText;

        return {
          percentUsed,
          windowPercent: percentUsed,
          weeklyPercent: weeklyPercent !== null ? weeklyPercent : 0,
          windowResetInText,
          weeklyResetInText,
          resetInText,
          windowResetsAt: windowReset ? (Date.parse(windowReset) || null) : null,
          modelName: activeItem.label || activeItem.modelOrAlias || activeItem.name || 'Gemini Pro'
        };
      }
    }

    return null;
  }

  // ==========================================
  // Session (auto-detected from the running Antigravity app, no sign-in)
  // ==========================================
  async restoreSession() {
    const saved = secureStore.getSession('antigravity');
    return Boolean(saved && saved.lastUsage);
  }

  toResult(u, extra) {
    const percentUsed = u.percentUsed || 0;
    return {
      provider: 'antigravity',
      name: 'Antigravity',
      loggedIn: true,
      percentUsed,
      windowPercent: u.windowPercent !== undefined ? u.windowPercent : percentUsed,
      weeklyPercent: u.weeklyPercent || 0,
      windowResetInText: u.windowResetInText,
      weeklyResetInText: u.weeklyResetInText,
      resetInText: u.resetInText || 'Active',
      windowResetsAt: u.windowResetsAt || null,
      status: percentUsed >= 90 ? 'critical' : percentUsed >= 70 ? 'warning' : 'ok',
      detail: u.detail || 'Antigravity Connected',
      hasData: true,
      needsReauth: false,
      ...extra
    };
  }

  // Remember a fresh reading so it can still be shown (as stale) while Antigravity is closed
  saveFresh(quota, source) {
    this.cachedUsage = {
      percentUsed: quota.percentUsed,
      windowPercent: quota.windowPercent,
      weeklyPercent: quota.weeklyPercent,
      windowResetInText: quota.windowResetInText,
      weeklyResetInText: quota.weeklyResetInText,
      resetInText: quota.resetInText,
      windowResetsAt: quota.windowResetsAt || null,
      detail: `${quota.modelName} Active (${source})`
    };
    const now = new Date().toISOString();
    secureStore.saveSession('antigravity', {
      ...(secureStore.getSession('antigravity') || {}),
      lastUsage: this.cachedUsage,
      lastUsageAt: now,
      connectedAt: now
    });
    return this.toResult(this.cachedUsage, { stale: false, updatedAt: Date.now() });
  }

  // ==========================================
  // Primary Fetch Usage Function
  // ==========================================
  async fetchUsage() {
    try {
      // 1. Running Antigravity app / agy hub on this machine
      try {
        const live = await this.queryLiveUsage();
        if (live) return this.saveFresh(live, 'Local');
      } catch (err) {
        console.warn('[AntigravityProvider] Live usage notice:', err.message);
      }

      // 2. Cloud Code API, if a local credential file holds an access token
      const accessToken = this.getLocalTokenCandidates().find(t => typeof t === 'string');
      if (accessToken) {
        const remote = await this.fetchRemoteQuota(accessToken);
        if (remote && !remote.error) return this.saveFresh(remote, 'Google Cloud');
      }

      // 3. Antigravity isn't running: last known numbers
      const saved = secureStore.getSession('antigravity') || {};
      if (saved.lastUsage) {
        return this.toResult(saved.lastUsage, {
          stale: true,
          updatedAt: saved.lastUsageAt ? Date.parse(saved.lastUsageAt) : null
        });
      }

      // 4. Never seen Antigravity running
      secureStore.setProviderLoggedIn('antigravity', false);
      return this.notConnected('Open Antigravity to start tracking its quotas');
    } catch (err) {
      console.error('[AntigravityProvider] Fetch error:', err.message);
      return this.notConnected('Could not read Antigravity usage');
    }
  }

  notConnected(detail) {
    return {
      provider: 'antigravity',
      name: 'Antigravity',
      loggedIn: false,
      percentUsed: 0,
      windowPercent: 0,
      weeklyPercent: 0,
      resetInText: 'Not Running',
      status: 'disconnected',
      detail
    };
  }

  async logout() {
    secureStore.clearSession('antigravity');
    this.activeServer = null;
    this.cachedUsage = null;
  }
}

module.exports = new AntigravityProvider();
