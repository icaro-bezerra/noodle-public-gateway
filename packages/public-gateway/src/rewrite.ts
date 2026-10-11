import { createHash } from 'node:crypto';
import type { Gallery } from './config.ts';

export type RewriteName = 'currentUser' | 'html';

/** Largest upstream body the gateway buffers to rewrite */
export const MAX_REWRITE_BYTES = 2 * 1024 * 1024;

/**
 * A stable fake user id per gallery. The web app shows edit, delete, share and face-naming controls only when
 * `asset.ownerId === currentUser.id` (see web/src/lib/utils/asset-editability.ts), so presenting an id that owns
 * nothing makes the app render every asset read-only.
 */
export const publicUserId = (gallery: Gallery) => {
  const hex = createHash('sha256').update(`noodle-public-gateway:${gallery.host}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

const rewriteCurrentUser = (body: string, gallery: Gallery) => {
  const user = JSON.parse(body) as Record<string, unknown>;
  return JSON.stringify({
    ...user,
    id: publicUserId(gallery),
    email: `public@${gallery.host}`,
    name: gallery.title ?? String(user.name ?? ''),
    isAdmin: false,
    profileImagePath: '',
  });
};

/** Feature names the web app reads from the marker tag (web/src/lib/utils/public-gallery.ts) */
const WEB_FEATURES: Record<keyof Gallery['features'], string> = {
  people: 'people',
  map: 'map',
  smartSearch: 'smart-search',
  downloadOriginal: 'download',
};

/** Marks the app shell so the web app hides every control that writes */
const rewriteHtml = (body: string, gallery: Gallery) => {
  const features = Object.entries(WEB_FEATURES)
    .filter(([feature]) => gallery.features[feature as keyof Gallery['features']])
    .map(([, name]) => name)
    .join(' ');
  const marker = `<meta name="noodle-public-gallery" content="${features}">`;
  const head = body.indexOf('<head>');
  return head === -1 ? marker + body : body.slice(0, head + 6) + marker + body.slice(head + 6);
};

const REWRITERS: Record<RewriteName, (body: string, gallery: Gallery) => string> = {
  currentUser: rewriteCurrentUser,
  html: rewriteHtml,
};

/** Content types each rewrite applies to; any other response passes through untouched */
const CONTENT_TYPES: Record<RewriteName, string> = {
  currentUser: 'application/json',
  html: 'text/html',
};

export const appliesTo = (name: RewriteName, contentType: string | undefined) =>
  !!contentType && contentType.toLowerCase().startsWith(CONTENT_TYPES[name]);

export const rewriteBody = (name: RewriteName, body: string, gallery: Gallery) => REWRITERS[name](body, gallery);
