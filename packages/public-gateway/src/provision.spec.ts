import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Manifest } from './config.ts';
import { ALL_FEATURES } from './policy.ts';
import { galleryEmail, GALLERY_PERMISSIONS, provision } from './provision.ts';

/** Just enough of the Noodle API to provision against, with its state open for assertions */
type User = { id: string; email: string; name: string; password: string; isOnboarded: boolean };
type Key = { id: string; userId: string; name: string; secret: string; permissions: string[] };
type Space = { id: string; name: string; members: { userId: string; role: string }[] };

let noodle: { users: User[]; keys: Key[]; spaces: Space[]; sessions: Map<string, string>; calls: string[] };
const ADMIN_KEY = 'admin-key';
const ADMIN_ID = 'admin';

let server: Server;
let upstream: URL;

const reset = () => {
  noodle = {
    users: [
      { id: ADMIN_ID, email: 'admin@example.com', name: 'Admin', password: 'x', isOnboarded: true },
      { id: 'maria', email: 'maria@example.com', name: 'Família', password: 'secret', isOnboarded: true },
    ],
    keys: [],
    spaces: [{ id: 'space-familia', name: 'Família', members: [{ userId: ADMIN_ID, role: 'owner' }] }],
    sessions: new Map(),
    calls: [],
  };
};

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      const path = new URL(req.url!, 'http://x').pathname.replace(/^\/api/, '');
      const key = req.headers['x-api-key'] as string | undefined;
      const token = (req.headers.authorization ?? '').replace('Bearer ', '');
      const caller = key
        ? key === ADMIN_KEY
          ? ADMIN_ID
          : noodle.keys.find((k) => k.secret === key)?.userId
        : noodle.sessions.get(token);
      noodle.calls.push(`${req.method} ${path}`);
      const send = (status: number, data?: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(data === undefined ? '' : JSON.stringify(data));
      };
      const route = `${req.method} ${path}`;
      if (route === 'POST /auth/login') {
        const user = noodle.users.find((u) => u.email === body.email && u.password === body.password);
        if (!user) return send(401, { message: 'Incorrect email or password' });
        const accessToken = randomUUID();
        noodle.sessions.set(accessToken, user.id);
        return send(201, { accessToken });
      }
      if (!caller) return send(401, { message: 'Invalid API key' });
      const isAdmin = caller === ADMIN_ID;
      let match: RegExpMatchArray | null;
      if (route === 'GET /admin/users' && isAdmin) {
        const withDeleted = new URL(req.url!, 'http://x').searchParams.get('withDeleted') === 'true';
        return send(
          200,
          noodle.users.filter((u) => withDeleted || !(u as any).deletedAt),
        );
      }
      if (route === 'POST /admin/users' && isAdmin) {
        if (noodle.users.some((u) => u.email === body.email && (u as any).deletedAt))
          return send(500, { message: 'Failed to create user' });
        if (noodle.users.some((u) => u.email === body.email)) return send(400, { message: 'User exists' });
        const user = { id: randomUUID(), isOnboarded: false, ...body };
        noodle.users.push(user);
        return send(201, user);
      }
      if ((match = route.match(/^PUT \/admin\/users\/(.+)$/)) && isAdmin) {
        Object.assign(
          noodle.users.find((u) => u.id === match![1])!,
          body,
        );
        return send(200, {});
      }
      if (route === 'GET /shared-spaces')
        return send(
          200,
          noodle.spaces.filter((s) => s.members.some((m) => m.userId === caller)),
        );
      if (route === 'POST /shared-spaces') {
        const space = { id: randomUUID(), name: body.name, members: [{ userId: caller, role: 'owner' }] };
        noodle.spaces.push(space);
        return send(201, space);
      }
      if ((match = route.match(/^(GET|POST) \/shared-spaces\/(.+)\/members$/))) {
        const space = noodle.spaces.find((s) => s.id === match![2])!;
        if (match[1] === 'GET') return send(200, space.members);
        space.members.push({ userId: body.userId, role: body.role });
        return send(201, {});
      }
      if (route === 'GET /users/me')
        return send(
          200,
          noodle.users.find((u) => u.id === caller),
        );
      if (route === 'PUT /users/me/onboarding') {
        noodle.users.find((u) => u.id === caller)!.isOnboarded = body.isOnboarded;
        return send(200, {});
      }
      if (route === 'GET /api-keys')
        return send(
          200,
          noodle.keys.filter((k) => k.userId === caller),
        );
      if (route === 'POST /api-keys') {
        const created = {
          id: randomUUID(),
          userId: caller,
          name: body.name,
          permissions: body.permissions,
          secret: randomUUID(),
        };
        noodle.keys.push(created);
        return send(201, created);
      }
      if ((match = route.match(/^DELETE \/api-keys\/(.+)$/))) {
        noodle.keys = noodle.keys.filter((k) => k.id !== match![1]);
        return send(204);
      }
      if (route === 'POST /auth/logout') {
        noodle.sessions.delete(token);
        return send(200, {});
      }
      send(404, { message: `unhandled ${route}` });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  upstream = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
});

afterAll(() => {
  server.closeAllConnections();
  server.close();
});

let stateDir: string;
beforeEach(() => {
  reset();
  stateDir = mkdtempSync(join(tmpdir(), 'provision-'));
});

const manifest = (galleries: Manifest['galleries']): Manifest => ({
  upstream,
  listen: { host: '127.0.0.1', port: 0 },
  trustProxy: false,
  maxBodyBytes: 1024,
  rateLimit: { default: { perSecond: 1, burst: 1 }, expensive: { perSecond: 1, burst: 1 } },
  allowIndexing: false,
  adminApiKey: ADMIN_KEY,
  stateDir,
  galleries,
});

const provisioned = (name: string, spaces: string[]) => ({
  hosts: [`${name.toLowerCase()}.example.com`],
  title: name,
  features: ALL_FEATURES,
  source: { kind: 'provisioned' as const, name, spaces },
});

const logs: Record<string, unknown>[] = [];
const log = (entry: Record<string, unknown>) => logs.push(entry);

describe('galleryEmail', () => {
  it('builds a stable address in the gateway domain', () => {
    expect(galleryEmail('Família')).toBe('familia@public-gallery.local');
    expect(galleryEmail('  Hamburgada 2026! ')).toBe('hamburgada-2026@public-gallery.local');
    expect(() => galleryEmail('!!!')).toThrow();
  });
});

describe('provision', () => {
  it('creates the user, makes it a Viewer, and issues a read-only key through a one-off session', async () => {
    const keys = await provision(manifest([provisioned('Família', ['Família'])]), log);

    const user = noodle.users.find((u) => u.email === 'familia@public-gallery.local')!;
    expect(user).toMatchObject({ name: 'Família', isOnboarded: true });
    expect(noodle.spaces[0].members).toContainEqual({ userId: user.id, role: 'viewer' });
    const issued = noodle.keys.filter((k) => k.userId === user.id);
    expect(issued).toHaveLength(1);
    expect(issued[0].permissions).toEqual(GALLERY_PERMISSIONS);
    expect(keys.get('família')).toBe(issued[0].secret);
    expect(noodle.sessions.size).toBe(0); // logged out again
    expect(JSON.parse(readFileSync(join(stateDir, 'galleries.json'), 'utf8')).keys).toEqual({
      'familia@public-gallery.local': issued[0].secret,
    });
  });

  it('never touches an existing personal account, even one with the same name', async () => {
    await provision(manifest([provisioned('Família', ['Família'])]), log);
    const maria = noodle.users.find((u) => u.id === 'maria')!;
    expect(maria.password).toBe('secret');
    expect(noodle.calls).not.toContain('PUT /admin/users/maria');
  });

  it('changes nothing on a second run', async () => {
    const config = manifest([provisioned('Família', ['Família'])]);
    const first = await provision(config, log);
    noodle.calls = [];
    const second = await provision(config, log);
    expect(second).toEqual(first);
    expect(noodle.calls.filter((call) => !call.startsWith('GET'))).toEqual([]);
  });

  it('creates a missing Space, empty, owned by the admin', async () => {
    await provision(manifest([provisioned('Hamburgada', ['Hamburgada'])]), log);
    const space = noodle.spaces.find((s) => s.name === 'Hamburgada')!;
    expect(space.members[0]).toEqual({ userId: ADMIN_ID, role: 'owner' });
    expect(space.members).toHaveLength(2);
  });

  it('replaces a key that was revoked in the Noodle UI and removes the old one', async () => {
    const config = manifest([provisioned('Família', ['Família'])]);
    const first = (await provision(config, log)).get('família');
    noodle.keys = []; // revoked
    const second = (await provision(config, log)).get('família');
    expect(second).toBeDefined();
    expect(second).not.toBe(first);
    expect(noodle.keys).toHaveLength(1);
  });

  it('recovers when its state was lost, without duplicating keys', async () => {
    const config = manifest([provisioned('Família', ['Família'])]);
    await provision(config, log);
    stateDir = mkdtempSync(join(tmpdir(), 'provision-')); // a new, empty volume
    const keys = await provision({ ...config, stateDir }, log);
    expect(keys.get('família')).toBeDefined();
    expect(noodle.users.filter((u) => u.email.endsWith('@public-gallery.local'))).toHaveLength(1);
    expect(noodle.keys).toHaveLength(1);
  });

  it('explains, instead of failing obscurely, when the gallery user was deleted in the UI', async () => {
    const config = manifest([provisioned('Família', ['Família'])]);
    await provision(config, log);
    (noodle.users.find((u) => u.email === 'familia@public-gallery.local') as any).deletedAt = '2026-10-15';
    logs.length = 0;
    const keys = await provision(config, log);
    expect(keys.has('família')).toBe(false);
    expect(logs).toContainEqual(
      expect.objectContaining({ event: 'provision-failed', error: expect.stringContaining('restore it there') }),
    );
  });

  it('keeps going when one gallery fails', async () => {
    noodle.spaces.push({ id: 'dup', name: 'Família', members: [{ userId: ADMIN_ID, role: 'owner' }] });
    logs.length = 0;
    const keys = await provision(
      manifest([provisioned('Família', ['Família']), provisioned('Hamburgada', ['Hamburgada'])]),
      log,
    );
    expect(keys.has('família')).toBe(false);
    expect(keys.has('hamburgada')).toBe(true);
    expect(logs).toContainEqual(expect.objectContaining({ event: 'provision-failed', gallery: 'Família' }));
  });

  it('leaves manual galleries alone and does nothing without provisioned ones', async () => {
    const keys = await provision(
      manifest([{ hosts: ['manual.example.com'], features: ALL_FEATURES, source: { kind: 'manual', apiKey: 'k' } }]),
      log,
    );
    expect(keys.size).toBe(0);
    expect(noodle.calls).toEqual([]);
  });
});
