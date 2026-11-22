import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseSocialStageConfig } from '../src/staging/config.js';

const PROJECT = 'a'.repeat(20);
const OTHER = 'b'.repeat(20);

function goodEnv(): NodeJS.ProcessEnv {
  return {
    SOCIAL_STAGING_PROJECT_REF: PROJECT,
    SOCIAL_STAGING_SUPABASE_URL: 'https://' + PROJECT + '.supabase.co',
    SOCIAL_STAGING_PUBLISHABLE_KEY: 'sb_publishable_' + 'x'.repeat(32),
    SOCIAL_STAGING_DATABASE_URL: 'postgresql://postgres:fake-test-only-password@db.' +
      PROJECT + '.supabase.co:5432/postgres',
    SOCIAL_STAGING_HOST: '127.0.0.1',
    SOCIAL_STAGING_PORT: '3201',
  };
}

test('staging requires an explicit matching project and loopback-only listener', () => {
  const config = parseSocialStageConfig(goodEnv());
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
  assert.throws(() => parseSocialStageConfig({
    DATABASE_URL: 'postgresql://test:test@localhost:5432/postgres',
    SOCIAL_STAGING_PROJECT_REF: PROJECT,
  }), /isolated Social staging configuration/);
});

test('reject mixed project refs in database URL and in browser Auth URL', () => {
  const mismatch = goodEnv();
  mismatch.SOCIAL_STAGING_DATABASE_URL = 'postgresql://postgres:test@db.' +
    OTHER + '.supabase.co/postgres';
  assert.throws(() => parseSocialStageConfig(mismatch), /isolated Social staging/);
  const authMismatch = goodEnv();
  authMismatch.SOCIAL_STAGING_SUPABASE_URL = 'https://' + OTHER + '.supabase.co';
  assert.throws(() => parseSocialStageConfig(authMismatch), /isolated Social staging/);
});

test('session pooler is allowed only when PostgreSQL username matches project', () => {
  const env = goodEnv();
  env.SOCIAL_STAGING_DATABASE_URL = 'postgresql://postgres.' +
    PROJECT + ':fake-test-only-password@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres';
  assert.equal(parseSocialStageConfig(env).databasePool.user, 'postgres.' + PROJECT);
  env.SOCIAL_STAGING_DATABASE_URL = 'postgresql://postgres.' +
    OTHER + ':fake-test-only-password@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres';
  assert.throws(() => parseSocialStageConfig(env), /isolated Social staging/);
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
    env.SOCIAL_STAGING_DATABASE_URL = url;
    assert.throws(() => parseSocialStageConfig(env), /isolated Social staging/, url);
  }
});

test('reject non-loopback binds, production port 3000 and invalid port names', () => {
  for (const bind of ['0.0.0.0', 'localhost', '::', '192.168.1.25']) {
    const env = goodEnv();
    env.SOCIAL_STAGING_HOST = bind;
    assert.throws(() => parseSocialStageConfig(env), /isolated Social staging/, bind);
  }
  for (const port of ['3000', '5432', '0', '99', '65536', 'NaN', '3201abc']) {
    const env = goodEnv();
    env.SOCIAL_STAGING_PORT = port;
    assert.throws(() => parseSocialStageConfig(env), /isolated Social staging/, port);
  }
});

test('reject secret keys, malicious host names and URL userinfo', () => {
  for (const key of ['sb_secret_PLEASE_NEVER', 'anon-not-allowed', '', 'sb_publishable_short']) {
    const env = goodEnv();
    env.SOCIAL_STAGING_PUBLISHABLE_KEY = key;
    assert.throws(() => parseSocialStageConfig(env), /isolated Social staging/);
  }
  for (const authUrl of [
    'http://' + PROJECT + '.supabase.co',
    'https://evil.example.com',
    'https://' + PROJECT + '.supabase.co.evil.example',
    'https://someone:secret@' + PROJECT + '.supabase.co',
    'https://' + PROJECT + '.supabase.co/api',
  ]) {
    const env = goodEnv();
    env.SOCIAL_STAGING_SUPABASE_URL = authUrl;
    assert.throws(() => parseSocialStageConfig(env), /isolated Social staging/);
  }
});
