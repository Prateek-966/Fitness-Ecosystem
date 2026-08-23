import { createHmac, randomBytes } from 'node:crypto';

/**
 * The OAuth 1.0a signing Garmin's token endpoints require.
 *
 * Why this file exists at all: the Connect login does not end at the
 * service ticket. The ticket is exchanged for an OAuth1 token, and that
 * token is exchanged for the OAuth2 bearer everything else uses - and
 * BOTH of those requests must carry an HMAC-SHA1 signature. An earlier
 * version of this adapter went straight from ticket to bearer with only
 * cookies, which cannot work and never did.
 *
 * Written against node:crypto rather than a library, because the server
 * has no dependencies and this is forty lines.
 */

/**
 * RFC 3986 percent-encoding.
 *
 * encodeURIComponent leaves ! * ' ( ) alone and OAuth does not, and a
 * signature that differs by one character is indistinguishable from a
 * wrong password. This is the single most common way to get 401 here.
 */
export const pct = (s: string): string =>
  encodeURIComponent(s).replace(/[!*'()]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

export interface Consumer { key: string; secret: string; }
export interface Token { token: string; secret: string; }

/**
 * Returns the value for an `Authorization` header.
 *
 * `url` must be the bare endpoint with no query string, and every query
 * and form parameter must be passed in `params` already decoded: the
 * signature base string re-encodes them itself, so anything encoded
 * twice signs a different request than the one being sent.
 */
/**
 * The signature base string and its HMAC, exported separately from the
 * header so they can be checked against a published test vector. A
 * signing bug and a wrong password produce the same 401, so this is the
 * one part that must be provable without Garmin.
 *
 * `params` must contain every query, form and oauth_* parameter.
 */
export function signature(
  method: 'GET' | 'POST',
  url: string,
  params: Record<string, string>,
  consumerSecret: string,
  tokenSecret = '',
): string {
  const normalised = Object.keys(params).sort()
    .map((k) => `${pct(k)}=${pct(params[k])}`).join('&');
  const base = `${method}&${pct(url)}&${pct(normalised)}`;
  // The trailing ampersand is required even when there is no token
  // secret, which is the case for a two-legged request.
  const signingKey = `${pct(consumerSecret)}&${pct(tokenSecret)}`;
  return createHmac('sha1', signingKey).update(base).digest('base64');
}

/**
 * Returns the value for an `Authorization` header.
 *
 * `url` must be the bare endpoint with no query string, and every query
 * and form parameter must be passed in `params` already decoded: the
 * signature base string re-encodes them itself, so anything encoded
 * twice signs a different request than the one being sent.
 */
export function authHeader(
  method: 'GET' | 'POST',
  url: string,
  params: Record<string, string>,
  consumer: Consumer,
  token?: Token,
  /** Injectable only so the test vector is reproducible. */
  fixed?: { nonce: string; timestamp: string },
): string {
  const oauth: Record<string, string> = {
    oauth_consumer_key: consumer.key,
    oauth_nonce: fixed?.nonce ?? randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: fixed?.timestamp ?? Math.floor(Date.now() / 1000).toString(),
    oauth_version: '1.0',
  };
  if (token) oauth.oauth_token = token.token;

  // Query params, form params and oauth_* params are signed together,
  // sorted, as one set. The spec is unusually specific about this.
  oauth.oauth_signature = signature(
    method, url, { ...params, ...oauth }, consumer.secret, token?.secret ?? '');

  return 'OAuth ' + Object.keys(oauth).sort()
    .map((k) => `${pct(k)}="${pct(oauth[k])}"`).join(', ');
}
