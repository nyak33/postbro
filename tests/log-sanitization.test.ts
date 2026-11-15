import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { Writable } from 'node:stream';
import { after, before, test } from 'node:test';

import { Pool } from 'pg';

import { buildApp } from '../src/app';
import { migrateDatabase } from '../src/db/migrate';
import { MockThreadsOAuthClient } from '../src/integrations/threads/oauth-client';
import { mintLinkToken } from '../src/modules/auth/oauth-state';
import {
  connectionStringFor,
  createLoginRole,
  startEmbeddedPostgres,
  type EmbeddedPostgresTestContext,
} from './helpers/embedded-postgres';

// Fixed dummy, non-real test-only values; mock client performs no I/O.
const SIGNING_SECRET = 'dummy-signing-secret-for-tests-only-000000';
const ENCRYPTION_KEY = { keyId: 'test-key-1', key: randomBytes(32) };
const OAUTH_CONFIG = {
  appId: 'fake-app-id-123',
  appSecret: 'fake-app-secret-NOT-REAL',
  redirectUri: 'http://127.0.0.1:3000/auth/threads/callback',
  scopes: ['threads_basic'],
};
const MIGRATIONS_DIR = path.join(process.cwd(), 'db', 'migrations');

// Sentinel strings that must NEVER appear in emitted logs.
const FAKE_CODE = 'fake-oauth-code-SENTINEL';
const FAKE_LINK_FRAGMENT = 'SENTINELLINK';

class LogSink extends Writable {
  readonly lines: string[] = [];
  override _write(chunk: Buffer | string, _enc: string, cb: () => void): void {
    for (const line of String(chunk).split('\n')) {
      if (line.trim().length > 0) this.lines.push(line);
    }
    cb();
  }
  all(): string {
    return this.lines.join('\n');
  }
  parsed(): Record<string, unknown>[] {
    return this.lines.map((l) => JSON.parse(l) as Record<string, unknown>);
  }
}

let pg: EmbeddedPostgresTestContext;
let appPool: Pool;

before(async () => {
  pg = await startEmbeddedPostgres();
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

async function createOperator(telegramUserId: number, status = 'active'): Promise<number> {
  const result = await pg.ownerPool.query<{ id: string }>(
    `INSERT INTO postbro.operators (telegram_user_id, status) VALUES ($1, $2) RETURNING id`,
    [telegramUserId, status],
  );
  return Number(result.rows[0]!.id);
}

test('request logs strip ALL query strings (code/state/link) on auth routes and others', async () => {
  const sink = new LogSink();
  const app = buildApp({
    logger: { level: 'info', stream: sink },
    threadsAuth: {
      pool: appPool,
      signingSecret: SIGNING_SECRET,
      oauthClient: new MockThreadsOAuthClient({ config: OAUTH_CONFIG }),
      tokenEncryptionKey: ENCRYPTION_KEY,
    },
  });
  try {
    await app.inject({ method: 'GET', url: `/auth/threads/callback?state=${FAKE_CODE}&code=${FAKE_CODE}` });
    await app.inject({ method: 'GET', url: `/auth/threads/start?link=1.${FAKE_LINK_FRAGMENT}.2.3.4` });
    await app.inject({ method: 'GET', url: `/health?probe=${FAKE_CODE}` });
    await app.ready();
    // Flush pino's buffered writes.
    await new Promise((r) => setTimeout(r, 50));
  } finally {
    await app.close();
  }
  const all = sink.all();
  assert.ok(all.length > 0, 'expected log output');
  assert.ok(!all.includes(FAKE_CODE), 'log output must not contain the OAuth code sentinel');
  assert.ok(!all.includes(FAKE_LINK_FRAGMENT), 'log output must not contain the link sentinel');
  // Query strings are stripped from logged urls, paths preserved.
  for (const entry of sink.parsed()) {
    const req = entry['req'] as Record<string, unknown> | undefined;
    if (req && typeof req['url'] === 'string') {
      assert.ok(!(req['url'] as string).includes('?'), `logged url has query: ${req['url']}`);
    }
  }
  assert.ok(all.includes('/auth/threads/callback'), 'path retained in logs');
});

test('provider failure logs warn with stage+kind only; response behavior unchanged', async () => {
  const sink = new LogSink();
  const oauthClient = new MockThreadsOAuthClient({
    config: OAUTH_CONFIG,
    failExchangeCode: 'invalid_code',
  });
  const app = buildApp({
    logger: { level: 'info', stream: sink },
    threadsAuth: {
      pool: appPool,
      signingSecret: SIGNING_SECRET,
      oauthClient,
      tokenEncryptionKey: ENCRYPTION_KEY,
    },
  });
  try {
    const operatorId = await createOperator(930001);
    const minted = await mintLinkToken(appPool, { operatorId, signingSecret: SIGNING_SECRET });
    const start = await app.inject({
      method: 'GET',
      url: `/auth/threads/start?link=${encodeURIComponent(minted.token)}`,
    });
    assert.equal(start.statusCode, 302);
    const state = new URL(start.headers.location as string).searchParams.get('state');
    assert.ok(state);

    const response = await app.inject({
      method: 'GET',
      url: `/auth/threads/callback?state=${encodeURIComponent(state!)}&code=${FAKE_CODE}`,
    });
    assert.equal(response.statusCode, 502);
    assert.deepEqual(response.json(), { error: 'provider_exchange_failed' });
    await new Promise((r) => setTimeout(r, 50));
  } finally {
    await app.close();
  }
  const warns = sink.parsed().filter((e) => e['level'] === 40);
  assert.equal(warns.length, 1, 'exactly one sanitized warn expected');
  const warn = warns[0]!;
  assert.equal(warn['stage'], 'exchangeCode');
  assert.equal(warn['providerErrorKind'], 'invalid_code');
  assert.equal(warn['msg'], 'threads oauth provider exchange failed');
  // No mock error message, no sentinel values, no tokens anywhere in logs.
  const all = sink.all();
  assert.ok(!all.includes('mock provider exchange failure'));
  assert.ok(!all.includes(FAKE_CODE));
  assert.ok(!all.includes('mock-short-lived-token'));
  assert.ok(!all.includes(OAUTH_CONFIG.appSecret));
  assert.ok(!all.includes(SIGNING_SECRET));
});

test('provider failure warn includes ONLY safe numeric diagnostics (status/code/subcode)', async () => {
  const sink = new LogSink();
  const oauthClient = new MockThreadsOAuthClient({
    config: OAUTH_CONFIG,
    failExchangeCode: 'invalid_code',
    failExchangeCodeDiagnostics: { status: 400, errorCode: 100, errorSubcode: 2345678 },
  });
  const app = buildApp({
    logger: { level: 'info', stream: sink },
    threadsAuth: {
      pool: appPool,
      signingSecret: SIGNING_SECRET,
      oauthClient,
      tokenEncryptionKey: ENCRYPTION_KEY,
    },
  });
  try {
    const operatorId = await createOperator(930002);
    const minted = await mintLinkToken(appPool, { operatorId, signingSecret: SIGNING_SECRET });
    const start = await app.inject({
      method: 'GET',
      url: `/auth/threads/start?link=${encodeURIComponent(minted.token)}`,
    });
    assert.equal(start.statusCode, 302);
    const state = new URL(start.headers.location as string).searchParams.get('state');
    assert.ok(state);

    const response = await app.inject({
      method: 'GET',
      url: `/auth/threads/callback?state=${encodeURIComponent(state!)}&code=${FAKE_CODE}`,
    });
    // HTTP response behavior unchanged.
    assert.equal(response.statusCode, 502);
    assert.deepEqual(response.json(), { error: 'provider_exchange_failed' });
    await new Promise((r) => setTimeout(r, 50));
  } finally {
    await app.close();
  }
  const warns = sink.parsed().filter((e) => e['level'] === 40);
  assert.equal(warns.length, 1, 'exactly one sanitized warn expected');
  const warn = warns[0]!;
  assert.equal(warn['stage'], 'exchangeCode');
  assert.equal(warn['providerErrorKind'], 'invalid_code');
  assert.equal(warn['providerStatus'], 400);
  assert.equal(warn['providerErrorCode'], 100);
  assert.equal(warn['providerErrorSubcode'], 2345678);
  assert.equal(warn['msg'], 'threads oauth provider exchange failed');
  // Allowlisted fields only on the warn entry (plus pino's own keys).
  const allowedKeys = new Set([
    'level', 'time', 'pid', 'hostname', 'msg',
    'stage', 'providerErrorKind', 'providerStatus', 'providerErrorCode', 'providerErrorSubcode',
    'providerFailureReason',
    'reqId', 'req', 'res', 'responseTime',
  ]);
  for (const key of Object.keys(warn)) {
    assert.ok(allowedKeys.has(key), `unexpected log field: ${key}`);
  }
  // No mock message, sentinel code, tokens or secrets anywhere in logs.
  const all = sink.all();
  assert.ok(!all.includes('mock provider exchange failure'));
  assert.ok(!all.includes(FAKE_CODE));
  assert.ok(!all.includes('mock-short-lived-token'));
  assert.ok(!all.includes(OAUTH_CONFIG.appSecret));
  assert.ok(!all.includes(SIGNING_SECRET));
});

test('provider failure warn includes categorical failureReason enum only', async () => {
  const sink = new LogSink();
  const oauthClient = new MockThreadsOAuthClient({
    config: OAUTH_CONFIG,
    failExchangeCode: 'unknown',
    failExchangeCodeDiagnostics: { failureReason: 'redirect' },
  });
  const app = buildApp({
    logger: { level: 'info', stream: sink },
    threadsAuth: {
      pool: appPool,
      signingSecret: SIGNING_SECRET,
      oauthClient,
      tokenEncryptionKey: ENCRYPTION_KEY,
    },
  });
  try {
    const operatorId = await createOperator(930003);
    const minted = await mintLinkToken(appPool, { operatorId, signingSecret: SIGNING_SECRET });
    const start = await app.inject({
      method: 'GET',
      url: `/auth/threads/start?link=${encodeURIComponent(minted.token)}`,
    });
    assert.equal(start.statusCode, 302);
    const state = new URL(start.headers.location as string).searchParams.get('state');
    assert.ok(state);

    const response = await app.inject({
      method: 'GET',
      url: `/auth/threads/callback?state=${encodeURIComponent(state!)}&code=${FAKE_CODE}`,
    });
    assert.equal(response.statusCode, 502);
    assert.deepEqual(response.json(), { error: 'provider_exchange_failed' });
    await new Promise((r) => setTimeout(r, 50));
  } finally {
    await app.close();
  }
  const warns = sink.parsed().filter((e) => e['level'] === 40);
  assert.equal(warns.length, 1, 'exactly one sanitized warn expected');
  const warn = warns[0]!;
  assert.equal(warn['stage'], 'exchangeCode');
  assert.equal(warn['providerErrorKind'], 'unknown');
  assert.equal(warn['providerFailureReason'], 'redirect');
  assert.equal(warn['providerStatus'], undefined);
  assert.equal(warn['providerErrorCode'], undefined);
  // Allowlisted fields only on the warn entry (plus pino's own keys).
  const allowedKeys = new Set([
    'level', 'time', 'pid', 'hostname', 'msg',
    'stage', 'providerErrorKind', 'providerStatus', 'providerErrorCode', 'providerErrorSubcode',
    'providerFailureReason',
    'reqId', 'req', 'res', 'responseTime',
  ]);
  for (const key of Object.keys(warn)) {
    assert.ok(allowedKeys.has(key), `unexpected log field: ${key}`);
  }
  const all = sink.all();
  assert.ok(!all.includes('mock provider exchange failure'));
  assert.ok(!all.includes(FAKE_CODE));
  assert.ok(!all.includes('mock-short-lived-token'));
  assert.ok(!all.includes(OAUTH_CONFIG.appSecret));
  assert.ok(!all.includes(SIGNING_SECRET));
});
