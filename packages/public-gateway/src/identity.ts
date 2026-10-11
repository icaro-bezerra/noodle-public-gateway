import type { Gallery } from './config.ts';
import { publicUserId } from './rewrite.ts';

type FetchUser = (gallery: Gallery) => Promise<string>;

/**
 * The web app is shown a fake user id (see `publicUserId`) but still sends that id back in queries such as
 * `/api/timeline/buckets?userId=…`. This maps it back to the real id before the request goes upstream.
 */
export class IdentityMap {
  readonly #fetchUserId: FetchUser;
  readonly #cache = new Map<string, Promise<string>>();

  constructor(fetchUserId: FetchUser) {
    this.#fetchUserId = fetchUserId;
  }

  realUserId(gallery: Gallery): Promise<string> {
    // keyed by API key, so a key rotated through a config reload resolves again
    let id = this.#cache.get(gallery.apiKey);
    if (!id) {
      id = this.#fetchUserId(gallery);
      id.catch(() => this.#cache.delete(gallery.apiKey));
      this.#cache.set(gallery.apiKey, id);
    }
    return id;
  }

  /** Replaces the fake id with the real one, or returns the input unchanged when it does not contain it */
  async translate(gallery: Gallery, value: string): Promise<string> {
    const fake = publicUserId(gallery);
    if (!value.includes(fake)) {
      return value;
    }
    return value.replaceAll(fake, await this.realUserId(gallery));
  }
}
