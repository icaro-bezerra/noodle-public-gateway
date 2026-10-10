# Noodle public gateway

A reverse proxy that serves Noodle users as public, read-only galleries. Each public hostname maps to one dedicated
Noodle user; visitors get the full web app without logging in, and every request that would change something is
blocked before it reaches the server.

The gateway authenticates with a read-only API key of that user, injected server-side, so the browser never sees a
credential. The key's permissions are a second barrier: even a request the gateway let through by mistake could not
write. See [PLAN.md](PLAN.md) for the design and the findings it is based on.

## Running

Requires Node 24 (TypeScript runs directly, no build step).

```sh
pnpm install --filter @immich/public-gateway
node src/main.ts path/to/gateway.yaml   # or GATEWAY_CONFIG=path/to/gateway.yaml
```

See [gateway.example.yaml](gateway.example.yaml) for every option. Point each gallery hostname at the gateway
(subdomains, not path prefixes: the web app must be served from `/`). Keep the normal Noodle hostname pointing at
the server itself for the people who log in.

## Adding a gallery

1. Create a dedicated, non-admin Noodle user and give it the content to publish: its own library, partner sharing,
   or Viewer membership in a Shared Space.
2. Log in once as that user and finish onboarding.
3. Create an API key for that user with only these permissions:
   `asset.read`, `asset.view`, `asset.statistics`, `assetFile.read`, `album.read`, `album.statistics`,
   `person.read`, `person.statistics`, `face.read`, `map.read`, `map.search`, `memory.read`, `memory.statistics`,
   `tag.read`, `stack.read`, `folder.read`, `sharedSpace.read`, `sharedSpaceAsset.read`, `user.read`,
   `userPreference.read`, `userProfileImage.read`, `userConfig.read`, `userOnboarding.read`, `activity.read`,
   `activity.statistics` — and `asset.download` only if `downloadOriginal` is enabled.
4. Save the key to a file, add the gallery to the config and send the gateway `SIGHUP`.

## How requests are handled

- The `Host` header selects the gallery; unknown hosts get 404.
- Client credentials are dropped: only an allowlist of request headers is forwarded, and the `apiKey`, `sessionKey`,
  `key` and `slug` query parameters are removed. A client session would otherwise outrank the injected key.
- Paths containing `..`, `.`, `//`, `\` or encoded `/`, `\`, `.` or NUL are rejected.
- API routes go through an explicit allowlist in [src/policy.ts](src/policy.ts); anything else is 403, so routes
  added upstream stay blocked until reviewed. Writes the UI fires on its own (favorites, person aliases, memory
  "seen", preferences, logout) are answered locally without reaching the server, because every visitor shares one
  user.
- Web pages are forwarded for `GET`/`HEAD`; `/auth`, `/admin` and `/user-settings` redirect to `/`.
- Server `Set-Cookie` headers are dropped; web pages get `immich_is_authenticated=true` so the app skips its login
  redirect.
- The websocket is proxied with the gallery's key.

## Tests

```sh
pnpm test        # unit and integration tests
pnpm check       # typecheck
pnpm inventory   # regenerate docs/route-classification.{json,md} from the OpenAPI spec
```

`src/policy.spec.ts` reads the OpenAPI spec and fails if the policy forwards any route whose permission is not
read-only, or any non-GET route outside the reviewed list. Run it after every upstream sync.

## Not yet done

The UI still shows edit controls (they fail harmlessly), `/api/users/me` exposes the gallery user's email, and GPS
data is not scrubbed when `map` is off. These are phases 3–4 in [PLAN.md](PLAN.md).
