const { BrowserWindow, session } = require('electron');
const path = require('path');
const secureStore = require('./secureStore');

let activeLoginWindow = null;

const chromeVersion = process.versions.chrome || '131.0.0.0';
const majorChromeVersion = chromeVersion.split('.')[0];
const CHROME_USER_AGENT = process.platform === 'darwin'
  ? `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`
  : `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;

function openLogin(provider, onSuccess, onFailure) {
  if (activeLoginWindow && !activeLoginWindow.isDestroyed()) {
    activeLoginWindow.focus();
    return;
  }

  const isClaude = provider === 'claude';
  const partition = isClaude ? 'persist:claude' : 'persist:gemini';
  const targetUrl = isClaude ? 'https://claude.ai/login' : 'https://gemini.google.com/app';
  const windowTitle = isClaude ? 'Log in to Claude' : 'Log in to Google Gemini';

  const ses = session.fromPartition(partition);
  ses.setUserAgent(CHROME_USER_AGENT);

  // Set up header filtering to prevent Google's "This browser or app may not be secure" block
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = { ...details.requestHeaders };
    headers['User-Agent'] = CHROME_USER_AGENT;

    // For Google auth endpoints, ensure Sec-CH-UA matches genuine Google Chrome
    if (details.url.includes('google.com')) {
      if (headers['sec-ch-ua'] || headers['Sec-CH-UA']) {
        const chromeBrand = `"Google Chrome";v="${majorChromeVersion}", "Chromium";v="${majorChromeVersion}", "Not_A Brand";v="24"`;
        headers['sec-ch-ua'] = chromeBrand;
        headers['Sec-CH-UA'] = chromeBrand;
      }
    }

    callback({ requestHeaders: headers });
  });

  activeLoginWindow = new BrowserWindow({
    width: 540,
    height: 740,
    title: windowTitle,
    resizable: true,
    alwaysOnTop: true,
    webPreferences: {
      partition,
      preload: path.join(__dirname, 'loginPreload.js'),
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  activeLoginWindow.webContents.setUserAgent(CHROME_USER_AGENT);

  let isDone = false;
  let checkInterval = null;

  async function checkLoginStatus() {
    if (isDone || !activeLoginWindow || activeLoginWindow.isDestroyed()) return;

    try {
      const currentUrl = activeLoginWindow.webContents.getURL() || '';

      if (isClaude) {
        const allCookies = await ses.cookies.get({});
        const hasSessionKey = allCookies.some(c => c.name === 'sessionKey' && c.value && c.value.length > 5);

        const isPastLogin = currentUrl.includes('claude.ai') && 
          (!currentUrl.includes('/login') || currentUrl.includes('/new') || currentUrl.includes('/chat'));

        let isChatDomReady = false;
        if (hasSessionKey || isPastLogin) {
          isChatDomReady = await activeLoginWindow.webContents.executeJavaScript(`
            Boolean(document.querySelector('textarea') || document.querySelector('[contenteditable]') || document.querySelector('nav') || window.__NEXT_DATA__)
          `).catch(() => false);
        }

        if (hasSessionKey && (isPastLogin || isChatDomReady)) {
          isDone = true;
          clearInterval(checkInterval);

          const pageResult = await activeLoginWindow.webContents.executeJavaScript(`
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
          `).catch(e => ({ error: e.message }));


          secureStore.saveSession('claude', {
            cookies: allCookies,
            orgId: pageResult && pageResult.orgId ? pageResult.orgId : null,
            lastUsage: pageResult && pageResult.usage ? pageResult.usage : null
          });

          await ses.cookies.flushStore();

          setTimeout(() => {
            if (activeLoginWindow && !activeLoginWindow.isDestroyed()) {
              activeLoginWindow.close();
            }
            if (onSuccess) onSuccess(provider, pageResult && pageResult.usage);
          }, 600);
        }
      } else {
        // Gemini Web Login
        const allCookies = await ses.cookies.get({});
        const hasGoogleAuth = allCookies.some(c => c.name === 'SID' || c.name === '__Secure-1PSID');

        const isGeminiPage = currentUrl.includes('gemini.google.com') && !currentUrl.includes('accounts.google.com');

        let isGeminiDomReady = false;
        if (hasGoogleAuth && isGeminiPage) {
          isGeminiDomReady = await activeLoginWindow.webContents.executeJavaScript(`
            Boolean(document.querySelector('.input-area') || document.querySelector('rich-textarea') || document.querySelector('chat-window') || document.querySelector('bard-sidenav') || document.querySelector('textarea'))
          `).catch(() => true);
        }

        if (hasGoogleAuth && (isGeminiPage || isGeminiDomReady)) {
          isDone = true;
          clearInterval(checkInterval);

          secureStore.saveSession('gemini', {
            cookies: allCookies,
            connectedAt: new Date().toISOString()
          });

          await ses.cookies.flushStore();

          setTimeout(() => {
            if (activeLoginWindow && !activeLoginWindow.isDestroyed()) {
              activeLoginWindow.close();
            }
            if (onSuccess) onSuccess(provider);
          }, 600);
        }
      }
    } catch (err) {
      console.error('[LoginWindow] Status check error:', err.message);
    }
  }

  activeLoginWindow.webContents.on('did-finish-load', checkLoginStatus);
  activeLoginWindow.webContents.on('did-navigate', checkLoginStatus);
  activeLoginWindow.webContents.on('did-navigate-in-page', checkLoginStatus);

  checkInterval = setInterval(checkLoginStatus, 1000);

  activeLoginWindow.on('closed', () => {
    clearInterval(checkInterval);
    activeLoginWindow = null;
    if (!isDone && onFailure) {
      onFailure(provider);
    }
  });

  activeLoginWindow.loadURL(targetUrl, { userAgent: CHROME_USER_AGENT });
}

module.exports = {
  openLogin
};
