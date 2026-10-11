import { createHash } from 'node:crypto';
import type { Gallery } from './config.ts';

export type RewriteName = 'currentUser' | 'faces' | 'html' | 'json';

/** Largest upstream body the gateway buffers to rewrite; a month of timeline can run to a few MB */
export const MAX_REWRITE_BYTES = 32 * 1024 * 1024;

/**
 * A stable fake user id per gallery. The web app shows edit, delete, share and face-naming controls only when
 * `asset.ownerId === currentUser.id` (see web/src/lib/utils/asset-editability.ts), so presenting an id that owns
 * nothing makes the app render every asset read-only.
 */
export const publicUserId = (gallery: Gallery) => {
  const hex = createHash('sha256').update(`noodle-public-gateway:${gallery.host}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

const LOCATION_KEYS = new Set(['latitude', 'longitude', 'city', 'state', 'country']);
// `/api/search/explore` groups assets by field; a city group names places even with the coordinates gone
const LOCATION_GROUP = /^exifInfo\.(city|state|country)$/;

const scrub = (value: unknown, hideLocation: boolean): unknown => {
  if (Array.isArray(value)) {
    const items = hideLocation
      ? value.filter(
          (item) => !(item && typeof item === 'object' && LOCATION_GROUP.test(String((item as any).fieldName ?? ''))),
        )
      : value;
    return items.map((item) => scrub(item, hideLocation));
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  const result: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value)) {
    if (key === 'email') {
      result[key] = '';
    } else if (key === 'canEdit' || key === 'isAdmin') {
      // the server computes these for the real user; the web app trusts `canEdit` over ownership
      result[key] = false;
    } else if (key === 'thumbnailPath' && typeof field === 'string') {
      // a server path the web app never uses
      result[key] = '';
    } else if (key === 'originalPath' && typeof field === 'string') {
      // the server's directory layout (or an external library's) is private; the web app only needs the extension
      result[key] = field.split('/').at(-1) ?? '';
    } else if (hideLocation && LOCATION_KEYS.has(key)) {
      // timeline buckets are columnar: keep the array shape so indexes still line up
      result[key] = Array.isArray(field) ? field.map(() => null) : null;
    } else {
      result[key] = scrub(field, hideLocation);
    }
  }
  return result;
};

/**
 * Applied to every JSON response of the API: no email addresses, server paths or edit capabilities ever, and no
 * location when the gallery's `map` feature is off. Keyed on field names rather than routes, so routes added upstream are covered.
 */
const rewriteJson = (body: string, gallery: Gallery) => JSON.stringify(scrub(JSON.parse(body), !gallery.features.map));

const rewriteCurrentUser = (body: string, gallery: Gallery) => {
  const user = JSON.parse(rewriteJson(body, gallery)) as Record<string, unknown>;
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
  // plus `hideUnlistedPeople`, which needs the people lookup and runs in the proxy
  faces: rewriteJson,
  html: rewriteHtml,
  json: rewriteJson,
};

/** Content types each rewrite applies to; any other response passes through untouched */
const CONTENT_TYPES: Record<RewriteName, string> = {
  currentUser: 'application/json',
  faces: 'application/json',
  html: 'text/html',
  json: 'application/json',
};

export const appliesTo = (name: RewriteName, contentType: string | undefined) =>
  !!contentType && contentType.toLowerCase().startsWith(CONTENT_TYPES[name]);

export const rewriteBody = (name: RewriteName, body: string, gallery: Gallery) => REWRITERS[name](body, gallery);
