import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { after, before, test } from 'node:test';

import { Pool } from 'pg';

import { migrateDatabase } from '../src/db/migrate';
import {
  InboxError,
  listInboxEvents,
  persistInboundReplies,
  type InboundReplyInput,
} from '../src/modules/inbox/reply-sync';
import {
  connectionStringFor,
  createLoginRole,
  startEmbeddedPostgres,
  type EmbeddedPostgresTestContext,
} from './helpers/embedded-postgres';

const MIGRATIONS_DIR = path.join(process.cwd(), 'db', 'migrations');

let pg: EmbeddedPostgresTestContext;
let appPool: Pool;

interface Fixture {
  operatorOne: number;
  operatorDisabled: number;
  accountA: number;
  accountB: number;
  accountDisabled: number;
}

async function insertAccount(providerId: string, status = 'active'): Promise<number> {
  const result = await pg.ownerPool.query<{ id: string }>(
    `INSERT INTO postbro.threads_accounts (provider_id, username, status, scopes) VALUES ($1, $2, $3, '{}') RETURNING id`,
    [providerId, `user_${providerId}`, status],
  );
  return Number(result.rows[0]!.id);
}

let seedCounter = 0;

async function seed(): Promise<Fixture> {
  const db = pg.ownerPool;
  seedCounter += 1;
  const tag = Date.now() * 100 + seedCounter;
  const operatorOne = Number(
    (await db.query<{ id: string }>(`INSERT INTO postbro.operators (telegram_user_id, status) VALUES ($1, 'active') RETURNING id`, [tag * 10 + 1])).rows[0]!.id,
  );
  const operatorDisabled = Number(
    (await db.query<{ id: string }>(`INSERT INTO postbro.operators (telegram_user_id, status) VALUES ($1, 'disabled') RETURNING id`, [tag * 10 + 2])).rows[0]!.id,
  );

  const accountA = await insertAccount(`inbox-a-${tag}`);
  const accountB = await insertAccount(`inbox-b-${tag}`);
  const accountDisabled = await insertAccount(`inbox-c-${tag}`, 'disabled');

  await db.query(
    `INSERT INTO postbro.operator_accounts (operator_id, account_id, role) VALUES
       ($1, $2, 'owner'), ($1, $4, 'owner'), ($3, $2, 'owner')`,
    [operatorOne, accountA, operatorDisabled, accountDisabled],
  );
  // accountB deliberately has NO operator_accounts row (ownership unknown).
  // NOTE: NO persona_bindings for any account — persona onboarding is not
  // integrated and must not gate sync/inbox.
  return { operatorOne, operatorDisabled, accountA, accountB, accountDisabled };
}

function reply(overrides: Partial<InboundReplyInput> = {}): InboundReplyInput {
  return {
    providerReplyId: 'r1',
    ownRootId: '1001',
    parentId: '1001',
    text: 'hello there',
    timestamp: '2026-11-15T10:00:00Z',
    isReplyOwnedByMe: false,
    ...overrides,
  };
}

async function eventRows(accountId: number) {
  const { rows } = await pg.ownerPool.query<{
    provider_reply_id: string;
    content: Record<string, unknown>;
  }>(`SELECT provider_reply_id, content FROM postbro.engagement_events WHERE account_id = $1 ORDER BY id`, [accountId]);
  return rows;
}

before(async () => {
  pg = await startEmbeddedPostgres();
  await migrateDatabase(pg.ownerPool, MIGRATIONS_DIR);
  const appPassword = randomBytes(16).toString('hex');
  await createLoginRole(pg.ownerPool, 'postbro_app_test', appPassword, 'postbro_app');
  appPool = new Pool({ connectionString: connectionStringFor(pg.port, 'postbro_app_test', appPassword), max: 10 });
});

after(async () => {
  if (appPool) await appPool.end();
  if (pg) await pg.stop();
});

test('SYNC-01: stores pre-validated inbound reply with minimal own_post content', async () => {
  const f = await seed();
  const counts = await persistInboundReplies(appPool, f.operatorOne, f.accountA, [reply()]);
  assert.deepEqual(counts, { received: 1, inserted: 1, existing: 0, skipped: 0 });
  const rows = await eventRows(f.accountA);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.provider_reply_id, 'r1');
  const content = rows[0]!.content;
  assert.equal(content['source'], 'own_post');
  assert.equal(content['root_post_id'], '1001');
  assert.equal(content['reply_id'], 'r1');
  assert.equal(content['parent_id'], '1001');
  assert.equal(content['text'], 'hello there');
  assert.equal(content['timestamp'], '2026-11-15T10:00:00Z');
  assert.equal(typeof content['fetched_at'], 'string');
});

test('SYNC-02: re-run dedupes via ON CONFLICT and never updates existing rows', async () => {
  const f = await seed();
  const first = await persistInboundReplies(appPool, f.operatorOne, f.accountA, [reply()]);
  assert.equal(first.inserted, 1);
  // Same provider reply id, different text — must dedupe, never update.
  const second = await persistInboundReplies(appPool, f.operatorOne, f.accountA, [reply({ text: 'changed' })]);
  assert.equal(second.inserted, 0);
  assert.equal(second.existing, 1);
  const rows = await eventRows(f.accountA);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.content['text'], 'hello there');
});

test('SYNC-03: cross-account isolation — same provider reply id stored per account', async () => {
  const f = await seed();
  await pg.ownerPool.query(
    `INSERT INTO postbro.operator_accounts (operator_id, account_id, role) VALUES ($1, $2, 'owner')`,
    [f.operatorOne, f.accountB],
  );
  await persistInboundReplies(appPool, f.operatorOne, f.accountA, [reply({ providerReplyId: 'shared-reply' })]);
  await persistInboundReplies(appPool, f.operatorOne, f.accountB, [reply({ providerReplyId: 'shared-reply' })]);
  assert.equal((await eventRows(f.accountA)).length, 1);
  assert.equal((await eventRows(f.accountB)).length, 1);
  const inboxA = await listInboxEvents(appPool, f.operatorOne, f.accountA);
  assert.equal(inboxA.total, 1);
  assert.equal(inboxA.items[0]!.providerReplyId, 'shared-reply');
});

test('SYNC-04: disabled account, disabled operator, unknown ownership all fail closed with no writes', async () => {
  const f = await seed();
  await assert.rejects(
    persistInboundReplies(appPool, f.operatorOne, f.accountDisabled, [reply()]),
    (e: unknown) => e instanceof InboxError && e.reason === 'account_not_authorized',
  );
  await assert.rejects(
    persistInboundReplies(appPool, f.operatorDisabled, f.accountA, [reply()]),
    (e: unknown) => e instanceof InboxError && e.reason === 'account_not_authorized',
  );
  // accountB has no operator_accounts row -> ownership uncertainty fails closed.
  await assert.rejects(
    persistInboundReplies(appPool, f.operatorOne, f.accountB, [reply()]),
    (e: unknown) => e instanceof InboxError && e.reason === 'account_not_authorized',
  );
  await assert.rejects(listInboxEvents(appPool, f.operatorOne, f.accountB), InboxError);
  assert.equal((await eventRows(f.accountB)).length, 0);
});

test('SYNC-05: missing persona binding does NOT block persist or inbox', async () => {
  const f = await seed();
  // Fixture creates no persona_bindings at all; persist must still work.
  const counts = await persistInboundReplies(appPool, f.operatorOne, f.accountA, [reply()]);
  assert.equal(counts.inserted, 1);
  const inbox = await listInboxEvents(appPool, f.operatorOne, f.accountA);
  assert.equal(inbox.total, 1);
});

test('SYNC-06: own, unknown-ownership and malformed/untrusted replies are skipped, never stored', async () => {
  const f = await seed();
  const counts = await persistInboundReplies(appPool, f.operatorOne, f.accountA, [
    reply({ providerReplyId: 'own1', isReplyOwnedByMe: true }), // own reply
    { ...reply({ providerReplyId: 'unk1' }), isReplyOwnedByMe: undefined as unknown as boolean }, // unknown
    reply({ providerReplyId: '' }), // invalid id
    reply({ providerReplyId: 'x'.repeat(201) }), // oversized id
    reply({ providerReplyId: 'ok1' }),
  ]);
  assert.deepEqual(counts, { received: 5, inserted: 1, existing: 0, skipped: 4 });
  const rows = await eventRows(f.accountA);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.provider_reply_id, 'ok1');
});

test('SYNC-07: invalid caller input fails closed', async () => {
  const f = await seed();
  await assert.rejects(persistInboundReplies(appPool, 0, f.accountA, [reply()]), (e: unknown) => e instanceof InboxError && e.reason === 'invalid_input');
  await assert.rejects(persistInboundReplies(appPool, f.operatorOne, -1, [reply()]), (e: unknown) => e instanceof InboxError && e.reason === 'invalid_input');
  await assert.rejects(listInboxEvents(appPool, 0, f.accountA), (e: unknown) => e instanceof InboxError && e.reason === 'invalid_input');
});

test('SYNC-08: inbox is read-only, newest first, with bounded limit', async () => {
  const f = await seed();
  const replies = Array.from({ length: 5 }, (_, i) =>
    reply({ providerReplyId: `r${i}`, text: `t${i}`, timestamp: `2026-11-15T1${i}:00:00Z` }),
  );
  await persistInboundReplies(appPool, f.operatorOne, f.accountA, replies);

  const page = await listInboxEvents(appPool, f.operatorOne, f.accountA, 2);
  assert.equal(page.total, 5);
  assert.equal(page.items.length, 2);
  // Newest first.
  assert.equal(page.items[0]!.providerReplyId, 'r4');
  assert.equal(page.items[0]!.content.source, 'own_post');
  // Over-limit is clamped to 100, never unbounded.
  const clamped = await listInboxEvents(appPool, f.operatorOne, f.accountA, 10_000);
  assert.equal(clamped.items.length, 5);
  // Invalid limit falls back to default 25 without error.
  const fallback = await listInboxEvents(appPool, f.operatorOne, f.accountA, 0);
  assert.equal(fallback.items.length, 5);
  // Read-only: no state change from listing.
  assert.equal((await listInboxEvents(appPool, f.operatorOne, f.accountA)).total, 5);
});

test('SYNC-09: no proposals, approvals, jobs or outbound actions are created by persist', async () => {
  const f = await seed();
  await persistInboundReplies(appPool, f.operatorOne, f.accountA, [reply()]);
  for (const table of ['engagement_proposals', 'approvals', 'engagement_jobs', 'execution_attempts']) {
    const { rows } = await pg.ownerPool.query<{ c: string }>(`SELECT count(*)::text AS c FROM postbro.${table} WHERE account_id = $1`, [f.accountA]);
    assert.equal(rows[0]!.c, '0', `${table} must stay empty`);
  }
});
