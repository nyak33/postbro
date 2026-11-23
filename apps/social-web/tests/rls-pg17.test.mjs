import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { URL } from 'node:url';
import { test } from 'node:test';
import pg from 'pg';

const DATABASE_URL = process.env.POSTGRES_17_11_URL;
const migrationSql = readFileSync(
  new URL('../migrations/001_social_foundation.sql', import.meta.url),
  'utf8'
);
const personaReviewMigrationSql = readFileSync(
  new URL('../migrations/002_social_persona_review_requests.sql', import.meta.url),
  'utf8'
);

function ensureDisposableUrl(url) {
  const db = new URL(url);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(db.hostname)) {
    throw new Error('Refusing to run Social RLS test against a non-loopback database');
  }
  if (db.pathname !== '/postgres') {
    throw new Error('Refusing to run Social RLS test against a non-disposable database');
  }
}

test('Supabase-compatible social schema enforces tenant RLS and pilot cap', {
  skip: !DATABASE_URL ? 'POSTGRES_17_11_URL (disposable PG17 test service) not set' : false,
  timeout: 120_000
}, async () => {
  ensureDisposableUrl(DATABASE_URL);
  const { Client } = pg;
  const admin = new Client({ connectionString: DATABASE_URL });
  const makeClient = () => new Client({ connectionString: DATABASE_URL });
  const clients = [];
  await admin.connect();
  try {
    // CI-only fake auth schema. This is NEVER executed on the hosted project.
    await admin.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        CREATE ROLE authenticated NOLOGIN;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        CREATE ROLE anon NOLOGIN;
      END IF;
    END $$`);
    await admin.query('CREATE SCHEMA IF NOT EXISTS auth');
    await admin.query('CREATE TABLE IF NOT EXISTS auth.users (id uuid PRIMARY KEY)');
    await admin.query(`CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
      LANGUAGE sql STABLE AS $$
        SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
      $$`);
    await admin.query('GRANT USAGE ON SCHEMA auth TO authenticated');
    await admin.query('GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated');

    await admin.query(migrationSql);
    await admin.query(personaReviewMigrationSql);

    const A = '10000000-0000-4000-8000-000000000001';
    const B = '10000000-0000-4000-8000-000000000002';
    const V = '10000000-0000-4000-8000-000000000003';
    const orgA = '20000000-0000-4000-8000-000000000001';
    const orgB = '20000000-0000-4000-8000-000000000002';
    const clientA = '30000000-0000-4000-8000-000000000001';
    const clientB = '30000000-0000-4000-8000-000000000002';

    for (const u of [A, B, V]) {
      await admin.query('INSERT INTO auth.users (id) VALUES ($1)', [u]);
    }
    for (const [id, name] of [[orgA, 'Alpha'], [orgB, 'Bravo']]) {
      await admin.query('INSERT INTO postbro_social.organizations (id, display_name) VALUES ($1, $2)', [id, name]);
    }
    for (const [org, user, role] of [
      [orgA, A, 'owner'], [orgB, B, 'owner'], [orgA, V, 'viewer']
    ]) {
      await admin.query('INSERT INTO postbro_social.memberships (organization_id, user_id, role) VALUES ($1,$2,$3)', [org, user, role]);
    }
    for (const [id, org, name] of [[clientA, orgA, 'Acme'], [clientB, orgB, 'Beta']]) {
      await admin.query(
        'INSERT INTO postbro_social.clients (id, organization_id, plan, business_name) VALUES ($1,$2,$3,$4)',
        [id, org, 'STARTER', name]
      );
    }

    async function asUser(userId, query, params = [], role = 'authenticated') {
      const conn = makeClient();
      await conn.connect();
      clients.push(conn);
      await conn.query('BEGIN');
      try {
        await conn.query('SET LOCAL ROLE ' + role);
        if (userId) await conn.query("SELECT set_config('request.jwt.claim.sub', $1, true)", [userId]);
        const result = await conn.query(query, params);
        return result;
      } finally {
        await conn.query('ROLLBACK');
      }
    }

    const own = await asUser(A, 'SELECT id FROM postbro_social.clients ORDER BY id');
    assert.deepEqual(own.rows.map(x => x.id), [clientA]);

    const other = await asUser(B, 'SELECT id FROM postbro_social.clients ORDER BY id');
    assert.deepEqual(other.rows.map(x => x.id), [clientB]);

    const viewer = await asUser(V, 'SELECT id FROM postbro_social.clients ORDER BY id');
    assert.deepEqual(viewer.rows.map(x => x.id), [clientA]);

    const noIdentity = await asUser(null, 'SELECT id FROM postbro_social.clients');
    assert.equal(noIdentity.rowCount, 0);

    const deniedAnon = await asUser(null, 'SELECT id FROM postbro_social.clients', [], 'anon')
      .then(() => null, error => error);
    assert.equal(deniedAnon?.code, '42501');

    const deniedMutation = await asUser(A, 'UPDATE postbro_social.clients SET niche=$1 WHERE id=$2', ['Wrong org', clientB]);
    assert.equal(deniedMutation.rowCount, 0);

    const viewerMutation = await asUser(V, 'UPDATE postbro_social.clients SET niche=$1 WHERE id=$2', ['Unauthorized', clientA]);
    assert.equal(viewerMutation.rowCount, 0);

    const blockedPlan = await asUser(A, 'UPDATE postbro_social.clients SET plan=$1 WHERE id=$2', ['GROWTH', clientA])
      .then(() => null, error => error);
    assert.equal(blockedPlan?.code, '42501');

    const blockedMembership = await asUser(A,
      'INSERT INTO postbro_social.memberships(organization_id,user_id,role) VALUES ($1,$2,$3)',
      [orgB, A, 'owner']
    ).then(() => null, error => error);
    assert.equal(blockedMembership?.code, '42501');

    const blockedPersona = await asUser(A,
      'UPDATE postbro_social.clients SET persona_approved_revision=$1 WHERE id=$2',
      [1, clientA]
    ).then(() => null, error => error);
    assert.equal(blockedPersona?.code, '42501');

    const oversizedProfile = await asUser(A,
      'UPDATE postbro_social.clients SET niche=$1 WHERE id=$2',
      ['x'.repeat(1001), clientA]
    ).then(() => null, error => error);
    assert.equal(oversizedProfile?.code, '23514');

    const forgedReady = await admin.query(
      "UPDATE postbro_social.clients SET status='READY' WHERE id=$1",
      [clientB]
    ).then(() => null, error => error);
    assert.equal(forgedReady?.code, '23514');

    const orgAccess = await asUser(A, 'SELECT display_name FROM postbro_social.organizations');
    assert.deepEqual(orgAccess.rows.map(x => x.display_name), ['Alpha']);
    const memberAccess = await asUser(A, 'SELECT role FROM postbro_social.memberships');
    assert.deepEqual(memberAccess.rows.map(x => x.role), ['owner']);

    // Exercise the new real RLS tenant-store against the disposable PG17 DB.
    // This checks actual PostgreSQL privileges, not only a mocked SQL adapter.
    const store = await import('../dist/src/http/tenant-store.js');
    const tenantPool = new pg.Pool({ connectionString: DATABASE_URL });
    try {
      const alpha = await store.listTenantClients(tenantPool, A);
      const bravo = await store.listTenantClients(tenantPool, B);
      assert.deepEqual(alpha.map(client => client.id), [clientA]);
      assert.deepEqual(bravo.map(client => client.id), [clientB]);
      assert.equal(await store.getTenantClient(tenantPool, A, clientB), null);
      const validBrand = {
        businessName: 'Acme', niche: 'Coffee', audience: 'Adults',
        language: 'English', tone: 'Warm', restrictions: '', samplePosts: ''
      };
      assert.equal(await store.saveTenantBrand(tenantPool, A, clientB, validBrand), null);
      assert.equal(await store.saveTenantBrand(tenantPool, V, clientA, validBrand), null);
      const updatedBrand = await store.saveTenantBrand(tenantPool, B, clientB, {
        ...validBrand, businessName: 'Beta'
      });
      assert.equal(updatedBrand.id, clientB);
      const updatedHistory = await store.saveTenantHistory(tenantPool, B, clientB, { optedIn: false });
      assert.equal(updatedHistory.historyDecisionRecorded, true);
      assert.equal(updatedHistory.historyConsent, false);
    } finally {
      await tenantPool.end();
    }

    // PB-SOCIAL-004A: review decisions are version-bound, scoped and do NOT
    // activate personas. Test against real PostgreSQL RLS, not only mock SQL.
    const externalDraft = JSON.stringify({
      source: 'EXTERNAL_ENGINE',
      engineInternal: 'MUST_NOT_BE_EXPOSED_IN_CLIENT_API',
      proposal: {
        summary: 'Coffee education for adult home brewers',
        writingStyle: 'Warm, practical and clear',
        contentPillars: 'Brewing tips, equipment and community'
      }
    });
    const mockDraft = JSON.stringify({
      source: 'MOCK_PREVIEW',
      proposal: {
        summary: 'Demo only',
        writingStyle: 'Friendly',
        contentPillars: 'Education'
      }
    });
    await admin.query(
      "UPDATE postbro_social.clients SET persona_revision=3, persona_draft=$2::jsonb, status='PERSONA_REVIEW' WHERE id=$1",
      [clientA, externalDraft]
    );
    await admin.query(
      "UPDATE postbro_social.clients SET persona_revision=3, persona_draft=$2::jsonb, status='PERSONA_REVIEW' WHERE id=$1",
      [clientB, mockDraft]
    );

    const reviewProjectionPool = new pg.Pool({ connectionString: DATABASE_URL });
    try {
      const store = await import('../dist/src/http/tenant-store.js');
      const clientDetails = await store.getTenantClient(reviewProjectionPool, A, clientA);
      assert.equal(clientDetails.personaDraft.source, 'EXTERNAL_ENGINE');
      assert.equal(clientDetails.personaDraft.proposal.summary,
        'Coffee education for adult home brewers');
      assert.equal(clientDetails.personaDraft.engineInternal, undefined);
      assert.doesNotMatch(JSON.stringify(clientDetails), /MUST_NOT_BE_EXPOSED_IN_CLIENT_API/);
      const mockClient = await store.getTenantClient(reviewProjectionPool, B, clientB);
      assert.equal(mockClient.personaDraft, null);
    } finally {
      await reviewProjectionPool.end();
    }

    const reviewInsert = `INSERT INTO postbro_social.persona_review_requests
      (client_id, persona_revision, requested_by, decision, suggested_changes)
      VALUES ($1, $2, $3, $4, $5::jsonb) RETURNING id`;
    const blockedViewer = await asUser(V, reviewInsert, [clientA, 3, V, 'APPROVE', null])
      .then(() => null, error => error);
    assert.equal(blockedViewer?.code, '42501');
    const blockedCrossTenant = await asUser(B, reviewInsert, [clientA, 3, B, 'APPROVE', null])
      .then(() => null, error => error);
    assert.equal(blockedCrossTenant?.code, '42501');
    const blockedMock = await asUser(B, reviewInsert, [clientB, 3, B, 'APPROVE', null])
      .then(() => null, error => error);
    assert.equal(blockedMock?.code, '42501');
    const blockedStale = await asUser(A, reviewInsert, [clientA, 2, A, 'APPROVE', null])
      .then(() => null, error => error);
    assert.equal(blockedStale?.code, '42501');
    const blockedSpoof = await asUser(A, reviewInsert, [clientA, 3, B, 'APPROVE', null])
      .then(() => null, error => error);
    assert.equal(blockedSpoof?.code, '42501');
    const malformedReview = await asUser(A, reviewInsert,
      [clientA, 3, A, 'REQUEST_CHANGES', JSON.stringify({ summary: 'Only one field' })])
      .then(() => null, error => error);
    assert.equal(malformedReview?.code, '23514');
    const extraReviewField = await asUser(A, reviewInsert,
      [clientA, 3, A, 'REQUEST_CHANGES', JSON.stringify({
        summary: 'Summary', writingStyle: 'Clear', contentPillars: 'Tips',
        untrusted: 'extra'
      })]).then(() => null, error => error);
    assert.equal(extraReviewField?.code, '23514');

    const deniedReviewRewrite = await asUser(A,
      "UPDATE postbro_social.persona_review_requests SET decision='REQUEST_CHANGES' WHERE client_id=$1",
      [clientA]).then(() => null, error => error);
    assert.equal(deniedReviewRewrite?.code, '42501');

    const reviewPool = new pg.Pool({ connectionString: DATABASE_URL });
    try {
      const store = await import('../dist/src/http/tenant-store.js');
      const payload = { expectedRevision: 3, decision: 'APPROVE' };
      const parallel = await Promise.all([
        store.submitPersonaReviewRequest(reviewPool, A, clientA, payload),
        store.submitPersonaReviewRequest(reviewPool, A, clientA, payload)
      ]);
      assert.equal(parallel.filter(Boolean).length, 1);
      assert.equal(parallel.filter(row => row === null).length, 1);

      const visibleA = await store.getPersonaReviewRequests(reviewPool, A, clientA);
      assert.equal(visibleA.length, 1);
      assert.equal(visibleA[0].decision, 'APPROVE');
      const invisibleB = await store.getPersonaReviewRequests(reviewPool, B, clientA);
      assert.equal(invisibleB.length, 0);
      const reviewerView = await store.getPersonaReviewRequests(reviewPool, V, clientA);
      assert.equal(reviewerView.length, 1); // Viewer may read, not write.

      const afterReview = await admin.query(
        'SELECT status, persona_approved_at, persona_approved_revision FROM postbro_social.clients WHERE id=$1',
        [clientA]
      );
      assert.equal(afterReview.rows[0].status, 'PERSONA_REVIEW');
      assert.equal(afterReview.rows[0].persona_approved_at, null);
      assert.equal(afterReview.rows[0].persona_approved_revision, null);

      const staleRequest = await store.submitPersonaReviewRequest(reviewPool, A, clientA, {
        expectedRevision: 2, decision: 'REQUEST_CHANGES',
        suggestedChanges: {
          summary: 'Updated',
          writingStyle: 'Warm',
          contentPillars: 'Helpful tips'
        }
      });
      assert.equal(staleRequest, null);
    } finally {
      await reviewPool.end();
    }

    // Restore the legacy revision-regression fixture to its original
    // starting state after the independent review-request checks above.
    // This is test-only setup on a disposable PostgreSQL instance.
    await admin.query(
      "UPDATE postbro_social.clients SET persona_revision=0, persona_draft=NULL, status='ONBOARDING' WHERE id=$1",
      [clientA]
    );

    // Simulate already approved persona before any client-initiated update.
    await admin.query(`UPDATE postbro_social.clients
      SET persona_revision=1, persona_draft='{"summary":"Old"}',
          persona_approved_revision=1, persona_approved_at=now(), status='READY',
          history_consent=true, history_decision_recorded=true
      WHERE id=$1`, [clientA]);

    const changed = await asUser(A,
      'UPDATE postbro_social.clients SET tone=$1 WHERE id=$2 RETURNING id, status, persona_revision',
      ['New tone', clientA]
    );
    assert.equal(changed.rowCount, 1);
    assert.equal(changed.rows[0].status, 'ONBOARDING');
    assert.equal(changed.rows[0].persona_revision, 2);
    // Change inside a committed transaction to test persisted trigger state.
    await admin.query('UPDATE postbro_social.clients SET tone=$1 WHERE id=$2', ['New tone', clientA]);
    const updated = await admin.query(`SELECT persona_revision, persona_draft,
       persona_approved_revision, persona_approved_at, history_consent,
       history_decision_recorded, status FROM postbro_social.clients WHERE id=$1`, [clientA]);
    assert.equal(updated.rows[0].persona_revision, 2);
    assert.equal(updated.rows[0].persona_draft, null);
    assert.equal(updated.rows[0].persona_approved_revision, null);
    assert.equal(updated.rows[0].persona_approved_at, null);
    assert.equal(updated.rows[0].history_consent, false);
    assert.equal(updated.rows[0].history_decision_recorded, false);
    assert.equal(updated.rows[0].status, 'ONBOARDING');

    // Four clients exist, then two independent transactions race for slot five.
    await admin.query('INSERT INTO postbro_social.clients (organization_id,plan,business_name) VALUES ($1,$2,$3)', [orgA, 'STARTER', 'Gamma']);
    await admin.query('INSERT INTO postbro_social.clients (organization_id,plan,business_name) VALUES ($1,$2,$3)', [orgA, 'STARTER', 'Delta']);
    const attempts = await Promise.allSettled([1, 2].map(async n => {
      const conn = makeClient();
      clients.push(conn);
      await conn.connect();
      return conn.query('INSERT INTO postbro_social.clients (organization_id,plan,business_name) VALUES ($1,$2,$3)', [orgA, 'STARTER', 'Contestant ' + n]);
    }));
    assert.equal(attempts.filter(a => a.status === 'fulfilled').length, 1);
    assert.equal(attempts.filter(a => a.status === 'rejected' && a.reason.code === '23514').length, 1);
    const count = await admin.query('SELECT count(*)::int AS total FROM postbro_social.clients');
    assert.equal(count.rows[0].total, 5);
  } finally {
    await Promise.allSettled(clients.map(x => x.end()));
    await admin.end();
  }
});
