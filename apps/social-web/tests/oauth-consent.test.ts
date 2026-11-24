import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Pool } from 'pg';
import { buildSocialPortalApp } from '../src/http/portal.js';
import { parseConsentEnv, validateConsentOptions } from '../src/http/oauth-consent.js';

const ORIGIN = 'https://social.example.com';
const REDIRECT = 'https://postiz.example.com/settings';
const AUTH_ID = 'test-authorization-12345678';
const USER = '10000000-0000-4000-8000-000000000001';
const CLIENT = '20000000-0000-4000-8000-000000000001';
const EMAIL = 'pilot@example.com';
const TOKEN = 'test-token.' + 'x'.repeat(60);
const config = { origin: ORIGIN, clients: [{ id: CLIENT, name: 'Postiz Pilot', redirectUri: REDIRECT }], pilotEmails: [EMAIL] };
const body = { authorizationId: AUTH_ID };
const headers = { origin: ORIGIN, 'content-type': 'application/json' };
const response = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });

test('consent is off by default and refuses incomplete or unsafe configuration', () => {
  assert.equal(parseConsentEnv({}), undefined);
  assert.throws(() => parseConsentEnv({ SOCIAL_PRELAUNCH_CONSENT_ENABLED: 'true' }));
  assert.throws(() => validateConsentOptions({ ...config, origin: 'http://social.example.com' }));
  assert.throws(() => validateConsentOptions({ ...config, clients: [{ ...config.clients[0]!, redirectUri: REDIRECT + '?evil=1' }] }));
  assert.deepEqual(validateConsentOptions(config), config);
});

function fixture() {
  const calls: string[] = [];
  let scenario = 'normal';
  const app = buildSocialPortalApp({
    pool: {} as Pick<Pool, 'connect'>,
    auth: {
      url: 'https://test-project.supabase.co',
      publishableKey: 'sb_publishable_' + 'x'.repeat(32),
      fetcher: (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const p = new URL(String(input)).pathname;
        calls.push(p);
        if (p.endsWith('/otp')) return response({});
        if (p.endsWith('/verify')) return response({ access_token: TOKEN, expires_in: 3600 });
        if (p.endsWith('/user')) return response({ id: USER });
        assert.equal(new Headers(init?.headers).get('origin'), ORIGIN);
        if (p.endsWith('/consent')) {
          const decision = JSON.parse(String(init?.body)).action;
          return response({ redirect_url: REDIRECT + (decision === 'deny' ? '?error=access_denied' : '?code=test-code') });
        }
        if (p.endsWith('/' + AUTH_ID)) {
          if (scenario === 'auto') return response({ redirect_url: REDIRECT + '?code=test-code' });
          if (scenario === 'bad-redirect') return response({ redirect_url: 'https://evil.example.com/settings?code=test-code' });
          return response({ authorization_id: AUTH_ID,
            client: { id: scenario === 'wrong-client' ? 'invalid-client' : CLIENT },
            redirect_uri: REDIRECT, user: { id: USER },
            scope: scenario === 'bad-scope' ? 'openid email phone' : 'openid email profile' });
        }
        return new Response('{}', { status: 400 });
      }) as typeof fetch,
    }, consent: config
  });
  const request = (route: string, payload: object = body, cookie?: string, origin = ORIGIN) =>
    app.inject({ method: 'POST', url: '/api/social/consent/' + route,
      headers: { ...headers, origin, ...(cookie ? { cookie } : {}) }, payload });
  return { app, request, calls: () => calls, scenario: (s: string) => { scenario = s; } };
}

test('consent requires invited login, valid origin and explicit decision; approved grants reuse IdP session', async () => {
  const f = fixture();
  try {
    const page = await f.app.inject({ method: 'GET', url: '/oauth/consent' });
    assert.equal(page.statusCode, 200);
    assert.match(page.body, /PostBro shared sign-in/);
    assert.equal((await f.request('details')).statusCode, 401);
    assert.equal((await f.request('otp', { ...body, email: EMAIL }, undefined, 'https://evil.example.com')).statusCode, 403);
    assert.equal((await f.request('otp', { ...body, email: 'uninvited@example.com' })).statusCode, 200);
    assert.equal(f.calls().length, 0);
    assert.equal((await f.request('otp', { ...body, email: EMAIL })).statusCode, 200);
    assert.equal((await f.request('otp', { ...body, email: EMAIL })).statusCode, 200);
    assert.equal(f.calls().filter(p => p.endsWith('/otp')).length, 1);
    const login = await f.request('verify', { ...body, email: EMAIL, code: '123456' });
    assert.equal(login.statusCode, 200);
    const cookieHeader = String(login.headers['set-cookie']);
    assert.match(cookieHeader, /HttpOnly; SameSite=Lax/);
    assert.doesNotMatch(cookieHeader, /test-token|Domain=/);
    const cookie = cookieHeader.split(';')[0]!;
    assert.equal((await f.request('decision', { ...body, action: 'approve' }, cookie)).statusCode, 400);
    const details = await f.request('details', body, cookie);
    assert.equal(details.statusCode, 200);
    assert.deepEqual(details.json(), { app: 'Postiz Pilot', scopes: ['openid','email','profile'] });
    assert.equal((await f.request('decision', { ...body, action: 'approve' }, cookie, 'https://evil.example.com')).statusCode, 403);
    assert.equal((await f.request('decision', { ...body, action: 'approve' }, cookie)).json().redirect, REDIRECT + '?code=test-code');
    assert.equal((await f.request('decision', { ...body, action: 'approve' }, cookie)).statusCode, 400);
    f.scenario('auto');
    assert.equal((await f.request('details', body, cookie)).json().redirect, REDIRECT + '?code=test-code');
    f.scenario('bad-redirect');
    assert.equal((await f.request('details', body, cookie)).statusCode, 400);
    f.scenario('wrong-client');
    assert.equal((await f.request('details', body, cookie)).statusCode, 400);
    f.scenario('bad-scope');
    assert.equal((await f.request('details', body, cookie)).statusCode, 400);
    f.scenario('normal');
    await f.request('details', body, cookie);
    assert.equal((await f.request('decision', { ...body, action: 'deny' }, cookie)).json().redirect, REDIRECT + '?error=access_denied');
    assert.equal((await f.request('logout', body, cookie)).statusCode, 204);
    assert.equal((await f.request('details', body, cookie)).statusCode, 401);
  } finally { await f.app.close(); }
});
