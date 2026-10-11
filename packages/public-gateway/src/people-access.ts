import type { Gallery } from './config.ts';

type FetchPeople = (gallery: Gallery) => Promise<string[]>;

const TTL_MS = 5 * 60 * 1000;
/** Unknown ids trigger a refresh at most this often, so probing cannot hammer the server */
const MIN_REFRESH_MS = 30 * 1000;

type Entry = { ids: Set<string>; loadedAt: number; pending?: Promise<Set<string>> };

/**
 * The people a gallery may show: what `GET /api/people?withSharedSpaces=true` lists for its user, which is the
 * user's own visible people plus the people of its Shared Spaces.
 *
 * `/api/people/{id}/**` must stay within that set. The server lets a space member read any person that has one face
 * in the space, including the owner's private row and a thumbnail cropped from a photo outside the space, and
 * `GET /api/faces` hands out those ids. Hidden people are not listed either, so they stay hidden.
 */
export class PeopleAccess {
  readonly #fetchPeople: FetchPeople;
  readonly #now: () => number;
  readonly #cache = new Map<string, Entry>();

  constructor(fetchPeople: FetchPeople, now: () => number = Date.now) {
    this.#fetchPeople = fetchPeople;
    this.#now = now;
  }

  async allows(gallery: Gallery, personId: string): Promise<boolean> {
    let entry = this.#cache.get(gallery.apiKey);
    if (entry?.pending) {
      await entry.pending.catch(() => {});
    }
    const age = entry ? this.#now() - entry.loadedAt : Infinity;
    if (!entry || age > TTL_MS || (!entry.ids.has(personId) && age > MIN_REFRESH_MS)) {
      entry = await this.#refresh(gallery, entry);
    }
    return entry.ids.has(personId);
  }

  async #refresh(gallery: Gallery, previous?: Entry): Promise<Entry> {
    if (previous?.pending) {
      await previous.pending;
      return this.#cache.get(gallery.apiKey)!;
    }
    const entry: Entry = previous ?? { ids: new Set(), loadedAt: 0 };
    entry.pending = this.#fetchPeople(gallery).then((ids) => new Set(ids));
    this.#cache.set(gallery.apiKey, entry);
    try {
      entry.ids = await entry.pending;
      entry.loadedAt = this.#now();
    } finally {
      entry.pending = undefined;
    }
    return entry;
  }
}

/**
 * `GET /api/faces` attaches the owner's own person row to faces on any asset the caller can read, private name and
 * birth date included. Faces whose person the gallery does not list keep their box but lose the identity.
 */
export const hideUnlistedPeople = async (body: string, gallery: Gallery, access: PeopleAccess) => {
  const faces = JSON.parse(body) as unknown;
  if (!Array.isArray(faces)) {
    return body;
  }
  for (const face of faces as { person?: { id?: string } | null }[]) {
    const id = face?.person?.id;
    if (id && !(await access.allows(gallery, id.toLowerCase()))) {
      face.person = null;
    }
  }
  return JSON.stringify(faces);
};
