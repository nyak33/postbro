/**
 * PB-P2 (scoped): account-scoped inbound reply persistence + read-only inbox.
 *
 * This module is ONLY the small DB foundation slice:
 * - persistInboundReplies(pool, operatorId, accountId, replies) — idempotent
 *   storage of caller/provider-prevalidated inbound replies to CONFIRMED OWN
 *   root posts, into postbro.engagement_events (source 'own_post').
 * - listInboxEvents(pool, operatorId, accountId, limit?) — bounded, newest-first
 *   listing of stored events for an authorized account.
 *
 * Explicitly OUT of scope here (per recovery task): provider polling, Threads
 * API reads, token resolution/decryption, MCP routes, scheduling, automation,
 * approvals/jobs, persona requirements. Replies MUST be pre-validated by the
 * caller/provider adapter as belonging to confirmed own root posts with
 * isReplyOwnedByMe === false, trusted ownRootId and providerReplyId. This
 * function fails closed on own/unknown ownership and on any malformed ID —
 * it never accepts arbitrary roots and never overwrites existing rows.
 */

import { type Pool } from 'pg';

import { setRlsContext } from '../../db/foundation';

export const INBOX_DEFAULT_LIMIT = 25;
export const INBOX_MAX_LIMIT = 100;
export const MAX_EVENT_TEXT_CHARS = 2000;
export const MAX_ID_CHARS = 200;

export type InboxFailure = 'invalid_input' | 'account_not_authorized';

export class InboxError extends Error {
  readonly reason: InboxFailure;

  constructor(reason: InboxFailure, message: string) {
    super(message);
    this.name = 'InboxError';
    this.reason = reason;
  }
}

/**
 * A single inbound reply as pre-validated by the caller/provider adapter.
 * ownRootId MUST be a root post already confirmed to belong to this account;
 * isReplyOwnedByMe MUST be exactly false; providerReplyId MUST be trusted.
 */
export interface InboundReplyInput {
  providerReplyId: string;
  ownRootId: string;
  parentId?: string;
  text?: string;
  timestamp?: string;
  isReplyOwnedByMe: boolean;
}

export interface PersistCounts {
  received: number;
  inserted: number;
  /** Already stored for this account; never updated. */
  existing: number;
  /** Skipped: own reply, unknown ownership, or malformed/untrusted fields. */
  skipped: number;
}

export interface InboxEvent {
  id: number;
  providerReplyId: string;
  receivedAt: string;
  content: {
    source: 'own_post';
    rootPostId: string;
    replyId: string;
    parentId?: string;
    text?: string;
    timestamp?: string;
    fetchedAt: string;
  };
}

export interface InboxPage {
  items: InboxEvent[];
  total: number;
}

function isPositiveInt(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) > 0;
}

function isSafeId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_CHARS;
}

function truncateText(text: string): string {
  return text.length > MAX_EVENT_TEXT_CHARS ? text.slice(0, MAX_EVENT_TEXT_CHARS) : text;
}

/**
 * Authorization for inbox persistence/reads: active operator +
 * operator_accounts ownership + active threads account. Deliberately NO
 * persona_bindings join — persona onboarding is not yet integrated and must
 * not gate inbound sync.
 */
async function assertAuthorizedAccount(
  pool: Pool,
  operatorId: number,
  accountId: number,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET TRANSACTION READ ONLY');
    await setRlsContext(client, operatorId, accountId);
    const result = await client.query(
      `SELECT 1
       FROM postbro.operators o
       JOIN postbro.operator_accounts oa ON oa.operator_id = o.id
       JOIN postbro.threads_accounts ta ON ta.id = oa.account_id
       WHERE o.id = $1
         AND o.status = 'active'
         AND ta.id = $2
         AND ta.status = 'active'`,
      [operatorId, accountId],
    );
    if (result.rowCount !== 1) {
      throw new InboxError('account_not_authorized', 'operator/account not authorized or not active');
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function buildEventContent(reply: InboundReplyInput, fetchedAt: Date): Record<string, unknown> {
  const content: Record<string, unknown> = {
    source: 'own_post',
    root_post_id: reply.ownRootId,
    reply_id: reply.providerReplyId,
    fetched_at: fetchedAt.toISOString(),
  };
  if (reply.parentId !== undefined) content['parent_id'] = reply.parentId;
  if (reply.text !== undefined) content['text'] = truncateText(reply.text);
  if (reply.timestamp !== undefined) content['timestamp'] = reply.timestamp;
  return content;
}

function parseReceivedAt(reply: InboundReplyInput, fetchedAt: Date): Date {
  if (reply.timestamp !== undefined) {
    const parsed = new Date(reply.timestamp);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return fetchedAt;
}

/**
 * Idempotently persist pre-validated inbound replies to confirmed own root
 * posts. ON CONFLICT (account_id, provider_reply_id) DO NOTHING — re-runs
 * dedupe and existing rows are never updated.
 */
export async function persistInboundReplies(
  pool: Pool,
  operatorId: number,
  accountId: number,
  replies: InboundReplyInput[],
): Promise<PersistCounts> {
  if (!isPositiveInt(operatorId) || !isPositiveInt(accountId)) {
    throw new InboxError('invalid_input', 'operatorId and accountId must be positive integers');
  }
  if (!Array.isArray(replies)) {
    throw new InboxError('invalid_input', 'replies must be an array');
  }

  const counts: PersistCounts = { received: replies.length, inserted: 0, existing: 0, skipped: 0 };

  // Fail closed per item: own replies, unknown ownership, malformed/untrusted
  // IDs are skipped, never stored, never thrown on mid-batch.
  const eligible: InboundReplyInput[] = [];
  for (const reply of replies) {
    if (reply === null || typeof reply !== 'object') {
      counts.skipped += 1;
      continue;
    }
    if (reply.isReplyOwnedByMe !== false) {
      counts.skipped += 1;
      continue;
    }
    if (!isSafeId(reply.providerReplyId) || !isSafeId(reply.ownRootId)) {
      counts.skipped += 1;
      continue;
    }
    if (reply.parentId !== undefined && !isSafeId(reply.parentId)) {
      counts.skipped += 1;
      continue;
    }
    if (reply.text !== undefined && typeof reply.text !== 'string') {
      counts.skipped += 1;
      continue;
    }
    if (reply.timestamp !== undefined && typeof reply.timestamp !== 'string') {
      counts.skipped += 1;
      continue;
    }
    eligible.push(reply);
  }

  if (eligible.length === 0) return counts;

  await assertAuthorizedAccount(pool, operatorId, accountId);

  const fetchedAt = new Date();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await setRlsContext(client, operatorId, accountId);
    for (const reply of eligible) {
      const result = await client.query(
        `INSERT INTO postbro.engagement_events (account_id, provider_reply_id, content, received_at)
         VALUES ($1, $2, $3::jsonb, $4)
         ON CONFLICT (account_id, provider_reply_id) DO NOTHING`,
        [accountId, reply.providerReplyId, JSON.stringify(buildEventContent(reply, fetchedAt)), parseReceivedAt(reply, fetchedAt)],
      );
      if (result.rowCount === 1) {
        counts.inserted += 1;
      } else {
        counts.existing += 1;
      }
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }

  return counts;
}

function toInboxEvent(row: {
  id: string;
  provider_reply_id: string;
  received_at: Date;
  content: Record<string, unknown>;
}): InboxEvent | null {
  const c = row.content;
  if (c['source'] !== 'own_post') return null;
  const rootPostId = typeof c['root_post_id'] === 'string' ? c['root_post_id'] : undefined;
  const replyId = typeof c['reply_id'] === 'string' ? c['reply_id'] : undefined;
  const fetchedAt = typeof c['fetched_at'] === 'string' ? c['fetched_at'] : undefined;
  if (!rootPostId || !replyId || !fetchedAt) return null;
  const parentId = typeof c['parent_id'] === 'string' ? c['parent_id'] : undefined;
  const text = typeof c['text'] === 'string' ? c['text'] : undefined;
  const timestamp = typeof c['timestamp'] === 'string' ? c['timestamp'] : undefined;
  return {
    id: Number(row.id),
    providerReplyId: row.provider_reply_id,
    receivedAt: row.received_at.toISOString(),
    content: {
      source: 'own_post',
      rootPostId,
      replyId,
      ...(parentId !== undefined ? { parentId } : {}),
      ...(text !== undefined ? { text } : {}),
      ...(timestamp !== undefined ? { timestamp } : {}),
      fetchedAt,
    },
  };
}

/**
 * Read-only, account-scoped inbox over stored engagement_events. Bounded
 * limit (1..100, default 25), newest first, RLS as the app role.
 */
export async function listInboxEvents(
  pool: Pool,
  operatorId: number,
  accountId: number,
  limit: number = INBOX_DEFAULT_LIMIT,
): Promise<InboxPage> {
  if (!isPositiveInt(operatorId) || !isPositiveInt(accountId)) {
    throw new InboxError('invalid_input', 'operatorId and accountId must be positive integers');
  }
  const bounded = isPositiveInt(limit) ? Math.min(limit, INBOX_MAX_LIMIT) : INBOX_DEFAULT_LIMIT;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET TRANSACTION READ ONLY');
    await setRlsContext(client, operatorId, accountId);

    const auth = await client.query(
      `SELECT 1
       FROM postbro.operators o
       JOIN postbro.operator_accounts oa ON oa.operator_id = o.id
       JOIN postbro.threads_accounts ta ON ta.id = oa.account_id
       WHERE o.id = $1 AND o.status = 'active' AND ta.id = $2 AND ta.status = 'active'`,
      [operatorId, accountId],
    );
    if (auth.rowCount !== 1) {
      throw new InboxError('account_not_authorized', 'operator/account not authorized or not active');
    }

    const totalResult = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM postbro.engagement_events WHERE account_id = $1`,
      [accountId],
    );
    const rows = await client.query<{
      id: string;
      provider_reply_id: string;
      received_at: Date;
      content: Record<string, unknown>;
    }>(
      `SELECT id, provider_reply_id, received_at, content
       FROM postbro.engagement_events
       WHERE account_id = $1
       ORDER BY received_at DESC, id DESC
       LIMIT $2`,
      [accountId, bounded],
    );
    await client.query('COMMIT');

    const items = rows.rows.map(toInboxEvent).filter((e): e is InboxEvent => e !== null);
    return { items, total: Number(totalResult.rows[0]!.count) };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
