import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseSocialPrelaunchConfig } from '../src/prelaunch/config.js';
import { buildPrelaunchApp } from '../src/prelaunch/server.js';
import type { Pool } from 'pg';

const PROJECT = 'nqjlgalyjxifzisitzfa';
const OTHER = 'b'.repeat(20);

function goodEnv(): NodeJS.ProcessEnv {
  return {
    SOCIAL_PRELAUNCH_PROJECT_REF: PROJECT,
    SOCIAL_PRELAUNCH_SUPABASE_URL: 'https://' + PROJECT + '.supabase.co',
    SOCIAL_PRELAUNCH_PUBLISHABLE_KEY: 'sb_publishable_' + 'x'.repeat(32),
    SOCIAL_PRELAUNCH_DATABASE_URL: 'postgresql://postgres:fake-test-only-password@db.' +
      PROJECT + '.supabase.co:5432/postgres',
    SOCIAL_PRELAUNCH_HOST: '127.0.0.1',
    SOCIAL_PRELAUNCH_PORT: '3201',
    SOCIAL_PRELAUNCH_SHARED_PROJECT_CONFIRM: 'postbro-core',
  };
}

test('prelaunch requires an explicit matching project and loopback-only listener', () => {
  const config = parseSocialPrelaunchConfig(goodEnv());
  assert.equal(config.projectRef, PROJECT);
  assert.equal(config.supabaseUrl, 'https://' + PROJECT + '.supabase.co');
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.port, 3201);
  assert.equal(config.databasePool.host, 'db.' + PROJECT + '.supabase.co');
  assert.equal(config.databasePool.port, 5432);
  assert.equal(config.databasePool.max, 3);
  assert.deepEqual(config.databasePool.ssl, {
    rejectUnauthorized: true,
    servername: 'db.' + PROJECT + '.supabase.co'
  });
});

test('missing standalone config never falls back to PostBro production DATABASE_URL', () => {
  assert.throws(() => parseSocialPrelaunchConfig({
    DATABASE_URL: 'postgresql://test:test@localhost:5432/postgres',
    SOCIAL_PRELAUNCH_PROJECT_REF: PROJECT,
  }), /isolated Social prelaunch configuration/);
});

test('reject alternative Supabase project even with valid shared-project acknowledgement', () => {
  const env = goodEnv();
  env.SOCIAL_PRELAUNCH_PROJECT_REF = OTHER;
  env.SOCIAL_PRELAUNCH_SUPABASE_URL = 'https://' + OTHER + '.supabase.co';
  env.SOCIAL_PRELAUNCH_DATABASE_URL = 'postgresql://postgres:fake-test-only-password@db.' + OTHER + '.supabase.co/postgres';
  assert.throws(() => parseSocialPrelaunchConfig(env), /Social prelaunch configuration/);
});

test('reject missing shared-project acknowledgement', () => {
  const env = goodEnv();
  delete env.SOCIAL_PRELAUNCH_SHARED_PROJECT_CONFIRM;
  assert.throws(() => parseSocialPrelaunchConfig(env), /Social prelaunch configuration/);
  env.SOCIAL_PRELAUNCH_SHARED_PROJECT_CONFIRM = 'another-project';
  assert.throws(() => parseSocialPrelaunchConfig(env), /Social prelaunch configuration/);
});

test('reject mixed project refs in database URL and in browser Auth URL', () => {
  const mismatch = goodEnv();
  mismatch.SOCIAL_PRELAUNCH_DATABASE_URL = 'postgresql://postgres:test@db.' +
    OTHER + '.supabase.co/postgres';
  assert.throws(() => parseSocialPrelaunchConfig(mismatch), /isolated Social prelaunch/);
  const authMismatch = goodEnv();
  authMismatch.SOCIAL_PRELAUNCH_SUPABASE_URL = 'https://' + OTHER + '.supabase.co';
  assert.throws(() => parseSocialPrelaunchConfig(authMismatch), /isolated Social prelaunch/);
});

test('session pooler is allowed only when PostgreSQL username matches project', () => {
  const env = goodEnv();
  env.SOCIAL_PRELAUNCH_DATABASE_URL = 'postgresql://postgres.' +
    PROJECT + ':fake-test-only-password@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres';
  assert.equal(parseSocialPrelaunchConfig(env).databasePool.user, 'postgres.' + PROJECT);
  env.SOCIAL_PRELAUNCH_DATABASE_URL = 'postgresql://postgres.' +
    OTHER + ':fake-test-only-password@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres';
  assert.throws(() => parseSocialPrelaunchConfig(env), /isolated Social prelaunch/);
});

test('reject insecure or untrusted database connection URLs', () => {
  const badUrls = [
    'postgresql://postgres:pass@localhost:5432/postgres',
    'postgresql://postgres:pass@db.' + PROJECT + '.supabase.co:5432/postgres?sslmode=disable',
    'http://postgres:pass@db.' + PROJECT + '.supabase.co/postgres',
    'postgresql://postgres:pass@db.' + PROJECT + '.supabase.co/postbro',
    'postgresql://postgres@db.' + PROJECT + '.supabase.co/postgres',
    'postgresql://postgres:pass@evil.example.com/postgres',
  ];
  for (const url of badUrls) {
    const env = goodEnv();
    env.SOCIAL_PRELAUNCH_DATABASE_URL = url;
    assert.throws(() => parseSocialPrelaunchConfig(env), /isolated Social prelaunch/, url);
  }
});

test('reject non-loopback binds, production port 3000 and invalid port names', () => {
  for (const bind of ['0.0.0.0', 'localhost', '::', '192.168.1.25']) {
    const env = goodEnv();
    env.SOCIAL_PRELAUNCH_HOST = bind;
    assert.throws(() => parseSocialPrelaunchConfig(env), /isolated Social prelaunch/, bind);
  }
  for (const port of ['3000', '5432', '0', '99', '65536', 'NaN', '3201abc']) {
    const env = goodEnv();
    env.SOCIAL_PRELAUNCH_PORT = port;
    assert.throws(() => parseSocialPrelaunchConfig(env), /isolated Social prelaunch/, port);
  }
});

test('reject secret keys, malicious host names and URL userinfo', () => {
  for (const key of ['sb_secret_PLEASE_NEVER', 'anon-not-allowed', '', 'sb_publishable_short']) {
    const env = goodEnv();
    env.SOCIAL_PRELAUNCH_PUBLISHABLE_KEY = key;
    assert.throws(() => parseSocialPrelaunchConfig(env), /isolated Social prelaunch/);
  }
  for (const authUrl of [
    'http://' + PROJECT + '.supabase.co',
    'https://evil.example.com',
    'https://' + PROJECT + '.supabase.co.evil.example',
    'https://someone:secret@' + PROJECT + '.supabase.co',
    'https://' + PROJECT + '.supabase.co/api',
  ]) {
    const env = goodEnv();
    env.SOCIAL_PRELAUNCH_SUPABASE_URL = authUrl;
    assert.throws(() => parseSocialPrelaunchConfig(env), /isolated Social prelaunch/);
  }
});

test('prelaunch process health is local-only intent and does not contact DB or Auth', async () => {
  const config = parseSocialPrelaunchConfig(goodEnv());
  const app = buildPrelaunchApp(config, {} as Pool);
  try {
    const health = await app.inject({ method: 'GET', url: '/social/health' });
    assert.equal(health.statusCode, 200);
    assert.deepEqual(health.json(), {
      status: 'configured',
      service: 'postbro-social-prelaunch',
      check: 'process_only',
    });
    const portal = await app.inject({ method: 'GET', url: '/social/' });
    assert.equal(portal.statusCode, 200);
    assert.match(portal.body, /Invite-only access/);
    const blocked = await app.inject({ method: 'GET', url: '/api/social/clients' });
    assert.equal(blocked.statusCode, 401);
    const configResponse = await app.inject({ method: 'GET', url: '/api/social/config' });
    assert.equal(configResponse.statusCode, 200);
    assert.deepEqual(configResponse.json(), {
      supabaseUrl: config.supabaseUrl,
      publishableKey: config.publishableKey,
    });
    assert.doesNotMatch(configResponse.body, /password|DATABASE_URL|service_role/);
  } finally {
    await app.close();
  }
});
