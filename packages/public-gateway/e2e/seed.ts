// Seeds the disposable Noodle started by `docker compose -f e2e/compose.yml up -d`, then writes e2e/gateway.yaml.
// Run `node e2e/seed.ts`, then `node src/main.ts e2e/gateway.yaml` and open http://gal1.localhost:28080.
//
// - gal1: owns two photos (one in an album, tagged, with a named face) and is a Viewer of the admin's space
// - gal2: owns one photo, used to check that galleries never see each other's content
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const API = 'http://127.0.0.1:22830/api';
const DIR = import.meta.dirname;

type Json = Record<string, any>;

const call = async (method: string, path: string, token?: string, body?: unknown): Promise<Json> => {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${method} ${path} → ${res.status} ${text}`);
  }
  return text ? JSON.parse(text) : {};
};

const login = async (email: string, password: string) =>
  (await call('POST', '/auth/login', undefined, { email, password })).accessToken as string;

const upload = async (token: string, name: string, colors: string, date: string) => {
  const file = join(DIR, `${name}.jpg`);
  execFileSync('magick', ['-size', '800x600', `gradient:${colors}`, file]);
  const form = new FormData();
  form.set('assetData', new Blob([readFileSync(file)], { type: 'image/jpeg' }), `${name}.jpg`);
  form.set('fileCreatedAt', date);
  form.set('fileModifiedAt', date);
  form.set('deviceAssetId', name);
  form.set('deviceId', 'e2e');
  const res = await fetch(`${API}/assets`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: form,
  });
  return ((await res.json()) as Json).id as string;
};

const createUser = async (admin: string, email: string, name: string) => {
  const user = await call('POST', '/admin/users', admin, {
    email,
    password: 'pass',
    name,
    shouldChangePassword: false,
  });
  const token = await login(email, 'pass');
  await call('PUT', '/users/me/onboarding', token, { isOnboarded: true });
  return { id: user.id as string, token };
};

const face = async (token: string, assetId: string, personName: string) => {
  const person = await call('POST', '/people', token, { name: personName });
  await call('POST', '/faces', token, {
    assetId,
    personId: person.id,
    imageWidth: 800,
    imageHeight: 600,
    x: 300,
    y: 150,
    width: 200,
    height: 250,
  });
  return person.id as string;
};

// Read-only permissions documented in README.md
const PERMISSIONS = [
  'asset.read',
  'asset.view',
  'asset.statistics',
  'assetFile.read',
  'album.read',
  'album.statistics',
  'person.read',
  'person.statistics',
  'face.read',
  'map.read',
  'map.search',
  'memory.read',
  'memory.statistics',
  'tag.read',
  'stack.read',
  'folder.read',
  'sharedSpace.read',
  'sharedSpaceAsset.read',
  'user.read',
  'userPreference.read',
  'userProfileImage.read',
  'userConfig.read',
  'userOnboarding.read',
  'activity.read',
  'activity.statistics',
];

const apiKey = async (token: string, file: string) => {
  const { secret } = await call('POST', '/api-keys', token, { name: 'public-gateway', permissions: PERMISSIONS });
  writeFileSync(join(DIR, file), `${secret}\n`);
};

await call('POST', '/auth/admin-sign-up', undefined, { email: 'admin@example.com', password: 'admin', name: 'Admin' });
const admin = await login('admin@example.com', 'admin');
const gal1 = await createUser(admin, 'gal1@example.com', 'Galeria 1');
const gal2 = await createUser(admin, 'gal2@example.com', 'Galeria 2');

const own1 = await upload(gal1.token, 'gal1-beach', 'skyblue-khaki', '2026-01-10T10:00:00.000Z');
const own2 = await upload(gal1.token, 'gal1-sunset', 'purple-orange', '2026-02-14T18:00:00.000Z');
await call('POST', '/albums', gal1.token, { albumName: 'Viagem', assetIds: [own1] });
const tag = await call('POST', '/tags', gal1.token, { name: 'praia' });
await call('PUT', `/tags/${tag.id}/assets`, gal1.token, { ids: [own1] });
await face(gal1.token, own1, 'Maria');

const adminAssets = [
  await upload(admin, 'admin-forest', 'darkgreen-lightgreen', '2025-12-24T20:00:00.000Z'),
  await upload(admin, 'admin-snow', 'white-lightblue', '2025-12-25T09:00:00.000Z'),
];
await face(admin, adminAssets[0], 'João');
const space = await call('POST', '/shared-spaces', admin, { name: 'Família' });
await call('POST', `/shared-spaces/${space.id}/members`, admin, { userId: gal1.id, role: 'viewer' });
await call('POST', `/shared-spaces/${space.id}/assets`, admin, { assetIds: adminAssets });

const gal2Asset = await upload(gal2.token, 'gal2-secret', 'red-black', '2026-03-01T12:00:00.000Z');

await apiKey(gal1.token, 'gal1.key');
await apiKey(gal2.token, 'gal2.key');

writeFileSync(
  join(DIR, 'gateway.yaml'),
  `upstream: http://127.0.0.1:22830
listen: { host: 127.0.0.1, port: 28080 }
galleries:
  - host: gal1.localhost
    apiKeyFile: gal1.key
    title: Galeria 1
    features: { people: true, map: true }
  - host: gal2.localhost
    apiKeyFile: gal2.key
`,
);
writeFileSync(
  join(DIR, 'seed.json'),
  JSON.stringify(
    {
      gal1: { id: gal1.id, assets: [own1, own2] },
      gal2: { id: gal2.id, assets: [gal2Asset] },
      space: space.id,
      adminAssets,
    },
    null,
    2,
  ),
);
console.log('Seeded. gal1 owns', [own1, own2], 'space', space.id, 'gal2 owns', gal2Asset);
