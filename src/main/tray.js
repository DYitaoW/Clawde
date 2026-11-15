const { Tray, BrowserWindow, screen, nativeImage } = require('electron');
const path = require('path');
const secureStore = require('./secureStore');

let tray = null;
let popoverWindow = null;

// Hidden window that draws the menu bar icon on a canvas, so the percentages
// use the real macOS system font (SF Pro) at menu bar size.
let iconRendererWindow = null;
let iconRendererReady = null;
let pendingIconData = null;
let iconRenderInFlight = false;

function getIconRenderer() {
  if (!iconRendererReady) {
    iconRendererWindow = new BrowserWindow({
      width: 400,
      height: 60,
      show: false,
      webPreferences: { nodeIntegration: false, contextIsolation: true }
    });
    iconRendererReady = iconRendererWindow
      .loadFile(path.join(__dirname, '../renderer/trayIcon.html'))
      .then(() => iconRendererWindow);
  }
  return iconRendererReady;
}

// Renders the latest requested icon; overlapping updates collapse into one
async function renderTrayIcon(providers) {
  pendingIconData = providers;
  if (iconRenderInFlight) return;
  iconRenderInFlight = true;
  try {
    while (pendingIconData) {
      const data = pendingIconData;
      pendingIconData = null;
      const win = await getIconRenderer();
      const dataUrl = await win.webContents.executeJavaScript(`renderTrayIcon(${JSON.stringify(data)})`);
      const png = nativeImage.createFromDataURL(dataUrl).toPNG();
      if (tray && !tray.isDestroyed()) {
        tray.setImage(nativeImage.createFromBuffer(png, { scaleFactor: 2.0 }));
        if (process.platform === 'darwin') tray.setTitle('');
      }
    }
  } catch (err) {
    console.warn('[Tray] Icon generation notice:', err.message);
  } finally {
    iconRenderInFlight = false;
  }
}

function createTray() {
  const isMac = process.platform === 'darwin';
  const iconName = isMac ? 'iconTemplate.png' : 'icon.png';
  const iconPath = path.join(__dirname, '../../assets', iconName);

  let icon = nativeImage.createFromPath(iconPath);
  if (isMac) {
    icon.setTemplateImage(true);
  }

  tray = new Tray(icon);
  tray.setToolTip('Clawde (Claude & Antigravity usage)');

  createPopoverWindow();

  tray.on('click', () => {
    toggleWindow();
  });

  tray.on('right-click', () => {
    toggleWindow();
  });

  return tray;
}

function createPopoverWindow() {
  popoverWindow = new BrowserWindow({
    width: 310,
    height: 320, // Initial size; the renderer resizes it to fit its content
    show: false,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    backgroundColor: '#131418',
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  popoverWindow.loadFile(path.join(__dirname, '../renderer/index.html'));

  popoverWindow.on('blur', () => {
    if (!popoverWindow.webContents.isDevToolsOpened()) {
      popoverWindow.hide();
    }
  });
}

function toggleWindow() {
  if (!popoverWindow) return;

  if (popoverWindow.isVisible()) {
    popoverWindow.hide();
  } else {
    showWindow();
  }
}

function showWindow() {
  if (!tray || !popoverWindow) return;

  const trayBounds = tray.getBounds();
  const windowBounds = popoverWindow.getBounds();
  const primaryDisplay = screen.getDisplayNearestPoint({ x: trayBounds.x, y: trayBounds.y });
  const displayBounds = primaryDisplay.workArea;

  let x = Math.round(trayBounds.x + (trayBounds.width / 2) - (windowBounds.width / 2));
  let y = Math.round(trayBounds.y + trayBounds.height + 4);

  if (process.platform === 'win32') {
    y = Math.round(trayBounds.y - windowBounds.height - 4);
  }

  if (x + windowBounds.width > displayBounds.x + displayBounds.width) {
    x = displayBounds.x + displayBounds.width - windowBounds.width - 8;
  }
  if (x < displayBounds.x) {
    x = displayBounds.x + 8;
  }

  popoverWindow.setPosition(x, y, false);
  popoverWindow.show();
  popoverWindow.focus();
}

function updateTrayTitle(usageList) {
  if (!tray) return;

  const showWeekly = secureStore.getSettings().trayWeeklyRing !== false;

  const claudeItem = usageList.find(u => u.provider === 'claude');
  const antiItem = usageList.find(u => u.provider === 'antigravity');

  const toRingData = (item) => {
    const active = Boolean(item && item.loggedIn);
    const session = active
      ? (typeof item.windowPercent === 'number' ? item.windowPercent : (item.percentUsed || 0))
      : 0;
    const weekly = active
      ? (typeof item.weeklyPercent === 'number' ? item.weeklyPercent : 0)
      : 0;
    return { active, sessionPercent: session, weeklyPercent: weekly, showWeekly };
  };

  // Draw percentage + ring for each provider (async, via the hidden canvas window)
  renderTrayIcon([
    { ...toRingData(claudeItem), base: 'claude' },
    { ...toRingData(antiItem), base: 'antigravity' }
  ]);

  const tooltipSummary = usageList
    .map(u => `${u.name}: ${u.loggedIn ? `${u.percentUsed}% (${u.resetInText})` : 'Not connected'}`)
    .join('\n');
  tray.setToolTip(`Clawde\n${tooltipSummary}`);
}

function getPopoverWindow() {
  return popoverWindow;
}

module.exports = {
  createTray,
  updateTrayTitle,
  getPopoverWindow,
  showWindow,
  toggleWindow
};
