import type { Pool } from 'pg';
import { requireUuid, withTenantRls } from '../http/tenant-store.js';

export interface ContentDecisionInput {
  expectedRevision: number;
  decision: 'APPROVE' | 'REQUEST_CHANGES';
  comment: string | null;
}

export function parseContentDecision(raw: unknown): ContentDecisionInput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('invalid_content_decision');
  }
  const item = raw as Record<string, unknown>;
  if (Object.keys(item).some(key => !['expectedRevision', 'decision', 'comment'].includes(key)) ||
      !Number.isSafeInteger(item.expectedRevision) || (item.expectedRevision as number) < 1) {
    throw new Error('invalid_content_decision');
  }
  if (item.decision === 'APPROVE') {
    if (item.comment !== undefined && item.comment !== null) {
      throw new Error('invalid_content_decision');
    }
    return { expectedRevision: item.expectedRevision as number,
      decision: 'APPROVE', comment: null };
  }
  if (item.decision !== 'REQUEST_CHANGES' ||
      typeof item.comment !== 'string' ||
      item.comment.trim().length < 1 || item.comment.trim().length > 1000) {
    throw new Error('invalid_content_decision');
  }
  return { expectedRevision: item.expectedRevision as number,
    decision: 'REQUEST_CHANGES', comment: item.comment.trim() };
}

const SAFE_COLUMNS = `
  id, client_id AS "clientId", persona_revision AS "personaRevision",
  content_revision AS "contentRevision", surface, body,
  scheduled_for AS "scheduledFor", status, updated_at AS "updatedAt"
`;

export async function listCustomerContent(
  pool: Pick<Pool, 'connect'>, userId: string, clientId: string,
) {
  requireUuid(clientId);
  return withTenantRls(pool, userId, async db => {
    const rows = await db.query(
      `SELECT ${SAFE_COLUMNS},
         (SELECT r.decision FROM postbro_social.content_review_requests AS r
          WHERE r.draft_id=content_drafts.id
            AND r.content_revision=content_drafts.content_revision
          LIMIT 1) AS "reviewDecision"
       FROM postbro_social.content_drafts
       WHERE client_id=$1 ORDER BY scheduled_for, id LIMIT 100`, [clientId]
    );
    return rows.rows;
  });
}

export async function listCustomerContentDecisions(
  pool: Pick<Pool, 'connect'>, userId: string, draftId: string,
) {
  requireUuid(draftId);
  return withTenantRls(pool, userId, async db => {
    const rows = await db.query(
      `SELECT id, draft_id AS "draftId",
         content_revision AS "contentRevision",
         requested_by AS "requestedBy", decision, comment,
         created_at AS "createdAt"
       FROM postbro_social.content_review_requests
       WHERE draft_id=$1 ORDER BY created_at DESC LIMIT 20`, [draftId]
    );
    return rows.rows;
  });
}

export async function submitCustomerContentDecision(
  pool: Pick<Pool, 'connect'>, userId: string, draftId: string,
  input: unknown,
) {
  requireUuid(draftId);
  const decision = parseContentDecision(input);
  return withTenantRls(pool, userId, async db => {
    const result = await db.query(
      `INSERT INTO postbro_social.content_review_requests
        (draft_id, content_revision, requested_by, decision, comment)
       SELECT d.id, d.content_revision, $3, $4, $5
       FROM postbro_social.content_drafts AS d
       WHERE d.id=$1 AND d.content_revision=$2 AND d.status='IN_REVIEW'
       ON CONFLICT (draft_id, content_revision) DO NOTHING
       RETURNING id, draft_id AS "draftId",
         content_revision AS "contentRevision",
         requested_by AS "requestedBy", decision, comment,
         created_at AS "createdAt"`,
      [draftId, decision.expectedRevision, userId, decision.decision, decision.comment]
    );
    return result.rows[0] ?? null;
  });
}
