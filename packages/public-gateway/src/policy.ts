import type { RewriteName } from './rewrite.ts';

export type Feature = 'people' | 'map' | 'smartSearch' | 'downloadOriginal';
export type Features = Record<Feature, boolean>;

export const ALL_FEATURES: Features = { people: true, map: true, smartSearch: true, downloadOriginal: true };

export type Decision =
  | { action: 'forward'; rewrite?: RewriteName }
  /** Answer locally without contacting the server */
  | { action: 'fake'; status: number; body?: unknown }
  | { action: 'redirect'; location: string }
  | { action: 'deny'; status: number };

type Rule = {
  methods: string[];
  /** Route template, `{name}` matches exactly one path segment */
  path: string;
  /** Default: forward */
  respond?: { status: number; body?: unknown };
  feature?: Feature;
  /** Response while `feature` is disabled. Default: 404 */
  whenDisabled?: { status: number; body?: unknown };
  rewrite?: RewriteName;
};

const GET = ['GET', 'HEAD'];
const empty = { status: 200, body: [] };
const noContent = { status: 204 };

/**
 * Every API route the gateway lets through. Anything not listed is denied, so routes added upstream stay blocked
 * until someone reviews them. `src/policy.spec.ts` checks this list against the OpenAPI spec.
 */
const API_RULES: Rule[] = [
  // bootstrap
  ...[
    '/api/server/config',
    '/api/server/features',
    '/api/server/media-types',
    '/api/server/ping',
    '/api/server/version',
    '/api/server/version-history',
    '/api/public/config',
    '/api/public/config/defaults',
    '/api/config',
    '/api/config/defaults',
    '/api/users/me/preferences',
    '/api/users/me/onboarding',
    '/api/users/me/calendar-heatmap',
    '/api/users/{id}/profile-image',
  ].map((path) => ({ methods: GET, path })),
  { methods: GET, path: '/api/users/me', rewrite: 'currentUser' },

  // timeline and assets
  ...[
    '/api/timeline/buckets',
    '/api/timeline/bucket',
    '/api/timeline/bucket-covers',
    '/api/assets/statistics',
    '/api/assets/{id}',
    '/api/assets/{id}/metadata',
    '/api/assets/{id}/metadata/{key}',
    '/api/assets/{id}/ocr',
    '/api/assets/{id}/thumbnail',
    '/api/assets/{id}/video/playback',
    '/api/assets/{id}/video/stream/main.m3u8',
    '/api/assets/{id}/video/stream/{sessionId}/{variantIndex}/playlist.m3u8',
    '/api/assets/{id}/video/stream/{sessionId}/{variantIndex}/{filename}',
    '/api/stacks',
    '/api/stacks/{id}',
    '/api/view/folder',
    '/api/view/folder/unique-paths',
  ].map((path) => ({ methods: GET, path })),
  // ends the visitor's own HLS transcoding session
  { methods: ['DELETE'], path: '/api/assets/{id}/video/stream/{sessionId}' },
  // the UI asks which assets it may edit; "none" makes it hide every edit action
  { methods: ['POST'], path: '/api/assets/editable', respond: empty },

  // albums, tags, memories, activity
  ...[
    '/api/albums',
    '/api/albums/names',
    '/api/albums/statistics',
    '/api/albums/{id}',
    '/api/tags',
    '/api/tags/{id}',
    '/api/memories',
    '/api/memories/statistics',
    '/api/memories/{id}',
    '/api/activities',
    '/api/activities/statistics',
  ].map((path) => ({ methods: GET, path })),

  // search and explore
  ...[
    '/api/search/explore',
    '/api/search/suggestions',
    '/api/search/suggestions/filters',
    '/api/search/suggestions/tags',
  ].map((path) => ({ methods: GET, path })),
  ...['/api/search/metadata', '/api/search/random', '/api/search/large-assets'].map((path) => ({
    methods: ['POST'],
    path,
  })),
  ...['/api/search/smart', '/api/search/smart/facets'].map((path): Rule => ({
    methods: ['POST'],
    path,
    feature: 'smartSearch',
  })),

  // people and faces
  { methods: GET, path: '/api/people', feature: 'people', whenDisabled: { status: 200, body: emptyPeople() } },
  { methods: GET, path: '/api/faces', feature: 'people', whenDisabled: empty, rewrite: 'faces' },
  { methods: GET, path: '/api/search/person', feature: 'people', whenDisabled: empty },
  ...[
    '/api/people/statistics',
    '/api/people/face-statistics',
    '/api/people/users',
    '/api/people/{id}',
    '/api/people/{id}/statistics',
    '/api/people/{id}/thumbnail',
    '/api/people/{id}/faces',
    '/api/people/{id}/faces/{faceId}/thumbnail',
  ].map((path): Rule => ({ methods: GET, path, feature: 'people' })),

  // map
  ...[
    '/api/map/markers',
    '/api/gallery/map/markers',
    '/api/albums/{id}/map-markers',
    '/api/shared-spaces/{id}/map-markers',
  ].map((path): Rule => ({ methods: GET, path, feature: 'map', whenDisabled: empty })),
  { methods: GET, path: '/api/map/reverse-geocode', feature: 'map' },
  ...['/api/search/cities', '/api/search/places'].map((path): Rule => ({
    methods: GET,
    path,
    feature: 'map',
    whenDisabled: empty,
  })),

  // shared spaces
  ...[
    '/api/shared-spaces',
    '/api/shared-spaces/{id}',
    '/api/shared-spaces/{id}/activities',
    '/api/shared-spaces/{id}/album-folders',
    '/api/shared-spaces/{id}/albums',
    '/api/shared-spaces/{id}/albums/{albumId}/timeline-hide-preview',
    '/api/shared-spaces/{id}/members',
    '/api/shared-spaces/{id}/timeline-hide-preview',
  ].map((path) => ({ methods: GET, path })),
  { methods: ['POST'], path: '/api/shared-spaces/{id}/assets/linked-albums' },
  ...[
    '/api/shared-spaces/{id}/assets/{assetId}/faces',
    '/api/shared-spaces/{id}/people',
    '/api/shared-spaces/{id}/people/statistics',
    '/api/shared-spaces/{id}/people/face-statistics',
    '/api/shared-spaces/{id}/people/{personId}',
    '/api/shared-spaces/{id}/people/{personId}/assets',
    '/api/shared-spaces/{id}/people/{personId}/faces',
    '/api/shared-spaces/{id}/people/{personId}/faces/{faceId}/thumbnail',
    '/api/shared-spaces/{id}/people/{personId}/statistics',
    '/api/shared-spaces/{id}/people/{personId}/thumbnail',
  ].map((path): Rule => ({ methods: GET, path, feature: 'people' })),

  // downloads
  { methods: GET, path: '/api/assets/{id}/original', feature: 'downloadOriginal' },
  { methods: ['POST'], path: '/api/download/info', feature: 'downloadOriginal' },
  { methods: ['POST'], path: '/api/download/archive', feature: 'downloadOriginal' },

  // Writes the UI fires on its own. Every visitor shares one user, so these must never reach the server:
  // one visitor's favorite or person alias would show up for everyone.
  ...[
    { methods: ['PUT'], path: '/api/assets/favorites' },
    { methods: ['PUT'], path: '/api/memories/{id}' },
    { methods: ['PUT'], path: '/api/users/me/preferences' },
    { methods: ['PUT'], path: '/api/users/me/onboarding' },
    { methods: ['PUT', 'DELETE'], path: '/api/shared-spaces/{id}/people/{personId}/alias' },
    { methods: ['PATCH'], path: '/api/shared-spaces/{id}/members/me/preferences' },
    { methods: ['PATCH'], path: '/api/shared-spaces/{id}/members/me/timeline' },
    { methods: ['PATCH'], path: '/api/shared-spaces/{id}/albums/{albumId}/me/timeline' },
    { methods: ['PATCH'], path: '/api/shared-spaces/{id}/view' },
  ].map((rule): Rule => ({ ...rule, respond: noContent })),
  {
    methods: ['POST'],
    path: '/api/auth/logout',
    respond: { status: 200, body: { successful: true, redirectUri: '/' } },
  },
  { methods: GET, path: '/api/notifications', respond: empty },
  // Server details stay private. The web app only reads `licensed` from it, to decide whether to show purchase
  // prompts, which visitors should never see.
  { methods: GET, path: '/api/server/about', respond: { status: 200, body: { licensed: true } } },
  // face suggestions are an owner-only review queue (person.update); the person page asks for them anyway
  { methods: GET, path: '/api/people/{id}/face-suggestions', respond: { status: 200, body: { total: 0, items: [] } } },
];

/** For tests: the route templates the policy knows about */
export const ruleTemplates = () => API_RULES.map(({ methods, path }) => ({ methods, path }));

/** Web app pages a visitor has no business on */
const REDIRECT_PREFIXES = [
  '/auth',
  '/admin',
  '/user-settings',
  // the owner's private areas, and pages that only manage things
  '/archive',
  '/trash',
  '/locked',
  '/utilities',
  '/import',
  '/sharing',
  '/shared-links',
  '/partners',
  '/buy',
  '/workflows',
];

function emptyPeople() {
  return { people: [], total: 0, hidden: 0, hasNextPage: false };
}

type CompiledRule = Rule & { pattern: RegExp };

const compile = (template: string) => {
  const source = template
    .split('/')
    .map((segment) =>
      segment.startsWith('{') && segment.endsWith('}') ? '[^/]+' : segment.replaceAll(/[.*+?^$()|[\]\\]/g, '\\$&'),
    )
    .join('/');
  return new RegExp(`^${source}$`);
};

// Static templates first, so `/api/people/statistics` never resolves as `/api/people/{id}`.
const COMPILED: CompiledRule[] = API_RULES.map((rule) => ({ ...rule, pattern: compile(rule.path) })).sort(
  (a, b) => a.path.split('{').length - b.path.split('{').length,
);

const THUMBNAIL = compile('/api/assets/{id}/thumbnail');

/**
 * Query string to send upstream. Without original downloads, a full-size thumbnail request asks for the preview
 * instead: when no full-size image was generated, the server redirects `size=fullsize` to the original file.
 */
export const upstreamQuery = (path: string, query: string, features: Features): string => {
  if (features.downloadOriginal || !THUMBNAIL.test(path) || !query) {
    return query;
  }
  const params = new URLSearchParams(query.slice(1));
  if (params.get('size') !== 'fullsize') {
    return query;
  }
  params.set('size', 'preview');
  return `?${params}`;
};

// What the owner archived, trashed, hid or locked away is not part of the public gallery.
const PRIVATE_VISIBILITIES = new Set(['archive', 'hidden', 'locked']);
const TRUE_FLAGS = ['isTrashed', 'isArchived', 'withDeleted'];
const TRASH_RANGE = ['trashedAfter', 'trashedBefore'];

/**
 * True when a read asks for assets outside the normal timeline, through query parameters (`/api/timeline/*`,
 * `/api/map/markers`, `/api/memories`…) or a search body (`/api/search/*`).
 */
export const requestsPrivateAssets = (query: string, body?: Buffer): boolean => {
  const params = new URLSearchParams(query.startsWith('?') ? query.slice(1) : query);
  for (const [name, value] of params) {
    if (
      (name === 'visibility' && PRIVATE_VISIBILITIES.has(value.toLowerCase())) ||
      (TRUE_FLAGS.includes(name) && value.toLowerCase() !== 'false') ||
      TRASH_RANGE.includes(name)
    ) {
      return true;
    }
  }
  if (!body?.length) {
    return false;
  }
  let dto: unknown;
  try {
    dto = JSON.parse(body.toString('utf8'));
  } catch {
    // the server would reject it anyway; refusing here keeps the check from being bypassed by odd encodings
    return true;
  }
  if (typeof dto !== 'object' || dto === null || Array.isArray(dto)) {
    return true;
  }
  const fields = dto as Record<string, unknown>;
  return (
    (typeof fields.visibility === 'string' && PRIVATE_VISIBILITIES.has(fields.visibility.toLowerCase())) ||
    TRUE_FLAGS.some((name) => fields[name] !== undefined && fields[name] !== false) ||
    TRASH_RANGE.some((name) => fields[name] !== undefined)
  );
};

const LOCATION_FILTERS = ['city', 'state', 'country'];
const LOCATION_SUGGESTIONS = new Set(['city', 'state', 'country']);

/**
 * With the `map` feature off, location must not leak through search either: filtering by a city would reveal where
 * photos were taken even with every coordinate scrubbed from responses. Suggestions for places are answered empty,
 * searches filtering by place are refused. Returns `undefined` when the request may go through.
 */
export const locationDecision = (
  path: string,
  query: string,
  body: Buffer | undefined,
  features: Features,
): Exclude<Decision, { action: 'forward' }> | undefined => {
  if (features.map) {
    return;
  }
  const params = new URLSearchParams(query.startsWith('?') ? query.slice(1) : query);
  if (path === '/api/search/suggestions' && LOCATION_SUGGESTIONS.has((params.get('type') ?? '').toLowerCase())) {
    return { action: 'fake', status: 200, body: [] };
  }
  if (LOCATION_FILTERS.some((name) => params.has(name))) {
    return { action: 'deny', status: 403 };
  }
  if (body?.length) {
    try {
      const dto = JSON.parse(body.toString('utf8')) as Record<string, unknown>;
      if (LOCATION_FILTERS.some((name) => dto[name] !== undefined && dto[name] !== null)) {
        return { action: 'deny', status: 403 };
      }
    } catch {
      // unparseable bodies are already refused by requestsPrivateAssets
    }
  }
};

// Smart search runs the ML model; the others are heavy database queries or archive builds.
const EXPENSIVE = new Set([
  '/api/search/smart',
  '/api/search/smart/facets',
  '/api/search/metadata',
  '/api/search/random',
  '/api/search/large-assets',
  '/api/download/info',
  '/api/download/archive',
]);

/** Requests that get the stricter `rateLimit.expensive` budget */
export const isExpensive = (method: string, path: string) => method === 'POST' && EXPENSIVE.has(path);

const isUnder = (path: string, prefix: string) => path === prefix || path.startsWith(`${prefix}/`);

/** `path` must already be normalized (see `normalizePath`) and carry no query string */
export const decide = (method: string, path: string, features: Features = ALL_FEATURES): Decision => {
  // Express routes case-insensitively, so `/API/users` reaches the API too. The prefix check ignores case and the
  // rules do not, which denies every non-canonical spelling.
  const lowerPath = path.toLowerCase();
  if (isUnder(lowerPath, '/api')) {
    const rule = COMPILED.find((r) => r.methods.includes(method) && r.pattern.test(path));
    if (!rule) {
      return { action: 'deny', status: 403 };
    }
    if (rule.feature && !features[rule.feature]) {
      return rule.whenDisabled ? { action: 'fake', ...rule.whenDisabled } : { action: 'deny', status: 404 };
    }
    if (rule.respond) {
      return { action: 'fake', ...rule.respond };
    }
    return { action: 'forward', rewrite: rule.rewrite ?? 'json' };
  }

  if (!GET.includes(method)) {
    return { action: 'deny', status: 403 };
  }
  if (REDIRECT_PREFIXES.some((prefix) => isUnder(lowerPath, prefix))) {
    return { action: 'redirect', location: '/' };
  }
  // build assets are immutable files; every other web path may be the app's HTML shell
  const isAsset = isUnder(lowerPath, '/_app') || (path.split('/').at(-1) ?? '').includes('.');
  return isAsset ? { action: 'forward' } : { action: 'forward', rewrite: 'html' };
};
