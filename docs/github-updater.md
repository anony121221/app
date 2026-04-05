# GitHub Updater Release Flow

This app now includes a Tauri updater UI and install flow. GitHub Releases is the update host.

## One-time setup

1. Push this project to GitHub.
2. Add these GitHub Actions secrets in the repository settings:
   - `TAURI_SIGNING_PRIVATE_KEY`
   - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
3. Put the full private key content into `TAURI_SIGNING_PRIVATE_KEY`.
4. If your updater key has no password, leave `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` empty or unset.

## Release flow

1. Bump the app version in [tauri.conf.json](/C:/Users/ctsco/.local/bin/radar-app/src-tauri/tauri.conf.json).
2. Commit and push.
3. Create and push a tag like `v0.1.1`.
4. GitHub Actions runs `.github/workflows/release.yml`.
5. The workflow:
   - writes the repository's GitHub Releases `latest.json` URL into `src-tauri/updater-endpoint.txt`
   - builds the Windows NSIS installer
   - uploads the installer, signatures, and `latest.json` to the GitHub Release

## Important behavior

- The first updater-enabled version must still be installed manually once.
- After that, future tagged releases can be installed from inside the app with the `Install Update` button.
- The app checks `https://github.com/anony121221/app/releases/latest/download/latest.json` at runtime.

## Local helper

If you want to test against a real repository before releasing, use:

```powershell
.\scripts\set-github-updater-endpoint.ps1 -Repo anony121221/app
```
