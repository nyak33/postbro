/**
 * PB-SOCIAL-005C: trusted-worker-only Postiz DRAFT dispatch reservation.
 * No HTTP client, API key reader, POST, retries or public routes in this module.
 * Calling prepare/claim is not permission to publish; a separately approved
 * future sender must call claim immediately before one draft-only POST.
 */
import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { requireUuid } from '../http/tenant-store.js';
import {
  buildPostizDraftPreview,
  type PostizClientMapping,
  type PostizCreateDraftPayload,
  type ReadyPostizMedia,
  type VerifiedPostizIntegration,
} from './draft-preview.js';

export type DispatchState =
  'PREPARED' | 'ATTEMPTED' | 'CONFIRMED' | 'NEEDS_RECONCILIATION' | 'REJECTED';
export interface ProviderDraftPost { postId: string; integration: string }
export class PostizDispatchError extends Error {
  constructor(message = 'postiz_dispatch_unavailable') { super(message); }
}

type ApprovedRow = Record<string, unknown> & {
  id: string;
  clientId: string;
  personaRevision: number;
  contentRevision: number;
};
type StoredRow = {
  id: string;
  draft_id: string;
  client_id: string;
  state: DispatchState;
  payload_sha256: string;
  customer_group_id: string;
  draft_payload: PostizCreateDraftPayload;
};

const APPROVED_SQL = [
  'SELECT d.id, d.client_id AS "clientId", d.body, d.surface,',
  'd.scheduled_for AS "scheduledFor", d.content_revision AS "contentRevision",',
  'd.persona_revision AS "personaRevision", c.plan',
  'FROM postbro_social.content_drafts AS d',
  'JOIN postbro_social.clients AS c ON c.id=d.client_id',
  'WHERE d.id=$1 AND d.status=\'APPROVED\' AND c.status=\'READY\'',
  'AND c.persona_approved_revision=d.persona_revision',
  'AND EXISTS (SELECT 1 FROM postbro_social.content_review_requests AS r',
  'JOIN postbro_social.content_review_actions AS a ON a.review_request_id=r.id',
  'WHERE r.draft_id=d.id AND r.content_revision=d.content_revision',
  'AND r.decision=\'APPROVE\' AND a.result=\'APPROVED\')',
  'FOR UPDATE OF d,c'
].join(' ');

async function tx<T>(
  pool: Pick<Pool, 'connect'>, work: (db: PoolClient) => Promise<T>,
): Promise<T> {
  const db = await pool.connect();
  let open = false;
  try {
    await db.query('BEGIN');
    open = true;
    await db.query("SET LOCAL statement_timeout = '5000ms'");
    const result = await work(db);
    await db.query('COMMIT');
    open = false;
    return result;
  } catch (error) {
    if (open) await db.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    db.release();
  }
}

async function approvedLocked(db: PoolClient, draftId: string): Promise<ApprovedRow> {
  const result = await db.query<ApprovedRow>(APPROVED_SQL, [requireUuid(draftId)]);
  const row = result.rows[0];
  if (!row) throw new PostizDispatchError('content_not_approved');
  return row;
}

function fingerprint(payload: PostizCreateDraftPayload): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function validateStored(
  row: StoredRow | undefined, payload: PostizCreateDraftPayload,
  groupId: string, clientId: string,
): StoredRow {
  if (!row || row.payload_sha256 !== fingerprint(payload) ||
      row.customer_group_id !== groupId || row.client_id !== clientId) {
    throw new PostizDispatchError('postiz_dispatch_conflict');
  }
  return row;
}

/** Durable once-per-content-draft intent, including its exact verified channel snapshot. */
export async function preparePostizDraftDispatch(
  pool: Pick<Pool, 'connect'>,
  draftId: string,
  mapping: PostizClientMapping,
  freshIntegrations: readonly VerifiedPostizIntegration[],
  media: readonly ReadyPostizMedia[] = [],
): Promise<{ id: string; state: DispatchState }> {
  return tx(pool, async db => {
    const approved = await approvedLocked(db, draftId);
    const payload = buildPostizDraftPreview(approved, mapping, freshIntegrations, media);
    const hash = fingerprint(payload);
    await db.query(
      'INSERT INTO postbro_social.postiz_draft_dispatches ' +
      '(draft_id,client_id,content_revision,persona_revision,customer_group_id,payload_sha256,draft_payload) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT (draft_id) DO NOTHING',
      [approved.id, approved.clientId, approved.contentRevision, approved.personaRevision,
        mapping.customerGroupId, hash, JSON.stringify(payload)]
    );
    const record = await db.query<StoredRow>(
      'SELECT * FROM postbro_social.postiz_draft_dispatches WHERE draft_id=$1 FOR UPDATE',
      [draftId]
    );
    const entry = validateStored(record.rows[0], payload, mapping.customerGroupId,
      approved.clientId);
    return { id: entry.id, state: entry.state };
  });
}

/**
 * Atomically consume the only permitted attempt. An abrupt worker crash leaves
 * ATTEMPTED, not PREPARED. Never reclaim/retry it automatically: Postiz has no
 * documented create-post idempotency key.
 * Reverify current integrations immediately before invoking this function.
 */
export async function claimPostizDraftDispatch(
  pool: Pick<Pool, 'connect'>,
  dispatchId: string,
  mapping: PostizClientMapping,
  freshIntegrations: readonly VerifiedPostizIntegration[],
  media: readonly ReadyPostizMedia[] = [],
): Promise<PostizCreateDraftPayload> {
  requireUuid(dispatchId);
  return tx(pool, async db => {
    const found = await db.query<{ draft_id: string }>(
      'SELECT draft_id FROM postbro_social.postiz_draft_dispatches WHERE id=$1',
      [dispatchId]
    );
    const draftId = found.rows[0]?.draft_id;
    if (!draftId) throw new PostizDispatchError();
    const approved = await approvedLocked(db, draftId);
    const payload = buildPostizDraftPreview(approved, mapping, freshIntegrations, media);
    const saved = await db.query<StoredRow>(
      'SELECT * FROM postbro_social.postiz_draft_dispatches WHERE id=$1 FOR UPDATE',
      [dispatchId]
    );
    const entry = validateStored(saved.rows[0], payload,
      mapping.customerGroupId, approved.clientId);
    if (entry.state !== 'PREPARED') {
      throw new PostizDispatchError('postiz_dispatch_already_attempted');
    }
    await db.query(
      "UPDATE postbro_social.postiz_draft_dispatches SET state='ATTEMPTED', attempted_at=now() WHERE id=$1",
      [dispatchId]
    );
    return payload; // Still DRAFT only, no HTTP operation.
  });
}

/** Postiz Create Post returns one {postId,integration} per target. */
export function verifyPostizDraftReceipt(
  payload: PostizCreateDraftPayload, response: unknown,
): ProviderDraftPost[] {
  if (payload.type !== 'draft' || !Array.isArray(response) ||
      response.length !== payload.posts.length) {
    throw new PostizDispatchError('unverified_postiz_draft_receipt');
  }
  const expected = payload.posts.map(item => item.integration.id);
  const found = response.map((item: unknown) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new PostizDispatchError('unverified_postiz_draft_receipt');
    }
    const record = item as Record<string, unknown>;
    if (typeof record.postId !== 'string' ||
        !/^[a-zA-Z0-9_-]{3,160}$/.test(record.postId) ||
        typeof record.integration !== 'string' ||
        !expected.includes(record.integration)) {
      throw new PostizDispatchError('unverified_postiz_draft_receipt');
    }
    return { postId: record.postId, integration: record.integration };
  });
  if (new Set(found.map(x => x.postId)).size !== found.length ||
      new Set(found.map(x => x.integration)).size !== expected.length) {
    throw new PostizDispatchError('unverified_postiz_draft_receipt');
  }
  return found;
}

/**
 * Record an external outcome AFTER one future operator-controlled POST.
 * Only a verified success receipt may become CONFIRMED. Timeout, 5xx,
 * malformed 2xx response or worker uncertainty -> NEEDS_RECONCILIATION.
 * A definitive 4xx can be REJECTED, but is never auto-retried.
 */
export async function finishPostizDraftDispatch(
  pool: Pick<Pool, 'connect'>,
  dispatchId: string,
  outcome: { kind: 'confirmed'; response: unknown } |
           { kind: 'ambiguous' } | { kind: 'rejected' },
): Promise<DispatchState> {
  requireUuid(dispatchId);
  return tx(pool, async db => {
    const stored = await db.query<StoredRow>(
      'SELECT * FROM postbro_social.postiz_draft_dispatches WHERE id=$1 FOR UPDATE',
      [dispatchId]
    );
    const entry = stored.rows[0];
    if (!entry || entry.state !== 'ATTEMPTED') {
      throw new PostizDispatchError('postiz_dispatch_not_in_flight');
    }
    let state: DispatchState;
    let posts: ProviderDraftPost[] = [];
    if (outcome.kind === 'confirmed') {
      try {
        posts = verifyPostizDraftReceipt(entry.draft_payload, outcome.response);
        state = 'CONFIRMED';
      } catch {
        state = 'NEEDS_RECONCILIATION';
      }
    } else if (outcome.kind === 'ambiguous') {
      state = 'NEEDS_RECONCILIATION';
    } else if (outcome.kind === 'rejected') {
      state = 'REJECTED';
    } else {
      throw new PostizDispatchError('invalid_dispatch_outcome');
    }
    await db.query(
      'UPDATE postbro_social.postiz_draft_dispatches ' +
      'SET state=$2, provider_posts=$3::jsonb, completed_at=now() WHERE id=$1',
      [dispatchId, state, JSON.stringify(posts)]
    );
    return state;
  });
}
