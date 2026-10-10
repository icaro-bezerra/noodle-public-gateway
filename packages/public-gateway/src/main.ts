import { loadConfig, type GatewayConfig } from './config.ts';
import { createGateway } from './proxy.ts';

const configPath = process.env.GATEWAY_CONFIG ?? process.argv[2] ?? '/etc/public-gateway/gateway.yaml';

let config: GatewayConfig = loadConfig(configPath);

// SIGHUP re-reads the config and API keys; a broken config keeps the previous one running.
process.on('SIGHUP', () => {
  try {
    config = loadConfig(configPath);
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
