import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SocialSsoBridge, SocialSsoError, validateSocialSsoOptions } from '../src/security/oidc-bridge.js';
import { buildSocialPortalApp } from '../src/http/portal.js';
import type { Pool } from 'pg';

const REF = 'z'.repeat(20);
const AUTH_URL = 'https://' + REF + '.supabase.co';
const CALLBACK = 'https://social.example.com/api/social/sso/callback';
const USER = '10000000-0000-4000-8000-000000000001';
const ACCESS = 'test-jwt.' + 'x'.repeat(60);
const KEY = Buffer.alloc(32, 42).toString('base64url');
const CLIENT_SECRET = 'test-only-confidential-client-secret';

function config(fetcher?: typeof fetch) {
  return {
    supabaseUrl: AUTH_URL,
    clientId: 'test-sso-client',
    clientSecret: CLIENT_SECRET,
    callbackUrl: CALLBACK,
    cookieKey: KEY,
    ...(fetcher ? { fetcher } : {}),
  };
}
const cookieValue = (header: string) => header.split(';')[0]!;

test('rejects untrusted IdP URLs, callbacks and invalid encryption keys', () => {
  assert.throws(() => validateSocialSsoOptions({
    ...config(), supabaseUrl: 'https://evil.example'
  }), SocialSsoError);
  assert.throws(() => validateSocialSsoOptions({
    ...config(), callbackUrl: 'http://social.example.com/api/social/sso/callback'
  }), SocialSsoError);
  assert.throws(() => validateSocialSsoOptions({
    ...config(), callbackUrl: CALLBACK + '?redirect=https://evil.example'
  }), SocialSsoError);
  assert.throws(() => validateSocialSsoOptions({
    ...config(), cookieKey: 'not-a-key'
  }), SocialSsoError);
});

test('generates a distinct PKCE challenge for each start and host-only sealed flow cookie', () => {
  const bridge = new SocialSsoBridge(config());
  const a = bridge.start();
  const b = bridge.start();
  const url = new URL(a.redirect);
  assert.equal(url.origin, AUTH_URL);
  assert.equal(url.pathname, '/auth/v1/oauth/authorize');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('scope'), 'openid email profile');
  assert.equal(url.searchParams.get('redirect_uri'), CALLBACK);
  assert.notEqual(url.searchParams.get('state'), new URL(b.redirect).searchParams.get('state'));
  assert.notEqual(url.searchParams.get('code_challenge'),
    new URL(b.redirect).searchParams.get('code_challenge'));
  assert.doesNotMatch(a.redirect, /code_verifier|client_secret|access_token/);
  assert.match(a.cookie, /^__Host-pb_social_oauth=/);
  assert.match(a.cookie, /HttpOnly; Secure; SameSite=Lax; Max-Age=600/);
  assert.doesNotMatch(a.cookie, /Domain=/);
});

test('rejects state tampering and incorrect cookies without contacting token endpoint', async () => {
  let calls = 0;
  const mockFetch = (async () => {
    calls++;
    throw new Error('must not call IdP');
  }) as typeof fetch;
  const bridge = new SocialSsoBridge(config(mockFetch));
  const { redirect, cookie } = bridge.start();
  const state = new URL(redirect).searchParams.get('state');
  const code = 'VALIDCODE' + 'a'.repeat(16);
  await assert.rejects(() => bridge.callback({ state: 'wrong', code },
    cookieValue(cookie)), SocialSsoError);
  const original = cookieValue(cookie);
  const middle = Math.floor(original.length / 2);
  const tampered = original.slice(0, middle) +
    (original[middle] === 'A' ? 'B' : 'A') + original.slice(middle + 1);
  await assert.rejects(() => bridge.callback({ state, code },
    tampered), SocialSsoError);
  await assert.rejects(() => bridge.callback({ state, code },
    undefined), SocialSsoError);
  await assert.rejects(() => bridge.callback({ state, code, error: 'denied' },
    cookieValue(cookie)), SocialSsoError);
  assert.equal(calls, 0);
});

test('exchanges PKCE code and exposes an encrypted session only to a matching cookie key', async () => {
  const seen: { url?: string; method?: string; body?: string; basic?: string } = {};
  const mockFetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    seen.url = String(input);
    if (init?.method) seen.method = init.method;
    seen.body = String(init?.body);
    const auth = new Headers(init?.headers).get('authorization');
    if (auth) seen.basic = auth;
    return new Response(JSON.stringify({ access_token: ACCESS, expires_in: 3600 }), { status: 200 });
  }) as typeof fetch;
  const bridge = new SocialSsoBridge(config(mockFetch));
  const { redirect, cookie } = bridge.start();
  const state = new URL(redirect).searchParams.get('state');
  const login = await bridge.callback({ state, code: 'VALIDCODE0123456789' }, cookieValue(cookie));
  assert.equal(seen.url, AUTH_URL + '/auth/v1/oauth/token');
  assert.equal(seen.method, 'POST');
  const body = new URLSearchParams(seen.body);
  assert.ok((body.get('code_verifier') || '').length >= 43);
  assert.equal(body.get('grant_type'), 'authorization_code');
  assert.equal(body.get('redirect_uri'), CALLBACK);
  assert.equal(body.has('client_secret'), false);
  assert.equal(body.has('client_id'), false);
  assert.equal(seen.basic, 'Basic ' + Buffer.from('test-sso-client:' + CLIENT_SECRET).toString('base64'));
  assert.equal(bridge.bearerFromCookie(cookieValue(login)), 'Bearer ' + ACCESS);
  assert.match(login, /HttpOnly; Secure; SameSite=Lax/);
  assert.doesNotMatch(login, /Domain=/);
  assert.doesNotMatch(login, /test-jwt|test-only-confidential/);
  const foreign = new SocialSsoBridge({ ...config(), cookieKey: Buffer.alloc(32, 44).toString('base64url') });
  assert.equal(foreign.bearerFromCookie(cookieValue(login)), null);
  assert.equal(bridge.bearerFromCookie(cookieValue(login) + '; ' + cookieValue(login)), null);
});

test('failed token exchange is generic and never exposes upstream bodies', async () => {
  const bridge = new SocialSsoBridge(config(
    (async () => new Response('PROVIDER_SENSITIVE_DATA', { status: 401 })) as typeof fetch
  ));
  const { redirect, cookie } = bridge.start();
  await assert.rejects(
    () => bridge.callback({
      state: new URL(redirect).searchParams.get('state'),
      code: 'VALIDCODE0123456789'
    }, cookieValue(cookie)),
    (error: unknown) => error instanceof SocialSsoError &&
      !JSON.stringify(error).includes('PROVIDER_SENSITIVE_DATA')
  );
});

test('PostBro portal accepts a verified SSO cookie but refuses sibling-origin write CSRF', async () => {
  let validated = 0;
  let transactions = 0;
  const mockPool = {
    async connect() {
      transactions++;
      return {
        async query() { return { rows: [], rowCount: 0 }; },
        release() {},
      };
    }
  } as unknown as Pick<Pool, 'connect'>;
  const app = buildSocialPortalApp({
    pool: mockPool,
    auth: {
      url: AUTH_URL,
      publishableKey: 'sb_publishable_' + 'a'.repeat(32),
      fetcher: (async () => {
        validated++;
        return new Response(JSON.stringify({ id: USER }), { status: 200 });
      }) as typeof fetch,
    },
    sso: config(
      (async () => new Response(JSON.stringify({ access_token: ACCESS, expires_in: 3600 }),
        { status: 200 })) as typeof fetch
    ),
  });
  try {
    assert.equal((await app.inject({ method: 'GET', url: '/api/social/config' })).json().ssoEnabled, true);
    assert.equal((await app.inject({ method: 'GET', url: '/api/social/sso/session' })).statusCode, 401);
    const start = await app.inject({ method: 'GET', url: '/api/social/sso/start' });
    assert.equal(start.statusCode, 302);
    const state = new URL(start.headers.location as string).searchParams.get('state');
    const callback = await app.inject({
      method: 'GET',
      url: '/api/social/sso/callback?state=' + state + '&code=VALIDCODE0123456789',
      headers: { cookie: cookieValue(start.headers['set-cookie'] as string) }
    });
    assert.equal(callback.statusCode, 302);
    assert.equal(callback.headers.location, '/social/');
    const cookies = callback.headers['set-cookie'];
    const loginCookie = (Array.isArray(cookies) ? cookies : [cookies]).find(c =>
      typeof c === 'string' && c.startsWith('__Host-pb_social_login='));
    assert.ok(loginCookie);
    const headers = { cookie: cookieValue(loginCookie!) };
    assert.equal((await app.inject({
      method: 'GET', url: '/api/social/sso/session', headers
    })).statusCode, 200);
    const allowed = await app.inject({ method: 'GET', url: '/api/social/clients', headers });
    assert.equal(allowed.statusCode, 200);
    assert.deepEqual(allowed.json().clients, []);
    const before = transactions;
    assert.equal((await app.inject({
      method: 'PUT', url: '/api/social/clients/' + USER + '/brand',
      headers, payload: {}
    })).statusCode, 401);
    assert.equal((await app.inject({
      method: 'PUT', url: '/api/social/clients/' + USER + '/brand',
      headers: { ...headers, origin: 'https://evil.example' }, payload: {}
    })).statusCode, 401);
    assert.equal(transactions, before);
    assert.ok(validated >= 3);
    const logoutBlocked = await app.inject({ method: 'POST', url: '/api/social/sso/logout',
      headers: { origin: 'https://evil.example' } });
    assert.equal(logoutBlocked.statusCode, 403);
    const logout = await app.inject({ method: 'POST', url: '/api/social/sso/logout',
      headers: { origin: 'https://social.example.com' } });
    assert.equal(logout.statusCode, 204);
    assert.match(String(logout.headers['set-cookie']), /Max-Age=0/);
  } finally {
    await app.close();
  }
});
