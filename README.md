<p align="center">
  <img src="assets/icon-512.png" alt="Clawde app icon" width="128" height="128">
</p>

<h1 align="center">Clawde</h1>

<p align="center">
  A small macOS menu bar app that shows how much of your <b>Claude</b> and <b>Google Antigravity</b> usage limits you've used, without opening either app.
</p>

<p align="center">
  <a href="https://github.com/DYitaoW/clawde/releases/latest"><b>Download for Mac</b></a> · Apple Silicon · macOS 12+
</p>

<!-- Screenshot: add docs/screenshot.png and uncomment
![Clawde menu bar and popover](docs/screenshot.png)
-->

## Features

**In the menu bar**
- Session (5-hour) usage percentage and ring for each service, with an optional inner ring for weekly usage.
- Choose which services appear: Claude, Antigravity or both.
- Right-click the icon for quick actions: Refresh, Settings, Check for Updates, Quit.
- Works in light and dark menu bars.

**In the popover**
- Session and weekly usage for each service, with the time until each limit resets.
- **Usage history**: a 24-hour chart of your session usage on each card. Hover to see the value at any point.
- **Pace**: how fast you're using your limit (% per hour).
- Click a card to open that service's usage page in your browser.
- Shows when numbers are out of date ("Updated 12m ago") if a service can't be reached, and a **Sign in again** button if a sign-in expires.
- Optional CPU and memory usage in the header.
- Light, dark or automatic appearance.

**Notifications**
- Alert when usage passes a threshold you choose.
- Alert when your 5-hour session resets and full quota is available again.

**Updates**
- New versions download in the background and install on restart.

Every extra (history, pace, system stats, menu bar rings, alerts) can be turned off in **Settings**.

## Requirements

- macOS 12 (Monterey) or later
- **Apple Silicon Mac (M1 or newer).** Intel Macs are not supported.

## Install

1. Download the latest `Clawde-x.y.z-arm64.dmg` from [Releases](https://github.com/DYitaoW/clawde/releases/latest).
2. Open the DMG and drag **Clawde** into **Applications**.
3. Clawde appears in the menu bar (there's no Dock icon). Click it and sign in to Claude and/or Antigravity.

## Updating

Clawde updates itself. It checks GitHub twice a day and downloads new versions in the background. When an update is ready, a **Restart to update** button appears at the bottom of the popover. Click it, or just keep going: the update installs the next time Clawde quits. You can also check manually in **Settings → About**.

## Privacy

- Everything stays on your Mac. Clawde talks only to claude.ai, Google (for Antigravity sign-in and quota), the local Antigravity app if it's running, and GitHub (for the update check).
- Saved sign-in sessions are encrypted with the macOS Keychain.
- Usage history is saved only on your Mac (percentages and times only), kept for 7 days, and deleted when you disconnect a service.
- No analytics or tracking.

## Disclaimer

Clawde is an unofficial, independent project. It is **not affiliated with, endorsed by, or sponsored by Anthropic or Google**. "Claude" is a trademark of Anthropic; "Antigravity" and "Gemini" are trademarks of Google.

Clawde reads usage data the same way the official websites and apps do. These are not public APIs: they can change or stop working at any time, which may break Clawde until it's updated. Use at your own risk.

## License

[MIT](LICENSE)
