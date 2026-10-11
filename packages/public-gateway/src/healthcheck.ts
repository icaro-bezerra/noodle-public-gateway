// Container health check: asks the running gateway, on the port its config listens on, for /healthz.
import { loadConfig } from './config.ts';

const { listen } = loadConfig(process.env.GATEWAY_CONFIG ?? process.argv[2] ?? '/etc/public-gateway/gateway.yaml');
const host = listen.host === '0.0.0.0' || listen.host === '::' ? '127.0.0.1' : listen.host;
try {
  const res = await fetch(`http://${host}:${listen.port}/healthz`, { signal: AbortSignal.timeout(2000) });
  process.exit(res.ok ? 0 : 1);
} catch {
  process.exit(1);
}
