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
- **Automatic updates**: new versions download in the background and install on restart.
- Works in light and dark menu bars.

## Requirements

- macOS 12 (Monterey) or later
- **Apple Silicon Mac (M1 or newer).** Intel Macs are not supported.

## Install

1. Download the latest `Clawde-x.y.z-arm64.dmg` from [Releases](https://github.com/DYitaoW/clawde/releases/latest).
2. Open the DMG and drag **Clawde** into **Applications**.
3. Open Clawde. It's signed and notarized by Apple, so it opens like any other app.
4. Clawde appears in the menu bar (there's no Dock icon). Click it and sign in to Claude and/or Antigravity.

## Updating

Clawde updates itself. It checks GitHub twice a day and downloads new versions in the background. When an update is ready, a **Restart to update** button appears at the bottom of the popover. Click it, or just keep going: the update installs the next time Clawde quits. You can also check manually in **Settings → About**.

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

### Signing and notarization (one-time setup)

Release builds are signed with a **Developer ID Application** certificate and notarized by Apple, so users can open Clawde without security warnings.

1. Create the certificate: Xcode → Settings → Accounts → select your paid team → **Manage Certificates…** → **+** → **Developer ID Application**. Check it's installed:
   ```bash
   security find-identity -v -p codesigning   # should list "Developer ID Application: …"
   ```
2. Create an app-specific password at [account.apple.com](https://account.apple.com) → Sign-In and Security → App-Specific Passwords.
3. Save notarization credentials in your Keychain (your Team ID is shown in the certificate name and at developer.apple.com → Membership):
   ```bash
   xcrun notarytool store-credentials "clawde-notary" \
     --apple-id "YOUR_APPLE_ID_EMAIL" --team-id "YOUR_TEAM_ID" --password "APP_SPECIFIC_PASSWORD"
   ```

Then build signed + notarized releases with:
```bash
APPLE_KEYCHAIN_PROFILE=clawde-notary npm run build:dmg
```
Check the result: `spctl -a -vv -t exec dist/mac-arm64/Clawde.app` should say `accepted` and `source=Notarized Developer ID`.

### Release a new version (GitHub Actions)

Releases are built, signed and notarized automatically by [.github/workflows/release.yml](.github/workflows/release.yml) on a GitHub-hosted Mac.

1. Bump `version` in `package.json` (for example `1.0.1`) and commit.
2. Tag and push:
   ```bash
   git tag v1.0.1
   git push origin main v1.0.1
   ```
3. Wait for the **Release** workflow in the Actions tab (about 5–15 minutes). It creates a **draft** release with the DMG, ZIP, blockmaps and `latest-mac.yml` attached.
4. Review the draft on the Releases page, add notes, and click **Publish**. Running copies of Clawde download the update within about 12 hours.

To release by hand instead, build locally (see above) and upload **all** of these from `dist/` to the release: `Clawde-x.y.z-arm64.dmg`, `Clawde-x.y.z-arm64.zip`, both `.blockmap` files and `latest-mac.yml`. The DMG is for new installs; the ZIP and `latest-mac.yml` are what auto-update uses.

To test the pipeline without releasing, use **Actions → Release → Run workflow**; the signed DMG is attached to the run.

The workflow needs these repository secrets (Settings → Secrets and variables → Actions):
- `MAC_CERT_P12_BASE64` and `MAC_CERT_PASSWORD` (Developer ID Application certificate)
- Notarization login, either `APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` + `APPLE_TEAM_ID`, or an App Store Connect API key: `APPLE_API_KEY_P8` + `APPLE_API_KEY_ID` + `APPLE_API_ISSUER`

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
