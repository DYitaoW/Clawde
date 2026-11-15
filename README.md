# Clawde

A small macOS menu bar app that shows how much of your **Claude** and **Google Antigravity** usage limits you've used, without opening either app.

<!-- Screenshot: add docs/screenshot.png and uncomment
![Clawde menu bar and popover](docs/screenshot.png)
-->

## Features

- **Menu bar at a glance**: session (5-hour) usage percentage and ring for each service, with an optional inner ring for weekly usage.
- **Popover details**: session and weekly usage, time until each limit resets, and a pace indicator (% per hour).
- **Alerts**: optional desktop notification when usage passes a threshold you choose.
- **System stats**: optional CPU and memory usage in the popover header.
- **Update check**: tells you when a new version is on GitHub.
- Works in light and dark menu bars.

## Requirements

- macOS 12 (Monterey) or later
- **Apple Silicon Mac (M1 or newer).** Intel Macs are not supported.

## Install

1. Download the latest `Clawde-x.y.z-arm64.dmg` from [Releases](https://github.com/DYitaoW/clawde/releases/latest).
2. Open the DMG and drag **Clawde** into **Applications**.
3. Open Clawde. Because the app isn't signed with a paid Apple Developer certificate, macOS will block it the first time:
   - **macOS 15 (Sequoia) and later:** open **System Settings → Privacy & Security**, scroll down and click **Open Anyway** next to the Clawde message, then confirm.
   - **macOS 12–14:** right-click (or Control-click) Clawde in Applications, choose **Open**, then **Open** again.
   - **Or, in Terminal:**
     ```bash
     xattr -cr /Applications/Clawde.app
     ```
   You only need to do this once per version.
4. Clawde appears in the menu bar (there's no Dock icon). Click it and sign in to Claude and/or Antigravity.

## Updating

Clawde checks GitHub for new versions twice a day. When one is available, an **Update** button appears at the bottom of the popover. Click it, download the new DMG and replace the app in Applications. You can also check manually in **Settings → About**.

## Privacy

- Everything stays on your Mac. Clawde talks only to claude.ai, Google (for Antigravity sign-in and quota), the local Antigravity app if it's running, and GitHub (for the update check).
- Saved sign-in sessions are encrypted with the macOS Keychain.
- No analytics or tracking.

## Disclaimer

Clawde is an unofficial, independent project. It is **not affiliated with, endorsed by, or sponsored by Anthropic or Google**. "Claude" is a trademark of Anthropic; "Antigravity" and "Gemini" are trademarks of Google.

Clawde reads usage data the same way the official websites and apps do. These are not public APIs: they can change or stop working at any time, which may break Clawde until it's updated. Use at your own risk.

## Development

```bash
npm install
npm start
```

### Build the DMG

```bash
npm run build:dmg
```

The DMG and a ZIP are written to `dist/` (for example `dist/Clawde-1.0.0-arm64.dmg`).

### Release a new version

1. Bump `version` in `package.json` (for example `1.0.1`).
2. Run `npm run build:dmg`.
3. On GitHub, go to **Releases → Draft a new release**, create the tag `v1.0.1`, and upload the `.dmg` (and `.zip`) from `dist/`.
4. Publish. Running copies of Clawde will show the update within about 12 hours.

### Project layout

```
src/main/        Electron main process (tray, providers, settings, update check)
src/main/providers/  Claude and Antigravity usage fetching
src/preload/     Bridge between the popover and the main process
src/renderer/    Popover UI and the canvas that draws the menu bar icon
assets/          Tray icons
```

## License

[MIT](LICENSE)
