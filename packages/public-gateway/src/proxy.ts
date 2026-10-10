import {
  request as httpRequest,
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { Duplex } from 'node:stream';
import type { Gallery, GatewayConfig } from './config.ts';
import { decide, type Decision } from './policy.ts';
import { buildUpstreamHeaders, normalizePath, stripCredentialParams } from './request.ts';

/** Lets the web app skip its login redirect; it carries no secret. */
const AUTH_COOKIE = 'immich_is_authenticated=true; Path=/; SameSite=Lax';

const SOCKET_PATH = '/api/socket.io';

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

const BODYLESS_METHODS = new Set(['GET', 'HEAD', 'DELETE']);

type Resolved = { gallery: Gallery; path: string; query: string };

type Log = (entry: Record<string, unknown>) => void;

const defaultLog: Log = (entry) => console.log(JSON.stringify({ time: new Date().toISOString(), ...entry }));

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const resolve = (config: GatewayConfig, req: IncomingMessage): Resolved => {
  const url = req.url ?? '';
  // absolute-form targets (`GET http://other/...`) could point the request somewhere else
  if (!url.startsWith('/')) {
    throw new HttpError(400, 'Bad request');
  }
  const host = (req.headers.host ?? '').toLowerCase().replace(/:\d+$/, '');
  const gallery = config.galleries.get(host);
  if (!gallery) {
    throw new HttpError(404, 'Not found');
  }
  const queryIndex = url.indexOf('?');
  const path = normalizePath(queryIndex === -1 ? url : url.slice(0, queryIndex));
  if (!path) {
    throw new HttpError(400, 'Bad request');
  }
  const query = queryIndex === -1 ? '' : stripCredentialParams(new URLSearchParams(url.slice(queryIndex + 1)));
  return { gallery, path, query };
};

const clientIp = (config: GatewayConfig, req: IncomingMessage) => {
  const remote = req.socket.remoteAddress;
  const forwarded = req.headers['x-forwarded-for'];
  if (config.trustProxy && typeof forwarded === 'string') {
    return remote ? `${forwarded}, ${remote}` : forwarded;
  }
  return remote;
};

const sendJson = (res: ServerResponse, method: string, status: number, body?: unknown) => {
  if (body === undefined) {
    res.writeHead(status).end();
    return;
  }
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(method === 'HEAD' ? undefined : payload);
};

const readBody = (req: IncomingMessage, maxBytes: number): Promise<Buffer | undefined> => {
  const method = req.method ?? 'GET';
  const length = req.headers['content-length'];
  if (req.headers['transfer-encoding']) {
    // ambiguous framing is how request smuggling starts; the web app always sends a content-length
    return Promise.reject(new HttpError(411, 'Length required'));
  }
  if (length === undefined || length === '0') {
    return Promise.resolve(undefined);
  }
  if (BODYLESS_METHODS.has(method)) {
    return Promise.reject(new HttpError(400, 'Unexpected body'));
  }
  if (!/^\d+$/.test(length) || Number(length) > maxBytes) {
    return Promise.reject(new HttpError(413, 'Payload too large'));
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new HttpError(413, 'Payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
};

/** Consumes a body the gateway will not forward, so the keep-alive connection stays usable */
const discardBody = (req: IncomingMessage, maxBytes: number) =>
  new Promise<void>((resolve) => {
    if (req.complete) {
      resolve();
      return;
    }
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        req.socket.destroy();
        resolve();
      }
    });
    req.on('end', resolve);
    req.on('close', resolve);
  });

const upstreamRequest = (config: GatewayConfig) => (config.upstream.protocol === 'https:' ? httpsRequest : httpRequest);

const upstreamOptions = (config: GatewayConfig, method: string, path: string, headers: Record<string, unknown>) => ({
  protocol: config.upstream.protocol,
  hostname: config.upstream.hostname,
  port: config.upstream.port || undefined,
  method,
  path,
  headers: headers as Record<string, string>,
});

const responseHeaders = (upstream: IncomingMessage, isApi: boolean) => {
  const headers: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(upstream.headers)) {
    if (value === undefined || HOP_BY_HOP.has(name) || name === 'set-cookie') {
      continue;
    }
    headers[name] = value;
  }
  if (!isApi) {
    headers['set-cookie'] = [AUTH_COOKIE];
  }
  headers['x-content-type-options'] = 'nosniff';
  headers['referrer-policy'] = 'same-origin';
  return headers;
};

const forward = async (config: GatewayConfig, req: IncomingMessage, res: ServerResponse, target: Resolved) => {
  const method = req.method ?? 'GET';
  const body = await readBody(req, config.maxBodyBytes);
  const headers = buildUpstreamHeaders(req.headers, {
    apiKey: target.gallery.apiKey,
    host: target.gallery.host,
    clientIp: clientIp(config, req),
  });
  if (body) {
    headers['content-length'] = body.length;
  }

  await new Promise<void>((resolve, reject) => {
    const upstream = upstreamRequest(config)(
      upstreamOptions(config, method, target.path + target.query, headers),
      (upstreamRes) => {
        const isApi = target.path.toLowerCase().startsWith('/api');
        res.writeHead(upstreamRes.statusCode ?? 502, responseHeaders(upstreamRes, isApi));
        upstreamRes.pipe(res);
        upstreamRes.on('end', resolve);
        upstreamRes.on('error', reject);
      },
    );
    upstream.on('error', reject);
    res.on('close', () => upstream.destroy());
    upstream.end(body);
  });
};

const answer = (res: ServerResponse, method: string, decision: Exclude<Decision, { action: 'forward' }>) => {
  switch (decision.action) {
    case 'fake': {
      sendJson(res, method, decision.status, decision.body);
      return;
    }
    case 'redirect': {
      res.writeHead(302, { location: decision.location }).end();
      return;
    }
    case 'deny': {
      sendJson(res, method, decision.status, { message: decision.status === 404 ? 'Not found' : 'Forbidden' });
      return;
    }
  }
};

const handleUpgrade = (config: GatewayConfig, req: IncomingMessage, socket: Duplex, head: Buffer, log: Log) => {
  socket.on('error', () => socket.destroy());
  let target: Resolved;
  try {
    target = resolve(config, req);
  } catch {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    return;
  }
  if (target.path !== SOCKET_PATH || req.method !== 'GET') {
    log({ event: 'denied', host: target.gallery.host, method: req.method, path: target.path, status: 403 });
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    return;
  }

  const headers = buildUpstreamHeaders(req.headers, {
    apiKey: target.gallery.apiKey,
    host: target.gallery.host,
    clientIp: clientIp(config, req),
    websocket: true,
  });
  // Engine.IO only answers on the path with its trailing slash, which normalizePath removed
  const upstream = upstreamRequest(config)(upstreamOptions(config, 'GET', `${SOCKET_PATH}/${target.query}`, headers));

  upstream.on('upgrade', (upstreamRes, upstreamSocket, upstreamHead) => {
    const lines = [`HTTP/1.1 101 ${upstreamRes.statusMessage ?? 'Switching Protocols'}`];
    for (const [name, value] of Object.entries(upstreamRes.headers)) {
      if (value === undefined || name === 'set-cookie') {
        continue;
      }
      for (const item of Array.isArray(value) ? value : [value]) {
        lines.push(`${name}: ${item}`);
      }
    }
    socket.write(lines.join('\r\n') + '\r\n\r\n');
    if (upstreamHead.length > 0) {
      socket.write(upstreamHead);
    }
    if (head.length > 0) {
      upstreamSocket.write(head);
    }
    upstreamSocket.on('error', () => socket.destroy());
    socket.on('close', () => upstreamSocket.destroy());
    upstreamSocket.on('close', () => socket.destroy());
    // The server has no client message handlers (the socket is push-only), so client frames are inert; they still
    // have to pass because Engine.IO heartbeats are client → server pongs.
    upstreamSocket.pipe(socket).pipe(upstreamSocket);
  });
  upstream.on('response', (upstreamRes) => {
    socket.end(`HTTP/1.1 ${upstreamRes.statusCode} ${upstreamRes.statusMessage ?? ''}\r\nConnection: close\r\n\r\n`);
    upstreamRes.resume();
  });
  upstream.on('error', () => socket.destroy());
  upstream.end();
};

export const createGateway = (getConfig: () => GatewayConfig, log: Log = defaultLog): Server => {
  const server = createServer((req, res) => {
    const config = getConfig();
    const method = req.method ?? 'GET';
    let target: Resolved | undefined;
    const handle = async () => {
      target = resolve(config, req);
      const decision = decide(method, target.path, target.gallery.features);
      if (decision.action !== 'forward') {
        if (decision.action === 'deny') {
          log({ event: 'denied', host: target.gallery.host, method, path: target.path, status: decision.status });
        }
        await discardBody(req, config.maxBodyBytes);
        answer(res, method, decision);
        return;
      }
      await forward(config, req, res, target);
    };

    handle().catch((error: unknown) => {
      const status = error instanceof HttpError ? error.status : 502;
      if (status === 502) {
        log({ event: 'upstream-error', host: target?.gallery.host, method, path: target?.path, error: String(error) });
      }
      if (res.headersSent) {
        res.destroy();
        return;
      }
      // the body may be partly read, so the connection cannot be reused safely
      res.shouldKeepAlive = false;
      sendJson(res, method, status, { message: error instanceof HttpError ? error.message : 'Bad gateway' });
      req.resume();
    });
  });

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) =>
    handleUpgrade(getConfig(), req, socket, head, log),
  );

  return server;
};
