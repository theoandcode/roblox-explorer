# Roblox Navigator

Roblox Navigator is an Electron desktop client for discovering Roblox experiences and handing selected joins to the installed Roblox Player. Its UI is local and its public browsing APIs run from the Electron main process, so it does not need to render `roblox.com`.

## Run locally

```sh
npm install
npm start
```

Run the verification suite with:

```sh
npm test
npm run check
```

The first launch runs read-only connectivity checks against Roblox API hosts. Search, experience details, thumbnails, public servers, and direct joins are anonymous. The Roblox Player must already be installed and registered for the `roblox:` protocol.

## Private servers

The **Private access** panel accepts a Roblox share/deep link or a link/access code. It can remember codes in the app's local store, encrypted with Electron `safeStorage` when the platform provides it.

The private-server panels are enabled only after sign-in through an isolated official Roblox session. The accessible-server list is join-only; the selected experience's **Owner tools** section loads the signed-in user's own servers and exposes creation, access, and subscription controls only there. Roblox currently exposes these player private-server operations through legacy cookie-authenticated endpoints; OAuth identity does not replace that session. If a listed row does not include a share/access code, its **Join** button still hands off to Roblox Player with the official-style private-list attempt fields; Player decides whether the signed-in account may enter. If the login origin is blocked, anonymous features and code-based private joins remain available, while account management is reported as unavailable. The app never asks for a password or `.ROBLOSECURITY` cookie.

If Roblox changes those legacy endpoints, private-server management can be disabled at launch while anonymous browsing remains available: `ROBLOX_NAVIGATOR_PRIVATE_SERVERS=0 npm start`.

Private-server creation and subscription renewal are intentionally disabled by default because they can spend Robux. Enable them only after verifying the current authenticated contract with `ROBLOX_NAVIGATOR_PRIVATE_PURCHASES=1`.

If `www.roblox.com` is blocked on the current network, the isolated sign-in window can use an explicitly configured HTTP(S) or SOCKS proxy. For example:

```sh
ROBLOX_NAVIGATOR_AUTH_PROXY=http://127.0.0.1:8080 npm start
# or
ROBLOX_NAVIGATOR_AUTH_PROXY=socks5://127.0.0.1:1080 npm start
```

Use only a proxy or VPN you trust; it can observe connection metadata. The proxy is enabled only while the isolated Roblox sign-in window is open and is removed after authentication. If the operating-system proxy/VPN already permits `www.roblox.com`, no environment variable is needed. You can also set or clear this value from **Settings → Roblox login proxy**.

## Support expectations

- Windows and macOS are the primary development targets.
- Linux can browse, but Roblox Player has no official native Linux support, so protocol handoff is best effort.
- Installers, signing, notarization, app-store submission, auto-updates, and public distribution are intentionally not included in this phase.

See [app-and-api-integration.md](app-and-api-integration.md) for the full API contract, security model, delivery plan, and acceptance criteria.
