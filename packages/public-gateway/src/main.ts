import { loadConfig, type GatewayConfig } from './config.ts';
import { createGateway } from './proxy.ts';

const configPath = process.env.GATEWAY_CONFIG ?? process.argv[2] ?? '/etc/public-gateway/gateway.yaml';

let config: GatewayConfig = loadConfig(configPath);

const warn = (config: GatewayConfig) => {
  for (const gallery of config.galleries.values()) {
    if (gallery.features.downloadOriginal && !gallery.features.map) {
      console.warn(
        `${gallery.host}: downloadOriginal serves original files, whose embedded metadata (GPS included) ` +
          'the gateway cannot scrub, so location is not private even with map off',
      );
    }
  }
};
warn(config);

// SIGHUP re-reads the config and API keys; a broken config keeps the previous one running.
process.on('SIGHUP', () => {
  try {
    config = loadConfig(configPath);
    warn(config);
    console.log(`Reloaded ${configPath}: ${config.galleries.size} galleries`);
  } catch (error) {
    console.error(`Reload of ${configPath} failed, keeping the previous config:`, error);
  }
});

const server = createGateway(() => config);
server.listen(config.listen.port, config.listen.host, () => {
  console.log(
    `Public gateway on ${config.listen.host}:${config.listen.port} → ${config.upstream.origin} ` +
      `(${[...config.galleries.keys()].join(', ')})`,
  );
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
