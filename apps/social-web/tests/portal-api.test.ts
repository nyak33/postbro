import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Pool } from 'pg';
import { buildSocialPortalApp } from '../src/http/portal.js';
import {
  parseBrand, parseHistory, parsePersonaReview, withTenantRls, saveTenantBrand,
} from '../src/http/tenant-store.js';

const USER = '10000000-0000-4000-8000-000000000001';
const CLIENT = '30000000-0000-4000-8000-000000000001';
const OTHER_CLIENT = '30000000-0000-4000-8000-000000000002';
const TOKEN = 'jwt.header.payload.signature.whatever';
const BRAND = {
  businessName: 'Acme Coffee', niche: 'Coffee', audience: 'Home brewers',
  language: 'English', tone: 'Warm', restrictions: '', samplePosts: ''
};
const KEY = 'sb_publishable_' + 'x'.repeat(32);

interface MockDb {
  pool: Pick<Pool, 'connect'>;
  calls: string[];
  values: unknown[][];
  connectionCount: () => number;
  releasedCount: () => number;
}

function mockDb(options: { viewer?: boolean; throwOnWrite?: boolean } = {}): MockDb {
  const calls: string[] = [];
  const values: unknown[][] = [];
  let connected = 0;
  let released = 0;
  const row = { id: CLIENT, businessName: 'Acme Coffee', plan: 'STARTER',
    organizationId: '20000000-0000-4000-8000-000000000001', status: 'ONBOARDING' };
  const pool = {
    async connect() {
      connected++;
      return {
        async query(sql: string, params: unknown[] = []) {
          calls.push(sql);
          values.push(params);
          if (sql.startsWith('INSERT INTO postbro_social.persona_review_requests')) {
            if (options.viewer || params[0] === OTHER_CLIENT) return { rows: [], rowCount: 0 };
            return { rows: [{ id: CLIENT, clientId: params[0],
              personaRevision: params[1], requestedBy: params[2],
              decision: params[3], suggestedChanges: params[4] }], rowCount: 1 };
          }
          if (sql.includes('FROM postbro_social.persona_review_requests')) {
            return { rows: [], rowCount: 0 };
          }
          if (sql.startsWith('UPDATE')) {
            if (options.throwOnWrite) throw new Error('database failed');
            if (options.viewer || params[0] === OTHER_CLIENT) return { rows: [], rowCount: 0 };
            return { rows: [{ ...row, businessName: params[1] }], rowCount: 1 };
          }
          if (sql.includes('FROM postbro_social.clients')) {
            return { rows: params[0] === OTHER_CLIENT ? [] : [row], rowCount: 1 };
          }
          return { rows: [], rowCount: 0 };
        },
        release() { released++; }
      };
    }
  } as unknown as Pick<Pool, 'connect'>;
  return { pool, calls, values, connectionCount: () => connected, releasedCount: () => released };
}

function portal(db: MockDb) {
  let authCalls = 0;
  const app = buildSocialPortalApp({
    pool: db.pool,
    auth: {
      url: 'https://test-project.supabase.co',
      publishableKey: KEY,
      fetcher: async () => {
        authCalls++;
        return new Response(JSON.stringify({ id: USER,
          user_metadata: { organizationId: 'attacker-org', role: 'admin' } }), { status: 200 });
      }
    }
  });
  return { app, authCalls: () => authCalls };
}

test('server validates every brand field and rejects caller-owned privilege fields', () => {
  assert.deepEqual(parseBrand(BRAND), BRAND);
  assert.throws(() => parseBrand({ ...BRAND, plan: 'GROWTH' }), /invalid_brand/);
  assert.throws(() => parseBrand({ ...BRAND, businessName: '' }), /invalid_businessName/);
  assert.throws(() => parseBrand({ ...BRAND, restrictions: 'x'.repeat(1001) }), /invalid_restrictions/);
  assert.equal(parseHistory({ optedIn: false }), false);
  assert.throws(() => parseHistory({ optedIn: 'yes' }), /invalid_history/);
  assert.throws(() => parseHistory({ optedIn: true, ownerId: USER }), /invalid_history/);
});

test('tenant transaction sets PostgreSQL role and verified identity before data access', async () => {
  const db = mockDb();
  const result = await withTenantRls(db.pool, USER, async client =>
    (await client.query('SELECT 1')).rowCount);
  assert.equal(result, 0);
  assert.deepEqual(db.calls.slice(0, 4), [
    'BEGIN', 'SET LOCAL ROLE authenticated',
    "SELECT set_config('request.jwt.claim.sub', $1, true)",
    "SET LOCAL statement_timeout = '5000ms'"
  ]);
  assert.deepEqual(db.values[2], [USER]);
  assert.equal(db.calls.at(-1), 'COMMIT');
  assert.equal(db.releasedCount(), 1);
  await assert.rejects(() => withTenantRls(db.pool, 'attacker', async () => null), /invalid_client_id/);
  assert.equal(db.connectionCount(), 1);
});

test('database failures always rollback and release tenant connections', async () => {
  const db = mockDb({ throwOnWrite: true });
  await assert.rejects(() => saveTenantBrand(db.pool, USER, CLIENT, BRAND), /database failed/);
  assert.ok(db.calls.includes('ROLLBACK'));
  assert.equal(db.releasedCount(), 1);
  assert.ok(!db.calls.includes('COMMIT'));
});

test('anonymous clients cannot read or edit any database record', async () => {
  const db = mockDb();
  const { app, authCalls } = portal(db);
  try {
    const list = await app.inject({ method: 'GET', url: '/api/social/clients' });
    assert.equal(list.statusCode, 401);
    const save = await app.inject({ method: 'PUT', url: '/api/social/clients/' + CLIENT + '/brand',
      payload: BRAND });
    assert.equal(save.statusCode, 401);
    assert.equal(db.connectionCount(), 0);
    assert.equal(authCalls(), 0);
  } finally {
    await app.close();
  }
});

test('authenticated client lists profiles and can save their brand only via RLS', async () => {
  const db = mockDb();
  const { app, authCalls } = portal(db);
  try {
    const headers = { authorization: 'Bearer ' + TOKEN };
    const list = await app.inject({ method: 'GET', url: '/api/social/clients',
      headers });
    assert.equal(list.statusCode, 200);
    assert.equal(list.json().clients.length, 1);

    const save = await app.inject({
      method: 'PUT', url: '/api/social/clients/' + CLIENT + '/brand',
      headers, payload: BRAND
    });
    assert.equal(save.statusCode, 200);
    assert.equal(save.json().client.id, CLIENT);
    assert.equal(authCalls(), 2);
    assert.ok(db.calls.some(sql => sql.startsWith('UPDATE postbro_social.clients')));
    assert.equal(db.releasedCount(), db.connectionCount());
  } finally {
    await app.close();
  }
});

test('unauthorized tenant IDs and viewer writes remain invisible', async () => {
  const db = mockDb({ viewer: true });
  const { app } = portal(db);
  try {
    const headers = { authorization: 'Bearer ' + TOKEN };
    const crossRead = await app.inject({ method: 'GET',
      url: '/api/social/clients/' + OTHER_CLIENT, headers });
    assert.equal(crossRead.statusCode, 404);
    const viewerWrite = await app.inject({ method: 'PUT',
      url: '/api/social/clients/' + CLIENT + '/brand', headers, payload: BRAND });
    assert.equal(viewerWrite.statusCode, 404);
    const badFields = await app.inject({ method: 'PUT',
      url: '/api/social/clients/' + CLIENT + '/brand', headers,
      payload: { ...BRAND, organizationId: 'other-org' } });
    assert.equal(badFields.statusCode, 400);
    const badId = await app.inject({ method: 'PUT',
      url: '/api/social/clients/hacked/brand', headers, payload: BRAND });
    assert.equal(badId.statusCode, 400);
  } finally {
    await app.close();
  }
});

test('history consent is explicit and never triggers provider-history APIs', async () => {
  const db = mockDb();
  const { app } = portal(db);
  try {
    const headers = { authorization: 'Bearer ' + TOKEN };
    const invalid = await app.inject({ method: 'PUT',
      url: '/api/social/clients/' + CLIENT + '/history',
      headers, payload: { optedIn: 'yes' } });
    assert.equal(invalid.statusCode, 400);
    const valid = await app.inject({ method: 'PUT',
      url: '/api/social/clients/' + CLIENT + '/history',
      headers, payload: { optedIn: false } });
    assert.equal(valid.statusCode, 200);
    assert.ok(db.calls.some(sql => sql.includes('history_decision_recorded=true')));
  } finally {
    await app.close();
  }
});

test('public client config contains no DB credentials or service-role keys', async () => {
  const db = mockDb();
  const { app } = portal(db);
  try {
    const r = await app.inject({ method: 'GET', url: '/api/social/config' });
    assert.equal(r.statusCode, 200);
    assert.deepEqual(r.json(), {
      supabaseUrl: 'https://test-project.supabase.co',
      publishableKey: KEY
    });
    assert.doesNotMatch(r.body, /DATABASE_URL|service_role|sb_secret_/);
    const page = await app.inject({ method: 'GET', url: '/social/' });
    assert.equal(page.statusCode, 200);
    assert.match(page.headers['content-security-policy'] as string,
      /connect-src 'self' https:\/\/test-project\.supabase\.co/);
    assert.match(page.body, /Invite-only access/);
  } finally {
    await app.close();
  }
});

test('persona review input accepts explicit version-bound approval and edits only', () => {
  assert.deepEqual(parsePersonaReview({
    expectedRevision: 3, decision: 'APPROVE'
  }), {
    expectedRevision: 3, decision: 'APPROVE', suggestedChanges: null
  });
  const edits = { summary: 'Niche summary', writingStyle: 'Clear',
    contentPillars: 'Three topics' };
  assert.deepEqual(parsePersonaReview({
    expectedRevision: 4, decision: 'REQUEST_CHANGES', suggestedChanges: edits
  }).suggestedChanges, edits);
  for (const invalid of [
    { expectedRevision: -1, decision: 'APPROVE' },
    { expectedRevision: 0, decision: 'APPROVE' },
    { expectedRevision: 1.5, decision: 'APPROVE' },
    { expectedRevision: 1, decision: 'APPROVE', suggestedChanges: edits },
    { expectedRevision: 1, decision: 'REQUEST_CHANGES' },
    { expectedRevision: 1, decision: 'REQUEST_CHANGES',
      suggestedChanges: { ...edits, mode: 'AUTO' } },
    { expectedRevision: 1, decision: 'REQUEST_CHANGES',
      suggestedChanges: { ...edits, summary: '' } },
    { expectedRevision: 1, decision: 'APPROVE', organizationId: OTHER_CLIENT },
  ]) {
    assert.throws(() => parsePersonaReview(invalid), /invalid_/);
  }
});

test('authenticated persona review request records intent and never activates persona', async () => {
  const db = mockDb();
  const { app } = portal(db);
  try {
    const headers = { authorization: 'Bearer ' + TOKEN };
    const res = await app.inject({
      method: 'POST',
      url: '/api/social/clients/' + CLIENT + '/persona/reviews',
      headers,
      payload: { expectedRevision: 3, decision: 'APPROVE' },
    });
    assert.equal(res.statusCode, 201);
    assert.equal(res.json().review.clientId, CLIENT);
    assert.equal(res.json().activated, false);
    assert.ok(db.calls.some(sql =>
      sql.startsWith('INSERT INTO postbro_social.persona_review_requests')));
    assert.ok(!db.calls.some(sql => /persona_approved_revision|status='READY'/.test(sql)));
  } finally {
    await app.close();
  }
});

test('persona review routes require verified sign-in and RLS rejects unauthorized writes', async () => {
  const db = mockDb({ viewer: true });
  const { app } = portal(db);
  try {
    const anon = await app.inject({ method: 'POST',
      url: '/api/social/clients/' + CLIENT + '/persona/reviews',
      payload: { expectedRevision: 3, decision: 'APPROVE' } });
    assert.equal(anon.statusCode, 401);
    const headers = { authorization: 'Bearer ' + TOKEN };
    const viewer = await app.inject({ method: 'POST',
      url: '/api/social/clients/' + CLIENT + '/persona/reviews', headers,
      payload: { expectedRevision: 3, decision: 'APPROVE' } });
    assert.equal(viewer.statusCode, 404);
    const invalid = await app.inject({ method: 'POST',
      url: '/api/social/clients/' + CLIENT + '/persona/reviews', headers,
      payload: { expectedRevision: 0, decision: 'APPROVE' } });
    assert.equal(invalid.statusCode, 400);
    assert.equal(db.connectionCount(), db.releasedCount());
  } finally {
    await app.close();
  }
});
