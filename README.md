# Roblox Explorer

Roblox Explorer is a **vibe-coded**, cross-platform Electron client for exploring Roblox experiences and handing launches to the installed Roblox Player. Browsing stays inside a local app UI, so you can search and navigate experiences even when the Roblox website is blocked.

## Explore and play

- Browse recently played and favorited experiences from Home.
- Search experiences by name and open a details page with thumbnails, player counts, and public servers.
- Browse top charts from Roblox's Explore API, with a bounded read-only catalog fallback when Roblox returns chart metadata without game rows.
- Join a public server or an accessible private server through the installed Roblox Player.
- Use the `roblox:` protocol for the final handoff; Roblox Player applies the account's admission and permission rules.

Public browsing, thumbnails, public servers, and code-based joins work without signing in. Experience details first use the anonymous Games API and, when Roblox returns its restricted placeholder response, retry through the isolated signed-in session or resolve a recent card through public search before falling back to saved metadata. The Roblox Player must already be installed and registered for the `roblox:` protocol.

When Roblox's Explore chart endpoint returns only a descriptor, the home rail
uses the read-only Rolimons catalog as a compatibility fallback, then resolves
the entries through Roblox's public universe and Games APIs. No Roblox cookies
or credentials are sent to that catalog.

## Private servers

On an experience details page, **Servers you can join** lists private servers returned for that experience. Select **Join** to hand the request to Roblox Player; it decides whether the signed-in account can enter.

The **Your private servers** popout contains owner-only controls for the selected experience:

- view private servers owned by you;
- edit whether Roblox friends may join;
- add or remove individual Roblox user IDs;
- view subscription state and available management actions.

You can also open **Join link** to parse a Roblox share link, deep link, or access code. Choose **Remember code** to save a code locally; it is encrypted with Electron `safeStorage` when the platform provides it.

Private-server listing and management require signing in through the isolated official Roblox session. If a listed server does not expose a share/access code, its **Join** action still uses the official-style Player handoff and lets Roblox report any permission failure. The app never asks for a Roblox password or `.ROBLOSECURITY` cookie.

Private-server creation and subscription renewal are disabled by default because they may spend Robux. Enable them only after verifying the current authenticated request contract:

```sh
ROBLOX_NAVIGATOR_PRIVATE_PURCHASES=1 npm start
```

If Roblox changes its legacy private-server endpoints, disable authenticated management while keeping anonymous browsing available:

```sh
ROBLOX_NAVIGATOR_PRIVATE_SERVERS=0 npm start
```

## Proxy for blocked Roblox web access

When `www.roblox.com` is blocked but Roblox API hosts remain reachable, configure a trusted proxy for the isolated sign-in window:

```sh
ROBLOX_NAVIGATOR_AUTH_PROXY=http://127.0.0.1:8080 npm start
# or
ROBLOX_NAVIGATOR_AUTH_PROXY=https://proxy.example:8443 npm start
# or
ROBLOX_NAVIGATOR_AUTH_PROXY=socks4://127.0.0.1:1080 npm start
# or
ROBLOX_NAVIGATOR_AUTH_PROXY=socks5://127.0.0.1:1080 npm start
```

The same value can be set or cleared from **Settings → Roblox login proxy**. Leave it empty to use the operating-system proxy.

The proxy is applied only to the isolated Roblox login session while sign-in is in progress, then removed after authentication. Anonymous API requests and private-server API calls remain direct. Use a proxy you trust because it can observe connection metadata. This is a network-reachability workaround, not a way to bypass Roblox account permissions, paid access, moderation, or private-server admission rules.

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

## Support and limitations

- Windows and macOS are the primary development targets.
- Linux browsing is best effort because Roblox Player has no official native Linux client.
- The renderer does not embed Roblox pages or automate passwords, MFA, CAPTCHA, or purchases.
- Installers, signing, notarization, app-store submission, auto-updates, and public distribution are outside this development phase.

See [app-and-api-integration.md](app-and-api-integration.md) for the API contract, Electron integration, security model, and acceptance criteria.
