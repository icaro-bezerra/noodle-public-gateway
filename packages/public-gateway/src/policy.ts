export type Feature = 'people' | 'map' | 'smartSearch' | 'downloadOriginal';
export type Features = Record<Feature, boolean>;

export const ALL_FEATURES: Features = { people: true, map: true, smartSearch: true, downloadOriginal: true };

export type Decision =
  | { action: 'forward' }
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
    '/api/users/me',
    '/api/users/me/preferences',
    '/api/users/me/onboarding',
    '/api/users/me/calendar-heatmap',
    '/api/users/{id}/profile-image',
  ].map((path) => ({ methods: GET, path })),

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
    '/api/search/cities',
    '/api/search/places',
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
  { methods: GET, path: '/api/faces', feature: 'people', whenDisabled: empty },
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
];

/** For tests: the route templates the policy knows about */
export const ruleTemplates = () => API_RULES.map(({ methods, path }) => ({ methods, path }));

/** Web app pages a visitor has no business on */
const REDIRECT_PREFIXES = ['/auth', '/admin', '/user-settings'];

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
    return rule.respond ? { action: 'fake', ...rule.respond } : { action: 'forward' };
  }

  if (!GET.includes(method)) {
    return { action: 'deny', status: 403 };
  }
  if (REDIRECT_PREFIXES.some((prefix) => isUnder(lowerPath, prefix))) {
    return { action: 'redirect', location: '/' };
  }
  return { action: 'forward' };
};
