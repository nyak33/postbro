-- PB-SOCIAL-004A: immutable client review intent; no persona activation.
-- APPLY ONLY AFTER 001_social_foundation.sql, with a reviewed hosted migration
-- approval. This file is NOT included in the live PostBro migration runner.
-- Does not alter any existing 'postbro' or 'auth' object.

CREATE TABLE postbro_social.persona_review_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES postbro_social.clients(id) ON DELETE RESTRICT,
  persona_revision integer NOT NULL CHECK (persona_revision >= 1),
  requested_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  decision text NOT NULL CHECK (decision IN ('APPROVE', 'REQUEST_CHANGES')),
  suggested_changes jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT persona_review_changes_shape CHECK (
    (decision = 'APPROVE' AND suggested_changes IS NULL) OR
    (decision = 'REQUEST_CHANGES'
      AND suggested_changes IS NOT NULL
      AND jsonb_typeof(suggested_changes) = 'object'
      AND suggested_changes ?& ARRAY['summary', 'writingStyle', 'contentPillars']
      AND (suggested_changes - 'summary' - 'writingStyle' - 'contentPillars') = '{}'::jsonb
      AND jsonb_typeof(suggested_changes->'summary') = 'string'
      AND jsonb_typeof(suggested_changes->'writingStyle') = 'string'
      AND jsonb_typeof(suggested_changes->'contentPillars') = 'string'
      AND length(trim(suggested_changes->>'summary')) BETWEEN 1 AND 1000
      AND length(trim(suggested_changes->>'writingStyle')) BETWEEN 1 AND 1000
      AND length(trim(suggested_changes->>'contentPillars')) BETWEEN 1 AND 1000)
  ),
  UNIQUE (client_id, persona_revision)
);

CREATE INDEX persona_review_requests_by_client
ON postbro_social.persona_review_requests (client_id, created_at DESC);

ALTER TABLE postbro_social.persona_review_requests ENABLE ROW LEVEL SECURITY;

-- Every member can read their own organization's review audit history.
-- The subqueries inherit RLS from clients/memberships.
CREATE POLICY social_persona_review_member_read ON postbro_social.persona_review_requests
FOR SELECT TO authenticated USING (
  EXISTS (
    SELECT 1
    FROM postbro_social.clients AS c
    JOIN postbro_social.memberships AS m ON m.organization_id = c.organization_id
    WHERE c.id = client_id
      AND m.user_id = (SELECT auth.uid())
  )
);

-- Owner/editor may file only ONE immutable intent for the CURRENT externally
-- generated revision. Mock/local template personas cannot be approved.
-- This NEVER writes the client's activation/approval columns.
CREATE POLICY social_persona_review_editor_submit ON postbro_social.persona_review_requests
FOR INSERT TO authenticated WITH CHECK (
  requested_by = (SELECT auth.uid())
  AND EXISTS (
    SELECT 1
    FROM postbro_social.clients AS c
    JOIN postbro_social.memberships AS m ON m.organization_id = c.organization_id
    WHERE c.id = client_id
      AND m.user_id = (SELECT auth.uid())
      AND m.role IN ('owner', 'editor')
      AND c.status = 'PERSONA_REVIEW'
      AND c.persona_revision = persona_revision
      AND c.persona_draft IS NOT NULL
      AND c.persona_draft->>'source' = 'EXTERNAL_ENGINE'
  )
);

-- Immutable submissions: no UPDATE/DELETE permission or RLS policies.
REVOKE ALL ON postbro_social.persona_review_requests FROM anon;
REVOKE ALL ON postbro_social.persona_review_requests FROM authenticated;
GRANT SELECT, INSERT ON postbro_social.persona_review_requests TO authenticated;
