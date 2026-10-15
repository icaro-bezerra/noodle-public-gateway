import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import type { Features } from './policy.ts';
import type { RateLimitRule } from './rate-limit.ts';

const FeaturesSchema = z
  .object({
    people: z.boolean().default(false),
    map: z.boolean().default(false),
    smartSearch: z.boolean().default(true),
    downloadOriginal: z.boolean().default(false),
  })
  .strict();

const Host = z
  .string()
  .min(1)
  .transform((host) => host.toLowerCase());

const GallerySchema = z
  .object({
    host: Host.optional(),
    hosts: z.array(Host).min(1).optional(),
    title: z.string().min(1).optional(),
    features: FeaturesSchema.default(FeaturesSchema.parse({})),
    /** Manual: the gallery user's read-only API key, created by hand */
    apiKeyFile: z.string().min(1).optional(),
    /** Provisioned: the gateway creates a user with this name and makes it a Viewer of `spaces` */
    name: z.string().min(1).optional(),
    spaces: z
      .union([
        z
          .string()
          .min(1)
          .transform((space) => [space]),
        z.array(z.string().min(1)).min(1),
      ])
      .optional(),
  })
  .strict()
  .superRefine((gallery, ctx) => {
    if (!gallery.host === !gallery.hosts) {
      ctx.addIssue({ code: 'custom', message: 'Set either `host` or `hosts`' });
    }
    const manual = gallery.apiKeyFile !== undefined;
    const provisioned = gallery.name !== undefined || gallery.spaces !== undefined;
    if (manual === provisioned) {
      ctx.addIssue({
        code: 'custom',
        message: 'Set either `apiKeyFile` (a key you created) or `name` and `spaces` (the gateway creates the user)',
      });
    } else if (provisioned && (!gallery.name || !gallery.spaces)) {
      ctx.addIssue({ code: 'custom', message: 'A provisioned gallery needs both `name` and `spaces`' });
    }
  });

const RateRuleSchema = z.object({ perSecond: z.number().min(0), burst: z.number().int().min(1) }).strict();

const DEFAULT_RATE_LIMIT = {
  // a timeline page pulls a thumbnail per photo on screen, so the general budget has to be generous
  default: { perSecond: 100, burst: 400 },
  // smart search runs the ML model, metadata search and archive downloads hit the database or disk hard
  expensive: { perSecond: 1, burst: 10 },
};

const ConfigSchema = z
  .object({
    upstream: z.url({ protocol: /^https?$/ }),
    listen: z
      .object({ host: z.string().default('0.0.0.0'), port: z.number().int().min(1).max(65_535).default(8080) })
      .strict()
      .default({ host: '0.0.0.0', port: 8080 }),
    /** Trust X-Forwarded-For from the edge proxy in front of the gateway */
    trustProxy: z.boolean().default(false),
    maxBodyBytes: z.number().int().positive().default(65_536),
    rateLimit: z
      .object({ default: RateRuleSchema, expensive: RateRuleSchema })
      .partial()
      .strict()
      .default({})
      .transform((rules) => ({ ...DEFAULT_RATE_LIMIT, ...rules })),
    /** Let search engines index the galleries; off by default, family galleries rarely want it */
    allowIndexing: z.boolean().default(false),
    /** An admin's API key, used only to create provisioned galleries (see README.md#provisioned-galleries) */
    adminApiKeyFile: z.string().min(1).optional(),
    /** Where the gateway keeps the keys of the gallery users it created */
    stateDir: z.string().min(1).default('/var/lib/public-gateway'),
    galleries: z.array(GallerySchema).min(1),
  })
  .strict()
  .superRefine((config, ctx) => {
    const hosts = new Set<string>();
    const names = new Set<string>();
    for (const [index, gallery] of config.galleries.entries()) {
      for (const host of gallery.hosts ?? [gallery.host!]) {
        if (hosts.has(host)) {
          ctx.addIssue({ code: 'custom', path: ['galleries', index], message: `Duplicate host ${host}` });
        }
        hosts.add(host);
      }
      if (gallery.name) {
        const key = gallery.name.toLowerCase();
        if (names.has(key)) {
          ctx.addIssue({
            code: 'custom',
            path: ['galleries', index, 'name'],
            message: `Duplicate name ${gallery.name}`,
          });
        }
        names.add(key);
      }
    }
    if (names.size > 0 && !config.adminApiKeyFile) {
      ctx.addIssue({
        code: 'custom',
        path: ['adminApiKeyFile'],
        message: 'Galleries with `name` and `spaces` are created by the gateway, which needs `adminApiKeyFile`',
      });
    }
  });

export type Gallery = {
  host: string;
  apiKey: string;
  title?: string;
  features: Features;
};

export type GalleryManifest = {
  hosts: string[];
  title?: string;
  features: Features;
  source: { kind: 'manual'; apiKey: string } | { kind: 'provisioned'; name: string; spaces: string[] };
};

/** The config file as written: galleries the gateway still has to create carry no key yet */
export type Manifest = {
  upstream: URL;
  listen: { host: string; port: number };
  trustProxy: boolean;
  maxBodyBytes: number;
  rateLimit: { default: RateLimitRule; expensive: RateLimitRule };
  allowIndexing: boolean;
  adminApiKey?: string;
  stateDir: string;
  galleries: GalleryManifest[];
};

export type GatewayConfig = Omit<Manifest, 'galleries' | 'adminApiKey' | 'stateDir'> & {
  galleries: Map<string, Gallery>;
};

const readKey = (baseDir: string, file: string, what: string) => {
  const key = readFileSync(resolve(baseDir, file), 'utf8').trim();
  if (!key) {
    throw new Error(`API key file for ${what} is empty`);
  }
  return key;
};

export const parseManifest = (source: string, baseDir: string): Manifest => {
  const config = ConfigSchema.parse(parse(source));
  return {
    upstream: new URL(config.upstream),
    listen: config.listen,
    trustProxy: config.trustProxy,
    maxBodyBytes: config.maxBodyBytes,
    rateLimit: config.rateLimit,
    allowIndexing: config.allowIndexing,
    adminApiKey: config.adminApiKeyFile ? readKey(baseDir, config.adminApiKeyFile, 'the admin') : undefined,
    stateDir: resolve(baseDir, config.stateDir),
    galleries: config.galleries.map((gallery) => {
      const hosts = gallery.hosts ?? [gallery.host!];
      return {
        hosts,
        title: gallery.title ?? gallery.name,
        features: gallery.features,
        source: gallery.apiKeyFile
          ? { kind: 'manual', apiKey: readKey(baseDir, gallery.apiKeyFile, hosts[0]) }
          : { kind: 'provisioned', name: gallery.name!, spaces: gallery.spaces! },
      };
    }),
  };
};

/**
 * The config the proxy serves. `provisionedKeys` maps a provisioned gallery's `name` to its key; galleries without
 * one yet (still being created, or failed) are left out until they have it.
 */
export const buildConfig = (manifest: Manifest, provisionedKeys = new Map<string, string>()): GatewayConfig => {
  const galleries = new Map<string, Gallery>();
  for (const gallery of manifest.galleries) {
    const apiKey =
      gallery.source.kind === 'manual' ? gallery.source.apiKey : provisionedKeys.get(gallery.source.name.toLowerCase());
    if (!apiKey) {
      continue;
    }
    for (const host of gallery.hosts) {
      galleries.set(host, { host, apiKey, title: gallery.title, features: gallery.features });
    }
  }
  return {
    upstream: manifest.upstream,
    listen: manifest.listen,
    trustProxy: manifest.trustProxy,
    maxBodyBytes: manifest.maxBodyBytes,
    rateLimit: manifest.rateLimit,
    allowIndexing: manifest.allowIndexing,
    galleries,
  };
};

export const parseConfig = (source: string, baseDir: string): GatewayConfig =>
  buildConfig(parseManifest(source, baseDir));

export const loadManifest = (path: string): Manifest => parseManifest(readFileSync(path, 'utf8'), dirname(path));

export const loadConfig = (path: string): GatewayConfig => buildConfig(loadManifest(path));
