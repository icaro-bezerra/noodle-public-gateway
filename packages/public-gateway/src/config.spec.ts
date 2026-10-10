import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseConfig } from './config.ts';

const dir = mkdtempSync(join(tmpdir(), 'public-gateway-'));
writeFileSync(join(dir, 'gal1.key'), 'secret-one\n');
writeFileSync(join(dir, 'empty.key'), '\n');

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
