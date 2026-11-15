import assert from 'node:assert/strict';
import test from 'node:test';

import {
  THREADS_GRAPH_ORIGIN,
  ThreadsHttpOAuthClient,
  ThreadsHttpTransportError,
  type HttpTransport,
  type HttpTransportRequest,
} from '../src/integrations/threads/oauth-client-http';
import {
  ThreadsOAuthProviderError,
  type ThreadsOAuthErrorKind,
} from '../src/integrations/threads/oauth-client';
import type { ThreadsOAuthConfig } from '../src/config';

/** Fixed dummy config — non-real, test-only. */
const CONFIG: ThreadsOAuthConfig = {
  appId: 'dummy-app-id',
  appSecret: 'dummy-app-secret-NOT-REAL',
  redirectUri: 'https://app.example.com/auth/threads/callback',
  scopes: ['threads_basic'],
};

type RecordedCall = HttpTransportRequest;

function transportReturning(
  handler: (req: HttpTransportRequest) => { status: number; body: string },
): { transport: HttpTransport; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const transport: HttpTransport = (req) => {
    calls.push({ ...req });
    const res = handler(req);
    return Promise.resolve(res);
  };
  return { transport, calls };
}

function makeClient(transport: HttpTransport): ThreadsHttpOAuthClient {
  return new ThreadsHttpOAuthClient({ config: CONFIG, transport });
}

test('exchangeCode POSTs to the fixed Graph host with all params in the URL query, no body', async () => {
  const { transport, calls } = transportReturning(() => ({
    status: 200,
    body: JSON.stringify({ access_token: 'short-token', user_id: '12345' }),
  }));
  const client = makeClient(transport);

  const result = await client.exchangeCode('dummy-code');
  assert.equal(result.accessToken, 'short-token');
  assert.equal(result.userId, '12345');

  assert.equal(calls.length, 1);
  const call = calls[0]!;
  assert.equal(call.method, 'POST');
  const url = new URL(call.url);
  assert.equal(url.origin, THREADS_GRAPH_ORIGIN);
  assert.equal(url.pathname, '/oauth/access_token');
  // Per Meta's official docs/Postman spec, ALL five parameters travel in
  // the URL query string and the request carries NO body.
  assert.equal(url.searchParams.get('client_id'), CONFIG.appId);
  assert.equal(url.searchParams.get('client_secret'), CONFIG.appSecret);
  assert.equal(url.searchParams.get('code'), 'dummy-code');
  assert.equal(url.searchParams.get('grant_type'), 'authorization_code');
  assert.equal(url.searchParams.get('redirect_uri'), CONFIG.redirectUri);
  assert.equal(call.body, undefined);
  assert.equal(call.headers['content-type'], undefined);
});

test('exchangeCode: transport errors never expose the secret/code-bearing request URL', async () => {
  // The exchange URL necessarily contains client_secret and the OAuth code
  // (Meta's documented parameter placement); a transport failure carrying
  // the URL (as a careless transport might) must be wrapped sanitized.
  const secretUrlProbe: HttpTransport = (req) =>
    Promise.reject(
      new ThreadsHttpTransportError('redirect', `unexpected redirect for ${req.url}`),
    );
  await assert.rejects(
    () => makeClient(secretUrlProbe).exchangeCode('SENSITIVE-CODE-SENTINEL'),
    (e: unknown) => {
      assert.ok(e instanceof ThreadsOAuthProviderError);
      const serialized = JSON.stringify(e);
      assert.equal(serialized.includes(CONFIG.appSecret), false);
      assert.equal(serialized.includes('SENSITIVE-CODE-SENTINEL'), false);
      assert.equal(serialized.includes('client_secret='), false);
      assert.equal(serialized.includes('code='), false);
      assert.equal(serialized.includes('graph.threads.net'), false);
      assert.equal(e.providerFailureReason, 'redirect');
      return true;
    },
  );
});

test('exchangeCode accepts numeric user_id', async () => {
  const { transport } = transportReturning(() => ({
    status: 200,
    body: JSON.stringify({ access_token: 'tok', user_id: 987 }),
  }));
  const result = await makeClient(transport).exchangeCode('code');
  assert.equal(result.userId, '987');
});

test('exchangeCode rejects empty code and never calls the transport', async () => {
  const { transport, calls } = transportReturning(() => ({ status: 200, body: '{}' }));
  await assert.rejects(
    () => makeClient(transport).exchangeCode(''),
    (e: unknown) => e instanceof ThreadsOAuthProviderError && e.kind === 'invalid_code',
  );
  assert.equal(calls.length, 0);
});

test('exchangeCode fails closed on provider 400 error envelope', async () => {
  const { transport } = transportReturning(() => ({
    status: 400,
    body: JSON.stringify({ error: { message: 'bad code SECRET-DETAIL', type: 'OAuthException', code: 100 } }),
  }));
  await assert.rejects(
    () => makeClient(transport).exchangeCode('code'),
    (e: unknown) => {
      assert.ok(e instanceof ThreadsOAuthProviderError);
      assert.equal(e.kind, 'unknown');
      // Provider message content must never leak into the error.
      assert.equal(e.message.includes('SECRET-DETAIL'), false);
      return true;
    },
  );
});

test('400 error envelope carries only safe numeric diagnostics, never the message', async () => {
  const { transport } = transportReturning(() => ({
    status: 400,
    body: JSON.stringify({
      error: {
        message: 'SECRET_SENTINEL message text',
        type: 'OAuthException',
        code: 100,
        error_subcode: 2345678,
        fbtrace_id: 'SECRET_TRACE_ID',
      },
    }),
  }));
  await assert.rejects(
    () => makeClient(transport).exchangeCode('code'),
    (e: unknown) => {
      assert.ok(e instanceof ThreadsOAuthProviderError);
      assert.equal(e.providerStatus, 400);
      assert.equal(e.providerErrorCode, 100);
      assert.equal(e.providerErrorSubcode, 2345678);
      // No string/body/message/trace leakage anywhere on the error.
      const serialized = JSON.stringify(e);
      assert.equal(serialized.includes('SECRET_SENTINEL'), false);
      assert.equal(serialized.includes('SECRET_TRACE_ID'), false);
      assert.equal(e.message.includes('SECRET_SENTINEL'), false);
      return true;
    },
  );
});

test('numeric diagnostics: code 190 maps token_expired and keeps numeric subcode', async () => {
  const { transport } = transportReturning(() => ({
    status: 400,
    body: JSON.stringify({
      error: { message: 'expired SECRET_SENTINEL', type: 'OAuthException', code: 190, error_subcode: 463 },
    }),
  }));
  await assert.rejects(
    () => makeClient(transport).exchangeLongLived('short'),
    (e: unknown) => {
      assert.ok(e instanceof ThreadsOAuthProviderError);
      assert.equal(e.kind, 'token_expired');
      assert.equal(e.providerStatus, 400);
      assert.equal(e.providerErrorCode, 190);
      assert.equal(e.providerErrorSubcode, 463);
      assert.equal(JSON.stringify(e).includes('SECRET_SENTINEL'), false);
      return true;
    },
  );
});

test('numeric diagnostics: malformed string code/subcode values are dropped', async () => {
  const { transport } = transportReturning(() => ({
    status: 400,
    body: JSON.stringify({
      error: {
        message: 'SECRET_SENTINEL',
        type: 'OAuthException',
        code: '100-STRING',
        error_subcode: 'SUBCODE-STRING',
      },
    }),
  }));
  await assert.rejects(
    () => makeClient(transport).exchangeCode('code'),
    (e: unknown) => {
      assert.ok(e instanceof ThreadsOAuthProviderError);
      assert.equal(e.providerStatus, 400);
      assert.equal(e.providerErrorCode, undefined);
      assert.equal(e.providerErrorSubcode, undefined);
      return true;
    },
  );
});

test('numeric diagnostics: out-of-range HTTP status and negative codes dropped', async () => {
  const { transport } = transportReturning(() => ({
    status: 99,
    body: JSON.stringify({
      error: { message: 'x', type: 'OAuthException', code: -5, error_subcode: 1.5 },
    }),
  }));
  await assert.rejects(
    () => makeClient(transport).exchangeCode('code'),
    (e: unknown) => {
      assert.ok(e instanceof ThreadsOAuthProviderError);
      assert.equal(e.providerStatus, undefined);
      assert.equal(e.providerErrorCode, undefined);
      assert.equal(e.providerErrorSubcode, undefined);
      return true;
    },
  );
});

test('exchangeCode fails closed on malformed JSON and missing fields', async () => {
  for (const body of ['not-json', '{"access_token":"tok"}', '{"user_id":"1"}', '[]', '"str"']) {
    const { transport } = transportReturning(() => ({ status: 200, body }));
    await assert.rejects(
      () => makeClient(transport).exchangeCode('code'),
      (e: unknown) => e instanceof ThreadsOAuthProviderError && e.kind === 'unknown',
    );
  }
});

test('exchangeCode HTTP 200 distinguishes missing_access_token vs missing_user_id', async () => {
  const cases: Array<{ body: string; expected: string }> = [
    { body: JSON.stringify({ user_id: '1' }), expected: 'missing_access_token' },
    { body: JSON.stringify({ access_token: 'tok' }), expected: 'missing_user_id' },
    { body: JSON.stringify({ access_token: 5, user_id: '1' }), expected: 'missing_access_token' },
    // Both missing -> first failure is access_token.
    { body: JSON.stringify({}), expected: 'missing_access_token' },
  ];
  for (const { body, expected } of cases) {
    const { transport } = transportReturning(() => ({ status: 200, body }));
    await assert.rejects(
      () => makeClient(transport).exchangeCode('code'),
      (e: unknown) => {
        assert.ok(e instanceof ThreadsOAuthProviderError);
        assert.equal(e.kind, 'unknown');
        assert.equal(e.providerFailureReason, expected);
        return true;
      },
    );
  }
});

test('exchangeCode fails closed on provider 5xx as provider_unavailable', async () => {
  const { transport } = transportReturning(() => ({ status: 503, body: '' }));
  await assert.rejects(
    () => makeClient(transport).exchangeCode('code'),
    (e: unknown) => e instanceof ThreadsOAuthProviderError && e.kind === 'provider_unavailable',
  );
});

test('exchangeLongLived uses th_exchange_token with bearer header', async () => {
  const { transport, calls } = transportReturning(() => ({
    status: 200,
    body: JSON.stringify({ access_token: 'long-token', token_type: 'bearer', expires_in: 5184000 }),
  }));
  const result = await makeClient(transport).exchangeLongLived('short-token');
  assert.equal(result.accessToken, 'long-token');
  assert.equal(result.expiresInSeconds, 5184000);

  const call = calls[0]!;
  const url = new URL(call.url);
  assert.equal(url.origin, THREADS_GRAPH_ORIGIN);
  assert.equal(url.pathname, '/access_token');
  assert.equal(url.searchParams.get('grant_type'), 'th_exchange_token');
  assert.equal(url.searchParams.get('client_secret'), CONFIG.appSecret);
  // Token goes via Authorization header, never in URL.
  assert.equal(url.searchParams.get('access_token'), null);
  assert.equal(call.headers['authorization'], 'Bearer short-token');
});

test('refreshLongLived uses th_refresh_token', async () => {
  const { transport, calls } = transportReturning(() => ({
    status: 200,
    body: JSON.stringify({ access_token: 'refreshed', token_type: 'bearer', expires_in: 5184000 }),
  }));
  await makeClient(transport).refreshLongLived('old-long-token');
  const url = new URL(calls[0]!.url);
  assert.equal(url.searchParams.get('grant_type'), 'th_refresh_token');
  assert.equal(calls[0]!.headers['authorization'], 'Bearer old-long-token');
});

test('exchangeLongLived tolerates missing expires_in', async () => {
  const { transport } = transportReturning(() => ({
    status: 200,
    body: JSON.stringify({ access_token: 'tok' }),
  }));
  const result = await makeClient(transport).exchangeLongLived('short');
  assert.equal(result.expiresInSeconds, undefined);
});

test('exchangeLongLived maps token-expired envelope (code 190)', async () => {
  const { transport } = transportReturning(() => ({
    status: 400,
    body: JSON.stringify({ error: { message: 'expired', type: 'OAuthException', code: 190 } }),
  }));
  await assert.rejects(
    () => makeClient(transport).exchangeLongLived('short'),
    (e: unknown) => e instanceof ThreadsOAuthProviderError && e.kind === 'token_expired',
  );
});

test('getMe GETs /v1.0/me with fields and bearer header only', async () => {
  const { transport, calls } = transportReturning(() => ({
    status: 200,
    body: JSON.stringify({ id: '12345', username: 'tester' }),
  }));
  const me = await makeClient(transport).getMe('long-token');
  assert.deepEqual(me, { id: '12345', username: 'tester' });

  const call = calls[0]!;
  const url = new URL(call.url);
  assert.equal(url.origin, THREADS_GRAPH_ORIGIN);
  assert.equal(url.pathname, '/v1.0/me');
  assert.equal(url.searchParams.get('fields'), 'id,username');
  assert.equal(url.searchParams.get('access_token'), null);
  assert.equal(call.headers['authorization'], 'Bearer long-token');
});

test('getMe fails closed on missing id', async () => {
  const { transport } = transportReturning(() => ({
    status: 200,
    body: JSON.stringify({ username: 'no-id' }),
  }));
  await assert.rejects(
    () => makeClient(transport).getMe('tok'),
    (e: unknown) => e instanceof ThreadsOAuthProviderError && e.kind === 'unknown',
  );
});

test('transport network failure maps to provider_unavailable and leaks nothing', async () => {
  const failing: HttpTransport = () =>
    Promise.reject(new Error('dns boom token=abc client_secret=shh'));
  await assert.rejects(
    () => makeClient(failing).getMe('tok'),
    (e: unknown) => {
      assert.ok(e instanceof ThreadsOAuthProviderError);
      assert.equal(e.kind, 'provider_unavailable');
      assert.equal(e.message.includes('token=abc'), false);
      assert.equal(e.message.includes('client_secret'), false);
      return true;
    },
  );
});

test('transport categories: network/redirect/body_too_large carry safe failureReason', async () => {
  const cases: Array<['network' | 'redirect' | 'body_too_large', ThreadsOAuthErrorKind]> = [
    ['network', 'unknown'],
    ['redirect', 'unknown'],
    ['body_too_large', 'unknown'],
  ];
  for (const [reason, expectedKind] of cases) {
    const failing: HttpTransport = () =>
      Promise.reject(new ThreadsHttpTransportError(reason, 'sanitized transport failure'));
    await assert.rejects(
      () => makeClient(failing).exchangeCode('code'),
      (e: unknown) => {
        assert.ok(e instanceof ThreadsOAuthProviderError);
        assert.equal(e.kind, expectedKind);
        assert.equal(e.providerFailureReason, reason);
        assert.equal(e.providerStatus, undefined);
        assert.equal(e.providerErrorCode, undefined);
        // No free-text transport detail leaks anywhere.
        assert.equal(JSON.stringify(e).includes('sanitized transport failure'), false);
        return true;
      },
    );
  }
});

test('transport categories: timeout stays provider_unavailable with failureReason', async () => {
  const failing: HttpTransport = () =>
    Promise.reject(new ThreadsHttpTransportError('timeout', 'timed out'));
  await assert.rejects(
    () => makeClient(failing).exchangeCode('code'),
    (e: unknown) => {
      assert.ok(e instanceof ThreadsOAuthProviderError);
      assert.equal(e.kind, 'provider_unavailable');
      assert.equal(e.providerFailureReason, 'timeout');
      assert.equal(e.providerStatus, undefined);
      return true;
    },
  );
});

test('HTTP 200 with malformed body categorizes as malformed_response', async () => {
  const { transport } = transportReturning(() => ({ status: 200, body: '<html>SECRET_SENTINEL</html>' }));
  await assert.rejects(
    () => makeClient(transport).exchangeCode('code'),
    (e: unknown) => {
      assert.ok(e instanceof ThreadsOAuthProviderError);
      assert.equal(e.kind, 'unknown');
      assert.equal(e.providerFailureReason, 'malformed_response');
      assert.equal(e.providerStatus, undefined);
      assert.equal(JSON.stringify(e).includes('SECRET_SENTINEL'), false);
      return true;
    },
  );
});

test('HTTP 200 JSON missing token fields categorizes as missing_access_token', async () => {
  const { transport } = transportReturning(() => ({
    status: 200,
    body: JSON.stringify({ error: { message: 'SECRET_SENTINEL', code: 100 } }),
  }));
  await assert.rejects(
    () => makeClient(transport).exchangeCode('code'),
    (e: unknown) => {
      assert.ok(e instanceof ThreadsOAuthProviderError);
      assert.equal(e.kind, 'unknown');
      assert.equal(e.providerFailureReason, 'missing_access_token');
      assert.equal(e.providerStatus, undefined);
      assert.equal(JSON.stringify(e).includes('SECRET_SENTINEL'), false);
      return true;
    },
  );
});

test('getMe HTTP 200 missing id categorizes as missing_fields', async () => {
  const { transport } = transportReturning(() => ({
    status: 200,
    body: JSON.stringify({ username: 'only-username' }),
  }));
  await assert.rejects(
    () => makeClient(transport).getMe('tok'),
    (e: unknown) => {
      assert.ok(e instanceof ThreadsOAuthProviderError);
      assert.equal(e.providerFailureReason, 'missing_fields');
      return true;
    },
  );
});

test('transport errors never expose the request URL (may contain client_secret)', async () => {
  // The long-lived GET URL necessarily contains client_secret (Meta's
  // documented contract); a redirect/oversize/network failure must not
  // propagate that URL through the thrown error.
  const secretUrlProbe: HttpTransport = (req) => {
    // Simulate a redirect failure carrying the URL (as a careless
    // transport might); the client must wrap it sanitized.
    return Promise.reject(
      new ThreadsHttpTransportError('redirect', `unexpected redirect for ${req.url}`),
    );
  };
  await assert.rejects(
    () => makeClient(secretUrlProbe).exchangeLongLived('short-token'),
    (e: unknown) => {
      assert.ok(e instanceof ThreadsOAuthProviderError);
      assert.equal(e.message.includes(CONFIG.appSecret), false);
      assert.equal(e.message.includes('client_secret='), false);
      assert.equal(e.message.includes('graph.threads.net'), false);
      return true;
    },
  );
});

test('getGrantedScopes always fails closed (no authoritative endpoint)', async () => {
  const { transport, calls } = transportReturning(() => ({ status: 200, body: '{}' }));
  const scopes = await makeClient(transport).getGrantedScopes('tok');
  assert.deepEqual(scopes, { verified: false, scopes: [] });
  // Must NOT make any network call.
  assert.equal(calls.length, 0);
});

test('client constructor rejects incomplete config', () => {
  assert.throws(
    () => new ThreadsHttpOAuthClient({ config: { ...CONFIG, appSecret: '' }, transport: () => Promise.resolve({ status: 200, body: '' }) }),
    /incomplete/,
  );
});

// --- transportMode: 'postiz' (experimental opt-in) -------------------------

const POSTIZ_CONFIG: ThreadsOAuthConfig = { ...CONFIG, transportMode: 'postiz' };

function makePostizClient(transport: HttpTransport): ThreadsHttpOAuthClient {
  return new ThreadsHttpOAuthClient({ config: POSTIZ_CONFIG, transport });
}

test('postiz mode: exchangeCode uses GET with identical query params and no body', async () => {
  const { transport, calls } = transportReturning(() => ({
    status: 200,
    body: JSON.stringify({ access_token: 'short-token', user_id: '12345' }),
  }));
  const result = await makePostizClient(transport).exchangeCode('dummy-code');
  assert.equal(result.accessToken, 'short-token');
  assert.equal(result.userId, '12345');

  assert.equal(calls.length, 1);
  const call = calls[0]!;
  assert.equal(call.method, 'GET');
  const url = new URL(call.url);
  assert.equal(url.origin, THREADS_GRAPH_ORIGIN);
  assert.equal(url.pathname, '/oauth/access_token');
  assert.equal(url.searchParams.get('client_id'), POSTIZ_CONFIG.appId);
  assert.equal(url.searchParams.get('client_secret'), POSTIZ_CONFIG.appSecret);
  assert.equal(url.searchParams.get('code'), 'dummy-code');
  assert.equal(url.searchParams.get('grant_type'), 'authorization_code');
  assert.equal(url.searchParams.get('redirect_uri'), POSTIZ_CONFIG.redirectUri);
  assert.equal(call.body, undefined);
});

test('postiz mode: exchangeLongLived passes token as access_token query param, no auth header', async () => {
  const { transport, calls } = transportReturning(() => ({
    status: 200,
    body: JSON.stringify({ access_token: 'long-token', token_type: 'bearer', expires_in: 5184000 }),
  }));
  await makePostizClient(transport).exchangeLongLived('short-token');
  const call = calls[0]!;
  assert.equal(call.method, 'GET');
  const url = new URL(call.url);
  assert.equal(url.pathname, '/access_token');
  assert.equal(url.searchParams.get('grant_type'), 'th_exchange_token');
  assert.equal(url.searchParams.get('client_secret'), POSTIZ_CONFIG.appSecret);
  assert.equal(url.searchParams.get('access_token'), 'short-token');
  assert.equal(call.headers['authorization'], undefined);
});

test('postiz mode: refreshLongLived matches Postiz refreshToken() exactly', async () => {
  // Postiz @ c22451b: GET https://graph.threads.net/refresh_access_token
  //   ?grant_type=th_refresh_token&access_token=<long-token>
  // — distinct path from the exchange endpoint and NO client_secret.
  const { transport, calls } = transportReturning(() => ({
    status: 200,
    body: JSON.stringify({ access_token: 'refreshed', token_type: 'bearer', expires_in: 5184000 }),
  }));
  await makePostizClient(transport).refreshLongLived('old-long-token');
  const call = calls[0]!;
  assert.equal(call.method, 'GET');
  const url = new URL(call.url);
  assert.equal(url.origin, THREADS_GRAPH_ORIGIN);
  assert.equal(url.pathname, '/refresh_access_token');
  assert.equal(url.searchParams.get('grant_type'), 'th_refresh_token');
  assert.equal(url.searchParams.get('access_token'), 'old-long-token');
  assert.equal(url.searchParams.get('client_secret'), null);
  assert.equal(call.headers['authorization'], undefined);
});

test('postiz mode: exchange still hits /access_token with client_secret (only refresh diverges)', async () => {
  const { transport, calls } = transportReturning(() => ({
    status: 200,
    body: JSON.stringify({ access_token: 'long-token', token_type: 'bearer' }),
  }));
  await makePostizClient(transport).exchangeLongLived('short-token');
  const url = new URL(calls[0]!.url);
  assert.equal(url.pathname, '/access_token');
  assert.equal(url.searchParams.get('client_secret'), POSTIZ_CONFIG.appSecret);
});

test('standard mode: refreshLongLived unchanged (/access_token, client_secret, Bearer header)', async () => {
  const { transport, calls } = transportReturning(() => ({
    status: 200,
    body: JSON.stringify({ access_token: 'refreshed', token_type: 'bearer' }),
  }));
  await makeClient(transport).refreshLongLived('old-long-token');
  const call = calls[0]!;
  assert.equal(call.method, 'GET');
  const url = new URL(call.url);
  assert.equal(url.origin, THREADS_GRAPH_ORIGIN);
  assert.equal(url.pathname, '/access_token');
  assert.equal(url.searchParams.get('grant_type'), 'th_refresh_token');
  assert.equal(url.searchParams.get('client_secret'), CONFIG.appSecret);
  assert.equal(url.searchParams.get('access_token'), null);
  assert.equal(call.headers['authorization'], 'Bearer old-long-token');
});

test('postiz mode: getMe passes token as access_token query param, no auth header', async () => {
  const { transport, calls } = transportReturning(() => ({
    status: 200,
    body: JSON.stringify({ id: '12345', username: 'tester' }),
  }));
  const me = await makePostizClient(transport).getMe('long-token');
  assert.deepEqual(me, { id: '12345', username: 'tester' });
  const call = calls[0]!;
  const url = new URL(call.url);
  assert.equal(url.pathname, '/v1.0/me');
  assert.equal(url.searchParams.get('fields'), 'id,username');
  assert.equal(url.searchParams.get('access_token'), 'long-token');
  assert.equal(call.headers['authorization'], undefined);
});

test('postiz mode: secret/token scrubbing on transport errors is unchanged', async () => {
  const secretUrlProbe: HttpTransport = (req) =>
    Promise.reject(new ThreadsHttpTransportError('network', `boom for ${req.url}`));
  await assert.rejects(
    () => makePostizClient(secretUrlProbe).exchangeLongLived('SECRET-TOKEN-SENTINEL'),
    (e: unknown) => {
      assert.ok(e instanceof ThreadsOAuthProviderError);
      const serialized = JSON.stringify(e);
      assert.equal(serialized.includes(POSTIZ_CONFIG.appSecret), false);
      assert.equal(serialized.includes('SECRET-TOKEN-SENTINEL'), false);
      assert.equal(serialized.includes('graph.threads.net'), false);
      return true;
    },
  );
});

test('postiz mode: provider error envelope handling unchanged (sanitized)', async () => {
  const { transport } = transportReturning(() => ({
    status: 400,
    body: JSON.stringify({ error: { message: 'SECRET_SENTINEL', type: 'OAuthException', code: 100 } }),
  }));
  await assert.rejects(
    () => makePostizClient(transport).exchangeCode('code'),
    (e: unknown) => {
      assert.ok(e instanceof ThreadsOAuthProviderError);
      assert.equal(e.providerStatus, 400);
      assert.equal(e.providerErrorCode, 100);
      assert.equal(JSON.stringify(e).includes('SECRET_SENTINEL'), false);
      return true;
    },
  );
});

test('standard mode (explicit) matches default behavior', async () => {
  const { transport, calls } = transportReturning(() => ({
    status: 200,
    body: JSON.stringify({ access_token: 'tok', user_id: '1' }),
  }));
  const client = new ThreadsHttpOAuthClient({
    config: { ...CONFIG, transportMode: 'standard' },
    transport,
  });
  await client.exchangeCode('code');
  assert.equal(calls[0]!.method, 'POST');
});
