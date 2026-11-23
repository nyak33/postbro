import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Pool } from 'pg';
import { buildSocialPortalApp } from '../src/http/portal.js';
import { parseContentDecision } from '../src/content/customer-store.js';

const CLIENT = '30000000-0000-4000-8000-000000000001';
const DRAFT = '40000000-0000-4000-8000-000000000001';
const USER = '10000000-0000-4000-8000-000000000001';
const TOKEN = 'header.payload_with_underscores.signature';
const AUTH = { url: 'https://test-project.supabase.co',
  publishableKey: 'sb_publishable_' + 'x'.repeat(32) };

function mockedPool() {
  const statements: string[] = [];
  let open = 0;
  let released = 0;
  const pool = {
    async connect() {
      open++;
      return {
        async query(sql: string, params: unknown[] = []) {
          statements.push(sql);
          if (sql.startsWith('INSERT INTO postbro_social.content_review_requests')) {
            return { rows: [{
              id: USER, draftId: params[0],
              contentRevision: params[1], requestedBy: params[2],
              decision: params[3], comment: params[4]
            }] };
          }
          if (sql.includes('FROM postbro_social.content_drafts')) {
            return { rows: params[0] === CLIENT ? [{
              id: DRAFT, clientId: CLIENT, personaRevision: 1,
              contentRevision: 1, surface: 'THREADS', status: 'IN_REVIEW',
              body: 'Please review this content.'
            }] : [], rowCount: 1 };
          }
          return { rows: [], rowCount: 0 };
        },
        release() { released++; }
      };
    }
  } as unknown as Pick<Pool, 'connect'>;
  return { pool, statements, connections: () => open, releases: () => released };
}

test('content-review payloads never accept tenant IDs or forged reviewer IDs', () => {
  assert.deepEqual(parseContentDecision({ expectedRevision: 1, decision: 'APPROVE' }), {
    expectedRevision: 1, decision: 'APPROVE', comment: null
  });
  const changes = parseContentDecision({
    expectedRevision: 2, decision: 'REQUEST_CHANGES',
    comment: ' Shorter caption. '
  });
  assert.equal(changes.comment, 'Shorter caption.');
  for (const payload of [
    null, [],
    { expectedRevision: 0, decision: 'APPROVE' },
    { expectedRevision: 1, decision: 'APPROVE', comment: 'Unwanted comment' },
    { expectedRevision: 1, decision: 'APPROVE', reviewerId: USER },
    { expectedRevision: 1, decision: 'REQUEST_CHANGES' },
    { expectedRevision: 1, decision: 'REQUEST_CHANGES', comment: ' ' },
    { expectedRevision: 1, decision: 'REQUEST_CHANGES', comment: 'x'.repeat(1001) },
  ]) {
    assert.throws(() => parseContentDecision(payload), /invalid_content_decision/);
  }
});

test('client content endpoints demand verified auth and never dispatch posts', async () => {
  const db = mockedPool();
  const app = buildSocialPortalApp({ pool: db.pool, auth: {
    ...AUTH,
    fetcher: async () => new Response(JSON.stringify({ id: USER }), { status: 200 })
  } });
  try {
    const anonymous = await app.inject({
      method: 'GET', url: '/api/social/clients/' + CLIENT + '/content'
    });
    assert.equal(anonymous.statusCode, 401);
    assert.equal(db.connections(), 0);

    const headers = { authorization: 'Bearer ' + TOKEN };
    const found = await app.inject({
      method: 'GET', headers, url: '/api/social/clients/' + CLIENT + '/content'
    });
    assert.equal(found.statusCode, 200);
    assert.equal(found.json().content[0].body, 'Please review this content.');
    const submitted = await app.inject({
      method: 'POST', headers, url: '/api/social/content/' + DRAFT + '/reviews',
      payload: { expectedRevision: 1, decision: 'APPROVE' }
    });
    assert.equal(submitted.statusCode, 201);
    assert.equal(submitted.json().scheduled, false);
    assert.equal(submitted.json().review.decision, 'APPROVE');
    assert.equal(db.connections(), db.releases());
    assert.ok(db.statements.some(sql =>
      sql.includes('INSERT INTO postbro_social.content_review_requests')));
    assert.ok(!db.statements.some(sql =>
      /postiz|publish|integration|dispatch/i.test(sql)));
  } finally {
    await app.close();
  }
});
