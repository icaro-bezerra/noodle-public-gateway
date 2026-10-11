import { describe, expect, it, vi } from 'vitest';
import type { Gallery } from './config.ts';
import { IdentityMap } from './identity.ts';
import { ALL_FEATURES } from './policy.ts';
import { appliesTo, publicUserId, rewriteBody } from './rewrite.ts';

const gallery: Gallery = {
  host: 'gal1.example.com',
  apiKey: 'key-one',
  title: 'Família',
  features: { ...ALL_FEATURES, downloadOriginal: false },
};
const other: Gallery = { ...gallery, host: 'gal2.example.com', apiKey: 'key-two' };
const REAL_ID = '11111111-1111-4111-8111-111111111111';

describe('publicUserId', () => {
  it('is a stable UUID that differs per gallery', () => {
    expect(publicUserId(gallery)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(publicUserId(gallery)).toBe(publicUserId({ ...gallery }));
    expect(publicUserId(gallery)).not.toBe(publicUserId(other));
  });
});

describe('rewriteBody', () => {
  it('replaces the identity in /api/users/me and keeps everything else', () => {
    const body = JSON.stringify({
      id: REAL_ID,
      email: 'owner@private.example',
      name: 'Owner',
      isAdmin: true,
      profileImagePath: '/data/profile/x.jpg',
      avatarColor: 'blue',
    });
    expect(JSON.parse(rewriteBody('currentUser', body, gallery))).toEqual({
      id: publicUserId(gallery),
      email: 'public@gal1.example.com',
      name: 'Família',
      isAdmin: false,
      profileImagePath: '',
      avatarColor: 'blue',
    });
  });

  it('marks the app shell with the enabled features', () => {
    const html = rewriteBody('html', '<!doctype html><html><head><title>x</title></head></html>', gallery);
    expect(html).toBe(
      '<!doctype html><html><head><meta name="noodle-public-gallery" content="people map smart-search">' +
        '<title>x</title></head></html>',
    );
  });

  it('only applies to the matching content type', () => {
    expect(appliesTo('html', 'text/html; charset=utf-8')).toBe(true);
    expect(appliesTo('html', 'application/javascript')).toBe(false);
    expect(appliesTo('currentUser', 'application/json')).toBe(true);
    expect(appliesTo('currentUser', undefined)).toBe(false);
  });
});

describe('IdentityMap', () => {
  it('maps the fake id back to the real one, resolving it once per key', async () => {
    const fetchUserId = vi.fn().mockResolvedValue(REAL_ID);
    const identity = new IdentityMap(fetchUserId);
    const fake = publicUserId(gallery);

    expect(await identity.translate(gallery, `/api/timeline/buckets?userId=${fake}`)).toBe(
      `/api/timeline/buckets?userId=${REAL_ID}`,
    );
    expect(await identity.translate(gallery, `{"userIds":["${fake}"]}`)).toBe(`{"userIds":["${REAL_ID}"]}`);
    expect(fetchUserId).toHaveBeenCalledTimes(1);
  });

  it('leaves values without the fake id alone and never resolves for them', async () => {
    const fetchUserId = vi.fn();
    const identity = new IdentityMap(fetchUserId);
    expect(await identity.translate(gallery, '/api/timeline/buckets')).toBe('/api/timeline/buckets');
    // another gallery's fake id is not this gallery's to translate
    expect(await identity.translate(gallery, publicUserId(other))).toBe(publicUserId(other));
    expect(fetchUserId).not.toHaveBeenCalled();
  });

  it('retries after a failed lookup', async () => {
    const fetchUserId = vi.fn().mockRejectedValueOnce(new Error('down')).mockResolvedValue(REAL_ID);
    const identity = new IdentityMap(fetchUserId);
    const fake = publicUserId(gallery);
    await expect(identity.translate(gallery, fake)).rejects.toThrow('down');
    expect(await identity.translate(gallery, fake)).toBe(REAL_ID);
  });
});
