import type { IncomingHttpHeaders, OutgoingHttpHeaders } from 'node:http';

// Encoded `/`, `\`, `.` and NUL could make the server see a different path than the policy did.
const FORBIDDEN_ENCODINGS = /%(2f|5c|2e|00)/i;

/**
 * Returns the path to check against the policy and forward upstream, or `undefined` when the path is ambiguous.
 * The same string is used for both, so the server can never route the request somewhere the policy did not approve.
 */
export const normalizePath = (path: string): string | undefined => {
  if (!path.startsWith('/') || path.includes('\\') || path.includes('\0') || FORBIDDEN_ENCODINGS.test(path)) {
    return;
  }
  const segments = path.split('/').slice(1);
  // an empty segment is only acceptable as a trailing slash
  if (segments.some((s, i) => s === '.' || s === '..' || (s === '' && i !== segments.length - 1))) {
    return;
  }
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
};

// Query params the server reads credentials from (see AuthService.validate).
const CREDENTIAL_PARAMS = new Set(['apikey', 'sessionkey', 'key', 'slug']);

export const stripCredentialParams = (search: URLSearchParams): string => {
  for (const name of [...search.keys()]) {
    if (CREDENTIAL_PARAMS.has(name.toLowerCase())) {
      search.delete(name);
    }
  }
  const query = search.toString();
  return query ? `?${query}` : '';
};

/**
 * Request headers passed upstream. Everything else is dropped, notably `Cookie`, `Authorization` and every
 * `x-immich-*` / `x-api-key` header: a client session would take precedence over the injected API key.
 */
const FORWARDED_REQUEST_HEADERS = [
  'accept',
  'accept-encoding',
  'accept-language',
  'cache-control',
  'content-length',
  'content-type',
  'if-match',
  'if-modified-since',
  'if-none-match',
  'if-range',
  'range',
  'user-agent',
];

const WEBSOCKET_HEADERS = [
  'connection',
  'upgrade',
  'sec-websocket-key',
  'sec-websocket-version',
  'sec-websocket-extensions',
  'sec-websocket-protocol',
];

export const buildUpstreamHeaders = (
  incoming: IncomingHttpHeaders,
  options: { apiKey: string; host: string; clientIp?: string; websocket?: boolean },
): OutgoingHttpHeaders => {
  const names = options.websocket ? [...FORWARDED_REQUEST_HEADERS, ...WEBSOCKET_HEADERS] : FORWARDED_REQUEST_HEADERS;
  const headers: OutgoingHttpHeaders = {};
  for (const name of names) {
    const value = incoming[name];
    if (value !== undefined) {
      headers[name] = value;
    }
  }
  headers['x-api-key'] = options.apiKey;
  headers['x-forwarded-host'] = options.host;
  if (options.clientIp) {
    headers['x-forwarded-for'] = options.clientIp;
  }
  return headers;
};
