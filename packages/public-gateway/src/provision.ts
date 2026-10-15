import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Manifest } from './config.ts';

/** Every gallery user's key gets exactly these: reading, never writing (see README.md#adding-a-gallery) */
export const GALLERY_PERMISSIONS = [
  'activity.read',
  'activity.statistics',
  'album.read',
  'album.statistics',
  'asset.read',
  'asset.statistics',
  'asset.view',
  'assetFile.read',
  'face.read',
  'folder.read',
  'map.read',
  'map.search',
  'memory.read',
  'memory.statistics',
  'person.read',
  'person.statistics',
  'sharedSpace.read',
  'sharedSpaceAsset.read',
  'stack.read',
  'tag.read',
  'user.read',
  'userConfig.read',
  'userOnboarding.read',
  'userPreference.read',
  'userProfileImage.read',
];

/** What the admin key needs to create galleries; nothing else */
export const ADMIN_PERMISSIONS = [
  'adminUser.read',
  'adminUser.create',
  'adminUser.update',
  'sharedSpace.read',
  'sharedSpace.create',
  'sharedSpaceMember.create',
];

/**
 * Users the gateway creates get an address in this domain, and the gateway only ever manages users in it: a gallery
 * named like an existing person's account is refused instead of taking that account over.
 */
export const GALLERY_EMAIL_DOMAIN = 'public-gallery.local';

const KEY_NAME = 'public-gateway';

export const galleryEmail = (name: string) => {
  const slug = name
    .normalize('NFD')
    .replaceAll(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-+|-+$/g, '');
  if (!slug) {
    throw new Error(`Gallery name "${name}" has no letters or digits to build a user from`);
  }
  return `${slug}@${GALLERY_EMAIL_DOMAIN}`;
};

type Log = (entry: Record<string, unknown>) => void;

type Json = Record<string, any>;

class NoodleError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const client = (upstream: URL, auth: { apiKey?: string; token?: string }) => {
  return async (method: string, path: string, body?: unknown): Promise<any> => {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (auth.apiKey) {
      headers['x-api-key'] = auth.apiKey;
    }
    if (auth.token) {
      headers.authorization = `Bearer ${auth.token}`;
    }
    const res = await fetch(new URL(`/api${path}`, upstream), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    if (!res.ok) {
      let message = text;
      try {
        message = (JSON.parse(text) as Json).message ?? text;
      } catch {
        // not JSON
      }
      throw new NoodleError(res.status, `${method} ${path}: ${res.status} ${message}`);
    }
    return text ? JSON.parse(text) : undefined;
  };
};

type State = { keys: Record<string, string> };

const loadState = (file: string): State => {
  try {
    const state = JSON.parse(readFileSync(file, 'utf8')) as State;
    return { keys: state.keys ?? {} };
  } catch {
    return { keys: {} };
  }
};

const saveState = (file: string, state: State) => {
  // write then rename, so a crash never leaves a half-written file
  writeFileSync(`${file}.tmp`, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
};

/** A fresh read-only key for `user`, created through a one-off session of that user */
const issueKey = async (
  upstream: URL,
  admin: ReturnType<typeof client>,
  user: { id: string; email: string },
): Promise<string> => {
  // gallery users have no password anyone knows; set a throwaway one just long enough to log in once
  const password = randomBytes(24).toString('base64url');
  await admin('PUT', `/admin/users/${user.id}`, { password, shouldChangePassword: false });
  const login = (await client(upstream, {})('POST', '/auth/login', { email: user.email, password })) as Json;
  const session = client(upstream, { token: login.accessToken });
  try {
    await session('PUT', '/users/me/onboarding', { isOnboarded: true });
    for (const key of (await session('GET', '/api-keys')) as Json[]) {
      if (key.name === KEY_NAME) {
        await session('DELETE', `/api-keys/${key.id}`);
      }
    }
    const created = (await session('POST', '/api-keys', { name: KEY_NAME, permissions: GALLERY_PERMISSIONS })) as Json;
    return created.secret as string;
  } finally {
    await session('POST', '/auth/logout').catch(() => {});
  }
};

const keyWorks = async (upstream: URL, apiKey: string, userId: string) => {
  try {
    const me = (await client(upstream, { apiKey })('GET', '/users/me')) as Json;
    return me.id === userId;
  } catch (error) {
    if (error instanceof NoodleError && error.status === 401) {
      return false;
    }
    throw error;
  }
};

/**
 * Creates what the provisioned galleries in `manifest` need and returns their keys by lower-cased name. Safe to run
 * on every start and reload: it only adds what is missing. A failing gallery is logged and left out; the others
 * still come up.
 */
export const provision = async (manifest: Manifest, log: Log): Promise<Map<string, string>> => {
  const keys = new Map<string, string>();
  const galleries = manifest.galleries.flatMap((gallery) =>
    gallery.source.kind === 'provisioned' ? [{ ...gallery, source: gallery.source }] : [],
  );
  if (galleries.length === 0 || !manifest.adminApiKey) {
    return keys;
  }

  mkdirSync(manifest.stateDir, { recursive: true, mode: 0o700 });
  const stateFile = join(manifest.stateDir, 'galleries.json');
  const state = loadState(stateFile);
  const admin = client(manifest.upstream, { apiKey: manifest.adminApiKey });

  // with deleted ones: a gallery user removed in the UI waits days before it is really gone
  const users = (await admin('GET', '/admin/users?withDeleted=true')) as Json[];
  const spaces = (await admin('GET', '/shared-spaces')) as Json[];

  for (const gallery of galleries) {
    const { name } = gallery.source;
    try {
      const email = galleryEmail(name);
      let user = users.find((candidate) => candidate.email === email);
      if (user?.deletedAt) {
        // someone deleted it on purpose; bringing it back is their call, not the gateway's
        throw new Error(
          `user ${email} was deleted in Administração → Usuários and is waiting to be removed; restore it there, ` +
            'or take this gallery out of the file',
        );
      }
      if (!user) {
        user = (await admin('POST', '/admin/users', {
          email,
          name,
          password: randomBytes(24).toString('base64url'),
          shouldChangePassword: false,
        })) as Json;
        users.push(user);
        delete state.keys[email];
        log({ event: 'provisioned', gallery: name, created: 'user', email });
      }

      for (const spaceName of gallery.source.spaces) {
        const matches = spaces.filter((space) => space.name === spaceName);
        if (matches.length > 1) {
          throw new Error(`more than one Space named "${spaceName}"; rename one`);
        }
        let space = matches[0];
        if (!space) {
          space = (await admin('POST', '/shared-spaces', { name: spaceName })) as Json;
          spaces.push(space);
          log({ event: 'provisioned', gallery: name, created: 'space', space: spaceName });
        }
        const members = (await admin('GET', `/shared-spaces/${space.id}/members`)) as Json[];
        const member = members.find((candidate) => candidate.userId === user.id);
        if (!member) {
          await admin('POST', `/shared-spaces/${space.id}/members`, { userId: user.id, role: 'viewer' });
          log({ event: 'provisioned', gallery: name, created: 'membership', space: spaceName });
        } else if (member.role !== 'viewer') {
          log({ event: 'warning', gallery: name, message: `is ${member.role} of "${spaceName}"; make it Viewer` });
        }
      }

      let apiKey = state.keys[email];
      if (!apiKey || !(await keyWorks(manifest.upstream, apiKey, user.id))) {
        apiKey = await issueKey(manifest.upstream, admin, { id: user.id, email });
        state.keys[email] = apiKey;
        saveState(stateFile, state);
        log({ event: 'provisioned', gallery: name, created: 'api key' });
      }
      keys.set(name.toLowerCase(), apiKey);
    } catch (error) {
      log({ event: 'provision-failed', gallery: name, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return keys;
};
