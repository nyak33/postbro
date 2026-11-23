import type { Pool, PoolClient } from 'pg';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FIELDS = `
  id, organization_id AS "organizationId", plan,
  business_name AS "businessName", niche, audience, language, tone,
  restrictions, sample_posts AS "samplePosts",
  history_consent AS "historyConsent",
  history_decision_recorded AS "historyDecisionRecorded",
  persona_revision AS "personaRevision",
  CASE
    WHEN persona_draft->>'source' = 'EXTERNAL_ENGINE' THEN
      jsonb_build_object(
        'source', 'EXTERNAL_ENGINE',
        'proposal', jsonb_build_object(
          'summary', persona_draft->'proposal'->>'summary',
          'writingStyle', persona_draft->'proposal'->>'writingStyle',
          'contentPillars', persona_draft->'proposal'->>'contentPillars'
        )
      )
    ELSE NULL
  END AS "personaDraft",
  persona_approved_revision AS "personaApprovedRevision",
  persona_approved_at AS "personaApprovedAt",
  status, updated_at AS "updatedAt"
`;

export function requireUuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new Error('invalid_client_id');
  }
  return value;
}

function stringField(value: unknown, name: string, max: number, required = false): string {
  if (typeof value !== 'string') throw new Error('invalid_' + name);
  const clean = value.trim();
  if (clean.length > max || (required && clean.length === 0)) {
    throw new Error('invalid_' + name);
  }
  return clean;
}

export interface BrandEdit {
  businessName: string; niche: string; audience: string;
  language: string; tone: string; restrictions: string; samplePosts: string;
}

export function parseBrand(value: unknown): BrandEdit {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('invalid_brand');
  }
  const raw = value as Record<string, unknown>;
  const keys = ['businessName', 'niche', 'audience', 'language', 'tone', 'restrictions', 'samplePosts'];
  if (Object.keys(raw).some(key => !keys.includes(key))) throw new Error('invalid_brand');
  return {
    businessName: stringField(raw.businessName, 'businessName', 200, true),
    niche: stringField(raw.niche, 'niche', 1000, true),
    audience: stringField(raw.audience, 'audience', 1000, true),
    language: stringField(raw.language, 'language', 1000, true),
    tone: stringField(raw.tone, 'tone', 1000, true),
    restrictions: stringField(raw.restrictions, 'restrictions', 1000),
    samplePosts: stringField(raw.samplePosts, 'samplePosts', 1000),
  };
}

export function parseHistory(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('invalid_history');
  }
  const data = value as Record<string, unknown>;
  if (Object.keys(data).length !== 1 || typeof data.optedIn !== 'boolean') {
    throw new Error('invalid_history');
  }
  return data.optedIn;
}

/**
 * Database role and auth.uid() are set from server-VERIFIED identity only.
 * Never use a service-role query, caller-provided org ID, or unverified JWT
 * claims for ordinary customer data. PostgreSQL RLS is mandatory.
 */
export async function withTenantRls<T>(
  pool: Pick<Pool, 'connect'>, userId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  requireUuid(userId);
  const client = await pool.connect();
  let transaction = false;
  try {
    await client.query('BEGIN');
    transaction = true;
    await client.query('SET LOCAL ROLE authenticated');
    await client.query("SELECT set_config('request.jwt.claim.sub', $1, true)", [userId]);
    await client.query("SET LOCAL statement_timeout = '5000ms'");
    const result = await fn(client);
    await client.query('COMMIT');
    transaction = false;
    return result;
  } catch (error) {
    if (transaction) await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function listTenantClients(pool: Pick<Pool, 'connect'>, userId: string) {
  return withTenantRls(pool, userId, async db =>
    (await db.query('SELECT ' + FIELDS + ' FROM postbro_social.clients ORDER BY created_at, id LIMIT 5')).rows
  );
}

export async function getTenantClient(
  pool: Pick<Pool, 'connect'>, userId: string, clientId: string,
) {
  requireUuid(clientId);
  return withTenantRls(pool, userId, async db =>
    (await db.query('SELECT ' + FIELDS + ' FROM postbro_social.clients WHERE id=$1',
      [clientId])).rows[0] ?? null
  );
}

export async function saveTenantBrand(
  pool: Pick<Pool, 'connect'>, userId: string, clientId: string, raw: unknown,
) {
  requireUuid(clientId);
  const value = parseBrand(raw);
  return withTenantRls(pool, userId, async db =>
    (await db.query('UPDATE postbro_social.clients SET business_name=$2, niche=$3, ' +
      'audience=$4, language=$5, tone=$6, restrictions=$7, sample_posts=$8 ' +
      'WHERE id=$1 RETURNING ' + FIELDS,
      [clientId, value.businessName, value.niche, value.audience, value.language,
        value.tone, value.restrictions, value.samplePosts])).rows[0] ?? null
  );
}

export async function saveTenantHistory(
  pool: Pick<Pool, 'connect'>, userId: string, clientId: string, raw: unknown,
) {
  requireUuid(clientId);
  const optedIn = parseHistory(raw);
  return withTenantRls(pool, userId, async db =>
    (await db.query('UPDATE postbro_social.clients SET history_consent=$2, ' +
      'history_decision_recorded=true WHERE id=$1 RETURNING ' + FIELDS,
      [clientId, optedIn])).rows[0] ?? null
  );
}

/** Client intent only: the separate trusted engine worker must process it.
 * Submitting a review NEVER creates an active persona or schedules content.
 */
export interface PersonaReviewDecision {
  expectedRevision: number;
  decision: 'APPROVE' | 'REQUEST_CHANGES';
  suggestedChanges: {
    summary: string;
    writingStyle: string;
    contentPillars: string;
  } | null;
}

export function parsePersonaReview(input: unknown): PersonaReviewDecision {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('invalid_persona_review');
  }
  const raw = input as Record<string, unknown>;
  if (Object.keys(raw).some(key =>
    !['expectedRevision', 'decision', 'suggestedChanges'].includes(key))) {
    throw new Error('invalid_persona_review');
  }
  if (!Number.isSafeInteger(raw.expectedRevision) ||
      (raw.expectedRevision as number) < 1) {
    throw new Error('invalid_persona_revision');
  }
  if (raw.decision === 'APPROVE') {
    if (raw.suggestedChanges !== undefined && raw.suggestedChanges !== null) {
      throw new Error('invalid_persona_review');
    }
    return {
      expectedRevision: raw.expectedRevision as number,
      decision: 'APPROVE',
      suggestedChanges: null
    };
  }
  if (raw.decision !== 'REQUEST_CHANGES' || !raw.suggestedChanges ||
      typeof raw.suggestedChanges !== 'object' ||
      Array.isArray(raw.suggestedChanges)) {
    throw new Error('invalid_persona_review');
  }
  const changes = raw.suggestedChanges as Record<string, unknown>;
  const fields = ['summary', 'writingStyle', 'contentPillars'];
  if (Object.keys(changes).some(key => !fields.includes(key))) {
    throw new Error('invalid_persona_review');
  }
  return {
    expectedRevision: raw.expectedRevision as number,
    decision: 'REQUEST_CHANGES',
    suggestedChanges: {
      summary: stringField(changes.summary, 'summary', 1000, true),
      writingStyle: stringField(changes.writingStyle, 'writingStyle', 1000, true),
      contentPillars: stringField(changes.contentPillars, 'contentPillars', 1000, true),
    }
  };
}

export async function getPersonaReviewRequests(
  pool: Pick<Pool, 'connect'>, userId: string, clientId: string,
) {
  requireUuid(clientId);
  return withTenantRls(pool, userId, async db =>
    (await db.query(
      `SELECT id, client_id AS "clientId", persona_revision AS "personaRevision",
        requested_by AS "requestedBy", decision,
        suggested_changes AS "suggestedChanges", created_at AS "createdAt"
        FROM postbro_social.persona_review_requests
        WHERE client_id=$1 ORDER BY created_at DESC LIMIT 20`,
      [clientId]
    )).rows
  );
}

export async function submitPersonaReviewRequest(
  pool: Pick<Pool, 'connect'>, userId: string, clientId: string, input: unknown,
) {
  requireUuid(clientId);
  const review = parsePersonaReview(input);
  return withTenantRls(pool, userId, async db => {
    const result = await db.query(
      `INSERT INTO postbro_social.persona_review_requests
        (client_id, persona_revision, requested_by, decision, suggested_changes)
        SELECT c.id, c.persona_revision, $3, $4, $5::jsonb
        FROM postbro_social.clients AS c
        WHERE c.id=$1 AND c.persona_revision=$2 AND c.status='PERSONA_REVIEW'
          AND c.persona_draft->>'source'='EXTERNAL_ENGINE'
        ON CONFLICT (client_id, persona_revision) DO NOTHING
        RETURNING id, client_id AS "clientId",
          persona_revision AS "personaRevision", requested_by AS "requestedBy",
          decision, suggested_changes AS "suggestedChanges", created_at AS "createdAt"`,
      [
        clientId, review.expectedRevision, userId, review.decision,
        review.suggestedChanges ? JSON.stringify(review.suggestedChanges) : null
      ]
    );
    return result.rows[0] ?? null;
  });
}
