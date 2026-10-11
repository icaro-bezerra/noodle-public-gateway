# Noodle Public Gateway — plan

A reverse proxy that turns Noodle users into public, read-only galleries. Each public hostname
(`gal-publica1.example.com`, `gal-pub2.example.com`, …) maps to one dedicated Noodle user. Visitors get the
full web UI — timeline, albums, Shared Spaces, people and face recognition, map, explore, search — with no
login, and every attempt to change state is blocked.

## Architecture

```
gal-publica1.example.com ─┐                          ┌─► API key of user 1 (read-only)
gal-pub2.example.com ─────┼─► [public-gateway] ──────┼─► API key of user 2 (read-only)
gal-pubN.example.com ─────┘   (resolved by Host)     └─► ...  ──► gallery-server:2283

photos.example.com ──► gallery-server (normal login, admin)
```

- One gateway container serves every gallery. Unknown `Host` → 404.
- Subdomains, not path prefixes: the SvelteKit web app assumes it is served from `/` and requests `/api/...`
  and `/_app/...` with absolute paths.
- The API key never reaches the browser; the gateway adds `x-api-key` server-side to every request,
  including `<img>` thumbnail requests and the WebSocket upgrade.

## Findings from the Noodle code (verified)

| Finding                                                                                         | Where                                                          | Consequence                                                                                                                   |
| ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| An API key authenticates as its owner, no session needed                                        | `server/src/services/auth.service.ts` `validateApiKey`         | No username/password stored anywhere                                                                                          |
| Key permissions are enforced per route                                                          | `AuthService.authenticate`                                     | A read-only key is a second barrier behind the gateway                                                                        |
| The web only checks that the `immich_is_authenticated` cookie exists                            | `web/src/lib/managers/auth-manager.svelte.ts` `#hasAuthCookie` | Gateway sets this non-secret cookie                                                                                           |
| A session token outranks the API key                                                            | `AuthService.validate`                                         | Gateway must strip client `Cookie`, `Authorization`, `x-immich-*` headers and `sessionKey`/`apiKey`/`key`/`slug` query params |
| `GET /albums/names`, `GET /gallery/map/markers` and the WebSocket required the `all` permission | controllers / `app.module.ts`                                  | **Fixed in this branch** (`album.read`, `map.read`, `asset.read`)                                                             |
| Some writes are guarded only by `*.read` permissions (per-user state)                           | see below                                                      | Gateway must allowlist by method + route, not by permission suffix                                                            |

Per-user writes reachable with read permissions — harmless for a real user, but in a public gallery every
visitor shares one user, so one visitor's action would be seen by all:

- `PUT /api/assets/favorites` (`asset.read`)
- `PUT|DELETE /api/shared-spaces/{id}/people/{personId}/alias` (`sharedSpace.read`)
- `PATCH /api/shared-spaces/{id}/members/me/preferences`, `/members/me/timeline`, `/albums/{albumId}/me/timeline`, `/view` (`sharedSpace.read`)

### Why an API key and not username/password

A session has full power (sessions carry no scope), needs login/refresh handling, and means storing a password.
A read-only API key is revocable, needs no refresh, and lets the server itself reject writes.

## Gateway rules

1. **Resolve gallery** by `Host`; unknown → 404.
2. **Strip client credentials**: `Cookie`, `Authorization`, `x-api-key`, `x-immich-user-token`,
   `x-immich-session-token`, `x-immich-share-key`, `x-immich-share-slug`, client `X-Forwarded-*`,
   `X-HTTP-Method-Override`; query params `apiKey`, `sessionKey`, `key`, `slug`.
3. **Normalize the path** and reject `..`, `//`, `%2f`, `%2e`, `%5c`, NUL.
4. **Allowlist** `(method, route template)`, generated from `docs/route-classification.json`:
   - `GET`/`HEAD` routes classified `read`, minus the sensitive set: `apiKey.read`, `session.read`,
     `sharedLink.read`, `notification.read`, `partner.read`, `syncCheckpoint.read`, `userLicense.read`,
     `workflow.read`, `plugin.read`, `duplicate.read`, `activity.read`.
   - `public` routes needed by the UI (`/api/server/*`, `/api/server-config`…), never `/api/auth/*` or `/api/oauth/*`.
   - Read-only POSTs: `/api/search/metadata|random|smart|smart/facets|large-assets`, `/api/assets/editable`.
   - Static web assets and SvelteKit routes (`GET` only).
5. **Fake success** (204, not forwarded) for writes the UI fires on its own: `PUT /api/memories/{id}`,
   preference/onboarding updates, the per-user writes above, `POST /api/auth/logout`.
6. **Override** `POST /api/assets/editable` → `[]` so the UI hides edit actions natively.
7. **Everything else → 403.** New upstream routes are blocked by default.
8. **Responses**: drop `Set-Cookie`; set `immich_is_authenticated=true` (host-only, no `Domain`); scrub
   `/api/users/me` (email → gallery title); optional GPS scrubbing.
9. **WebSocket** `/api/socket.io/`: forward with injected key. Client frames must pass (Engine.IO heartbeats are
   client → server pongs); they are inert because the server registers no client message handlers.

## Per-gallery config

```yaml
upstream: http://gallery-server:2283
galleries:
  - host: gal-publica1.example.com
    apiKeyFile: /run/secrets/gal1_key
    title: Família Silva
    features: { people: true, map: true, smartSearch: true, downloadOriginal: false }
  - host: gal-pub2.example.com
    apiKeyFile: /run/secrets/gal2_key
    features: { people: false, map: false }
```

A disabled feature returns empty results (not 403), so the UI renders cleanly.

### Creating a gallery

1. Create a dedicated non-admin user; give it content (own library, partner sharing, or Viewer of a Shared Space).
2. Log in once as that user and finish onboarding.
3. Create an API key with read-only permissions (exact list in [README.md](README.md#adding-a-gallery)).
4. Store it as a secret and add the gallery to the config (hot-reloaded).

## Privacy

Face recognition on a public page publishes people's names and faces (biometric data under LGPD/GDPR).
`people` and `map` default to off; hidden people (`isHidden`) stay hidden. Global People was checked: Noodle keeps
upstream's cluster groups unmounted, so there is no cross-library face pooling, but the server lets a space member
read another user's private person row and a face crop from a photo outside the space; the gateway confines
`/api/people/{id}/**` and `/api/faces` to the gallery's own people list. See README.md#privacy.

## Phases

- [x] **0. Route inventory** — `pnpm inventory` → `docs/route-classification.{json,md}`.
- [x] **1. Server patch** — `album.read` on `/albums/names`, `map.read` on `/gallery/map/markers`,
      `asset.read` on the WebSocket; controller tests; OpenAPI spec updated.
- [x] **2. Gateway MVP** — Host routing, key injection, credential stripping, explicit allowlist checked
      against the OpenAPI spec, local answers for UI side-effect writes, websocket, SIGHUP reload. Verified
      against a real Noodle (`e2e/`): the web app loads and shows the timeline without login. The released
      image still rejects `/albums/names` and `/gallery/map/markers` with `Missing required permission: all`,
      which the phase 1 patch fixes.
- [x] **3. Full UI** — every screen walked in a browser through the gateway (`e2e/`, Noodle v5.8.0-rc.1 with the
      web app from this branch): no failed requests except `/api/gallery/map/markers`, which the phase 1 patch fixes.
      Instead of CSS injection (menu items have no stable selectors), the web app got a public-gallery mode driven by
      a `<meta>` tag the gateway injects, and `/api/users/me` returns a fake user id so ownership checks make every
      asset read-only. Archived/hidden/locked/trashed assets are refused; full-size images fall back to the preview
      when originals are private.
- [x] **4. Feature flags & privacy** — field-name scrubbing of every JSON response (emails, server paths,
      `canEdit`, location when `map` is off), place searches gated, previews verified EXIF-free with GPS-tagged
      seeds, people confined to the gallery's own list. Upstream follow-up worth filing: `requireThumbnailAccess`
      should check access to the representative face's asset. Unverified: video originals' embedded location.
- [ ] **5. Hardening** — rate limiting, host-keyed cache, CSP, logging of blocked requests.
- [ ] **6. Adversarial tests** — every `write`/`admin`/`full` route × every gallery must be 403; bypass
      variants; cross-gallery isolation (asset of user 1 is 404 on gallery 2). Run on every upstream sync.
