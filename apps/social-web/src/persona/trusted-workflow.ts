/**
 * PB-SOCIAL-004C: trusted background workflow library. It has NO HTTP route
 * and is never called with client-provided Auth tokens or database credentials.
 * Requires a separately configured, privileged agency-only database pool.
 */
import type { Pool, PoolClient } from 'pg';
import { requireUuid } from '../http/tenant-store.js';
import {
  prepareExternalPersonaDraft,
  type PersonaBrandInput,
  type PersonaCliRunner,
  type SafeExternalPersonaDraft,
} from './private-cli-adapter.js';

export class PersonaWorkflowConflict extends Error {
  constructor() { super('persona_revision_conflict'); }
}

export class PersonaWorkflowUnavailable extends Error {
  constructor() { super('persona_workflow_unavailable'); }
}

interface Snapshot {
  id: string;
  revision: number;
  status: string;
  brand: PersonaBrandInput;
}

const SNAPSHOT_SQL = `
  SELECT id, persona_revision AS revision, status,
    business_name AS "businessName", niche, audience, language, tone,
    restrictions, sample_posts AS "samplePosts"
  FROM postbro_social.clients WHERE id=$1
`;

async function trustedTransaction<T>(
  pool: Pick<Pool, 'connect'>,
  cb: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const db = await pool.connect();
  let active = false;
  try {
    await db.query('BEGIN');
    active = true;
    await db.query("SET LOCAL statement_timeout = '5000ms'");
    const result = await cb(db);
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

function asSnapshot(row: Record<string, unknown> | undefined): Snapshot {
  if (!row || typeof row.id !== 'string' ||
      !Number.isSafeInteger(row.revision) ||
      typeof row.status !== 'string') {
    throw new PersonaWorkflowUnavailable();
  }
  const fields = ['businessName', 'niche', 'audience', 'language', 'tone', 'restrictions', 'samplePosts'];
  const brand: Record<string, string> = {};
  for (const field of fields) {
    if (typeof row[field] !== 'string') throw new PersonaWorkflowUnavailable();
    brand[field] = row[field] as string;
    if (!['restrictions', 'samplePosts'].includes(field) && !brand[field].trim()) {
      throw new PersonaWorkflowUnavailable();
    }
  }
  return {
    id: row.id,
    revision: row.revision as number,
    status: row.status,
    brand: brand as unknown as PersonaBrandInput,
  };
}

function sameSnapshot(a: Snapshot, b: Snapshot): boolean {
  return a.id === b.id && a.revision === b.revision &&
    a.status === b.status &&
    JSON.stringify(a.brand) === JSON.stringify(b.brand);
}

function strictExternalDraft(value: SafeExternalPersonaDraft): void {
  const p = value?.proposal;
  if (value?.source !== 'EXTERNAL_ENGINE' || !p ||
      !Number.isSafeInteger(value.engineVersion) ||
      value.engineVersion < 1 ||
      typeof value.enginePersonaId !== 'string' ||
      !/^persona_[A-Za-z0-9_-]{8,128}$/.test(value.enginePersonaId) ||
      !value.engineRecord || typeof value.engineRecord !== 'object' ||
      Array.isArray(value.engineRecord)) {
    throw new PersonaWorkflowUnavailable();
  }
  for (const item of [p.summary, p.writingStyle, p.contentPillars]) {
    if (typeof item !== 'string' || !item.trim() || item.length > 1000) {
      throw new PersonaWorkflowUnavailable();
    }
  }
}

/** Generate offline, then CAS-persist under row lock: no stale persona drafts. */
export async function generateAndSaveTrustedPersona(
  pool: Pick<Pool, 'connect'>,
  clientId: string,
  runner: PersonaCliRunner,
): Promise<{ clientId: string; revision: number; state: 'PERSONA_REVIEW' }> {
  requireUuid(clientId);
  const snapshot = await trustedTransaction(pool, async db => {
    const rows = await db.query(SNAPSHOT_SQL, [clientId]);
    return asSnapshot(rows.rows[0]);
  });
  if (snapshot.status !== 'ONBOARDING') throw new PersonaWorkflowConflict();

  // Engine runs without holding a database transaction, reducing lock time.
  const draft = await prepareExternalPersonaDraft(snapshot.brand, runner);
  strictExternalDraft(draft);

  return trustedTransaction(pool, async db => {
    const current = await db.query(SNAPSHOT_SQL + ' FOR UPDATE', [clientId]);
    const locked = asSnapshot(current.rows[0]);
    if (!sameSnapshot(snapshot, locked) || locked.status !== 'ONBOARDING' ||
        locked.revision >= Number.MAX_SAFE_INTEGER - 1) {
      throw new PersonaWorkflowConflict();
    }
    const revision = locked.revision + 1;
    const publicDraft = { source: 'EXTERNAL_ENGINE', proposal: draft.proposal };
    // Both operations commit/rollback as one transaction; snapshots are
    // immutable and their full contents are NOT returned to the browser.
    await db.query(
      `INSERT INTO postbro_social.persona_versions
        (client_id, revision, engine_persona_id, engine_version, engine_record, proposal)
        VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb)`,
      [clientId, revision, draft.enginePersonaId, draft.engineVersion,
        JSON.stringify(draft.engineRecord), JSON.stringify(draft.proposal)]
    );
    await db.query(
      `UPDATE postbro_social.clients
        SET persona_revision=$2, persona_draft=$3::jsonb, status='PERSONA_REVIEW',
          persona_approved_revision=NULL, persona_approved_at=NULL
        WHERE id=$1`,
      [clientId, revision, JSON.stringify(publicDraft)]
    );
    return { clientId, revision, state: 'PERSONA_REVIEW' as const };
  });
}

export type PersonaReviewProcessingResult = 'ACTIVATED' | 'REVISION_REQUIRED' | 'STALE';

/**
 * Idempotent trusted processor: a user's request is not itself activation.
 * All paths keep an immutable action record. Stale requests never activate.
 */
export async function processTrustedPersonaReview(
  pool: Pick<Pool, 'connect'>,
  reviewRequestId: string,
): Promise<{ reviewRequestId: string; result: PersonaReviewProcessingResult }> {
  requireUuid(reviewRequestId);
  return trustedTransaction(pool, async db => {
    const q = await db.query(
      `SELECT r.id, r.client_id AS "clientId", r.persona_revision AS "requestedRevision",
        r.decision, c.status, c.persona_revision AS "currentRevision",
        c.persona_draft AS "personaDraft",
        EXISTS (
          SELECT 1 FROM postbro_social.persona_versions AS v
          WHERE v.client_id=r.client_id AND v.revision=r.persona_revision
            AND v.source='EXTERNAL_ENGINE'
        ) AS "hasVersion"
        FROM postbro_social.persona_review_requests AS r
        JOIN postbro_social.clients AS c ON c.id=r.client_id
        WHERE r.id=$1 FOR UPDATE OF c, r`,
      [reviewRequestId]
    );
    const row = q.rows[0] as Record<string, unknown> | undefined;
    if (!row) throw new PersonaWorkflowUnavailable();
    const existing = await db.query(
      'SELECT result FROM postbro_social.persona_review_actions WHERE review_request_id=$1',
      [reviewRequestId]
    );
    if (existing.rows[0]) {
      const result = existing.rows[0].result as PersonaReviewProcessingResult;
      return { reviewRequestId, result };
    }
    const draft = row.personaDraft as Record<string, unknown> | null;
    const current = row.currentRevision === row.requestedRevision &&
      row.status === 'PERSONA_REVIEW' &&
      row.hasVersion === true && draft?.source === 'EXTERNAL_ENGINE';

    let result: PersonaReviewProcessingResult = 'STALE';
    if (current && row.decision === 'APPROVE') {
      await db.query(
        `UPDATE postbro_social.clients
          SET status='READY', persona_approved_revision=$2,
            persona_approved_at=now()
          WHERE id=$1`,
        [row.clientId, row.requestedRevision]
      );
      result = 'ACTIVATED';
    } else if (current && row.decision === 'REQUEST_CHANGES') {
      await db.query(
        `UPDATE postbro_social.clients
          SET status='ONBOARDING', persona_revision=persona_revision+1,
            persona_draft=NULL, persona_approved_revision=NULL,
            persona_approved_at=NULL
          WHERE id=$1`,
        [row.clientId]
      );
      result = 'REVISION_REQUIRED';
    }
    await db.query(
      `INSERT INTO postbro_social.persona_review_actions
        (review_request_id, client_id, persona_revision, result)
        VALUES ($1,$2,$3,$4)`,
      [reviewRequestId, row.clientId, row.requestedRevision, result]
    );
    return { reviewRequestId, result };
  });
}

/** Trusted-only version lookup for later content generation. Never exposed via client route. */
export async function getTrustedApprovedPersonaRecord(
  pool: Pick<Pool, 'connect'>,
  clientId: string,
): Promise<Record<string, unknown> | null> {
  requireUuid(clientId);
  return trustedTransaction(pool, async db => {
    const r = await db.query(
      `SELECT v.engine_record AS record
        FROM postbro_social.clients AS c
        JOIN postbro_social.persona_versions AS v
          ON v.client_id=c.id AND v.revision=c.persona_approved_revision
        JOIN postbro_social.persona_review_requests AS rr
          ON rr.client_id=c.id AND rr.persona_revision=v.revision
          AND rr.decision='APPROVE'
        JOIN postbro_social.persona_review_actions AS a
          ON a.review_request_id=rr.id AND a.result='ACTIVATED'
        WHERE c.id=$1 AND c.status='READY'
          AND c.persona_approved_at IS NOT NULL
          AND v.source='EXTERNAL_ENGINE'`,
      [clientId]
    );
    return (r.rows[0]?.record as Record<string, unknown> | undefined) ?? null;
  });
}
