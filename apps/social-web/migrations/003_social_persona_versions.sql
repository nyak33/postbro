-- PB-SOCIAL-004C: private engine snapshots + trusted review processing.
-- Isolated migration; NOT run by root PostBro migration runner.
-- Requires 001_social_foundation.sql and 002_social_persona_review_requests.sql.
CREATE TABLE postbro_social.persona_versions (
  client_id uuid NOT NULL REFERENCES postbro_social.clients(id) ON DELETE RESTRICT,
  revision integer NOT NULL CHECK (revision >= 1),
  source text NOT NULL DEFAULT 'EXTERNAL_ENGINE' CHECK (source = 'EXTERNAL_ENGINE'),
  engine_persona_id text NOT NULL CHECK (length(engine_persona_id) BETWEEN 12 AND 160),
  engine_version integer NOT NULL CHECK (engine_version >= 1),
  engine_record jsonb NOT NULL CHECK (
    jsonb_typeof(engine_record) = 'object'
    AND engine_record->>'schemaVersion' = '1.0'
  ),
  proposal jsonb NOT NULL CHECK (
    jsonb_typeof(proposal) = 'object'
    AND jsonb_typeof(proposal->'summary') = 'string'
    AND jsonb_typeof(proposal->'writingStyle') = 'string'
    AND jsonb_typeof(proposal->'contentPillars') = 'string'
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (client_id, revision)
);

CREATE TABLE postbro_social.persona_review_actions (
  review_request_id uuid PRIMARY KEY
    REFERENCES postbro_social.persona_review_requests(id) ON DELETE RESTRICT,
  client_id uuid NOT NULL REFERENCES postbro_social.clients(id) ON DELETE RESTRICT,
  persona_revision integer NOT NULL CHECK (persona_revision >= 1),
  result text NOT NULL CHECK (result IN ('ACTIVATED', 'REVISION_REQUIRED', 'STALE')),
  processed_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (client_id, persona_revision)
    REFERENCES postbro_social.persona_versions(client_id, revision)
    ON DELETE RESTRICT
);

CREATE INDEX persona_review_actions_client_idx
ON postbro_social.persona_review_actions (client_id, processed_at DESC);

-- No client-user grants. Owner-only workflows may operate these tables.
ALTER TABLE postbro_social.persona_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE postbro_social.persona_review_actions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON postbro_social.persona_versions FROM PUBLIC, anon, authenticated;
REVOKE ALL ON postbro_social.persona_review_actions FROM PUBLIC, anon, authenticated;
