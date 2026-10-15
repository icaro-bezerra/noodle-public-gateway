import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildConfig, parseConfig, parseManifest } from './config.ts';

const dir = mkdtempSync(join(tmpdir(), 'public-gateway-'));
writeFileSync(join(dir, 'gal1.key'), 'secret-one\n');
writeFileSync(join(dir, 'empty.key'), '\n');
writeFileSync(join(dir, 'admin.key'), 'admin-secret\n');

describe('parseConfig', () => {
  it('loads galleries, reads key files relative to the config and defaults features to private', () => {
    const config = parseConfig(
      `
upstream: http://gallery-server:2283
galleries:
  - host: Gal1.Example.com
    apiKeyFile: gal1.key
    features: { people: true }
`,
      dir,
    );
    expect(config.listen).toEqual({ host: '0.0.0.0', port: 8080 });
    expect(config.galleries.get('gal1.example.com')).toEqual({
      host: 'gal1.example.com',
      apiKey: 'secret-one',
      title: undefined,
      features: { people: true, map: false, smartSearch: true, downloadOriginal: false },
    });
  });

  it('rejects duplicate hosts', () => {
    expect(() =>
      parseConfig(
        `
upstream: http://gallery-server:2283
galleries:
  - { host: a.example.com, apiKeyFile: gal1.key }
  - { host: A.example.com, apiKeyFile: gal1.key }
`,
        dir,
      ),
    ).toThrow(/Duplicate host/);
  });

  it('rejects unknown keys, so a typo never silently disables a setting', () => {
    expect(() =>
      parseConfig(
        `
upstream: http://gallery-server:2283
galleries:
  - { host: a.example.com, apiKeyFile: gal1.key, features: { peopel: true } }
`,
        dir,
      ),
    ).toThrow();
  });

  it('rejects an empty key file', () => {
    expect(() =>
      parseConfig(
        `
upstream: http://gallery-server:2283
galleries:
  - { host: a.example.com, apiKeyFile: empty.key }
`,
        dir,
      ),
    ).toThrow(/empty/);
  });
});

describe('provisioned galleries', () => {
  const source = `
upstream: http://gallery-server:2283
adminApiKeyFile: admin.key
stateDir: state
galleries:
  - name: Família
    hosts: [familia.example.com, Familia.Tunnel.example]
    spaces: Família
    features: { people: true }
  - host: manual.example.com
    apiKeyFile: gal1.key
`;

  it('reads them without a key, which the gateway creates later', () => {
    const manifest = parseManifest(source, dir);
    expect(manifest.adminApiKey).toBe('admin-secret');
    expect(manifest.stateDir).toBe(join(dir, 'state'));
    expect(manifest.galleries[0]).toEqual({
      hosts: ['familia.example.com', 'familia.tunnel.example'],
      title: 'Família',
      features: { people: true, map: false, smartSearch: true, downloadOriginal: false },
      source: { kind: 'provisioned', name: 'Família', spaces: ['Família'] },
    });
  });

  it('serves a provisioned gallery on every host once its key exists, and manual ones right away', () => {
    const manifest = parseManifest(source, dir);
    expect([...buildConfig(manifest).galleries.keys()]).toEqual(['manual.example.com']);
    const config = buildConfig(manifest, new Map([['família', 'issued-key']]));
    expect(config.galleries.get('familia.tunnel.example')).toMatchObject({ apiKey: 'issued-key', title: 'Família' });
    expect(config.galleries.size).toBe(3);
  });

  it.each([
    ['without the admin key', 'galleries:\n  - { name: A, host: a.example.com, spaces: A }', /adminApiKeyFile/],
    [
      'with both kinds at once',
      'adminApiKeyFile: admin.key\ngalleries:\n  - { name: A, host: a.example.com, spaces: A, apiKeyFile: gal1.key }',
      /either/,
    ],
    [
      'with a name but no spaces',
      'adminApiKeyFile: admin.key\ngalleries:\n  - { name: A, host: a.example.com }',
      /both/,
    ],
    ['with no host', 'adminApiKeyFile: admin.key\ngalleries:\n  - { name: A, spaces: A }', /host/],
    [
      'with a duplicate name',
      'adminApiKeyFile: admin.key\ngalleries:\n  - { name: A, host: a.example.com, spaces: A }\n  - { name: a, host: b.example.com, spaces: B }',
      /Duplicate name/,
    ],
  ])('rejects a gallery %s', (_, galleries, error) => {
    expect(() => parseManifest(`upstream: http://gallery-server:2283\n${galleries}\n`, dir)).toThrow(error);
  });
});
