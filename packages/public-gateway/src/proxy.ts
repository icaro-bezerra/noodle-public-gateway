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
import { IdentityMap } from './identity.ts';
import { decide, requestsPrivateAssets, upstreamQuery, type Decision } from './policy.ts';
import { buildUpstreamHeaders, normalizePath, stripCredentialParams } from './request.ts';
import { appliesTo, MAX_REWRITE_BYTES, rewriteBody, type RewriteName } from './rewrite.ts';

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

const readAll = (stream: IncomingMessage, maxBytes: number) =>
  new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    stream.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        stream.destroy(new Error('Upstream response too large to rewrite'));
        return;
      }
      chunks.push(chunk);
    });
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });

const sendRewritten = async (
  res: ServerResponse,
  upstreamRes: IncomingMessage,
  headers: Record<string, string | string[]>,
  rewrite: RewriteName,
  target: Resolved,
) => {
  const original = await readAll(upstreamRes, MAX_REWRITE_BYTES);
  const body = Buffer.from(rewriteBody(rewrite, original.toString('utf8'), target.gallery));
  // the body changed, so validators computed by the server no longer describe it
  delete headers['etag'];
  delete headers['content-encoding'];
  headers['content-length'] = String(body.length);
  res.writeHead(upstreamRes.statusCode ?? 502, headers);
  res.end(body);
};

const forward = async (
  config: GatewayConfig,
  identity: IdentityMap,
  req: IncomingMessage,
  res: ServerResponse,
  target: Resolved,
  rewrite?: RewriteName,
) => {
  const method = req.method ?? 'GET';
  const rawBody = await readBody(req, config.maxBodyBytes);
  if (requestsPrivateAssets(target.query, rawBody)) {
    throw new HttpError(403, 'Forbidden');
  }
  // the policy already approved this path; swapping one id segment for another cannot change the route
  const query = upstreamQuery(target.path, target.query, target.gallery.features);
  const upstreamPath = await identity.translate(target.gallery, target.path + query);
  const body = rawBody && Buffer.from(await identity.translate(target.gallery, rawBody.toString('utf8')));
  const headers = buildUpstreamHeaders(req.headers, {
    apiKey: target.gallery.apiKey,
    host: target.gallery.host,
    clientIp: clientIp(config, req),
  });
  if (body) {
    headers['content-length'] = body.length;
  }
  if (rewrite) {
    // rewriting needs the plain body; conditional requests could answer 304 with a stale, unrewritten copy cached
    delete headers['accept-encoding'];
    delete headers['if-none-match'];
    delete headers['if-modified-since'];
  }

  await new Promise<void>((resolve, reject) => {
    const upstream = upstreamRequest(config)(upstreamOptions(config, method, upstreamPath, headers), (upstreamRes) => {
      const isApi = target.path.toLowerCase().startsWith('/api');
      const headers = responseHeaders(upstreamRes, isApi);
      const status = upstreamRes.statusCode ?? 502;
      if (rewrite && status === 200 && appliesTo(rewrite, upstreamRes.headers['content-type'])) {
        sendRewritten(res, upstreamRes, headers, rewrite, target).then(resolve, reject);
        return;
      }
      res.writeHead(status, headers);
      upstreamRes.pipe(res);
      upstreamRes.on('end', resolve);
      upstreamRes.on('error', reject);
    });
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

const fetchUserId = (getConfig: () => GatewayConfig) => async (gallery: Gallery) => {
  const res = await fetch(new URL('/api/users/me', getConfig().upstream), { headers: { 'x-api-key': gallery.apiKey } });
  if (!res.ok) {
    throw new Error(`Could not resolve the user of ${gallery.host}: ${res.status}`);
  }
  return ((await res.json()) as { id: string }).id;
};

export const createGateway = (getConfig: () => GatewayConfig, log: Log = defaultLog): Server => {
  const identity = new IdentityMap(fetchUserId(getConfig));
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
      await forward(config, identity, req, res, target, decision.rewrite);
    };

    handle().catch((error: unknown) => {
      const status = error instanceof HttpError ? error.status : 502;
      if (status === 502) {
        log({ event: 'upstream-error', host: target?.gallery.host, method, path: target?.path, error: String(error) });
      } else if (status === 403) {
        log({
          event: 'denied',
          host: target?.gallery.host,
          method,
          path: target?.path,
          status,
          reason: 'private-assets',
        });
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
