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
const personaVersionsMigrationSql = readFileSync(
  new URL('../migrations/003_social_persona_versions.sql', import.meta.url),
  'utf8'
);
const contentApprovalMigrationSql = readFileSync(
  new URL('../migrations/004_social_content_approval.sql', import.meta.url),
  'utf8'
);
const postizDispatchMigrationSql = readFileSync(
  new URL('../migrations/005_postiz_draft_dispatches.sql', import.meta.url),
  'utf8'
);
const postizOrgLinkMigrationSql = readFileSync(
  new URL('../migrations/006_postiz_organization_links.sql', import.meta.url),
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
    await admin.query(personaVersionsMigrationSql);
    await admin.query(contentApprovalMigrationSql);
    await admin.query(postizDispatchMigrationSql);
    await admin.query(postizOrgLinkMigrationSql);

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

    // The link is PRIVATE even from a legitimately signed-in tenant member.
    await admin.query(`INSERT INTO postbro_social.postiz_organization_links
      (client_id, postiz_instance_origin, postiz_organization_id,
       postiz_customer_group_id, state, verification_method, verified_at, verified_by)
      VALUES ($1,$2,$3,$4,'VERIFIED','OPERATOR_POSTIZ_ME_AND_MEMBERSHIP',now(),$5)`,
      [clientA, 'https://postiz-staging.syaqirshaq.online', 'org_client_A', 'group_client_A', A]);
    const bound = await admin.query(
      'SELECT state FROM postbro_social.postiz_organization_links WHERE client_id=$1', [clientA]);
    assert.equal(bound.rows[0]?.state, 'VERIFIED');
    const duplicateOrg = await admin.query(`INSERT INTO postbro_social.postiz_organization_links
      (client_id, postiz_instance_origin, postiz_organization_id, postiz_customer_group_id)
      VALUES ($1,$2,$3,$4)`,
      [clientB, 'https://postiz-staging.syaqirshaq.online', 'org_client_A', 'group_client_B'])
      .then(() => null, error => error);
    assert.equal(duplicateOrg?.code, '23505');

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

    const privateLink = await asUser(A,
      'SELECT client_id FROM postbro_social.postiz_organization_links')
      .then(() => null, error => error);
    assert.equal(privateLink?.code, '42501');

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

    // PB-SOCIAL-004C: trusted draft and activation lifecycle, with actual
    // PostgreSQL 17.11 transactions and RLS grants.
    const workflow = await import('../dist/src/persona/trusted-workflow.js');
    const trustedPool = new pg.Pool({ connectionString: DATABASE_URL });
    const privateCliCalls = [];
    const fakePrivateRunner = async args => {
      privateCliCalls.push([...args]);
      const command = args.slice(0, 2).join(' ');
      if (command === 'session create') {
        return JSON.stringify({ session: { id: 'session_test123456789012' } });
      }
      if (command === 'session patch') {
        const jsonIndex = args.indexOf('--json');
        const parsed = JSON.parse(args[jsonIndex + 1]);
        fakePrivateRunner.patch = parsed;
        return JSON.stringify({ sessionId: 'session_test123456789012', status: { ready: true } });
      }
      if (command === 'persona finalize') {
        const patch = fakePrivateRunner.patch;
        return JSON.stringify({ persona: {
          id: 'persona_test123456789012', schemaVersion: '1.0',
          version: 1, name: 'Beta', base: {
            ...patch, engagementBehavior: {}
          }, contexts: [], learnedPreferences: []
        } });
      }
      throw Error('unexpected private CLI command');
    };
    try {
      // Mock draft must be invalidated before creating a real-engine one.
      await admin.query(
        "UPDATE postbro_social.clients SET status='ONBOARDING', persona_draft=NULL, persona_revision=4 WHERE id=$1",
        [clientB]
      );
      const prepared = await workflow.generateAndSaveTrustedPersona(
        trustedPool, clientB, fakePrivateRunner
      );
      assert.equal(prepared.revision, 5);
      assert.equal(prepared.state, 'PERSONA_REVIEW');
      assert.equal(privateCliCalls.length, 3);
      assert.equal(await workflow.getTrustedApprovedPersonaRecord(trustedPool, clientB), null);
      const version = await admin.query(
        'SELECT engine_record, proposal FROM postbro_social.persona_versions WHERE client_id=$1 AND revision=5',
        [clientB]
      );
      assert.equal(version.rowCount, 1);
      assert.equal(version.rows[0].engine_record.base.identity.niche, 'Coffee');

      // Full private engine record is not accessible to authenticated members.
      const privateReadDenied = await asUser(B,
        'SELECT engine_record FROM postbro_social.persona_versions WHERE client_id=$1', [clientB]
      ).then(() => null, error => error);
      assert.equal(privateReadDenied?.code, '42501');

      const afterPrepare = await store.getTenantClient(trustedPool, B, clientB);
      assert.equal(afterPrepare.personaDraft.source, 'EXTERNAL_ENGINE');
      assert.equal(afterPrepare.personaDraft.engineRecord, undefined);
      assert.equal(afterPrepare.status, 'PERSONA_REVIEW');
      assert.equal(afterPrepare.personaApprovedRevision, null);

      const request = await store.submitPersonaReviewRequest(trustedPool, B, clientB,
        { expectedRevision: 5, decision: 'APPROVE' });
      assert.ok(request?.id);
      // Request is only intent: no active private record before trusted processing.
      assert.equal(await workflow.getTrustedApprovedPersonaRecord(trustedPool, clientB), null);
      const approvalResult = await workflow.processTrustedPersonaReview(trustedPool, request.id);
      assert.deepEqual(approvalResult, { reviewRequestId: request.id, result: 'ACTIVATED' });
      const duplicateResult = await workflow.processTrustedPersonaReview(trustedPool, request.id);
      assert.deepEqual(duplicateResult, approvalResult);
      const approved = await workflow.getTrustedApprovedPersonaRecord(trustedPool, clientB);
      assert.equal(approved.id, 'persona_test123456789012');

      const actionRows = await admin.query(
        'SELECT result FROM postbro_social.persona_review_actions WHERE review_request_id=$1',
        [request.id]
      );
      assert.deepEqual(actionRows.rows.map(x => x.result), ['ACTIVATED']);

      // Brand change revokes activated record immediately.
      const changedBrand = await store.saveTenantBrand(trustedPool, B, clientB, {
        businessName: 'Beta', niche: 'Coffee', audience: 'Adults',
        language: 'English', tone: 'Direct', restrictions: '', samplePosts: ''
      });
      assert.equal(changedBrand.status, 'ONBOARDING');
      assert.equal(changedBrand.personaApprovedRevision, null);
      assert.equal(await workflow.getTrustedApprovedPersonaRecord(trustedPool, clientB), null);

      // Stale review for another client has no corresponding version and
      // must be logged as STALE; this cannot activate a mock row.
      const oldReviewId = (await admin.query(
        "SELECT id FROM postbro_social.persona_review_requests WHERE client_id=$1",
        [clientA]
      )).rows[0].id;
      const stale = await workflow.processTrustedPersonaReview(trustedPool, oldReviewId);
      assert.equal(stale.result, 'STALE');

      // Now run another version through explicit REQUEST_CHANGES.
      const nextDraft = await workflow.generateAndSaveTrustedPersona(
        trustedPool, clientB, fakePrivateRunner
      );
      const revision = nextDraft.revision;
      const changeRequest = await store.submitPersonaReviewRequest(
        trustedPool, B, clientB, {
          expectedRevision: revision, decision: 'REQUEST_CHANGES',
          suggestedChanges: {
            summary: 'Focus on manual coffee brewing',
            writingStyle: 'Short sentences',
            contentPillars: 'Pour-over, grinding and freshness'
          }
        }
      );
      const changes = await workflow.processTrustedPersonaReview(trustedPool, changeRequest.id);
      assert.equal(changes.result, 'REVISION_REQUIRED');
      const afterChanges = await store.getTenantClient(trustedPool, B, clientB);
      assert.equal(afterChanges.status, 'ONBOARDING');
      assert.equal(afterChanges.personaRevision, revision + 1);
      assert.equal(afterChanges.personaDraft, null);
      assert.equal(await workflow.getTrustedApprovedPersonaRecord(trustedPool, clientB), null);
      const replay = await workflow.processTrustedPersonaReview(trustedPool, changeRequest.id);
      assert.equal(replay.result, 'REVISION_REQUIRED');

      const rejectedStale = await workflow.generateAndSaveTrustedPersona(
        trustedPool, clientB, async args => {
          if (args[0] === 'session' && args[1] === 'patch') {
            await admin.query(
              'UPDATE postbro_social.clients SET tone=$2 WHERE id=$1',
              [clientB, 'Changed again']
            );
          }
          return fakePrivateRunner(args);
        }
      ).then(() => null, error => error);
      assert.ok(rejectedStale instanceof workflow.PersonaWorkflowConflict);
    } finally {
      await trustedPool.end();
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

    // PB-SOCIAL-005A: use disposable active persona fixtures to prove that
    // content cannot bypass client approval, RLS or package limits.
    const content = await import('../dist/src/content/trusted-workflow.js');
    const contentStore = await import('../dist/src/content/customer-store.js');
    const contentPool = new pg.Pool({ connectionString: DATABASE_URL });
    try {
      await admin.query(`
        UPDATE postbro_social.clients
        SET persona_revision=10, persona_draft=$2::jsonb,
          persona_approved_revision=10, persona_approved_at=now(), status='READY'
        WHERE id=$1
      `, [clientA, externalDraft]);

      const day = '2027-01-11T01:00:00.000Z';
      const first = await content.createTrustedContentDraft(
        contentPool, clientA, 'THREADS', 'How to prepare specialty coffee at home', day
      );
      assert.equal(first.status, 'IN_REVIEW');
      assert.equal(first.contentRevision, 1);
      assert.equal(await content.getTrustedApprovedContent(contentPool, first.id), null);
      const viewerDrafts = await contentStore.listCustomerContent(contentPool, V, clientA);
      assert.equal(viewerDrafts.length, 1); // viewer reads but cannot approve
      assert.equal((await contentStore.listCustomerContent(contentPool, B, clientA)).length, 0);
      const viewerContentReview = await contentStore.submitCustomerContentDecision(
        contentPool, V, first.id, { expectedRevision: 1, decision: 'APPROVE' }
      ).then(() => null, error => error);
      assert.equal(viewerContentReview?.code, '42501');
      const wrongTenantReview = await contentStore.submitCustomerContentDecision(
        contentPool, B, first.id, { expectedRevision: 1, decision: 'APPROVE' }
      );
      assert.equal(wrongTenantReview, null);

      const requests = await Promise.all([
        contentStore.submitCustomerContentDecision(contentPool, A, first.id,
          { expectedRevision: 1, decision: 'APPROVE' }),
        contentStore.submitCustomerContentDecision(contentPool, A, first.id,
          { expectedRevision: 1, decision: 'APPROVE' })
      ]);
      assert.equal(requests.filter(Boolean).length, 1);
      const request = requests.find(Boolean);
      assert.equal(await content.getTrustedApprovedContent(contentPool, first.id), null);
      const accepted = await content.processTrustedContentDecision(contentPool, request.id);
      assert.equal(accepted.result, 'APPROVED');
      const repeated = await content.processTrustedContentDecision(contentPool, request.id);
      assert.equal(repeated.result, 'APPROVED');
      const approvedContent = await content.getTrustedApprovedContent(contentPool, first.id);
      assert.equal(approvedContent.body, 'How to prepare specialty coffee at home');

      // PB-SOCIAL-005B: verify complete approved-content-to-Postiz DRAFT
      // payload with actual DB approval, without any HTTP or Postiz network.
      const postiz = await import('../dist/src/postiz/draft-preview.js');
      const dryRunMapping = {
        clientId: clientA, customerGroupId: 'client-test-group-123',
        integrationIds: { threads: 'postiz_threads_123' }
      };
      const dryRunConnections = [{
        id: 'postiz_threads_123', identifier: 'threads',
        disabled: false, customer: { id: 'client-test-group-123' }
      }];
      const draftOnly = await postiz.previewApprovedPostizDraft(
        contentPool, first.id, dryRunMapping, dryRunConnections
      );
      assert.equal(draftOnly.type, 'draft');
      assert.deepEqual(draftOnly.posts.map(p => p.settings.__type), ['threads']);
      assert.equal(draftOnly.posts[0].value[0].content,
        'How to prepare specialty coffee at home');

      // PB-SOCIAL-005C: one durable attempt, even under concurrent workers.
      // The fake Postiz API returns a documented-shaped response WITHOUT HTTP.
      const dispatch = await import('../dist/src/postiz/draft-dispatch.js');
      const prepared = await Promise.all([
        dispatch.preparePostizDraftDispatch(
          contentPool, first.id, dryRunMapping, dryRunConnections),
        dispatch.preparePostizDraftDispatch(
          contentPool, first.id, dryRunMapping, dryRunConnections)
      ]);
      assert.equal(prepared[0].id, prepared[1].id);
      assert.equal(prepared[0].state, 'PREPARED');
      const forgedMapping = { ...dryRunMapping, customerGroupId: 'client-elsewhere' };
      const forged = await dispatch.preparePostizDraftDispatch(
        contentPool, first.id, forgedMapping, dryRunConnections
      ).then(() => null, error => error);
      assert.ok(forged);
      const claims = await Promise.allSettled([
        dispatch.claimPostizDraftDispatch(
          contentPool, prepared[0].id, dryRunMapping, dryRunConnections),
        dispatch.claimPostizDraftDispatch(
          contentPool, prepared[0].id, dryRunMapping, dryRunConnections)
      ]);
      assert.equal(claims.filter(x => x.status === 'fulfilled').length, 1);
      const payload = claims.find(x => x.status === 'fulfilled').value;
      assert.equal(payload.type, 'draft');
      assert.equal(payload.posts.length, 1);
      const fakeResponse = [{
        postId: 'mock_draft_12345', integration: 'postiz_threads_123'
      }];
      assert.equal(await dispatch.finishPostizDraftDispatch(
        contentPool, prepared[0].id, { kind: 'confirmed', response: fakeResponse }),
      'CONFIRMED');
      const replay = await dispatch.claimPostizDraftDispatch(
        contentPool, prepared[0].id, dryRunMapping, dryRunConnections
      ).then(() => null, error => error);
      assert.equal(replay?.message, 'postiz_dispatch_already_attempted');
      const privateDispatchRead = await asUser(A,
        'SELECT id FROM postbro_social.postiz_draft_dispatches'
      ).then(() => null, error => error);
      assert.equal(privateDispatchRead?.code, '42501');


      const second = await content.createTrustedContentDraft(
        contentPool, clientA, 'FB_IG', 'Second coffee post', day
      );
      const changeRequest = await contentStore.submitCustomerContentDecision(
        contentPool, A, second.id, {
          expectedRevision: 1, decision: 'REQUEST_CHANGES',
          comment: 'Please make the message shorter.'
        }
      );
      const changeAction = await content.processTrustedContentDecision(
        contentPool, changeRequest.id
      );
      assert.equal(changeAction.result, 'CHANGES_REQUESTED');
      assert.equal(await content.getTrustedApprovedContent(contentPool, second.id), null);
      const revised = await content.reviseTrustedContentDraft(
        contentPool, second.id, 'Shorter specialty coffee message'
      );
      assert.equal(revised.contentRevision, 2);
      const previousDecision = await contentStore.submitCustomerContentDecision(
        contentPool, A, second.id,
        { expectedRevision: 1, decision: 'APPROVE' }
      );
      assert.equal(previousDecision, null);
      const currentDecision = await contentStore.submitCustomerContentDecision(
        contentPool, A, second.id,
        { expectedRevision: 2, decision: 'APPROVE' }
      );
      assert.equal((await content.processTrustedContentDecision(
        contentPool, currentDecision.id
      )).result, 'APPROVED');

      // Mark a claimed but unconfirmed crossposted draft as uncertain.
      const fbMapping = {
        clientId: clientA, customerGroupId: 'client-test-group-123',
        integrationIds: {
          facebook: 'postiz_facebook_123', instagram: 'postiz_instagram_123'
        }
      };
      const fbConnections = [
        { id: 'postiz_facebook_123', identifier: 'facebook',
          disabled: false, customer: { id: 'client-test-group-123' } },
        { id: 'postiz_instagram_123', identifier: 'instagram',
          disabled: false, customer: { id: 'client-test-group-123' } }
      ];
      const media = [{
        id: 'postiz_image_123', path: 'https://media.example.com/photo.jpg',
        status: 'ready'
      }];
      const readyFB = await dispatch.preparePostizDraftDispatch(
        contentPool, second.id, fbMapping, fbConnections, media
      );
      const fbPayload = await dispatch.claimPostizDraftDispatch(
        contentPool, readyFB.id, fbMapping, fbConnections, media
      );
      assert.equal(fbPayload.type, 'draft');
      assert.equal(await dispatch.finishPostizDraftDispatch(
        contentPool, readyFB.id, { kind: 'ambiguous' }),
      'NEEDS_RECONCILIATION');
      const cannotRetry = await dispatch.claimPostizDraftDispatch(
        contentPool, readyFB.id, fbMapping, fbConnections, media
      ).then(() => null, error => error);
      assert.equal(cannotRetry?.message, 'postiz_dispatch_already_attempted');
      const ledger = await admin.query(
        'SELECT state, provider_posts FROM postbro_social.postiz_draft_dispatches WHERE id=$1',
        [readyFB.id]
      );
      assert.equal(ledger.rows[0].state, 'NEEDS_RECONCILIATION');
      assert.deepEqual(ledger.rows[0].provider_posts, []);


      // Starter: 3 Threads + 2 combined Facebook/Instagram per MYT day.
      await content.createTrustedContentDraft(
        contentPool, clientA, 'THREADS', 'Third coffee education post', day
      );
      await content.createTrustedContentDraft(
        contentPool, clientA, 'THREADS', 'Fourth coffee education post', day
      );
      await content.createTrustedContentDraft(
        contentPool, clientA, 'FB_IG', 'Fifth coffee education post', day
      );
      const overThreads = await content.createTrustedContentDraft(
        contentPool, clientA, 'THREADS', 'Should be blocked', day
      ).then(() => null, error => error);
      assert.equal(overThreads?.code, '23514');
      const overCrosspost = await content.createTrustedContentDraft(
        contentPool, clientA, 'FB_IG', 'Also blocked', day
      ).then(() => null, error => error);
      assert.equal(overCrosspost?.code, '23514');

      const forbiddenPrivateAction = await asUser(A,
        'SELECT * FROM postbro_social.content_review_actions')
        .then(() => null, error => error);
      assert.equal(forbiddenPrivateAction?.code, '42501');

      // Client brand change invalidates approval even for already reviewed post.
      await admin.query('UPDATE postbro_social.clients SET tone=$2 WHERE id=$1',
        [clientA, 'New brand voice']);
      assert.equal(await content.getTrustedApprovedContent(contentPool, first.id), null);
      const nowStale = await postiz.previewApprovedPostizDraft(
        contentPool, first.id, dryRunMapping, dryRunConnections
      ).then(() => null, error => error);
      assert.equal(nowStale?.message, 'content_not_approved');
      const pending = await content.createTrustedContentDraft(
        contentPool, clientA, 'THREADS', 'Should not create with stale persona', day
      ).then(() => null, error => error);
      assert.equal(pending?.message, 'approved_persona_required');
    } finally {
      await contentPool.end();
    }

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
