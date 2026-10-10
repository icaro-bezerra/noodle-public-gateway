import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadInventory } from './inventory.ts';
import { ALL_FEATURES, decide, ruleTemplates, type Features } from './policy.ts';

const SPEC = fileURLToPath(new URL('../../../open-api/immich-openapi-specs.json', import.meta.url));
const inventory = loadInventory(SPEC);

const ID = '00000000-0000-4000-8000-000000000000';
const concrete = (template: string) => template.replaceAll(/\{[^}]+\}/g, ID);
const NO_FEATURES: Features = { people: false, map: false, smartSearch: false, downloadOriginal: false };

describe('policy against the OpenAPI spec', () => {
  it('only references routes that exist', () => {
    const known = new Set(inventory.map((r) => `${r.method} ${r.path}`));
    const missing = ruleTemplates().flatMap(({ methods, path }) =>
      methods.filter((m) => m !== 'HEAD' && !known.has(`${m} ${path}`)).map((m) => `${m} ${path}`),
    );
    expect(missing).toEqual([]);
  });

  it('never forwards a write, admin or full-permission route', () => {
    const leaks = inventory
      .filter((r) => r.class !== 'read' && r.class !== 'public')
      .filter((r) => decide(r.method, concrete(r.path)).action === 'forward')
      .map((r) => `${r.method} ${r.path} (${r.permission ?? r.class})`);
    expect(leaks).toEqual([]);
  });

  it('only forwards reviewed non-GET routes', () => {
    const forwarded = inventory
      .filter((r) => r.method !== 'GET' && decide(r.method, concrete(r.path)).action === 'forward')
      .map((r) => `${r.method} ${r.path}`);
    expect(forwarded.sort()).toEqual([
      'DELETE /api/assets/{id}/video/stream/{sessionId}',
      'POST /api/download/archive',
      'POST /api/download/info',
      'POST /api/search/large-assets',
      'POST /api/search/metadata',
      'POST /api/search/random',
      'POST /api/search/smart',
      'POST /api/search/smart/facets',
      'POST /api/shared-spaces/{id}/assets/linked-albums',
    ]);
  });

  it('never forwards a write that is guarded only by a read permission', () => {
    const forwarded = inventory
      .filter((r) => ['PUT', 'PATCH'].includes(r.method) || (r.method === 'DELETE' && !r.path.includes('/video/')))
      .filter((r) => decide(r.method, concrete(r.path)).action === 'forward');
    expect(forwarded).toEqual([]);
  });

  it('forwards nothing behind a disabled feature', () => {
    const forwarded = inventory
      .filter((r) => /\/(people|faces|map|map-markers|smart|download|original)(\/|$)/.test(r.path))
      .filter((r) => decide(r.method, concrete(r.path), NO_FEATURES).action === 'forward')
      .map((r) => `${r.method} ${r.path}`);
    expect(forwarded).toEqual([]);
  });
});

describe('decide', () => {
  it.each([
    ['GET', '/api/timeline/buckets'],
    ['GET', `/api/assets/${ID}/thumbnail`],
    ['HEAD', `/api/assets/${ID}/thumbnail`],
    ['GET', '/api/people'],
    ['GET', `/api/shared-spaces/${ID}/people`],
    ['POST', '/api/search/metadata'],
    ['GET', '/'],
    ['GET', '/photos'],
    ['GET', '/_app/immutable/entry/start.js'],
  ])('forwards %s %s', (method, path) => {
    expect(decide(method, path)).toEqual({ action: 'forward' });
  });

  it.each([
    ['GET', '/api/api-keys'],
    ['GET', '/api/sessions'],
    ['GET', '/api/users'],
    ['GET', '/api/partners'],
    ['GET', '/api/shared-links'],
    ['GET', '/api/admin/users'],
    ['POST', '/api/auth/login'],
    ['POST', '/api/assets'],
    ['DELETE', '/api/assets'],
    ['PUT', `/api/assets/${ID}`],
    ['PUT', `/api/people/${ID}`],
    ['POST', '/api/albums'],
    ['GET', '/api/unknown-route'],
    ['POST', '/photos'],
    ['OPTIONS', '/api/timeline/buckets'],
  ])('denies %s %s', (method, path) => {
    expect(decide(method, path)).toEqual({ action: 'deny', status: 403 });
  });

  it.each(['/API/users', '/Api/api-keys', '/api/USERS/me', '/API/timeline/buckets'])(
    'denies the non-canonical spelling %s (Express routes case-insensitively)',
    (path) => {
      expect(decide('GET', path)).toEqual({ action: 'deny', status: 403 });
    },
  );

  it('does not let a parameter match a static sibling route', () => {
    expect(decide('GET', '/api/people/statistics')).toEqual({ action: 'forward' });
    expect(decide('GET', `/api/people/${ID}/thumbnail/extra`)).toEqual({ action: 'deny', status: 403 });
  });

  it('answers writes the UI fires on its own without reaching the server', () => {
    expect(decide('PUT', '/api/assets/favorites')).toEqual({ action: 'fake', status: 204 });
    expect(decide('PUT', `/api/shared-spaces/${ID}/people/${ID}/alias`)).toEqual({ action: 'fake', status: 204 });
    expect(decide('POST', '/api/assets/editable')).toEqual({ action: 'fake', status: 200, body: [] });
    expect(decide('POST', '/api/auth/logout')).toMatchObject({ action: 'fake', status: 200 });
  });

  it('redirects login, admin and settings pages home', () => {
    for (const path of ['/auth/login', '/admin', '/admin/users', '/user-settings', '/AUTH/login']) {
      expect(decide('GET', path)).toEqual({ action: 'redirect', location: '/' });
    }
  });

  it('serves empty results for disabled list features', () => {
    expect(decide('GET', '/api/people', NO_FEATURES)).toMatchObject({ action: 'fake', status: 200 });
    expect(decide('GET', '/api/map/markers', NO_FEATURES)).toEqual({ action: 'fake', status: 200, body: [] });
    expect(decide('GET', `/api/people/${ID}/thumbnail`, NO_FEATURES)).toEqual({ action: 'deny', status: 404 });
    expect(decide('GET', `/api/assets/${ID}/original`, NO_FEATURES)).toEqual({ action: 'deny', status: 404 });
  });

  it('keeps the original download off unless enabled', () => {
    expect(decide('GET', `/api/assets/${ID}/original`, ALL_FEATURES)).toEqual({ action: 'forward' });
  });
});
