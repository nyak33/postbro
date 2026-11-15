import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { after, before, test } from 'node:test';

import { Pool } from 'pg';

import { buildApp, type BuildAppOptions } from '../src/app';
import { migrateDatabase } from '../src/db/migrate';
import { MockThreadsOAuthClient } from '../src/integrations/threads/oauth-client';
import { ThreadsHttpOAuthClient } from '../src/integrations/threads/oauth-client-http';
import { mintLinkToken } from '../src/modules/auth/oauth-state';
import {
  connectionStringFor,
  createLoginRole,
  startEmbeddedPostgres,
  type EmbeddedPostgresTestContext,
} from './helpers/embedded-postgres';

// Fixed dummy, non-real test-only values. The mock OAuth client performs no
// I/O: no Meta, no network, no Telegram, disposable local Postgres only.
const SIGNING_SECRET = 'dummy-signing-secret-for-tests-only-000000';
// Test-only, non-real AES key for encrypted persistence assertions.
const ENCRYPTION_KEY = { keyId: 'test-key-1', key: randomBytes(32) };
const OAUTH_CONFIG = {
  appId: 'fake-app-id-123',
  appSecret: 'fake-app-secret-NOT-REAL',
  redirectUri: 'http://127.0.0.1:3000/auth/threads/callback',
  scopes: ['threads_basic'],
};

const MIGRATIONS_DIR = path.join(process.cwd(), 'db', 'migrations');

let pg: EmbeddedPostgresTestContext;
let appPool: Pool;
let ownerPool: Pool;

async function createOperator(telegramUserId: number, status = 'active'): Promise<number> {
  const result = await ownerPool.query<{ id: string }>(
    `INSERT INTO postbro.operators (telegram_user_id, status) VALUES ($1, $2) RETURNING id`,
    [telegramUserId, status],
  );
  return Number(result.rows[0]!.id);
}

function buildWithClient(oauthClient: MockThreadsOAuthClient): ReturnType<typeof buildApp> {
  const options: BuildAppOptions = {
    threadsAuth: {
      pool: appPool,
      signingSecret: SIGNING_SECRET,
      oauthClient,
      tokenEncryptionKey: ENCRYPTION_KEY,
    },
  };
  return buildApp(options);
}

/**
 * Runs the D1 start flow and extracts the state from the redirect Location,
 * simulating Meta redirecting the browser back with that state.
 */
async function startAndExtractState(
  app: ReturnType<typeof buildApp>,
  operatorId: number,
): Promise<string> {
  const minted = await mintLinkToken(appPool, { operatorId, signingSecret: SIGNING_SECRET });
  const start = await app.inject({
    method: 'GET',
    url: `/auth/threads/start?link=${encodeURIComponent(minted.token)}`,
  });
  assert.equal(start.statusCode, 302);
  const url = new URL(start.headers.location as string);
  const state = url.searchParams.get('state');
  assert.ok(state);
  return state!;
}

before(async () => {
  pg = await startEmbeddedPostgres();
  ownerPool = pg.ownerPool;
  await migrateDatabase(pg.ownerPool, MIGRATIONS_DIR);
  const appPassword = randomBytes(16).toString('hex');
  await createLoginRole(pg.ownerPool, 'postbro_app_test', appPassword, 'postbro_app');
  appPool = new Pool({
    connectionString: connectionStringFor(pg.port, 'postbro_app_test', appPassword),
    max: 10,
  });
});

after(async () => {
  if (appPool) await appPool.end();
  if (pg) await pg.stop();
});

test('callback: end-to-end D1 start -> fake Meta callback -> mocked exchanges -> safe pending result', async () => {
  const oauthClient = new MockThreadsOAuthClient({ config: OAUTH_CONFIG });
  const app = buildWithClient(oauthClient);
  try {
    const operatorId = await createOperator(920001);
    const state = await startAndExtractState(app, operatorId);

    const response = await app.inject({
      method: 'GET',
      url: `/auth/threads/callback?state=${encodeURIComponent(state)}&code=fake-code-1`,
    });

    assert.equal(response.statusCode, 200);
    const body = response.json() as Record<string, unknown>;
    assert.equal(body.status, 'connected');
    assert.equal(typeof body.accountId, 'number');
    assert.equal(body.operatorId, operatorId);
    // Default mock scope evidence is UNVERIFIED — requested scopes are never
    // inferred as granted.
    assert.equal(body.scopesVerified, false);
    assert.deepEqual(body.grantedScopes, []);
    // No token material anywhere in the response.
    const raw = response.body;
    assert.ok(!raw.includes('mock-short-lived-token'));
    assert.ok(!raw.includes('mock-long-lived-token'));
    assert.ok(!raw.includes(OAUTH_CONFIG.appSecret));
    assert.ok(!raw.includes(SIGNING_SECRET));

    // Full mock sequence ran exactly once, in order.
    const methods = oauthClient.calls.map((c) => c.method);
    assert.deepEqual(
      methods.filter((m) => m !== 'buildAuthorizeUrl'),
      ['exchangeCode', 'exchangeLongLived', 'getMe', 'getGrantedScopes'],
    );

    // State was consumed exactly once.
    const sessions = await ownerPool.query(
      'SELECT consumed_at FROM postbro.oauth_sessions WHERE operator_id = $1',
      [operatorId],
    );
    assert.equal(sessions.rowCount, 1);
    assert.ok(sessions.rows[0]!.consumed_at !== null);
  } finally {
    await app.close();
  }
});

test('callback: replayed state is rejected and no provider calls occur', async () => {
  const oauthClient = new MockThreadsOAuthClient({ config: OAUTH_CONFIG, userId: 'mock-user-replay' });
  const app = buildWithClient(oauthClient);
  try {
    const operatorId = await createOperator(920002);
    const state = await startAndExtractState(app, operatorId);
    const url = `/auth/threads/callback?state=${encodeURIComponent(state)}&code=fake-code-2`;

    const first = await app.inject({ method: 'GET', url });
    assert.equal(first.statusCode, 200);

    const second = await app.inject({ method: 'GET', url });
    assert.equal(second.statusCode, 401);
    assert.deepEqual(second.json(), { error: 'invalid_state' });
    assert.equal(
      oauthClient.calls.filter((c) => c.method === 'exchangeCode').length,
      1,
    );
  } finally {
    await app.close();
  }
});

test('callback: missing/unknown/expired state and missing code fail closed', async () => {
  const oauthClient = new MockThreadsOAuthClient({ config: OAUTH_CONFIG });
  const app = buildWithClient(oauthClient);
  try {
    const noParams = await app.inject({ method: 'GET', url: '/auth/threads/callback' });
    assert.equal(noParams.statusCode, 400);

    const unknown = await app.inject({
      method: 'GET',
      url: '/auth/threads/callback?state=does-not-exist&code=x',
    });
    assert.equal(unknown.statusCode, 401);
    assert.deepEqual(unknown.json(), { error: 'invalid_state' });

    // Expired state: mint a session then force expiry in the past.
    const operatorId = await createOperator(920003);
    const state = await startAndExtractState(app, operatorId);
    await ownerPool.query(
      `UPDATE postbro.oauth_sessions SET expires_at = now() - interval '1 second'
        WHERE operator_id = $1`,
      [operatorId],
    );
    const expired = await app.inject({
      method: 'GET',
      url: `/auth/threads/callback?state=${encodeURIComponent(state)}&code=x`,
    });
    assert.equal(expired.statusCode, 401);
    assert.deepEqual(expired.json(), { error: 'invalid_state' });
    assert.equal(oauthClient.calls.filter((c) => c.method === 'exchangeCode').length, 0);
  } finally {
    await app.close();
  }
});

test('callback: provider error param maps to safe coarse rejection', async () => {
  const oauthClient = new MockThreadsOAuthClient({ config: OAUTH_CONFIG });
  const app = buildWithClient(oauthClient);
  try {
    const response = await app.inject({
      method: 'GET',
      url: '/auth/threads/callback?error=access_denied&state=whatever&code=x',
    });
    assert.equal(response.statusCode, 400);
    assert.deepEqual(response.json(), { error: 'provider_error' });
  } finally {
    await app.close();
  }
});

test('callback: provider exchange failure maps to provider_exchange_failed', async () => {
  const oauthClient = new MockThreadsOAuthClient({
    config: OAUTH_CONFIG,
    failExchangeCode: 'invalid_code',
  });
  const app = buildWithClient(oauthClient);
  try {
    const operatorId = await createOperator(920004);
    const state = await startAndExtractState(app, operatorId);
    const response = await app.inject({
      method: 'GET',
      url: `/auth/threads/callback?state=${encodeURIComponent(state)}&code=bad-code`,
    });
    assert.equal(response.statusCode, 502);
    assert.deepEqual(response.json(), { error: 'provider_exchange_failed' });
  } finally {
    await app.close();
  }
});

test('callback: immutable id mismatch between exchange and getMe is rejected', async () => {
  // exchangeCode returns userId A; getMe must return the same id. A mock
  // whose identity differs simulates a confused provider response.
  const oauthClient = new MockThreadsOAuthClient({ config: OAUTH_CONFIG, userId: 'user-A' });
  const originalGetMe = oauthClient.getMe.bind(oauthClient);
  oauthClient.getMe = async (token: string) => {
    const me = await originalGetMe(token);
    return { ...me, id: 'user-B-attacker' };
  };
  const app = buildWithClient(oauthClient);
  try {
    const operatorId = await createOperator(920005);
    const state = await startAndExtractState(app, operatorId);
    const response = await app.inject({
      method: 'GET',
      url: `/auth/threads/callback?state=${encodeURIComponent(state)}&code=fake-code-3`,
    });
    assert.equal(response.statusCode, 502);
    assert.deepEqual(response.json(), { error: 'identity_mismatch' });
  } finally {
    await app.close();
  }
});

test('callback: verified granted-scope evidence is reported as verified', async () => {
  const oauthClient = new MockThreadsOAuthClient({
    config: OAUTH_CONFIG,
    userId: 'mock-user-verified-scopes',
    grantedScopes: { verified: true, scopes: ['threads_basic'] },
  });
  const app = buildWithClient(oauthClient);
  try {
    const operatorId = await createOperator(920006);
    const state = await startAndExtractState(app, operatorId);
    const response = await app.inject({
      method: 'GET',
      url: `/auth/threads/callback?state=${encodeURIComponent(state)}&code=fake-code-4`,
    });
    assert.equal(response.statusCode, 200);
    const body = response.json() as Record<string, unknown>;
    assert.equal(body.scopesVerified, true);
    assert.deepEqual(body.grantedScopes, ['threads_basic']);
    // Connected only after persistence succeeded.
    assert.equal(body.status, 'connected');
  } finally {
    await app.close();
  }
});

test('callback: disabled operator session fails closed', async () => {
  const oauthClient = new MockThreadsOAuthClient({ config: OAUTH_CONFIG });
  const app = buildWithClient(oauthClient);
  try {
    const operatorId = await createOperator(920007);
    const state = await startAndExtractState(app, operatorId);
    await ownerPool.query('UPDATE postbro.operators SET status = $1 WHERE id = $2', [
      'disabled',
      operatorId,
    ]);
    const response = await app.inject({
      method: 'GET',
      url: `/auth/threads/callback?state=${encodeURIComponent(state)}&code=x`,
    });
    assert.equal(response.statusCode, 401);
    assert.deepEqual(response.json(), { error: 'invalid_state' });
    // Session must NOT have been consumed by the failed attempt.
    const sessions = await ownerPool.query(
      'SELECT consumed_at FROM postbro.oauth_sessions WHERE operator_id = $1',
      [operatorId],
    );
    assert.equal(sessions.rows[0]!.consumed_at, null);
    assert.equal(oauthClient.calls.filter((c) => c.method === 'exchangeCode').length, 0);
  } finally {
    await app.close();
  }
});

// --- postiz exchange omits user_id: /me becomes the sole provider id ------

function buildWithPostizTransport(handler: (req: {
  method: string;
  url: string;
}) => { status: number; body: string }): ReturnType<typeof buildApp> {
  // Full-stack: real ThreadsHttpOAuthClient in postiz mode over a fake
  // transport — exercises parsing, mode gating and callback orchestration.
  // No network; disposable Postgres only.
  const client = new ThreadsHttpOAuthClient({
    config: { ...OAUTH_CONFIG, transportMode: 'postiz' },
    transport: (req) => {
      const url = new URL(req.url);
      return Promise.resolve(handler({ method: req.method, url: url.pathname }));
    },
  });
  const options: BuildAppOptions = {
    threadsAuth: {
      pool: appPool,
      signingSecret: SIGNING_SECRET,
      oauthClient: client,
      tokenEncryptionKey: ENCRYPTION_KEY,
    },
  };
  return buildApp(options);
}

function postizHandler(userIdBody: string | undefined, meId: string | undefined) {
  return ({ url }: { method: string; url: string }) => {
    if (url === '/oauth/access_token') {
      return {
        status: 200,
        body: JSON.stringify({
          access_token: 'short-tok-NOT-REAL',
          ...(userIdBody !== undefined ? { user_id: userIdBody } : {}),
        }),
      };
    }
    if (url === '/access_token') {
      return { status: 200, body: JSON.stringify({ access_token: 'long-tok-NOT-REAL', expires_in: 3600 }) };
    }
    // /v1.0/me
    return {
      status: 200,
      body: JSON.stringify({
        ...(meId !== undefined ? { id: meId } : {}),
        username: 'postiz-user',
      }),
    };
  };
}

test('callback (postiz transport): token-only exchange succeeds via /me id through persistence', async () => {
  const app = buildWithPostizTransport(postizHandler(undefined, 'provider-postiz-1'));
  try {
    const operatorId = await createOperator(920101);
    const state = await startAndExtractState(app, operatorId);
    const response = await app.inject({
      method: 'GET',
      url: `/auth/threads/callback?state=${encodeURIComponent(state)}&code=fake-code-p1`,
    });
    assert.equal(response.statusCode, 200);
    const body = response.json() as Record<string, unknown>;
    assert.equal(body.status, 'connected');
    assert.equal(typeof body.accountId, 'number');
    // Persisted under the /me id.
    const account = await ownerPool.query(
      'SELECT id, username FROM postbro.threads_accounts WHERE provider_id = $1',
      ['provider-postiz-1'],
    );
    assert.equal(account.rowCount, 1);
    assert.equal(account.rows[0]!.username, 'postiz-user');
    // No token material in the response.
    assert.ok(!response.body.includes('short-tok'));
    assert.ok(!response.body.includes('long-tok'));
  } finally {
    await app.close();
  }
});

test('callback (postiz transport): present user_id matching /me succeeds', async () => {
  const app = buildWithPostizTransport(postizHandler('provider-postiz-2', 'provider-postiz-2'));
  try {
    const operatorId = await createOperator(920102);
    const state = await startAndExtractState(app, operatorId);
    const response = await app.inject({
      method: 'GET',
      url: `/auth/threads/callback?state=${encodeURIComponent(state)}&code=fake-code-p2`,
    });
    assert.equal(response.statusCode, 200);
    const account = await ownerPool.query(
      'SELECT count(*)::int AS n FROM postbro.threads_accounts WHERE provider_id = $1',
      ['provider-postiz-2'],
    );
    assert.equal(account.rows[0]!.n, 1);
  } finally {
    await app.close();
  }
});

test('callback (postiz transport): present user_id mismatching /me rejects, no persistence', async () => {
  const app = buildWithPostizTransport(postizHandler('exchange-id-A', 'me-id-B'));
  try {
    const operatorId = await createOperator(920103);
    const state = await startAndExtractState(app, operatorId);
    const response = await app.inject({
      method: 'GET',
      url: `/auth/threads/callback?state=${encodeURIComponent(state)}&code=fake-code-p3`,
    });
    assert.equal(response.statusCode, 502);
    assert.deepEqual(response.json(), { error: 'identity_mismatch' });
    for (const pid of ['exchange-id-A', 'me-id-B']) {
      const account = await ownerPool.query(
        'SELECT count(*)::int AS n FROM postbro.threads_accounts WHERE provider_id = $1',
        [pid],
      );
      assert.equal(account.rows[0]!.n, 0, 'no account persisted on mismatch');
    }
  } finally {
    await app.close();
  }
});

test('callback (postiz transport): /me missing id rejects, no persistence', async () => {
  const app = buildWithPostizTransport(postizHandler(undefined, undefined));
  try {
    const operatorId = await createOperator(920104);
    const state = await startAndExtractState(app, operatorId);
    const response = await app.inject({
      method: 'GET',
      url: `/auth/threads/callback?state=${encodeURIComponent(state)}&code=fake-code-p4`,
    });
    assert.equal(response.statusCode, 502);
    assert.deepEqual(response.json(), { error: 'provider_exchange_failed' });
    const accounts = await ownerPool.query(
      `SELECT count(*)::int AS n FROM postbro.threads_accounts WHERE username = 'postiz-user'`,
    );
    // Only the earlier successful test's row may exist; this operator got none.
    const bindings = await ownerPool.query(
      'SELECT count(*)::int AS n FROM postbro.operator_accounts WHERE operator_id = $1',
      [operatorId],
    );
    assert.equal(bindings.rows[0]!.n, 0, 'no binding created for failed /me');
    void accounts;
  } finally {
    await app.close();
  }
});

test('callback (postiz transport): present INVALID user_id falls back to /me and persists', async () => {
  // Live failure 2026-11-15: Meta returned a usable access_token with a
  // present-but-unusable user_id (null); Postiz ignores the exchange
  // user_id and sources identity from /me. The callback must therefore
  // proceed: /me IS consulted and its identity persisted.
  const app = buildWithPostizTransport(postizHandler('', 'me-id-C'));
  try {
    const operatorId = await createOperator(920105);
    const state = await startAndExtractState(app, operatorId);
    const response = await app.inject({
      method: 'GET',
      url: `/auth/threads/callback?state=${encodeURIComponent(state)}&code=fake-code-p5`,
    });
    assert.equal(response.statusCode, 200);
    assert.equal((response.json() as Record<string, unknown>).status, 'connected');
    const account = await ownerPool.query(
      'SELECT count(*)::int AS n FROM postbro.threads_accounts WHERE provider_id = $1',
      ['me-id-C'],
    );
    assert.equal(account.rows[0]!.n, 1, 'account persisted under the /me id');
  } finally {
    await app.close();
  }
});

test('callback (postiz transport): invalid exchange user_id + /me missing id rejects, no persistence', async () => {
  const app = buildWithPostizTransport(postizHandler('', undefined));
  try {
    const operatorId = await createOperator(920106);
    const state = await startAndExtractState(app, operatorId);
    const response = await app.inject({
      method: 'GET',
      url: `/auth/threads/callback?state=${encodeURIComponent(state)}&code=fake-code-p6`,
    });
    assert.equal(response.statusCode, 502);
    assert.deepEqual(response.json(), { error: 'provider_exchange_failed' });
    const bindings = await ownerPool.query(
      'SELECT count(*)::int AS n FROM postbro.operator_accounts WHERE operator_id = $1',
      [operatorId],
    );
    assert.equal(bindings.rows[0]!.n, 0, 'no binding created when /me id missing');
  } finally {
    await app.close();
  }
});
