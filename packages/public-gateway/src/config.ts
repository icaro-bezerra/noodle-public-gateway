import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import type { Features } from './policy.ts';

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
    galleries,
  };
};

export const loadConfig = (path: string): GatewayConfig => parseConfig(readFileSync(path, 'utf8'), dirname(path));
