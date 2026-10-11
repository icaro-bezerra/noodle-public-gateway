// Attacks a running gateway in front of the seeded Noodle (see README.md#end-to-end-environment) and exits non-zero
// on any finding. Run after `node e2e/seed.ts` with the gateway started on e2e/gateway.yaml:
//
//   node e2e/adversarial.ts
//
// The checks do not trust the gateway's own policy. The Noodle server tags every response with `x-correlation-id`
// and the gateway's local answers never carry it, so "did this request reach the server?" is observable directly.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadInventory } from '../src/inventory.ts';

const DIR = import.meta.dirname;
const GATEWAY = process.env.GATEWAY_URL ?? 'http://127.0.0.1:28080';
const SERVER = process.env.SERVER_URL ?? 'http://127.0.0.1:22830';
const HOSTS = ['gal1.localhost', 'gal2.localhost'];

const seed = JSON.parse(readFileSync(join(DIR, 'seed.json'), 'utf8'));
const [ASSET] = seed.gal1.assets as string[];
const inventory = loadInventory(join(DIR, '../../../open-api/immich-openapi-specs.json'));

const findings: string[] = [];
const fail = (message: string) => findings.push(message);
let requests = 0;
const dropped: string[] = [];

type Reply = { status: number; reachedServer: boolean; body: string };

/** Raw path on purpose: fetch would normalize `..`, `//` and case before they reach the gateway */
const send = async (
  host: string,
  method: string,
  path: string,
  options: { headers?: Record<string, string>; body?: string } = {},
): Promise<Reply> => {
  requests++;
  const { request } = await import('node:http');
  const url = new URL(GATEWAY);
  return new Promise((resolve) => {
    const req = request(
      {
        host: url.hostname,
        port: url.port,
        method,
        path,
        headers: {
          host,
          ...(options.body === undefined
            ? {}
            : { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(options.body)) }),
          ...options.headers,
        },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, reachedServer: 'x-correlation-id' in res.headers, body }),
        );
      },
    );
    // a connection the gateway closes is an answer too: nothing reached the server
    req.on('error', (error) => {
      dropped.push(`${method} ${path}: ${error.message}`);
      resolve({ status: 0, reachedServer: false, body: '' });
    });
    req.end(options.body);
  });
};

const login = async (email: string, password: string) => {
  const res = await fetch(`${SERVER}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  return ((await res.json()) as { accessToken: string }).accessToken;
};

/** What could change if a write slipped through, per user, read with that user's own session */
const snapshot = async (token: string) => {
  const get = async (path: string) => {
    const res = await fetch(`${SERVER}/api${path}`, { headers: { authorization: `Bearer ${token}` } });
    return res.ok ? res.json() : `HTTP ${res.status}`;
  };
  return JSON.stringify({
    me: await get('/users/me'),
    preferences: await get('/users/me/preferences'),
    timeline: await get('/timeline/buckets?visibility=timeline'),
    archive: await get('/timeline/buckets?visibility=archive'),
    trash: await get('/timeline/buckets?isTrashed=true'),
    favorites: await get('/timeline/buckets?isFavorite=true'),
    albums: await get('/albums'),
    people: await get('/people?withHidden=true'),
    tags: await get('/tags'),
    spaces: await get('/shared-spaces'),
    apiKeys: await get('/api-keys'),
    sharedLinks: await get('/shared-links'),
    asset: await get(`/assets/${ASSET}`),
  });
};

const concrete = (template: string) => template.replaceAll(/\{[^}]+\}/g, ASSET);

const admin = await login('admin@example.com', 'admin');
const sessions = {
  admin,
  gal1: await login('gal1@example.com', 'pass'),
  gal2: await login('gal2@example.com', 'pass'),
};
const before = Object.fromEntries(
  await Promise.all(Object.entries(sessions).map(async ([name, token]) => [name, await snapshot(token)])),
);

// 1. No write, admin or full-permission route reaches the server, on any gallery.
const writes = inventory.filter((route) => route.class !== 'read' && route.class !== 'public');
for (const host of HOSTS) {
  for (const route of writes) {
    const reply = await send(host, route.method, concrete(route.path), {
      body: route.method === 'GET' || route.method === 'HEAD' ? undefined : '{}',
    });
    if (reply.status === 429) {
      fail(`${host} ${route.method} ${route.path}: rate limited, so not actually tested`);
    } else if (reply.reachedServer) {
      fail(
        `${host} ${route.method} ${route.path} (${route.permission ?? route.class}) reached the server: ${reply.status}`,
      );
    }
  }
}

// 2. Writes guarded only by read permissions (per-user state shared by every visitor) never reach the server.
for (const route of inventory.filter((r) => r.class === 'read' && !['GET', 'HEAD'].includes(r.method))) {
  const forwardedOnPurpose = route.path.startsWith('/api/search/') || route.path.endsWith('/linked-albums');
  const reply = await send('gal1.localhost', route.method, concrete(route.path), { body: '{}' });
  if (reply.reachedServer && !forwardedOnPurpose && !route.path.includes('/video/stream/')) {
    fail(`gal1 ${route.method} ${route.path} is a read-permission write and reached the server`);
  }
}

// 3. Bypass variants on sensitive targets.
const sensitive: [string, string, string?][] = [
  ['GET', '/api/api-keys'],
  ['GET', '/api/admin/users'],
  ['GET', '/api/users'],
  ['GET', '/api/sessions'],
  ['GET', '/api/partners'],
  ['POST', '/api/albums', '{"albumName":"pwned"}'],
  ['DELETE', '/api/assets', JSON.stringify({ ids: [ASSET], force: true })],
  ['PUT', '/api/assets', JSON.stringify({ ids: [ASSET], isFavorite: true })],
  ['POST', '/api/api-keys', '{"name":"pwned","permissions":["all"]}'],
];
const variants: [string, (path: string) => string][] = [
  ['as is', (p) => p],
  ['upper case', (p) => p.toUpperCase()],
  ['mixed case prefix', (p) => p.replace('/api', '/Api')],
  ['trailing slash', (p) => `${p}/`],
  ['double slash', (p) => p.replace('/api/', '/api//')],
  ['dot segment', (p) => p.replace('/api/', '/api/./')],
  ['traversal', (p) => p.replace('/api/', '/api/timeline/../')],
  ['encoded traversal', (p) => p.replace('/api/', '/api/timeline/%2e%2e/')],
  ['encoded slash', (p) => p.replace('/api/', '/api%2f')],
  ['backslash', (p) => p.replace('/api/', '/api\\')],
  ['matrix param', (p) => `${p};x=1`],
  ['query credential', (p) => `${p}?apiKey=x&sessionKey=x&key=x`],
];
const credentials: [string, Record<string, string>][] = [
  ['none', {}],
  ['admin bearer', { authorization: `Bearer ${admin}` }],
  ['admin cookie', { cookie: `immich_access_token=${admin}` }],
  ['admin user-token header', { 'x-immich-user-token': admin }],
  ['method override', { 'x-http-method-override': 'GET' }],
];
for (const [method, path, body] of sensitive) {
  for (const [variant, mutate] of variants) {
    for (const [credential, headers] of credentials) {
      const reply = await send('gal1.localhost', method, mutate(path), { headers, body });
      if (reply.reachedServer) {
        fail(`${method} ${path} [${variant}, ${credential}] reached the server: ${reply.status}`);
      }
    }
  }
}
for (const method of ['OPTIONS', 'TRACE', 'CONNECT', 'PROPFIND']) {
  const reply = await send('gal1.localhost', method, '/api/users');
  if (reply.reachedServer) {
    fail(`${method} /api/users reached the server`);
  }
}

// 4. A visitor's credentials never replace the gallery's identity.
for (const [credential, headers] of credentials.slice(1)) {
  const reply = await send('gal1.localhost', 'GET', '/api/users/me', { headers });
  if (!reply.body.includes('public@gal1.localhost')) {
    fail(`/api/users/me with ${credential} did not answer as the gallery: ${reply.body.slice(0, 120)}`);
  }
}

// 5. Galleries never see each other's content.
const gal2Asset = seed.gal2.assets[0] as string;
for (const [host, asset] of [
  ['gal2.localhost', ASSET],
  ['gal1.localhost', gal2Asset],
] as const) {
  for (const path of [`/api/assets/${asset}`, `/api/assets/${asset}/thumbnail`, `/api/faces?id=${asset}`]) {
    const reply = await send(host, 'GET', path);
    // a local answer (e.g. the empty list for a disabled feature) reveals nothing
    if (reply.reachedServer && reply.status >= 200 && reply.status < 300) {
      fail(`${host} could read ${path}: ${reply.status}`);
    }
  }
}
const space = await send('gal2.localhost', 'GET', `/api/shared-spaces/${seed.space}`);
if (space.reachedServer && space.status >= 200 && space.status < 300) {
  fail("gal2 could read gal1's Shared Space");
}

// 6. Nothing archived, trashed, hidden or locked is reachable.
for (const query of [
  'visibility=archive',
  'visibility=locked',
  'visibility=hidden',
  'isTrashed=true',
  'withDeleted=true',
]) {
  const reply = await send('gal1.localhost', 'GET', `/api/timeline/buckets?${query}`);
  if (reply.reachedServer) {
    fail(`timeline with ${query} reached the server`);
  }
}

// 7. No forwarded read leaks an email address or a server path.
for (const host of HOSTS) {
  for (const route of inventory.filter((r) => (r.class === 'read' || r.class === 'public') && r.method === 'GET')) {
    const reply = await send(host, 'GET', concrete(route.path));
    if (reply.status !== 200 || !reply.reachedServer) {
      continue;
    }
    const emails = [...reply.body.matchAll(/[\w.+-]+@[\w-]+\.[\w.]+/g)].map((m) => m[0]);
    const leaked = emails.filter((email) => !email.startsWith('public@'));
    if (leaked.length > 0) {
      fail(`${host} GET ${route.path} leaks ${leaked.join(', ')}`);
    }
    if (/"(originalPath|thumbnailPath|profileImagePath)":"\//.test(reply.body)) {
      fail(`${host} GET ${route.path} leaks a server path`);
    }
  }
}

// 8. Nothing changed for anyone.
for (const [name, token] of Object.entries(sessions)) {
  if ((await snapshot(token)) !== before[name]) {
    fail(`state of ${name} changed during the run`);
  }
}

console.log(`${requests} requests, ${findings.length} findings`);
if (dropped.length > 0) {
  console.log(
    `  ${dropped.length} connections closed by the gateway (not findings): ${dropped.slice(0, 5).join('; ')}`,
  );
}
for (const finding of findings) {
  console.log(`  ✗ ${finding}`);
}
process.exit(findings.length > 0 ? 1 : 0);
