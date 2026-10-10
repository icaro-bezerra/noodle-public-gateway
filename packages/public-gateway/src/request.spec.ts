import { describe, expect, it } from 'vitest';
import { buildUpstreamHeaders, normalizePath, stripCredentialParams } from './request.ts';

describe('normalizePath', () => {
  it.each([
    ['/', '/'],
    ['/api/users/me', '/api/users/me'],
    ['/api/users/me/', '/api/users/me'],
    ['/photos/abc', '/photos/abc'],
  ])('accepts %s', (input, expected) => {
    expect(normalizePath(input)).toBe(expected);
  });

  it.each([
    '/api/assets/../api-keys',
    '/api/./users',
    '/api//users',
    '//api/users',
    '/api/assets/%2e%2e/api-keys',
    '/api/assets/%2E%2E%2Fapi-keys',
    '/api/users%2fme',
    '/api\\users',
    '/api/users%5cme',
    '/api/users%00',
    'api/users',
    '',
  ])('rejects %s', (input) => {
    expect(normalizePath(input)).toBeUndefined();
  });
});

describe('stripCredentialParams', () => {
  it('removes every query param the server reads credentials from', () => {
    const search = new URLSearchParams('size=preview&apiKey=a&sessionKey=b&key=c&slug=d&APIKEY=e&c=1');
    expect(stripCredentialParams(search)).toBe('?size=preview&c=1');
  });

  it('returns an empty string when nothing is left', () => {
    expect(stripCredentialParams(new URLSearchParams('key=abc'))).toBe('');
  });
});

describe('buildUpstreamHeaders', () => {
  const incoming = {
    accept: 'application/json',
    cookie: 'immich_access_token=stolen',
    authorization: 'Bearer stolen',
    'x-api-key': 'client-key',
    'x-immich-user-token': 'stolen',
    'x-immich-session-token': 'stolen',
    'x-immich-share-key': 'stolen',
    'x-http-method-override': 'DELETE',
    'x-forwarded-for': '6.6.6.6',
    range: 'bytes=0-100',
    upgrade: 'websocket',
  };

  it('keeps only safe headers and injects the gallery key', () => {
    expect(
      buildUpstreamHeaders(incoming, { apiKey: 'gallery-key', host: 'gal1.example.com', clientIp: '10.0.0.1' }),
    ).toEqual({
      accept: 'application/json',
      range: 'bytes=0-100',
      'x-api-key': 'gallery-key',
      'x-forwarded-host': 'gal1.example.com',
      'x-forwarded-for': '10.0.0.1',
    });
  });

  it('passes websocket handshake headers only for upgrades', () => {
    const headers = buildUpstreamHeaders(incoming, { apiKey: 'k', host: 'h', websocket: true });
    expect(headers.upgrade).toBe('websocket');
    expect(headers.cookie).toBeUndefined();
  });
});
