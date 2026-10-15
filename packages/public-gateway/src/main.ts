import { watchFile } from 'node:fs';
import { buildConfig, loadManifest, type GatewayConfig, type Manifest } from './config.ts';
import { provision } from './provision.ts';
import { createGateway } from './proxy.ts';

const configPath = process.env.GATEWAY_CONFIG ?? process.argv[2] ?? '/etc/public-gateway/gateway.yaml';

const log = (entry: Record<string, unknown>) =>
  console.log(JSON.stringify({ time: new Date().toISOString(), ...entry }));

const warn = (manifest: Manifest) => {
  for (const gallery of manifest.galleries) {
    if (gallery.features.downloadOriginal && !gallery.features.map) {
      console.warn(
        `${gallery.hosts.join(', ')}: downloadOriginal serves original files, whose embedded metadata (GPS included) ` +
          'the gateway cannot scrub, so location is not private even with map off',
      );
    }
  }
};

let manifest = loadManifest(configPath);
warn(manifest);
// manual galleries serve right away; provisioned ones join once their users and keys exist
let keys = new Map<string, string>();
let config: GatewayConfig = buildConfig(manifest, keys);

const RETRY_MS = 10_000;
// also re-checks that every gallery's key still works, so a key revoked in the Noodle UI is replaced
const RESYNC_MS = 5 * 60_000;

let running: Promise<void> | undefined;
let again = false;
let timer: NodeJS.Timeout | undefined;

/** Re-reads the file and creates whatever provisioned galleries still lack; runs one at a time */
const sync = (reason: string): Promise<void> => {
  if (running) {
    again = true;
    return running;
  }
  running = (async () => {
    clearTimeout(timer);
    let next = RESYNC_MS;
    try {
      const fresh = loadManifest(configPath);
      if (reason !== 'start') {
        warn(fresh);
      }
      manifest = fresh;
      config = buildConfig(manifest, keys);
      keys = await provision(manifest, log);
      config = buildConfig(manifest, keys);
      const pending = manifest.galleries.filter(
        (gallery) => gallery.source.kind === 'provisioned' && !keys.has(gallery.source.name.toLowerCase()),
      );
      if (pending.length > 0) {
        next = RETRY_MS;
      }
      log({ event: 'config', reason, galleries: [...config.galleries.keys()], pending: pending.length });
    } catch (error) {
      // a broken file or an unreachable Noodle keeps what is already serving
      next = RETRY_MS;
      log({ event: 'config-failed', reason, error: error instanceof Error ? error.message : String(error) });
    } finally {
      running = undefined;
      timer = setTimeout(() => void sync('periodic'), next);
      timer.unref();
      if (again) {
        again = false;
        void sync('changed while syncing');
      }
    }
  })();
  return running;
};

// edits to the file apply on their own; SIGHUP still works for key files and scripts
watchFile(configPath, { interval: 2000 }, (current, previous) => {
  if (current.mtimeMs !== previous.mtimeMs) {
    void sync('file changed');
  }
});
process.on('SIGHUP', () => void sync('SIGHUP'));

const server = createGateway(() => config);
server.listen(config.listen.port, config.listen.host, () => {
  console.log(`Public gateway on ${config.listen.host}:${config.listen.port} → ${config.upstream.origin}`);
  void sync('start');
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
