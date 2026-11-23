/**
 * PB-SOCIAL-005A: trusted worker-only content drafting/review processing.
 * NO Postiz API calls, NO browser-accessible writer, NO automatic scheduling.
 */
import type { Pool, PoolClient } from 'pg';
import { requireUuid } from '../http/tenant-store.js';

export type ContentSurface = 'THREADS' | 'FB_IG';
export type ContentProcessResult = 'APPROVED' | 'CHANGES_REQUESTED' | 'STALE';

export class ContentWorkflowError extends Error {
  constructor(message = 'content_workflow_unavailable') { super(message); }
}

async function trustedTx<T>(pool: Pick<Pool, 'connect'>, fn: (db: PoolClient) => Promise<T>): Promise<T> {
  const db = await pool.connect();
  let active = false;
  try {
    await db.query('BEGIN');
    active = true;
    await db.query("SET LOCAL statement_timeout = '5000ms'");
    const result = await fn(db);
    await db.query('COMMIT');
    active = false;
    return result;
  } catch (error) {
    if (active) await db.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    db.release();
  }
}

function validBody(body: unknown): string {
  if (typeof body !== 'string' || body.trim().length < 1 ||
      body.trim().length > 3000) {
    throw new ContentWorkflowError('invalid_content_body');
  }
  return body.trim();
}

function validScheduledFor(value: unknown): string {
  if (typeof value !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    throw new ContentWorkflowError('invalid_schedule_datetime');
  }
  const when = new Date(value);
  if (Number.isNaN(when.getTime())) throw new ContentWorkflowError('invalid_schedule_datetime');
  return when.toISOString();
}

export async function createTrustedContentDraft(
  pool: Pick<Pool, 'connect'>, clientId: string, surface: ContentSurface,
  body: string, scheduledFor: string,
): Promise<{ id: string; status: 'IN_REVIEW'; contentRevision: number }> {
  requireUuid(clientId);
  if (surface !== 'THREADS' && surface !== 'FB_IG') {
    throw new ContentWorkflowError('invalid_content_surface');
  }
  const cleanBody = validBody(body);
  const target = validScheduledFor(scheduledFor);
  return trustedTx(pool, async db => {
    const client = await db.query(
      `SELECT status, persona_revision, persona_approved_revision
        FROM postbro_social.clients WHERE id=$1 FOR UPDATE`, [clientId]
    );
    const row = client.rows[0];
    if (!row || row.status !== 'READY' ||
        row.persona_approved_revision !== row.persona_revision) {
      throw new ContentWorkflowError('approved_persona_required');
    }
    const inserted = await db.query(
      `INSERT INTO postbro_social.content_drafts
        (client_id, persona_revision, surface, body, scheduled_for)
        VALUES ($1,$2,$3,$4,$5::timestamptz)
        RETURNING id, content_revision AS "contentRevision", status`,
      [clientId, row.persona_revision, surface, cleanBody, target]
    );
    return inserted.rows[0] as { id: string; status: 'IN_REVIEW'; contentRevision: number };
  });
}

export async function reviseTrustedContentDraft(
  pool: Pick<Pool, 'connect'>, draftId: string, nextBody: string,
): Promise<{ id: string; contentRevision: number; status: 'IN_REVIEW' }> {
  requireUuid(draftId);
  const body = validBody(nextBody);
  return trustedTx(pool, async db => {
    const row = await db.query(
      `SELECT d.id, d.status, d.content_revision,
          d.persona_revision, c.status AS "clientStatus",
          c.persona_approved_revision AS "approvedRevision"
        FROM postbro_social.content_drafts AS d
        JOIN postbro_social.clients AS c ON c.id=d.client_id
        WHERE d.id=$1 FOR UPDATE OF d, c`, [draftId]
    );
    const d = row.rows[0];
    if (!d || d.status !== 'CHANGES_REQUESTED' ||
        d.clientStatus !== 'READY' || d.approvedRevision !== d.persona_revision) {
      throw new ContentWorkflowError('content_revision_unavailable');
    }
    const edited = await db.query(
      `UPDATE postbro_social.content_drafts
        SET content_revision=content_revision+1, body=$2, status='IN_REVIEW',
            updated_at=now()
        WHERE id=$1
        RETURNING id, content_revision AS "contentRevision", status`,
      [draftId, body]
    );
    return edited.rows[0] as { id: string; contentRevision: number; status: 'IN_REVIEW' };
  });
}

export async function processTrustedContentDecision(
  pool: Pick<Pool, 'connect'>, reviewId: string,
): Promise<{ reviewId: string; result: ContentProcessResult }> {
  requireUuid(reviewId);
  return trustedTx(pool, async db => {
    const found = await db.query(
      `SELECT r.id, r.draft_id AS "draftId", r.content_revision AS "requestedRevision",
          r.decision, d.content_revision AS "currentRevision",
          d.status AS "draftStatus", d.persona_revision AS "draftPersonaRevision",
          c.status AS "clientStatus",
          c.persona_approved_revision AS "approvedPersonaRevision"
        FROM postbro_social.content_review_requests AS r
        JOIN postbro_social.content_drafts AS d ON d.id=r.draft_id
        JOIN postbro_social.clients AS c ON c.id=d.client_id
        WHERE r.id=$1 FOR UPDATE OF r, d, c`,
      [reviewId]
    );
    const row = found.rows[0];
    if (!row) throw new ContentWorkflowError();
    const previous = await db.query(
      'SELECT result FROM postbro_social.content_review_actions WHERE review_request_id=$1',
      [reviewId]
    );
    if (previous.rows[0]) {
      return { reviewId, result: previous.rows[0].result as ContentProcessResult };
    }
    const current = row.draftStatus === 'IN_REVIEW' &&
      row.currentRevision === row.requestedRevision &&
      row.clientStatus === 'READY' &&
      row.draftPersonaRevision === row.approvedPersonaRevision;
    let result: ContentProcessResult = 'STALE';
    if (current && row.decision === 'APPROVE') {
      await db.query(
        "UPDATE postbro_social.content_drafts SET status='APPROVED' WHERE id=$1",
        [row.draftId]
      );
      result = 'APPROVED';
    } else if (current && row.decision === 'REQUEST_CHANGES') {
      await db.query(
        "UPDATE postbro_social.content_drafts SET status='CHANGES_REQUESTED' WHERE id=$1",
        [row.draftId]
      );
      result = 'CHANGES_REQUESTED';
    }
    await db.query(
      `INSERT INTO postbro_social.content_review_actions
        (review_request_id, draft_id, content_revision, result)
        VALUES ($1,$2,$3,$4)`,
      [reviewId, row.draftId, row.requestedRevision, result]
    );
    return { reviewId, result };
  });
}

/**
 * This is ONLY a read gate for a future Postiz bridge. It deliberately has
 * no network or publish side effects.
 */
export async function getTrustedApprovedContent(
  pool: Pick<Pool, 'connect'>, draftId: string,
): Promise<Record<string, unknown> | null> {
  requireUuid(draftId);
  return trustedTx(pool, async db => {
    const data = await db.query(
      `SELECT d.id, d.client_id AS "clientId", d.body, d.surface,
         d.scheduled_for AS "scheduledFor", d.content_revision AS "contentRevision",
         d.persona_revision AS "personaRevision", c.plan
       FROM postbro_social.content_drafts AS d
       JOIN postbro_social.clients AS c ON c.id=d.client_id
       JOIN postbro_social.content_review_requests AS r
         ON r.draft_id=d.id AND r.content_revision=d.content_revision
         AND r.decision='APPROVE'
       JOIN postbro_social.content_review_actions AS a
         ON a.review_request_id=r.id AND a.result='APPROVED'
       WHERE d.id=$1 AND d.status='APPROVED' AND c.status='READY'
         AND c.persona_approved_revision=d.persona_revision`,
      [draftId]
    );
    return data.rows[0] ?? null;
  });
}
