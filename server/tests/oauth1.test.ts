import { describe, expect, it } from 'vitest';
import { authHeader, pct, signature } from '../src/garmin/oauth1.ts';

/**
 * A wrong OAuth1 signature and a wrong password both come back as 401,
 * so "it returned 401" tells you nothing about which one you have. The
 * published Twitter vector is the only way to know the signing itself is
 * right before ever talking to Garmin - and the previous version of this
 * adapter shipped with no OAuth1 leg at all.
 */
describe('OAuth1 signing, against the published test vector', () => {
  // https://developer.twitter.com/en/docs/authentication/oauth-1-0a/creating-a-signature
  const CONSUMER_SECRET = 'kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw';
  const TOKEN_SECRET = 'LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE';
  const PARAMS = {
    status: 'Hello Ladies + Gentlemen, a signed OAuth request!',
    include_entities: 'true',
    oauth_consumer_key: 'xvz1evFS4wEEPTGEFPHBog',
    oauth_nonce: 'kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg',
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: '1318622958',
    oauth_token: '370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb',
    oauth_version: '1.0',
  };

  it('reproduces the documented signature exactly', () => {
    expect(signature(
      'POST', 'https://api.twitter.com/1.1/statuses/update.json',
      PARAMS, CONSUMER_SECRET, TOKEN_SECRET,
    )).toBe('hCtSmYh+iHYCEqBWrE7C7hYmtUk=');
  });

  it('is sensitive to every input', () => {
    // Otherwise the vector above could pass by coincidence.
    const good = signature('POST', 'https://api.twitter.com/1.1/statuses/update.json',
      PARAMS, CONSUMER_SECRET, TOKEN_SECRET);
    expect(signature('GET', 'https://api.twitter.com/1.1/statuses/update.json',
      PARAMS, CONSUMER_SECRET, TOKEN_SECRET)).not.toBe(good);
    expect(signature('POST', 'https://api.twitter.com/1.1/statuses/show.json',
      PARAMS, CONSUMER_SECRET, TOKEN_SECRET)).not.toBe(good);
    expect(signature('POST', 'https://api.twitter.com/1.1/statuses/update.json',
      { ...PARAMS, status: 'something else' }, CONSUMER_SECRET, TOKEN_SECRET)).not.toBe(good);
    expect(signature('POST', 'https://api.twitter.com/1.1/statuses/update.json',
      PARAMS, CONSUMER_SECRET, '')).not.toBe(good);
  });
});

describe('percent-encoding', () => {
  it('encodes the characters encodeURIComponent leaves alone', () => {
    // The single most common cause of a 401 here.
    expect(pct("!*'()")).toBe('%21%2A%27%28%29');
  });

  it('leaves the unreserved set untouched', () => {
    expect(pct('aZ09-._~')).toBe('aZ09-._~');
  });

  it('encodes a space as %20, never as +', () => {
    expect(pct('r b')).toBe('r%20b');
  });
});

describe('the Authorization header', () => {
  const consumer = { key: 'ck', secret: 'cs' };

  it('carries every oauth field a two-legged request needs', () => {
    const h = authHeader('GET', 'https://example.com/x', { a: '1' }, consumer);
    for (const field of ['oauth_consumer_key', 'oauth_nonce', 'oauth_signature',
      'oauth_signature_method', 'oauth_timestamp', 'oauth_version']) {
      expect(h).toContain(`${field}="`);
    }
    // No token on a two-legged request.
    expect(h).not.toContain('oauth_token=');
  });

  it('includes the token when one is supplied', () => {
    const h = authHeader('POST', 'https://example.com/x', {}, consumer,
      { token: 'tk', secret: 'ts' });
    expect(h).toContain('oauth_token="tk"');
    // The secret authenticates; it is never transmitted.
    expect(h).not.toContain('ts');
  });

  it('signs query parameters, so tampering with one invalidates it', () => {
    const fixed = { nonce: 'n', timestamp: '1' };
    const a = authHeader('GET', 'https://example.com/x', { ticket: 'abc' }, consumer,
      undefined, fixed);
    const b = authHeader('GET', 'https://example.com/x', { ticket: 'xyz' }, consumer,
      undefined, fixed);
    expect(a).not.toBe(b);
  });

  it('is reproducible given the same nonce and timestamp', () => {
    const fixed = { nonce: 'n', timestamp: '1' };
    expect(authHeader('GET', 'https://example.com/x', {}, consumer, undefined, fixed))
      .toBe(authHeader('GET', 'https://example.com/x', {}, consumer, undefined, fixed));
  });
});
