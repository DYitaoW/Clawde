# AI Usage Monitor (macOS & Windows)

A lightweight menu bar / system tray utility that tracks real-time usage limits for **Claude** and **Google Antigravity** (Gemini & Argon models).

## Features

- **Claude**: Direct web chat 5-hour rolling limits, weekly limits, and reset countdowns.
- **Antigravity**: Tracks Gemini & Argon model quotas (5-hour rolling session windows and weekly allocations).
- **Default System Browser OAuth**: Connects Google Antigravity via your genuine default browser (Chrome, Safari, Arc) with automatic loopback callback — eliminating embedded WebView blocks and passkey failures.
- **Auto-Detection**: Automatically detects local Antigravity sessions if already running or authenticated on your Mac.
- **Persistent Sessions**: Logins and sessions persist across app reloads and system restarts without requiring re-authentication.

---

## How It Works

1. Click the menu bar icon `⚡` in the macOS top bar (or system tray on Windows).
2. For **Claude**: Click **"Log in to Claude"** to sign in to your `claude.ai` account.
3. For **Antigravity**: Click **"Connect Antigravity"** — it opens Google's official authorization screen in your default browser and connects automatically upon approval.
4. The popover displays:
   - Percentage of 5-hour quota used (e.g., `24% Used` / `Full Quota Available`)
   - Reset countdown (e.g., `Resets in 2h 15m`)
   - Weekly usage breakdown (`5h: X% · Weekly: Y%`)
   - Compact menu bar summary: `C:24% AGY:15%`

---

## Running the App

```bash
npm start
```

---

## Building the .dmg Installer (macOS)

To build a standalone `.dmg` installer that can be installed on any Mac:

1. **Install dependencies** (including `electron-builder`):
   ```bash
   npm install
   ```

2. **Generate the .dmg**:
   ```bash
   npm run build:dmg
   ```
   *(or `npm run dist`)*

3. The compiled `.dmg` will be located in the `dist/` folder:
   ```
   dist/AI Usage Monitor-1.0.0.dmg
   ```
   You can double-click the `.dmg` and drag **AI Usage Monitor** to your **Applications** folder.

### What is configured for macOS:
- **`LSUIElement: 1`**: Configured so the app runs purely as a menu bar app without cluttering the macOS Dock.
- **Drag-and-Drop Installer**: Automatically includes a direct symlink to `/Applications` inside the DMG disk window.
- **Universal / Apple Silicon & Intel**: Builds for your Mac's architecture (`arm64` Apple Silicon or `x64` Intel).
