const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const cp = require('child_process');
const secureStore = require('../secureStore');

// Google Cloud Code / Antigravity standard OAuth client ID
const CLIENT_ID = '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com';
const OAUTH_SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile'
].join(' ');

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
    this.server = null;
    this.cachedUsage = null;
    this.activeServer = null; // Caches working local { port, token, isHttps }
    this.pendingAuth = null;  // Caches PKCE { verifier, state, redirectUri }
  }

  // ==========================================
  // Method 1: OpenUsage Remote Cloud Code API
  // ==========================================

  // Queries Cloud Code internal quota APIs using Google OAuth access token
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
          body: JSON.stringify({})
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

  // Refreshes expired Google OAuth access token using refresh_token
  async refreshAccessToken(refreshToken) {
    if (!refreshToken) return null;
    try {
      const res = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: CLIENT_ID,
          refresh_token: refreshToken,
          grant_type: 'refresh_token'
        }).toString()
      });

      if (res.ok) {
        const tokenData = await res.json();
        return tokenData.access_token;
      } else {
        const err = await res.text().catch(() => '');
        console.warn('[AntigravityProvider] Token refresh response error:', res.status, err);
      }
    } catch (e) {
      console.warn('[AntigravityProvider] Token refresh error:', e.message);
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

  // Discover candidate (port, token) pairs from process table and environment
  async findServerCandidates() {
    const candidates = [];

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
    }

    const candidates = await this.findServerCandidates();

    for (const c of candidates) {
      for (const isHttps of [true, false]) {
        for (const ep of endpoints) {
          for (const pl of payloads) {
            const res = await this.requestRpc(isHttps, c.port, ep, c.token, pl);
            if (res) {
              const parsed = this.parseAntigravityQuota(res);
              if (parsed) {
                this.activeServer = { port: c.port, token: c.token, isHttps };
                console.log(`[AntigravityProvider] Connected to local Language Server on port ${c.port} (${isHttps ? 'HTTPS' : 'HTTP'})`);
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
          modelName: activeItem.label || activeItem.modelOrAlias || activeItem.name || 'Gemini Pro'
        };
      }
    }

    return null;
  }

  // ==========================================
  // Session & Authentication
  // ==========================================
  async restoreSession() {
    try {
      const savedSession = secureStore.getSession('antigravity');
      if (savedSession && (savedSession.tokens || savedSession.connectedAt || savedSession.lastUsage)) {
        return true;
      }

      const localCreds = this.getLocalTokenCandidates();
      if (localCreds.length > 0) {
        return true;
      }
    } catch (err) {
      console.warn('[AntigravityProvider] Session restore warning:', err.message);
    }
    return false;
  }

  async checkAuth() {
    const savedSession = secureStore.getSession('antigravity');
    if (savedSession && (savedSession.tokens || savedSession.connectedAt || savedSession.lastUsage)) {
      return true;
    }

    const localCreds = this.getLocalTokenCandidates();
    if (localCreds.length > 0) {
      return true;
    }

    if (this.activeServer) return true;
    return false;
  }

  // Browser redirect landing page HTML
  renderBrowserHtml(isSuccess, message) {
    const title = isSuccess ? 'Connected to Antigravity' : 'Connection Error';
    const accentColor = isSuccess ? '#8ab4f8' : '#f87171';
    const badgeText = isSuccess ? 'Google Antigravity' : 'Antigravity Auth';

    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${title}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #131418; color: #ededed; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
    .card { background: #1c1d22; border: 1px solid rgba(255,255,255,0.08); border-radius: 14px; padding: 36px 32px; text-align: center; max-width: 440px; box-shadow: 0 12px 32px rgba(0,0,0,0.6); }
    h1 { font-size: 20px; font-weight: 600; margin-bottom: 10px; color: ${accentColor}; }
    p { color: #9a9b9f; font-size: 14px; line-height: 1.6; margin: 0 0 16px 0; }
    .badge { display: inline-block; background: rgba(138, 180, 248, 0.15); color: ${accentColor}; padding: 4px 10px; border-radius: 6px; font-size: 12px; font-weight: 600; margin-bottom: 16px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="badge">${badgeText}</div>
    <h1>${title}</h1>
    <p>${message}</p>
  </div>
  ${isSuccess ? '<script>setTimeout(() => { try { window.close(); } catch(e){} }, 3000);</script>' : ''}
</body>
</html>`;
  }

  // ==========================================
  // OAuth Login with PKCE via Default Browser
  // ==========================================
  startOAuthLogin(onSuccess, onFailure) {
    if (this.server) {
      try { this.server.close(); } catch (e) {}
      this.server = null;
    }

    // 1. Generate PKCE code_verifier and code_challenge
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const state = crypto.randomBytes(16).toString('hex');

    const port = 51121;
    const redirectUri = `http://localhost:${port}/oauth-callback`;

    this.pendingAuth = {
      verifier,
      challenge,
      state,
      redirectUri,
      port
    };

    // 2. Local HTTP Server to capture OAuth redirect callback
    this.server = http.createServer(async (req, res) => {
      try {
        const reqUrl = new URL(req.url, `http://localhost:${port}`);
        if (reqUrl.pathname === '/oauth-callback') {
          const code = reqUrl.searchParams.get('code');
          const error = reqUrl.searchParams.get('error');

          if (error) {
            console.error('[AntigravityProvider] OAuth redirect returned error:', error);
            res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(this.renderBrowserHtml(false, `Google authentication error: ${error}`));
            this.cleanupServer();
            if (onFailure) onFailure('antigravity');
            return;
          }

          if (code) {
            console.log('[AntigravityProvider] Received OAuth authorization code. Exchanging with PKCE...');

            let tokenData = null;
            try {
              const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                  client_id: CLIENT_ID,
                  code: code,
                  code_verifier: verifier,
                  redirect_uri: redirectUri,
                  grant_type: 'authorization_code'
                }).toString()
              });

              if (tokenRes.ok) {
                tokenData = await tokenRes.json();
                console.log('[AntigravityProvider] Token exchange successful! Access token obtained.');
              } else {
                const errText = await tokenRes.text().catch(() => '');
                console.error('[AntigravityProvider] Token exchange failed with status', tokenRes.status, ':', errText);
                res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(this.renderBrowserHtml(false, `Token exchange failed: ${errText || 'Invalid code or verifier'}`));
                this.cleanupServer();
                if (onFailure) onFailure('antigravity');
                return;
              }
            } catch (err) {
              console.error('[AntigravityProvider] Token exchange network error:', err.message);
              res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
              res.end(this.renderBrowserHtml(false, `Token exchange network error: ${err.message}`));
              this.cleanupServer();
              if (onFailure) onFailure('antigravity');
              return;
            }

            // Save authenticated tokens in secure store
            secureStore.saveSession('antigravity', {
              tokens: tokenData,
              connectedAt: new Date().toISOString()
            });
            secureStore.setProviderLoggedIn('antigravity', true);

            // Fetch remote quotas immediately
            if (tokenData && tokenData.access_token) {
              try {
                const remoteResult = await this.fetchRemoteQuota(tokenData.access_token);
                if (remoteResult && !remoteResult.error) {
                  this.cachedUsage = {
                    percentUsed: remoteResult.percentUsed,
                    windowPercent: remoteResult.windowPercent,
                    weeklyPercent: remoteResult.weeklyPercent,
                    windowResetInText: remoteResult.windowResetInText,
                    weeklyResetInText: remoteResult.weeklyResetInText,
                    resetInText: remoteResult.resetInText,
                    detail: `${remoteResult.modelName} Active (Google Cloud)`
                  };
                  secureStore.saveSession('antigravity', {
                    tokens: tokenData,
                    connectedAt: new Date().toISOString(),
                    lastUsage: this.cachedUsage
                  });
                }
              } catch (e) {
                console.warn('[AntigravityProvider] Immediate quota fetch notice:', e.message);
              }
            }

            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(this.renderBrowserHtml(true, 'Your Antigravity authorization is complete. You can close this tab and return to <strong>UsageMonitor</strong>.'));

            setTimeout(() => {
              this.cleanupServer();
              if (onSuccess) onSuccess('antigravity');
            }, 600);

          } else {
            res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(this.renderBrowserHtml(false, 'No authorization code found in the callback request.'));
            this.cleanupServer();
            if (onFailure) onFailure('antigravity');
          }
        } else {
          res.writeHead(404);
          res.end();
        }
      } catch (err) {
        console.error('[AntigravityProvider] OAuth callback server exception:', err.message);
      }
    });

    this.server.on('error', (err) => {
      console.error('[AntigravityProvider] OAuth listener error:', err.message);
      if (err.code === 'EADDRINUSE') {
        console.warn(`[AntigravityProvider] Port ${port} is currently busy. Please close any conflicting processes or paste authorization code.`);
      }
      this.cleanupServer();
      if (onFailure) onFailure('antigravity');
    });

    this.server.listen(port, '127.0.0.1', () => {
      console.log(`[AntigravityProvider] OAuth listener bound to http://127.0.0.1:${port}/oauth-callback`);

      const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?` + new URLSearchParams({
        client_id: CLIENT_ID,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: OAUTH_SCOPES,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state: state,
        access_type: 'offline',
        prompt: 'consent'
      }).toString();

      console.log('[AntigravityProvider] Opening authorization URL in default browser...');
      shell.openExternal(authUrl);
    });

    // Auto-timeout after 5 minutes if user abandons
    setTimeout(() => {
      if (this.server) {
        this.cleanupServer();
      }
    }, 5 * 60 * 1000);
  }

  // Fallback: Manually submit authorization code or callback URL
  async handleManualCode(input) {
    if (!input || typeof input !== 'string') {
      return { success: false, error: 'No code or URL provided' };
    }

    let code = input.trim();
    if (code.includes('code=')) {
      const match = code.match(/code=([^&]+)/);
      if (match) code = decodeURIComponent(match[1]);
    }

    if (!code) {
      return { success: false, error: 'Could not extract authorization code from input' };
    }

    const verifier = (this.pendingAuth && this.pendingAuth.verifier) || null;
    const redirectUri = (this.pendingAuth && this.pendingAuth.redirectUri) || 'http://localhost:51121/oauth-callback';

    try {
      const payload = {
        client_id: CLIENT_ID,
        code,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code'
      };
      if (verifier) {
        payload.code_verifier = verifier;
      }

      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(payload).toString()
      });

      if (!tokenRes.ok) {
        const err = await tokenRes.text().catch(() => '');
        console.error('[AntigravityProvider] Manual code exchange failed:', err);
        return { success: false, error: err };
      }

      const tokenData = await tokenRes.json();
      secureStore.saveSession('antigravity', {
        tokens: tokenData,
        connectedAt: new Date().toISOString()
      });
      secureStore.setProviderLoggedIn('antigravity', true);

      if (tokenData && tokenData.access_token) {
        const remoteResult = await this.fetchRemoteQuota(tokenData.access_token);
        if (remoteResult && !remoteResult.error) {
          this.cachedUsage = {
            percentUsed: remoteResult.percentUsed,
            windowPercent: remoteResult.windowPercent,
            weeklyPercent: remoteResult.weeklyPercent,
            windowResetInText: remoteResult.windowResetInText,
            weeklyResetInText: remoteResult.weeklyResetInText,
            resetInText: remoteResult.resetInText,
            detail: `${remoteResult.modelName} Active (Google Cloud)`
          };
          secureStore.saveSession('antigravity', {
            tokens: tokenData,
            connectedAt: new Date().toISOString(),
            lastUsage: this.cachedUsage
          });
        }
      }

      this.cleanupServer();
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  cleanupServer() {
    if (this.server) {
      try { this.server.close(); } catch (e) {}
      this.server = null;
    }
  }

  // ==========================================
  // Primary Fetch Usage Function
  // ==========================================
  async fetchUsage() {
    try {
      const savedSession = secureStore.getSession('antigravity') || {};
      let tokens = savedSession.tokens || {};
      let accessToken = tokens.access_token;
      const refreshToken = tokens.refresh_token;

      // 1. Check local credential files if no stored token
      if (!accessToken) {
        const localTokens = this.getLocalTokenCandidates();
        for (const t of localTokens) {
          if (typeof t === 'string') {
            accessToken = t;
            break;
          } else if (t && t.refreshToken) {
            tokens.refresh_token = t.refreshToken;
          }
        }
      }

      // 2. OpenUsage Remote API: Try cloudcode-pa with access token
      if (accessToken) {
        let remoteResult = await this.fetchRemoteQuota(accessToken);
        if (remoteResult && remoteResult.error === 'unauthorized' && (refreshToken || tokens.refresh_token)) {
          console.log('[AntigravityProvider] OAuth token expired, refreshing with Google...');
          const freshToken = await this.refreshAccessToken(refreshToken || tokens.refresh_token);
          if (freshToken) {
            tokens.access_token = freshToken;
            accessToken = freshToken;
            secureStore.saveSession('antigravity', { ...savedSession, tokens });
            remoteResult = await this.fetchRemoteQuota(freshToken);
          }
        }

        if (remoteResult && !remoteResult.error) {
          secureStore.setProviderLoggedIn('antigravity', true);
          this.cachedUsage = {
            percentUsed: remoteResult.percentUsed,
            windowPercent: remoteResult.windowPercent,
            weeklyPercent: remoteResult.weeklyPercent,
            windowResetInText: remoteResult.windowResetInText,
            weeklyResetInText: remoteResult.weeklyResetInText,
            resetInText: remoteResult.resetInText,
            detail: `${remoteResult.modelName} Active (Google Cloud)`
          };

          secureStore.saveSession('antigravity', {
            ...(secureStore.getSession('antigravity') || {}),
            lastUsage: this.cachedUsage,
            connectedAt: new Date().toISOString()
          });

          const status = remoteResult.percentUsed >= 90 ? 'critical' : remoteResult.percentUsed >= 70 ? 'warning' : 'ok';
          return {
            provider: 'antigravity',
            name: 'Antigravity',
            loggedIn: true,
            percentUsed: remoteResult.percentUsed,
            windowPercent: remoteResult.windowPercent,
            weeklyPercent: remoteResult.weeklyPercent,
            windowResetInText: remoteResult.windowResetInText,
            weeklyResetInText: remoteResult.weeklyResetInText,
            resetInText: remoteResult.resetInText,
            status,
            detail: this.cachedUsage.detail
          };
        }
      }

      // 3. Fallback: Query live local Language Server / Daemon
      try {
        const liveQuota = await this.queryLiveUsage();
        if (liveQuota) {
          secureStore.setProviderLoggedIn('antigravity', true);
          const detail = `${liveQuota.modelName} Active (Local)`;
          this.cachedUsage = {
            percentUsed: liveQuota.percentUsed,
            windowPercent: liveQuota.windowPercent,
            weeklyPercent: liveQuota.weeklyPercent,
            windowResetInText: liveQuota.windowResetInText,
            weeklyResetInText: liveQuota.weeklyResetInText,
            resetInText: liveQuota.resetInText,
            detail
          };

          secureStore.saveSession('antigravity', {
            ...(secureStore.getSession('antigravity') || {}),
            lastUsage: this.cachedUsage,
            connectedAt: new Date().toISOString()
          });

          const status = liveQuota.percentUsed >= 90 ? 'critical' : liveQuota.percentUsed >= 70 ? 'warning' : 'ok';
          return {
            provider: 'antigravity',
            name: 'Antigravity',
            loggedIn: true,
            percentUsed: liveQuota.percentUsed,
            windowPercent: liveQuota.windowPercent,
            weeklyPercent: liveQuota.weeklyPercent,
            windowResetInText: liveQuota.windowResetInText,
            weeklyResetInText: liveQuota.weeklyResetInText,
            resetInText: liveQuota.resetInText,
            status,
            detail
          };
        }
      } catch (err) {
        console.warn('[AntigravityProvider] Live usage notice:', err.message);
      }

      // 4. Cached usage from store if available
      if (savedSession.lastUsage) {
        const u = savedSession.lastUsage;
        return {
          provider: 'antigravity',
          name: 'Antigravity',
          loggedIn: true,
          percentUsed: u.percentUsed || 0,
          windowPercent: u.windowPercent !== undefined ? u.windowPercent : (u.percentUsed || 0),
          weeklyPercent: u.weeklyPercent || 0,
          windowResetInText: u.windowResetInText,
          weeklyResetInText: u.weeklyResetInText,
          resetInText: u.resetInText || 'Active',
          status: (u.percentUsed >= 90) ? 'critical' : (u.percentUsed >= 70) ? 'warning' : 'ok',
          detail: u.detail || 'Antigravity Connected'
        };
      }

      // 5. Not connected
      secureStore.setProviderLoggedIn('antigravity', false);
      return {
        provider: 'antigravity',
        name: 'Antigravity',
        loggedIn: false,
        percentUsed: 0,
        windowPercent: 0,
        weeklyPercent: 0,
        resetInText: 'Not Connected',
        status: 'disconnected',
        detail: 'Sign in with Google to track Antigravity quotas'
      };

    } catch (err) {
      console.error('[AntigravityProvider] Fetch error:', err.message);
      return {
        provider: 'antigravity',
        name: 'Antigravity',
        loggedIn: false,
        percentUsed: 0,
        windowPercent: 0,
        weeklyPercent: 0,
        resetInText: 'Not Connected',
        status: 'disconnected',
        detail: 'Could not connect to Antigravity'
      };
    }
  }

  async logout() {
    secureStore.clearSession('antigravity');
    this.activeServer = null;
    this.cachedUsage = null;
    this.cleanupServer();
  }
}

module.exports = new AntigravityProvider();
