# Hawl desktop installers

Double-click setup for the `hawl` CLI and its helper (the daemon, spec 16 §3), plus a tray or
menu bar icon that shows whether the helper is running and lets you start, stop, update it and
connect a project folder. Nothing here re-implements the CLI: every action calls `hawl`
(`hawl autostart on`, `hawl daemon start|stop`, `hawl status --json`, `hawl join`, `hawl update`).

| OS | Download | What setup does |
|---|---|---|
| Windows x64 | `hawl-setup-win-x64.exe` | Per-user Inno Setup installer, no admin prompt. `hawl.exe` goes to `%USERPROFILE%\.hawl\bin` (same as `install.ps1`) and onto the user PATH; `hawl autostart on` creates the `hawl-daemon` logon task and starts the helper; the tray (`HawlTray.exe`, `%LOCALAPPDATA%\Programs\Hawl`) starts at login. Uninstall from Settings > Apps removes the task, tray and PATH entry; keys and `~/.hawl` stay. |
| macOS (Apple silicon) | `hawl-desktop-darwin-arm64.dmg` | Drag Hawl to Applications and open it. On launch it copies the bundled `hawl` to `~/.hawl/bin`, runs `hawl autostart on` (LaunchAgent) and registers itself as a login item. Menu bar icon only (no Dock icon). |
| Linux x64 | `hawl-desktop-linux-x64.tar.gz` | Unpack, run `./setup.sh [site]`. No sudo: `hawl` to `~/.hawl/bin`, `hawl autostart on` (systemd --user unit), tray in the app menu and desktop autostart. The tray needs GTK 3 and Ayatana AppIndicator (`sudo apt install gir1.2-ayatanaappindicator3-0.1`); without them the helper still runs. `./setup.sh --uninstall` removes it. |

Download links: `https://hawl.ai/download/windows`, `/download/mac`, `/download/linux` redirect to
the latest release of the public repo `aaronlilla/hawl`.

Join: Windows setup's last page has "Connect a project folder now"; every tray has
"Connect a project folder…". It asks for the folder and the site, then opens a terminal running
`hawl join <site>` in that folder, so the typed-code approval works as usual. Windows setup takes
`/SITE=acme` to pre-fill the site.

## Building

CI builds all three on every PR that touches `packages/desktop` or `packages/cli`
(`.github/workflows/desktop.yml`), smoke-tests them (Windows: silent install, helper start/stop,
uninstall) and publishes a `desktop-<sha>` prerelease from main. The public release
(`.github/public-workflows/release.yml`, tag `v*`) attaches the same files.

Locally, on the target OS:

```sh
pnpm --filter @hawl/cli run build:sea -- --target win-x64   # or darwin-arm64, linux-x64
pwsh packages/desktop/windows/build.ps1 -Version 0.1.2         # Windows: csc (.NET Framework 4.x) + Inno Setup 6
sh packages/desktop/macos/build.sh 0.1.2                       # macOS: swiftc, sips, iconutil, hdiutil
sh packages/desktop/linux/build.sh                             # Linux: tar
```

## Unsigned for now: what users see

- **Windows SmartScreen**: "Windows protected your PC" on first run of the setup. Click
  **More info**, then **Run anyway**. Chrome and Edge may also say the download "isn't commonly
  downloaded"; choose **Keep**.
- **macOS Gatekeeper**: the app is ad-hoc signed, not notarized, so the first open says Apple
  can't verify it. Open **System Settings > Privacy & Security** and click **Open Anyway** next to
  the Hawl message, then open Hawl again.
- **Linux**: no warning.

## Signing later (needs Aaron: an account and a card)

- **Windows**: Microsoft Artifact Signing (formerly Trusted Signing), Basic plan $9.99/month for
  5,000 signatures. Open to individuals in the USA and Canada and organizations in the EU/UK.
  Needs an Azure subscription, an Artifact Signing account, identity validation and a certificate
  profile. Then CI signs `hawl.exe`, `HawlTray.exe` and the setup with `signtool` and the
  Artifact Signing dlib (OIDC from GitHub Actions, no key file). Reputation with SmartScreen still
  builds up over downloads.
- **macOS**: Apple Developer Program, $99/year. Needs a Developer ID Application certificate
  (exported as a CI secret) and an App Store Connect API key for `notarytool`. Then CI signs with
  the hardened runtime, notarizes the dmg and staples the ticket, and Gatekeeper opens it without
  a prompt.

Sources (fetched 2026-10-13): azure.microsoft.com/products/artifact-signing,
developer.apple.com/programs.
