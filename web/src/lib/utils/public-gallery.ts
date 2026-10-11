import { browser } from '$app/environment';

const MARKER = 'meta[name="noodle-public-gallery"]';

/**
 * True when the app is served by the public gateway (packages/public-gateway), which marks its pages with
 * `<meta name="noodle-public-gallery">`. Visitors there can browse but never change anything, so controls that
 * write are hidden. This is presentation only: the gateway and the read-only API key enforce it.
 */
export const isPublicGallery = browser && !!document.querySelector<Element>(MARKER);

/** Gateway features enabled for this gallery, e.g. `download` (listed in the meta tag's `content`) */
export const publicGalleryAllows = (feature: string) =>
  !isPublicGallery ||
  (document.querySelector<Element>(MARKER)?.getAttribute('content') ?? '').split(/\s+/).includes(feature);
