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

const GallerySchema = z
  .object({
    host: z
      .string()
      .min(1)
      .transform((host) => host.toLowerCase()),
    apiKeyFile: z.string().min(1),
    title: z.string().min(1).optional(),
    features: FeaturesSchema.default(FeaturesSchema.parse({})),
  })
  .strict();

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
    galleries: z.array(GallerySchema).min(1),
  })
  .strict()
  .superRefine((config, ctx) => {
    const seen = new Set<string>();
    for (const [index, gallery] of config.galleries.entries()) {
      if (seen.has(gallery.host)) {
        ctx.addIssue({ code: 'custom', path: ['galleries', index, 'host'], message: `Duplicate host ${gallery.host}` });
      }
      seen.add(gallery.host);
    }
  });

export type Gallery = {
  host: string;
  apiKey: string;
  title?: string;
  features: Features;
};

export type GatewayConfig = {
  upstream: URL;
  listen: { host: string; port: number };
  trustProxy: boolean;
  maxBodyBytes: number;
  rateLimit: { default: RateLimitRule; expensive: RateLimitRule };
  allowIndexing: boolean;
  galleries: Map<string, Gallery>;
};

export const parseConfig = (source: string, baseDir: string): GatewayConfig => {
  const config = ConfigSchema.parse(parse(source));
  const galleries = new Map<string, Gallery>();
  for (const gallery of config.galleries) {
    const apiKey = readFileSync(resolve(baseDir, gallery.apiKeyFile), 'utf8').trim();
    if (!apiKey) {
      throw new Error(`API key file for ${gallery.host} is empty`);
    }
    galleries.set(gallery.host, { host: gallery.host, apiKey, title: gallery.title, features: gallery.features });
  }
  return {
    upstream: new URL(config.upstream),
    listen: config.listen,
    trustProxy: config.trustProxy,
    maxBodyBytes: config.maxBodyBytes,
    rateLimit: config.rateLimit,
    allowIndexing: config.allowIndexing,
    galleries,
  };
};

export const loadConfig = (path: string): GatewayConfig => parseConfig(readFileSync(path, 'utf8'), dirname(path));
