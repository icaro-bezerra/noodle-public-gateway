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
- Reads of archived, hidden, locked or trashed assets are refused (`visibility=archive|hidden|locked`, `isTrashed`,
  `isArchived`, `withDeleted`, `trashedAfter|Before`, in the query or a search body): what the owner put away is
  not part of the gallery.
- Web pages are forwarded for `GET`/`HEAD`; login, admin, settings and the owner's private or management areas
  (`/archive`, `/trash`, `/locked`, `/utilities`, `/import`, `/sharing`…) redirect to `/`.
- Server `Set-Cookie` headers are dropped; web pages get `immich_is_authenticated=true` so the app skips its login
  redirect.
- The websocket is proxied with the gallery's key.

## How the web app stays read-only

- `/api/users/me` answers with a stable fake user id per gallery (and `public@<host>` as email). The web app shows
  edit, delete, share and face-naming controls only when `asset.ownerId === currentUser.id`, so every asset renders
  read-only. Requests that send the fake id back (e.g. `/api/timeline/buckets?userId=…`) get the real one.
- The app shell gets `<meta name="noodle-public-gallery" content="people map …">`. The web app
  (`web/src/lib/utils/public-gallery.ts`) then hides upload, notifications, the account menu, management links,
  storage info, album creation, person editing, bulk selection and "add to album", and offers downloads only when
  the meta lists `download`.
- Without `downloadOriginal`, full-size image requests are served the preview: the server would otherwise redirect
  them to the original file.

None of this is a security boundary: the gateway's allowlist and the read-only API key are.

## Tests

```sh
pnpm test        # unit and integration tests
pnpm check       # typecheck
pnpm inventory   # regenerate docs/route-classification.{json,md} from the OpenAPI spec
```

`src/policy.spec.ts` reads the OpenAPI spec and fails if the policy forwards any route whose permission is not
read-only, or any non-GET route outside the reviewed list. Run it after every upstream sync.

## End-to-end environment

`e2e/` starts a disposable Noodle and seeds two galleries (one owning photos, an album, a tag and a named face, and
viewing a Shared Space; one for isolation checks):

```sh
cd e2e
NOODLE_VERSION=v5.8.0-rc.1 docker compose -f compose.yml -f compose.web.yml up -d   # web from this checkout
node seed.ts
cd .. && node src/main.ts e2e/gateway.yaml   # then open http://gal1.localhost:28080
```

`compose.web.yml` mounts `web/build`, so build the web app first (`pnpm --filter immich-web build`). Leave it out to
test the image's own web app.

## Privacy

- Every JSON response is scrubbed by field name, so routes added upstream are covered too: `email` is blanked,
  `originalPath` is cut to the file name, `thumbnailPath` is blanked, `canEdit` and `isAdmin` are forced to `false`.
- With `map` off, `latitude`, `longitude`, `city`, `state` and `country` become `null` everywhere (columnar timeline
  arrays keep their length), place groups are dropped from Explore, place suggestions come back empty, and searches
  filtering by place are refused. Thumbnails and previews carry no EXIF (verified).
- People are limited to what the gallery's own people list returns (its visible people plus its Shared Spaces'):
  `/api/people/{id}/**` for any other id is 404, and `/api/faces` drops persons outside that list. This closes a
  server-side exposure where a space member could read another user's private person row and a face crop taken
  from a photo outside the space (`requireThumbnailAccess` in `server/src/services/person.service.ts` only excludes
  locked photos).

### Known limitations

- `downloadOriginal` serves original files with all their embedded metadata, GPS included; the gateway warns at
  startup when it is combined with `map: false`.
- Videos that the server did not transcode are played from the original file, so their embedded metadata (which
  may include location) reaches the visitor. Not yet verified; set the server's transcode policy to "all" if that
  matters for a gallery.
- Names in a Shared Space are whatever the space shows its members; publishing a space publishes those names.
