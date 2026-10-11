import { createServer, request, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { connect } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { GatewayConfig } from './config.ts';
import { ALL_FEATURES } from './policy.ts';
import { createGateway } from './proxy.ts';

type Seen = { method?: string; url?: string; headers: IncomingHttpHeaders; body: string };

const ID = '00000000-0000-4000-8000-000000000000';

let upstream: Server;
let gateway: Server;
let gatewayPort: number;
let seen: Seen[] = [];
const logs: Record<string, unknown>[] = [];

const listen = (server: Server) =>
  new Promise<number>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)),
  );

const send = (
  host: string,
  method: string,
  path: string,
  options: { headers?: Record<string, string>; body?: string } = {},
) =>
  new Promise<{ status: number; headers: IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port: gatewayPort,
        method,
        path,
        headers: {
          host,
          // node omits the length for bodies on DELETE, which a real client never does
          ...(options.body === undefined ? {} : { 'content-length': String(Buffer.byteLength(options.body)) }),
          ...options.headers,
        },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on('error', reject);
    req.end(options.body);
  });

beforeAll(async () => {
  upstream = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      res.writeHead(200, {
        'content-type': 'application/json',
        'set-cookie': 'immich_access_token=leak; HttpOnly',
      });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  upstream.on('upgrade', (req, socket) => {
    seen.push({ method: req.method, url: req.url, headers: req.headers, body: '' });
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    socket.on('data', (data) => socket.write(data));
  });
  const upstreamPort = await listen(upstream);

  const config: GatewayConfig = {
    upstream: new URL(`http://127.0.0.1:${upstreamPort}`),
    listen: { host: '127.0.0.1', port: 0 },
    trustProxy: false,
    maxBodyBytes: 1024,
    galleries: new Map([
      ['gal1.example.com', { host: 'gal1.example.com', apiKey: 'key-one', features: ALL_FEATURES }],
      [
        'gal2.example.com',
        {
          host: 'gal2.example.com',
          apiKey: 'key-two',
          features: { people: false, map: false, smartSearch: false, downloadOriginal: false },
        },
      ],
    ]),
  };
  gateway = createGateway(
    () => config,
    (entry) => logs.push(entry),
  );
  gatewayPort = await listen(gateway);
});

afterAll(() => {
  gateway.closeAllConnections();
  upstream.closeAllConnections();
  gateway.close();
  upstream.close();
});

beforeEach(() => {
  seen = [];
});

describe('gateway', () => {
  it('injects the key of the gallery selected by Host', async () => {
    await send('gal1.example.com', 'GET', '/api/timeline/buckets');
    await send('GAL2.example.com:443', 'GET', '/api/timeline/buckets');
    expect(seen.map((s) => s.headers['x-api-key'])).toEqual(['key-one', 'key-two']);
  });

  it('rejects unknown hosts without contacting the server', async () => {
    const res = await send('evil.example.com', 'GET', '/api/users/me');
    expect(res.status).toBe(404);
    expect(seen).toEqual([]);
  });

  it('strips client credentials from headers and query', async () => {
    await send('gal1.example.com', 'GET', `/api/assets/${ID}/thumbnail?size=preview&key=share&apiKey=x&sessionKey=y`, {
      headers: {
        cookie: 'immich_access_token=admin-session',
        authorization: 'Bearer admin-session',
        'x-api-key': 'client-key',
        'x-immich-user-token': 'admin-session',
      },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe(`/api/assets/${ID}/thumbnail?size=preview`);
    expect(seen[0].headers['x-api-key']).toBe('key-one');
    expect(seen[0].headers.cookie).toBeUndefined();
    expect(seen[0].headers.authorization).toBeUndefined();
    expect(seen[0].headers['x-immich-user-token']).toBeUndefined();
  });

  it('drops server cookies and marks web pages as authenticated', async () => {
    const api = await send('gal1.example.com', 'GET', '/api/users/me');
    expect(api.headers['set-cookie']).toBeUndefined();

    const page = await send('gal1.example.com', 'GET', '/photos');
    expect(page.headers['set-cookie']).toEqual(['immich_is_authenticated=true; Path=/; SameSite=Lax']);
  });

  it('blocks writes before they reach the server', async () => {
    for (const [method, path] of [
      ['POST', '/api/assets'],
      ['DELETE', '/api/assets'],
      ['PUT', `/api/albums/${ID}`],
      ['GET', '/api/api-keys'],
      ['GET', '/API/users'],
    ]) {
      const res = await send('gal1.example.com', method, path, { body: method === 'GET' ? undefined : '{}' });
      expect(res.status, `${method} ${path}`).toBe(403);
    }
    expect(seen).toEqual([]);
    expect(logs.some((entry) => entry.event === 'denied' && entry.path === '/api/api-keys')).toBe(true);
  });

  it('ignores X-HTTP-Method-Override', async () => {
    await send('gal1.example.com', 'GET', '/api/timeline/buckets', { headers: { 'x-http-method-override': 'DELETE' } });
    expect(seen[0].method).toBe('GET');
    expect(seen[0].headers['x-http-method-override']).toBeUndefined();
  });

  it.each(['/api/assets/../api-keys', '/api/assets/%2e%2e/api-keys', '/api//api-keys'])(
    'rejects the traversal %s',
    async (path) => {
      const res = await send('gal1.example.com', 'GET', path);
      expect(res.status).toBe(400);
      expect(seen).toEqual([]);
    },
  );

  it('rejects absolute-form request targets', async () => {
    const res = await send('gal1.example.com', 'GET', 'http://127.0.0.1:1/api/users/me');
    expect(res.status).toBe(400);
    expect(seen).toEqual([]);
  });

  it('answers UI side-effect writes locally', async () => {
    const res = await send('gal1.example.com', 'PUT', '/api/assets/favorites', {
      body: '{"ids":[],"isFavorite":true}',
    });
    expect(res.status).toBe(204);
    expect(seen).toEqual([]);
  });

  it('forwards read-only POST bodies', async () => {
    const body = JSON.stringify({ query: 'beach' });
    const res = await send('gal1.example.com', 'POST', '/api/search/smart', {
      headers: { 'content-type': 'application/json' },
      body,
    });
    expect(res.status).toBe(200);
    expect(seen[0].body).toBe(body);
  });

  it('limits body size', async () => {
    const res = await send('gal1.example.com', 'POST', '/api/search/metadata', { body: 'x'.repeat(2048) });
    expect(res.status).toBe(413);
    expect(seen).toEqual([]);
  });

  it('applies per-gallery features', async () => {
    const people = await send('gal2.example.com', 'GET', '/api/people');
    expect(people.status).toBe(200);
    expect(JSON.parse(people.body)).toMatchObject({ people: [], total: 0 });
    expect((await send('gal2.example.com', 'POST', '/api/search/smart', { body: '{}' })).status).toBe(404);
    expect(seen).toEqual([]);
  });

  it('refuses reads of archived or trashed assets before they reach the server', async () => {
    expect((await send('gal1.example.com', 'GET', '/api/timeline/buckets?visibility=archive')).status).toBe(403);
    const search = await send('gal1.example.com', 'POST', '/api/search/metadata', {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ withDeleted: true }),
    });
    expect(search.status).toBe(403);
    expect(seen).toEqual([]);
  });

  it('redirects the login page home', async () => {
    const res = await send('gal1.example.com', 'GET', '/auth/login');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/');
  });

  it('proxies the websocket with the gallery key and strips client credentials', async () => {
    const socket = connect(gatewayPort, '127.0.0.1');
    const received = await new Promise<string>((resolve, reject) => {
      let data = '';
      socket.on('error', reject);
      socket.on('data', (chunk) => {
        data += chunk.toString();
        if (data.includes('ping-frame')) {
          resolve(data);
        }
      });
      socket.write(
        [
          'GET /api/socket.io/?EIO=4&transport=websocket HTTP/1.1',
          'Host: gal1.example.com',
          'Connection: Upgrade',
          'Upgrade: websocket',
          'Sec-WebSocket-Version: 13',
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
          'Cookie: immich_access_token=admin-session',
          '',
          '',
        ].join('\r\n'),
      );
      setTimeout(() => socket.write('ping-frame'), 50);
    });
    socket.destroy();

    expect(received.startsWith('HTTP/1.1 101')).toBe(true);
    expect(seen[0].url).toBe('/api/socket.io/?EIO=4&transport=websocket');
    expect(seen[0].headers['x-api-key']).toBe('key-one');
    expect(seen[0].headers.cookie).toBeUndefined();
  });

  it('refuses upgrades outside the socket path', async () => {
    const socket = connect(gatewayPort, '127.0.0.1');
    const received = await new Promise<string>((resolve) => {
      let data = '';
      socket.on('data', (chunk) => (data += chunk.toString()));
      socket.on('close', () => resolve(data));
      socket.write(
        'GET /api/users/me HTTP/1.1\r\nHost: gal1.example.com\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n',
      );
    });
    expect(received.startsWith('HTTP/1.1 403')).toBe(true);
    expect(seen).toEqual([]);
  });
});
