# Roblox Explorer: application and API integration specification

Status: approved  
Last verified: 2026-09-04
Working title: **Roblox Explorer**

## 1. Purpose

Build a cross-platform Electron desktop application that can browse Roblox experiences without loading `roblox.com`, then hand a selected experience or server to the installed Roblox Player through the operating system's `roblox:` protocol handler.

The application should provide:

- experience search;
- experience details, icons, and media;
- public-server listing and exact-server joins;
- joining a private server from a link/access code supplied by the user or a listed private-server row;
- listing and managing the signed-in user's private servers when a Roblox web session can be established;
- clear diagnostics when an API host, authentication surface, or Roblox Player is unavailable.

This is a navigation client, not a replacement game runtime, modified Roblox client, or mechanism for bypassing access controls. Roblox Player remains responsible for authentication, eligibility, parental controls, moderation restrictions, and admission to a server.

## 2. Critical feasibility finding

The requested features do not all use the same authentication system.

| Capability                                            | Feasible without login? | API status                  | Notes                                                                                    |
| ----------------------------------------------------- | ----------------------- | --------------------------- | ---------------------------------------------------------------------------------------- |
| Search experiences                                    | Yes                     | Undocumented Roblox web API | Works anonymously today, but may change without notice.                                  |
| Experience metadata                                   | Yes                     | Documented legacy web API   | Uses universe IDs; no cookie required.                                                   |
| Icons and thumbnails                                  | Yes                     | Documented legacy web API   | No cookie required.                                                                      |
| List public live servers                              | Yes                     | Documented legacy web API   | Uses a **place ID**, not a universe ID.                                                  |
| Join an experience or exact public server             | Yes                     | Roblox deep link            | Roblox Player applies the user's own session and access rules.                           |
| Join a private server from an existing code           | Yes, in principle       | Roblox deep link            | The user must already possess a valid `linkCode` or `accessCode`.                        |
| Join a listed private server without exposing a code  | Best effort             | Player-style deep link      | Roblox Player applies the signed-in account's server permissions and may deny admission. |
| List online friends and their presence                 | No                      | Friends/presence cookie APIs | Requires an authenticated Roblox session; exact server IDs may be withheld by privacy.  |
| List private servers accessible to the user           | No                      | Legacy cookie API           | Requires an authenticated `.ROBLOSECURITY` web session.                                  |
| Create, rename, configure, or cancel a private server | No                      | Legacy cookie API           | Requires the cookie and CSRF handling; some actions may also require Robux/confirmation. |

Roblox's Open Cloud guidance says to prefer API-key or OAuth endpoints because legacy cookie APIs have weaker stability guarantees. However, the currently documented private-server endpoints are cookie-authenticated. Roblox OAuth/OIDC can identify a user and authorize supported Open Cloud resources, but it does **not** turn into a browser cookie and currently does not cover these player private-server operations. See [Roblox Open Cloud](https://create.roblox.com/docs/cloud), [OAuth 2.0 authentication](https://create.roblox.com/docs/cloud/auth/oauth2-reference), and [private-server endpoints](https://create.roblox.com/docs/cloud/reference/features/private-servers).

Consequences:

1. The anonymous browsing and launch client is viable even when `www.roblox.com` is blocked.
2. Private-server joins are viable if the user already has a code/link, or if an authenticated private-server list row supplies enough context for a Player-style handoff.
3. “My private servers” and management require a separate authenticated web-cookie session. Electron cannot safely or portably extract the installed Roblox Player's session.
4. If every Roblox login/consent web surface is blocked and Electron has no existing valid Roblox cookie, authenticated private-server listing and management are unavailable. The UI must say this rather than silently falling back to credential or cookie scraping.

## 3. Scope

### 3.1 Single target release

- Anonymous experience search with pagination.
- Experience details and icon/thumbnail display.
- Public-server list with occupancy, approximate ping, FPS, refresh, and cursor pagination.
- Join default matchmaking.
- Join a selected public server by job/instance ID.
- Parse and locally save private-server links/codes, then join them.
- Sign in using a dedicated, isolated Electron browser session that loads only official Roblox HTTPS origins.
- List private servers available for a selected place and servers owned by the current user.
- Show private-server metadata and subscription state.
- Keep accessible rows join-only; expose access and subscription controls only for servers returned by the signed-in user's own-server list.
- Create a private server for the selected experience only after explicit purchase confirmation.
- Sign out by clearing the dedicated session partition.
- Host-by-host connectivity diagnostics.
- Local favorites and recent history.
- An authenticated Home rail for online friends and their current experiences, with exact-session joins, manual refresh, and a ten-second default polling interval.
- Local development and runtime support on Windows and macOS; Linux remains browse-only/best effort because Roblox Player has no official native Linux support.

All of these capabilities belong to one implementation and acceptance phase. They may be built as parallel workstreams, but private-server management is not deferred to a later release.

### 3.1.1 Renderer navigation and surfaces

The local renderer uses hash routes so navigation never leaves the app protocol:

| Route | Purpose |
| --- | --- |
| `#/home` | Recently played, favorites, and top charts rails. |
| `#/search?q={text}` | Paginated experience search results. |
| `#/experience/{universeId}` | Experience details, inline joinable private servers, and public servers. |

The brand mark and Home control are always visible. Experience cards use a
thumbnail tile with a gradient overlay, capped description, and Details/Play
actions. Settings, code-based private joins, and owner private-server tools are
native Electron `<dialog>` popouts; joinable rows stay inline on the details
page and no Roblox web page is embedded in the app renderer. On an
authenticated details route, accessible and owned private-server lists are
fetched automatically; the owned list is presented in the owner-tools popout.

### 3.2 Feasibility gate inside the target release

The authenticated workstream starts with a time-boxed feasibility checkpoint confirming that the user's network can reach the necessary official login pages and that Roblox permits this flow. This checkpoint is part of the same phase, not a separate release. If it fails, the project has a documented external blocker: there is no supported substitute for the cookie-authenticated private-server endpoints. The app must not ask the user to paste `.ROBLOSECURITY`, collect a Roblox password in app-owned HTML, automate MFA/CAPTCHA, or read another browser's/player's cookie database.

### 3.3 Non-goals

- Rendering `roblox.com` as the main application UI.
- Reimplementing Roblox matchmaking or admission checks.
- Installing, patching, launching an executable directly, or modifying Roblox Player.
- Circumventing bans, age/region restrictions, privacy settings, paid access, or private-server permissions.
- Automating Robux purchases; private-server creation or subscription changes that spend Robux require explicit confirmation and remain disabled until their current request contract is verified.
- Installers, app-store submission, public distribution, auto-update infrastructure, code-signing, and notarization for this project phase.
- Scraping HTML pages when a JSON endpoint exists.

## 4. Identifier model

Roblox uses several identifiers that must remain distinct in the domain model:

| Name                       | Type                                               | Used for                                                                                                     |
| -------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `universeId`               | integer represented as a decimal string internally | An experience as a whole; details, icons, votes, recommendations, and private-server creation/configuration. |
| `rootPlaceId` / `placeId`  | integer represented as a decimal string internally | A playable place; server listing and launch.                                                                 |
| `jobId` / `gameInstanceId` | UUID-like string                                   | One running public server process.                                                                           |
| `vipServerId`              | integer represented as a decimal string internally | A persistent private-server configuration/subscription.                                                      |
| `privateServerId`           | UUID-like string                                   | Stable private-server identity used by the Player-style list handoff when the API exposes it.                 |
| `accessCode`               | opaque string                                      | Private/reserved-server admission via deep link. Treat as a secret.                                          |
| `linkCode`                 | opaque string                                      | Shareable private-server link code. Treat as sensitive.                                                      |

Although current JavaScript can exactly represent many Roblox IDs, store and validate every numeric ID as a decimal string at application boundaries to avoid future `Number.MAX_SAFE_INTEGER` problems.

## 5. Roblox API inventory

All network calls originate in the Electron main process. The renderer never receives cookies, OAuth tokens, CSRF tokens, or unrestricted URLs.

### 5.1 Experience search

```http
GET https://apis.roblox.com/search-api/omni-search
    ?searchQuery={url-encoded text}
    &sessionId={UUID}
    &pageType=all
    [&pageToken={opaque nextPageToken}]
```

Relevant response fields observed on 2026-09-03:

- top level: `searchResults`, `nextPageToken`, `filteredSearchQuery`, `paginationMethod`;
- game content: `universeId`, `rootPlaceId`, `name`, `description`, `playerCount`, votes, creator fields, maturity fields, and `canonicalUrlPath`.

Generate one random `sessionId` for a continuous search interaction; reset it when the query changes. Treat the page token as opaque. Flatten only entries whose `contentGroupType`/`contentType` identifies a game, deduplicate by `universeId`, and tolerate unknown groups and missing fields.

This endpoint was announced by Roblox as the replacement search route, but is absent from the stable Open Cloud reference. It is therefore an adapter behind a feature flag, with contract fixtures and an “API changed” error. Roblox's announcement also replaced the former games sorts/list endpoints with `explore-api`; do not use the deprecated `/v1/games/list` route. Source: [Roblox endpoint deprecation announcement](https://devforum.roblox.com/t/official-list-of-deprecated-web-endpoints/62889/59).

Optional follow-up discovery/charts:

```http
GET https://apis.roblox.com/explore-api/v1/get-sorts
    ?device=computer&country=all&sessionId={UUID}
GET https://apis.roblox.com/explore-api/v1/get-sort-content
    ?device=computer&country=all&sessionId={UUID}&sortId={opaque}
```

These routes carry the same undocumented/compatibility risk as search. A live
`curl` probe on 2026-09-04 found that `get-sorts` returned only the
`filters_v5` descriptor (with a continuation token), while
`get-sort-content?sortId=top-playing-now` returned a `Games` descriptor with no
`content`, `contents`, `games`, or `gameSet` rows. The deprecated
`games.roblox.com/v1/games/sorts` and `/v1/games/list` routes returned HTTP 404.
An empty array in this situation therefore means “the response has no game
rows,” not “the adapter rejected every game.”

The renderer treats discovery as a best-effort home rail. The main process:

1. creates one short-lived session ID;
2. follows `nextSortsPageToken` as `sortsPageToken` for a bounded number of
   catalogue pages;
3. recursively normalizes every observed row shape, including entries that
   have a `universeId` and player count but no `rootPlaceId`, then enriches
   missing roots through the anonymous Games API; and
4. when the official response is a descriptor with no experience rows, uses a
   bounded, read-only [Rolimons game catalog](https://api.rolimons.com/games/v1/gamelist)
   as a compatibility fallback. The fallback is ranked by its reported live
   player count, resolves each root place through Roblox's official
   `universes/v1/places/{placeId}/universe` endpoint, and hydrates the resulting
   universes with the official Games API before sending them to the renderer.

The fallback never receives cookies or secrets and is not treated as an
authoritative Roblox chart contract. Its response is marked
`source: "rolimons-fallback"`; if both sources fail, the rail shows a useful
error while search, details, and direct joins remain available.

### 5.2 Experience details

```http
GET https://games.roblox.com/v1/games?universeIds={comma-separated universe IDs}
```

Use this anonymous endpoint to hydrate a search result or saved item. Important fields include `id`, `rootPlaceId`, `name`, `description`, `creator`, `playing`, `visits`, `maxPlayers`, timestamps, price, private-server availability, favorites, genres, and content restrictions. Batch and deduplicate IDs rather than issuing one request per card. See the [official `games.roblox.com` reference](https://create.roblox.com/docs/cloud/reference/domains/games).

Do not assume a `200` response contains usable metadata: Roblox can return a
`[TITLE UNAVAILABLE]`/`[DESCRIPTION UNAVAILABLE]` record with zero IDs and
`isContentRestricted: true` for an otherwise public experience. Normalize and
discard that placeholder. When the isolated Roblox session is signed in, retry
the same request through its cookie-backed session before using the recent or
search card as a fallback. Recent cards retain their root place ID, so the
search API is also used to recover public metadata when both Games API paths
return the placeholder. Persist the normalized recent DTO (without cookies or
codes) so a temporary API failure does not erase the metadata already seen by
the user.

Optional enrichment:

```http
GET https://games.roblox.com/v1/games/votes?universeIds={ids}
GET https://games.roblox.com/v1/games/{universeId}/favorites/count
GET https://games.roblox.com/v2/games/{universeId}/media
GET https://games.roblox.com/v1/games/multiget-playability-status?universeIds={ids}
```

Playability is user-sensitive when a cookie is present. A launch result from Roblox Player remains authoritative.

### 5.3 Icons and thumbnails

```http
GET https://thumbnails.roblox.com/v1/games/icons
    ?universeIds={comma-separated IDs}
    &returnPolicy=PlaceHolder
    &size=150x150
    &format=Png
    &isCircular=false

GET https://thumbnails.roblox.com/v1/games/{universeId}/thumbnails
    ?countPerUniverse=10
    &defaults=true
    &size=768x432
    &format=Png
    &isCircular=false
```

Accept only returned HTTPS image URLs on `*.rbxcdn.com` (and any specifically documented Roblox CDN host added later). Handle `Pending`, `Blocked`, and placeholder states. Cache images through Chromium's HTTP cache; do not proxy image bytes through renderer IPC. See the [official thumbnail endpoint reference](https://create.roblox.com/docs/cloud/reference/features/thumbnails).

Search and discovery cards are rendered immediately and request thumbnails lazily
through a narrow `get-experience-thumbnails` IPC method. The renderer receives
only validated CDN URLs and falls back to a neutral placeholder when a thumbnail
is pending, blocked, or no longer available.

### 5.4 Public servers

```http
GET https://games.roblox.com/v1/games/{placeId}/servers/Public
    ?sortOrder={Asc|Desc}
    &limit={10|25|50|100}
    [&cursor={opaque nextPageCursor}]
    [&excludeFullGames=true]
```

Expected fields are `previousPageCursor`, `nextPageCursor`, and server entries containing `id` (job ID), `maxPlayers`, `playing`, `fps`, and `ping`. Player identity/token fields may be empty and must not be required. Refresh replaces the current page; cursor navigation must not invent page numbers.

Recommended UI defaults:

- `limit=25`;
- hide full servers on by default, user-toggleable;
- sort least-full first when the API behavior supports it;
- no refresh interval faster than 15 seconds;
- cancel stale requests when the selected place changes.

### 5.5 Private-server joins from a supplied code

No management API call is needed. Parse one of:

- an opaque `linkCode` entered directly;
- an opaque `accessCode` entered directly;
- a Roblox URL containing `privateServerLinkCode`, `linkCode`, or `accessCode`.

Never navigate to the supplied URL. Parse it with the platform URL parser, extract only recognized fields, discard the rest, and construct a new deep link from validated values. Store saved codes only when the user explicitly chooses “Remember”; mask them in the UI and logs.

### 5.6 Authenticated private-server APIs

The official reference currently labels the following as cookie-authenticated legacy endpoints:

```http
GET   https://games.roblox.com/v1/games/{placeId}/private-servers
GET   https://games.roblox.com/v1/private-servers/my-private-servers
GET   https://games.roblox.com/v1/vip-servers/my-private-servers
GET   https://games.roblox.com/v1/vip-servers/{vipServerId}
GET   https://games.roblox.com/v1/private-servers/enabled-in-universe/{universeId}
POST  https://games.roblox.com/v1/games/vip-servers/{universeId}
PATCH https://games.roblox.com/v1/vip-servers/{vipServerId}
PATCH https://games.roblox.com/v1/vip-servers/{vipServerId}/permissions
PATCH https://games.roblox.com/v1/vip-servers/{vipServerId}/subscription
GET   https://games.roblox.com/v1/vip-server/can-invite/{userId}
```

At implementation time, generate/validate request types against Roblox's current published OpenAPI description rather than freezing guessed request bodies in this document. The two “my private servers” routes may represent different generations/shapes; place them behind one repository interface, select the current working route with a contract test, and do not merge results without stable IDs.

For mutating legacy requests:

1. send the request using the dedicated authenticated Electron session;
2. if Roblox returns `403` with `x-csrf-token`, retain that token only in main-process memory for the matching Roblox origin;
3. retry the same idempotent update once with that header and the same cookie jar;
4. never retry a purchase/creation automatically unless an idempotency guarantee is confirmed;
5. surface price and subscription consequences and require an explicit confirmation immediately before any Robux-affecting action.

The app must handle `401` as “session required/expired,” `403` without a CSRF header as an authorization failure, `429` with bounded exponential backoff and jitter, and `5xx` as a retryable service failure. Never log response headers containing cookies or tokens.

### 5.7 Online friends and presence

The Home friends rail is available only after the isolated Roblox session is
authenticated. Resolve the current user, request the online-friends subset,
then resolve presence in bounded batches:

```http
GET  https://users.roblox.com/v1/users/authenticated
POST https://users.roblox.com/v1/users
     { "userIds": [ ...friendIds ] }
GET  https://friends.roblox.com/v1/users/{userId}/friends/online
     ?sortOrder=Asc&limit=100
POST https://presence.roblox.com/v1/presence/users
     { "userIds": [ ...friendIds ] }
```

The online-friends endpoint can return only friend IDs after Roblox's Friends
API response changes, so resolve those IDs through the Users API before
rendering display names and usernames. The User Profile API is a compatibility
fallback when the legacy Users API is unavailable. If both profile lookups are
temporarily unavailable, keep the presence row but use a neutral fallback
name.

The presence response may include `userPresenceType`, `lastLocation`,
`universeId`, `placeId`, `rootPlaceId`, and a running `gameId`. Normalize
these into a renderer-safe friend DTO and enrich the universe IDs through the
anonymous Games API when possible. A friend is joinable only when both a valid
place ID and a valid `gameId` are present; hand that pair to the existing exact
public-server launch path and never fall back to default matchmaking. Presence
privacy and race conditions can remove the game ID, so render the friend but
show the session as unavailable in that case.

Poll only while the Home route is visible, at a default interval of ten
seconds, and provide a user-triggered Refresh button. Do not persist presence,
game IDs, or friend activity beyond the in-memory rail; clear it when the user
signs out. Presence and friend requests use the authenticated session only and
never expose cookies or unrestricted URLs to the renderer.

## 6. Authentication design

### 6.1 Anonymous mode is the default

Most of the app must remain usable without an account. Do not attach a Roblox cookie to endpoints that do not need one. This reduces both account risk and coupling to legacy behavior.

### 6.2 OAuth/OIDC is optional and not the private-server solution

If user identity is useful later, implement Roblox Authorization Code + PKCE as a public desktop client:

- discover endpoints from `https://apis.roblox.com/oauth/.well-known/openid-configuration`;
- use a cryptographically random verifier, S256 challenge, state, and nonce;
- launch authorization only on an official Roblox origin;
- receive the callback on a loopback address or an application-owned custom URI registered with Roblox;
- request only `openid profile` unless a concrete Open Cloud feature needs more;
- exchange and refresh in the main process;
- encrypt refresh tokens with Electron `safeStorage` and never expose them to the renderer.

Roblox currently describes OAuth as beta, access tokens as short-lived, and refresh tokens as rotating. OAuth must be feature-detected and cannot be presented as enabling cookie-only private-server routes.

### 6.3 Legacy web-session mode

If the authenticated private-server spike succeeds, create a separate persistent Electron session partition such as `persist:roblox-auth`. Open a modal `BrowserWindow` restricted to an allowlist of exact official authentication/account hosts. It must use:

```ts
{
  nodeIntegration: false,
  contextIsolation: true,
  sandbox: true,
  webviewTag: false
}
```

Additional rules:

- no preload bridge is attached to the login window;
- deny all new windows, downloads, permissions, non-HTTPS navigation, and navigation outside the allowlist;
- never inspect form fields or transmit credentials through app code;
- API requests use that partition's `net`/session facilities so Chromium owns cookie attachment;
- renderer-facing DTOs are stripped of secrets;
- “Sign out” clears cookies, storage, cache, CSRF memory, and private cached data for that partition;
- enable Electron cookie encryption where available; note that stable OS-backed cookie/Keychain behavior for a future distributed macOS build will require signing/notarization, which is outside the current phase.

When the target network blocks `www.roblox.com`, the app may support an explicitly configured trusted HTTP(S) or SOCKS proxy for the login window (for example, `ROBLOX_NAVIGATOR_AUTH_PROXY=http://127.0.0.1:8080`, or an equivalent Settings control). Electron exposes proxy configuration at the session level rather than per request, so enable it only while the isolated login window is active, detect the authenticated cookie, then switch that session back to direct networking before private-server API calls. Anonymous API traffic should remain direct unless separately configured. A proxy is a connectivity aid, not an authentication bypass, and its use must be disclosed because it can observe connection metadata.

If the required login page is blocked, stop here. Do not add a raw cookie import box as a workaround.

## 7. Player protocol handoff

Roblox documents these deep-link parameters: `placeId`, `gameInstanceId`, `accessCode`, `linkCode`, `userId`, and `launchData`. Direct deep links use the `roblox:` scheme. The deep-link mechanism is deprecated for creating public promotional links in favor of share links, but remains the documented direct-to-app format and supplies the parameters needed here. Source: [Roblox deep links](https://create.roblox.com/docs/production/promotion/deeplinks).

Construct links only from typed internal data:

```text
Default matchmaking:
roblox://experiences/start?placeId={placeId}

Exact public server:
roblox://experiences/start?placeId={placeId}&gameInstanceId={jobId}

Private server by link code:
roblox://experiences/start?placeId={placeId}&linkCode={urlEncodedLinkCode}

Private/reserved server by access code:
roblox://experiences/start?placeId={placeId}&accessCode={urlEncodedAccessCode}
```

Private-server list joins require a usable `linkCode` or `accessCode` from the
list or a follow-up private-server metadata response. A place ID alone is a
public matchmaking selector, so never construct a private join from only a
place ID and never fabricate a `joinAttemptId`. If Roblox withholds the
private-session data (including a `403` metadata response), stop before
`shell.openExternal` and show `PRIVATE_SESSION_UNAVAILABLE`; no public server
may be opened as a fallback. The app must not claim that the selected private
server was joined; it only confirms that the OS accepted a verified private
handoff.

Compatibility fallback: if a Player build does not accept `/experiences/start`, retry only after a fresh user click with the documented legacy direct form `roblox://placeId={placeId}&...`. Keep formats in a versioned `LaunchUriBuilder`, covered by tests. Do not use the lower-level `roblox-player:` ticket protocol; it would require browser authentication tickets, exposes more sensitive material, and is less stable.

The main process performs the handoff with Electron's `shell.openExternal()` after strict validation. Electron warns that opening attacker-controlled protocols can compromise a host, so the renderer sends a typed join intent—not a URL—and the main process creates the final string. See [Electron `shell.openExternal`](https://www.electronjs.org/docs/latest/api/shell/) and [Electron security guidance](https://www.electronjs.org/docs/latest/tutorial/security).

Validation:

- `placeId`: `/^[1-9][0-9]{0,19}$/`;
- `jobId`: canonical UUID syntax, unless future observed API contracts document another form;
- code: bounded length, no control characters, encoded with `URLSearchParams`;
- scheme and host/path are constants, not renderer input;
- join must follow a visible user gesture and show the target experience/server;
- redact codes from telemetry and error reports.

`shell.openExternal()` returning successfully means the OS accepted the URI, not that Roblox Player launched or admitted the user. Show “Sent to Roblox Player,” then offer troubleshooting rather than claiming “Joined.”

## 8. Electron architecture

Recommended stack:

- current supported Electron release;
- Electron Forge + Vite;
- TypeScript in strict mode;
- React for the renderer;
- a runtime schema validator such as Zod for API and IPC boundaries;
- native-dependency-free local persistence for the target release (small JSON/state store plus Chromium cache).

Avoiding native Node modules keeps Windows/macOS/Linux packaging simpler. Add SQLite only when the data volume justifies per-platform native builds.

```text
Sandboxed renderer (local packaged UI)
        |
        | narrow, typed contextBridge calls
        v
Preload bridge
        |
        | validated ipcRenderer.invoke
        v
Electron main process
  - IPC controllers
  - Roblox API adapters
  - request scheduler/cache
  - auth/session owner
  - LaunchUriBuilder
  - shell.openExternal
        |
        +--> official Roblox JSON APIs / CDN (HTTPS only)
        +--> OS roblox: protocol --> installed Roblox Player
```

### 8.1 Renderer

The renderer is entirely local and has no Node.js integration. It owns presentation state only: route, filters, selection, optimistic loading indicators, and accessible interaction. It cannot issue arbitrary network requests or open arbitrary URLs.

Primary routes:

- `/search?q=`: search results and cursor loading;
- `/experience/:universeId`: overview plus media;
- `/experience/:universeId/servers`: public/private tabs;
- `/private-servers`: saved codes and, when authenticated, join-only accessible servers plus selected-experience owner tools;
- `/settings`: connectivity, auth state, cache, and diagnostics.

### 8.2 Preload bridge

Expose one method per operation, never raw `ipcRenderer`:

```ts
interface RobloxNavigatorBridge {
  searchExperiences(input: SearchInput): Promise<SearchPage>;
  getExperience(universeId: Id): Promise<ExperienceDetails>;
  listOnlineFriends(input?: { cache?: boolean }): Promise<OnlineFriendPage>;
  listPublicServers(input: PublicServerInput): Promise<ServerPage>;
  join(input: JoinIntent): Promise<LaunchReceipt>;
  parsePrivateServerLink(input: string): Promise<ParsedPrivateJoin>;
  getAuthStatus(): Promise<AuthStatus>;
  onAuthStateChanged(listener: (status: AuthStatus) => void): () => void;
  beginLegacySignIn(): Promise<AuthStatus>;
  signOut(): Promise<void>;
  listPrivateServers(input: PrivateServerInput): Promise<PrivateServerPage>;
  updatePrivateServer(input: PrivateServerUpdate): Promise<PrivateServer>;
  runConnectivityCheck(): Promise<ConnectivityReport>;
}
```

Validate arguments in preload for early feedback and again in main before privileged work. Validate the IPC sender/frame against the packaged application origin. Electron explicitly recommends context isolation, sandboxing, narrow bridges, and sender validation; see [context isolation](https://www.electronjs.org/docs/latest/tutorial/context-isolation) and [IPC guidance](https://www.electronjs.org/docs/latest/tutorial/ipc).

### 8.3 Main-process API layer

Use interfaces so unstable endpoints can be replaced:

```ts
interface ExperienceSearchProvider {
  search(input: SearchInput): Promise<SearchPage>;
}
interface ExperienceRepository {
  getMany(ids: Id[]): Promise<ExperienceDetails[]>;
}
interface ServerRepository {
  listPublic(input: PublicServerInput): Promise<ServerPage>;
  listPrivate(input: PrivateServerInput): Promise<PrivateServerPage>;
  updatePrivate(input: PrivateServerUpdate): Promise<PrivateServer>;
}
interface FriendsRepository {
  listOnline(): Promise<OnlineFriendPage>;
}
interface PlayerLauncher {
  launch(intent: JoinIntent): Promise<LaunchReceipt>;
}
```

Every adapter must have:

- an exact hostname/path allowlist;
- request and response runtime schemas that preserve unknown fields but reject missing identity fields;
- a timeout (10 seconds metadata/search, 15 seconds media/private mutations);
- cancellation through `AbortController`;
- coalescing for identical in-flight reads;
- bounded retry only for `429`/transient network/`5xx` failures;
- per-host rate limiting and a short-lived cache;
- a sanitized structured error mapping.

Suggested cache TTLs: search 60 seconds, experience details 5 minutes, thumbnails through HTTP cache, public servers 10 seconds, private server lists 30 seconds, and no caching of mutation responses beyond updating the local query cache.

## 9. Network and content security

Allow outbound HTTPS only to the minimum required hosts:

- `apis.roblox.com`;
- `users.roblox.com`;
- `friends.roblox.com`;
- `presence.roblox.com`;
- `games.roblox.com`;
- `api.rolimons.com` (read-only chart fallback only);
- `thumbnails.roblox.com`;
- returned Roblox CDN hosts explicitly matched as subdomains of `rbxcdn.com`;
- exact OAuth/login hosts only while their corresponding feature is active.

Renderer policy:

- `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`;
- restrictive CSP, starting with `default-src 'self'; script-src 'self'; connect-src 'none'; img-src 'self' https://*.rbxcdn.com data:; object-src 'none'; frame-src 'none'; base-uri 'none'`;
- no `<webview>`, remote module, remote code, `eval`, inline script, or arbitrary iframe;
- deny unexpected navigation, window creation, downloads, and permission requests;
- use a privileged custom app protocol for packaged assets rather than granting remote content local-file privileges;
- enable appropriate Electron fuses and cookie encryption for production packages.

Render all Roblox names/descriptions as text, never HTML. Treat API content, URLs, link codes, image URLs, and cursor tokens as untrusted input.

## 10. Connectivity and failure UX

The user's block may be hostname-, DNS-, TLS-, HTTP-, or application-layer specific. On first run and from Settings, test these independently with small read-only requests:

| Host/capability         | Test                                           | User-facing consequence                                   |
| ----------------------- | ---------------------------------------------- | --------------------------------------------------------- |
| `apis.roblox.com`       | benign search query or endpoint health request | Search unavailable if blocked.                            |
| `games.roblox.com`      | known public metadata request                  | Details and server lists unavailable if blocked.          |
| `thumbnails.roblox.com` | known icon request                             | Text-only cards if blocked.                               |
| Roblox auth origin      | only when user chooses sign in                 | Private-server management unavailable if blocked.         |
| `roblox:` OS handler    | user-triggered test launch only                | Browse works, Play buttons disabled/explained if missing. |

Do not probe `roblox.com` repeatedly. Report failures separately: DNS resolution, connection timeout, TLS failure, HTTP status, schema mismatch, unauthenticated, rate-limited, and protocol handler rejected. Include a copyable sanitized diagnostic report with app/OS versions and host-level results, but no query history, cookies, codes, or tokens.

## 11. Data and privacy

Persist locally:

- local favorites and recent experience metadata (IDs, display fields, and
  counts; never cookies or secrets);
- search/display preferences;
- remembered private-server entries only after explicit opt-in, encrypted where `safeStorage` is available;
- anonymous cache entries with expiry;
- authentication mode/status, not raw secrets in renderer-readable state.

Do not persist:

- CSRF tokens;
- browser cookies outside Electron's encrypted session store;
- unmasked access/link codes in logs;
- Roblox credentials;
- public-server job IDs after their short usefulness window unless needed for a recent-action display.

Provide “Clear browsing data,” “Forget saved private servers,” and “Sign out and clear Roblox session” as separate controls with precise effects.

## 12. Cross-platform behavior

| OS                                  | Browse    | Player handoff                                   | Packaging notes                                                                                                       |
| ----------------------------------- | --------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| Windows 10/11                       | Supported | Supported when Roblox Player registers `roblox:` | Local unsigned NSIS build; signing and Store distribution remain out of scope.                                         |
| macOS supported by current Electron | Supported | Supported when Roblox Player registers `roblox:` | Local unsigned DMG build; persistent Keychain/cookie behavior may vary until a future build is signed/notarized.      |
| Linux                               | Supported | Best effort only                                 | Local AppImage/deb build; Roblox Player has no official native Linux support.                                         |

Build x64 and arm64 where both Electron and Roblox Player support the combination. The UI must not equate Electron platform support with Roblox Player platform support.

The npm build scripts invoke `dotenv-cli` before starting the repository's
`scripts/build.js` wrapper. The wrapper only resolves and runs electron-builder
with `electron-builder.config.js`; it does not load dotenv itself. `npm run build:mac`,
`npm run build:win`, and `npm run build:linux` select one target;
`npm run build:all` requests all three, and `npm run build` selects the current
host. The configuration validates `ROBLOX_NAVIGATOR_AUTH_PROXY` and writes only
the normalized, non-secret endpoint to the packaged `package.json` under
`robloxExplorerDefaults.authProxy`. The runtime reads that metadata as a
packaged fallback. A saved Settings value (including an explicit empty value to
force the system proxy) takes precedence, followed by an explicitly supplied
process environment variable. The selected environment file itself is never
copied into packaged artifacts and must contain no other secrets.

## 13. Testing strategy

### Unit tests

- all identifier and DTO schemas;
- search-result flattening/deduplication;
- cursor preservation;
- private-link parsing with malicious and malformed inputs;
- launch URI construction and percent encoding;
- HTTP error mapping, retry rules, and secret redaction;
- CSRF single-retry behavior.

### Contract tests

Nightly or manually triggered read-only checks against anonymous endpoints:

- search returns at least one parseable game for a stable query;
- details map universe to root place;
- icon response accepts completed/placeholder states;
- public server page accepts empty and populated data;
- response-schema drift produces an actionable failure.

Authenticated contract tests use a dedicated test account and run only in a protected environment. They must not create/cancel a subscription automatically.

### Electron integration tests

- renderer cannot access Node globals;
- arbitrary IPC channel names and malformed payloads are rejected;
- navigation/window/permission policies deny unexpected origins;
- renderer-provided URLs cannot reach `shell.openExternal`;
- a mocked protocol handler receives the expected URI on Windows and macOS;
- clearing auth removes the dedicated partition data.

### Manual acceptance tests

1. With `www.roblox.com` blocked but API hosts reachable, search, details, icons, and public servers work.
2. Selecting Play sends a valid deep link without opening a Roblox web page.
3. Selecting a public server sends its job ID and place ID.
4. Pasting a valid private-server link extracts and joins by code without navigating to the pasted link.
5. Missing Player registration produces a useful diagnostic rather than an unhandled error.
6. A `401`, `429`, API schema change, and offline state each render a distinct recoverable error.
7. When login is reachable, the user can sign in through official Roblox content, the sign-in window closes after authentication, renderer auth state refreshes automatically, private servers can be listed, a non-purchase setting can be updated, and the user can sign out without exposing session secrets to the renderer.
8. When login is not reachable, private-server management is disabled with an honest external-blocker explanation; anonymous browsing and code-based private joins continue to work.
9. A private-server row without a resolvable private-session selector produces `PRIVATE_SESSION_UNAVAILABLE` and never hands a place-only matchmaking URI to Roblox Player.
10. When signed in, Home shows online friends, refreshes their presence every ten seconds by default, supports manual refresh, and only joins a friend when an exact place/job pair is present.

## 14. Single-phase delivery plan

The project has one target phase with four coordinated workstreams. Workstream ordering below describes dependency checkpoints, not separate releases; the phase is complete only when the combined exit criteria pass.

### Workstream A: feasibility and contracts

1. **Network matrix:** test the target environment against each required hostname, including whether Roblox's login origin is reachable in an isolated Electron session.
2. **Launch matrix:** validate default, exact-public, `linkCode`, and `accessCode` handoffs against currently installed Roblox Player builds on Windows and macOS.
3. **Private-server contract:** identify the canonical current-user route and validate read/update request and response shapes against Roblox's current reference/OpenAPI behavior.

Record sanitized fixtures and results immediately so the other workstreams can proceed against stable adapters. A failed login/network check is an external blocker for account-backed management, not a reason to silently reduce the phase's promised scope.

### Workstream B: application foundation and public navigation

- Electron shell and security baseline;
- typed IPC bridge and runtime schemas;
- search adapter, experience details, icons, and media;
- public-server listing and cursor navigation;
- default and exact-public launch;
- connectivity screen, caching, and sanitized diagnostics.

### Workstream C: private joins and local library

- strict Roblox link parser;
- private `linkCode`/`accessCode` launches;
- encrypted remembered entries;
- local favorites and recents.

### Workstream D: authenticated private-server management

- isolated official login window and session lifecycle;
- current-user/session verification;
- private-server lists by place and owner;
- metadata and subscription display;
- permissions and subscription controls for owned servers, plus explicitly confirmed creation where enabled;
- CSRF negotiation, session expiry, and sign-out/clear-data handling;
- explicit confirmation for subscription or Robux-affecting actions;
- kill switch/feature flag for legacy API drift.

### Combined exit criteria

The single phase is complete when:

1. all manual acceptance tests in section 13 pass on the target Windows and macOS development machines;
2. anonymous browsing and all supported protocol handoffs work when `www.roblox.com` is blocked but the required API hosts are reachable;
3. the isolated login flow can establish and clear a Roblox web session without app-owned credential handling;
4. private servers can be listed and non-purchase management operations pass contract and integration tests;
5. any subscription/Robux-affecting operation shows its consequences, requires immediate confirmation, and is never automatically retried;
6. endpoint drift, expired authentication, a missing Player handler, and partial host blocking each produce an actionable error;
7. unit, contract, Electron security, and secret-redaction tests pass.

Local unsigned installers are included in this phase. Signing, notarization, app-store submission, auto-update, and public distribution are explicitly outside it.

## 15. Decisions and open questions

Decisions made by this specification:

- anonymous-first architecture;
- direct `roblox:` handoff, never web launch or low-level authentication tickets;
- network/auth/launch privileges remain in the Electron main process;
- no raw cookie import or credential collection;
- undocumented search is isolated behind an adapter and feature flag;
- no promise that private-server management works when Roblox login surfaces are blocked.

Questions the feasibility workstream must answer:

1. Which exact domains are blocked in the target environment: only `www.roblox.com`, all `*.roblox.com`, or selected hosts?
2. Does the currently installed Player accept both modern and legacy direct-link shapes for all four join modes?
3. Which current “my private servers” route and response shape should be canonical?
4. Can a dedicated official Roblox login window complete login, MFA, and consent on the target network without app automation?

Any future public-distribution phase must separately review Roblox's current terms and platform rules for a desktop client using legacy cookie endpoints; technical accessibility is not the same as supported third-party use.

## 16. Reference links

- [Roblox Cloud API overview and stability guidance](https://create.roblox.com/docs/cloud)
- [Roblox games domain API reference](https://create.roblox.com/docs/cloud/reference/domains/games)
- [Roblox private-server API reference](https://create.roblox.com/docs/cloud/reference/features/private-servers)
- [Roblox thumbnail API reference](https://create.roblox.com/docs/cloud/reference/features/thumbnails)
- [Roblox OAuth overview](https://create.roblox.com/docs/cloud/auth/oauth2-overview)
- [Roblox OAuth endpoint reference](https://create.roblox.com/docs/cloud/auth/oauth2-reference)
- [Roblox deep-link reference](https://create.roblox.com/docs/production/promotion/deeplinks)
- [Roblox search/explore replacement announcement](https://devforum.roblox.com/t/official-list-of-deprecated-web-endpoints/62889/59)
- [Electron security checklist](https://www.electronjs.org/docs/latest/tutorial/security)
- [Electron context isolation](https://www.electronjs.org/docs/latest/tutorial/context-isolation)
- [Electron process sandboxing](https://www.electronjs.org/docs/latest/tutorial/sandbox)
- [Electron IPC](https://www.electronjs.org/docs/latest/tutorial/ipc)
- [Electron shell API](https://www.electronjs.org/docs/latest/api/shell/)
- [Electron code-signing considerations](https://www.electronjs.org/docs/latest/tutorial/code-signing)
