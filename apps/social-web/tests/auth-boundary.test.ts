import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  SocialUnauthorizedError,
  extractSocialBearer,
  verifySocialIdentity,
} from '../src/security/supabase-auth.js';

const USER = '10000000-0000-4000-8000-000000000001';
const KEY = 'sb_publishable_' + 'x'.repeat(32);
const TOKEN = 'header.payload_valid-with_underscores.signature';
const config = { url: 'https://social-project.supabase.co', publishableKey: KEY };

test('missing, malformed or too-short bearer credentials fail closed', () => {
  for (const value of [
    undefined, '', 'Basic aaaa', 'Bearer abc',
    'Bearer ' + TOKEN + '\r\nX-Injected: x',
    'bearer ' + TOKEN,
  ]) {
    assert.throws(() => extractSocialBearer(value), SocialUnauthorizedError);
  }
});

test('valid JWT character set passes opaque token extraction', () => {
  assert.equal(extractSocialBearer('Bearer ' + TOKEN), TOKEN);
});

test('identity is derived only from trusted Auth /user response, never metadata', async () => {
  let called = false;
  const fakeFetch: typeof fetch = async (input, init) => {
    called = true;
    assert.equal(String(input), 'https://social-project.supabase.co/auth/v1/user');
    const headers = init?.headers as Record<string, string>;
    assert.equal(headers.authorization, 'Bearer ' + TOKEN);
    assert.equal(headers.apikey, KEY);
    assert.equal(init?.redirect, 'error');
    assert.ok(init?.signal);
    return new Response(JSON.stringify({
      id: USER,
      user_metadata: { organizationId: 'ATTACKER_ORG', role: 'superadmin' },
      app_metadata: { anything: true },
    }), { status: 200 });
  };
  const actual = await verifySocialIdentity('Bearer ' + TOKEN, {
    ...config, fetcher: fakeFetch,
  });
  assert.equal(called, true);
  assert.deepEqual(actual, { userId: USER });
});

test('401 and 403 from Auth endpoint never authorize', async () => {
  for (const code of [401, 403]) {
    await assert.rejects(
      () => verifySocialIdentity('Bearer ' + TOKEN, {
        ...config, fetcher: async () => new Response(null, { status: code }),
      }),
      SocialUnauthorizedError,
    );
  }
});

test('malformed Auth response and missing id never authorize', async () => {
  for (const body of ['not-json', '{}', '{"id":"some-attacker"}', '{"id":123}']) {
    await assert.rejects(
      () => verifySocialIdentity('Bearer ' + TOKEN, {
        ...config, fetcher: async () => new Response(body),
      }),
      SocialUnauthorizedError,
    );
  }
});

test('outbound network exceptions are sanitized', async () => {
  await assert.rejects(
    () => verifySocialIdentity('Bearer ' + TOKEN, {
      ...config, fetcher: async () => { throw Error('a sensitive exception'); },
    }),
    (error: unknown) => error instanceof SocialUnauthorizedError &&
      error.message === 'unauthorized',
  );
});

test('untrusted or malformed project URLs reject before Bearer token is sent', async () => {
  let called = false;
  for (const url of [
    'https://not-supabase.example.com',
    'http://social-project.supabase.co',
    'https://social-project.supabase.co.evil.example',
    'https://social-project.supabase.co/?redirect=https://evil.example',
    'https://social-project.supabase.co:9443',
    'https://social-project.supabase.co/other/path',
    'https://test:secret@social-project.supabase.co',
  ]) {
    await assert.rejects(
      () => verifySocialIdentity('Bearer ' + TOKEN, {
        ...config, url, fetcher: async () => { called = true; return new Response('{}'); },
      }),
      /Invalid Supabase URL/,
    );
  }
  assert.equal(called, false);
});

test('missing or secret server key cannot be used as public project key', async () => {
  await assert.rejects(
    () => verifySocialIdentity('Bearer ' + TOKEN, {
      ...config, publishableKey: 'sb_secret_NEVER_IN_BROWSER',
      fetcher: async () => new Response(JSON.stringify({ id: USER })),
    }),
    /publishable key is not configured/,
  );
});
