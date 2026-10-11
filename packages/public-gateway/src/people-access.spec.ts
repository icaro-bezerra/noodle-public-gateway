import { describe, expect, it, vi } from 'vitest';
import type { Gallery } from './config.ts';
import { hideUnlistedPeople, PeopleAccess } from './people-access.ts';
import { ALL_FEATURES } from './policy.ts';

const gallery: Gallery = { host: 'gal1.example.com', apiKey: 'key-one', features: ALL_FEATURES };

describe('PeopleAccess', () => {
  it('allows the listed people and loads the list once', async () => {
    const fetchPeople = vi.fn().mockResolvedValue(['own', 'space']);
    const access = new PeopleAccess(fetchPeople, () => 0);
    expect(await access.allows(gallery, 'own')).toBe(true);
    expect(await access.allows(gallery, 'space')).toBe(true);
    expect(fetchPeople).toHaveBeenCalledTimes(1);
  });

  it('refuses unlisted people and refreshes for them at most every 30 seconds', async () => {
    let now = 0;
    const fetchPeople = vi.fn().mockResolvedValueOnce(['own']).mockResolvedValue(['own', 'renamed-later']);
    const access = new PeopleAccess(fetchPeople, () => now);

    expect(await access.allows(gallery, 'someone-elses')).toBe(false);
    now = 10_000;
    expect(await access.allows(gallery, 'someone-elses')).toBe(false);
    expect(fetchPeople).toHaveBeenCalledTimes(1);

    now = 40_000;
    expect(await access.allows(gallery, 'renamed-later')).toBe(true);
    expect(fetchPeople).toHaveBeenCalledTimes(2);
  });

  it('shares one lookup between concurrent requests', async () => {
    const fetchPeople = vi.fn().mockResolvedValue(['own']);
    const access = new PeopleAccess(fetchPeople, () => 0);
    expect(
      await Promise.all([access.allows(gallery, 'own'), access.allows(gallery, 'own'), access.allows(gallery, 'x')]),
    ).toEqual([true, true, false]);
    expect(fetchPeople).toHaveBeenCalledTimes(1);
  });
});

describe('hideUnlistedPeople', () => {
  it('keeps the face but drops a person the gallery does not list', async () => {
    const access = new PeopleAccess(vi.fn().mockResolvedValue(['listed']), () => 0);
    const body = JSON.stringify([
      { id: 'f1', boundingBoxX1: 1, person: { id: 'listed', name: 'Maria' } },
      { id: 'f2', boundingBoxX1: 2, person: { id: 'OWNERS-PRIVATE', name: 'João', birthDate: '1980-01-01' } },
      { id: 'f3', boundingBoxX1: 3, person: null },
    ]);
    expect(JSON.parse(await hideUnlistedPeople(body, gallery, access))).toEqual([
      { id: 'f1', boundingBoxX1: 1, person: { id: 'listed', name: 'Maria' } },
      { id: 'f2', boundingBoxX1: 2, person: null },
      { id: 'f3', boundingBoxX1: 3, person: null },
    ]);
  });
});
