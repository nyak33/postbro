-- PB-SOCIAL-005C: trusted-only, one-attempt Postiz draft dispatch ledger.
-- SOURCE ONLY: apply solely to a disposable Social PG17 rehearsal.
-- Never place in root db/migrations or run against hosted Supabase without approval.
CREATE TABLE postbro_social.postiz_draft_dispatches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  draft_id uuid NOT NULL UNIQUE REFERENCES postbro_social.content_drafts(id) ON DELETE RESTRICT,
  client_id uuid NOT NULL REFERENCES postbro_social.clients(id) ON DELETE RESTRICT,
  content_revision integer NOT NULL CHECK (content_revision >= 1),
  persona_revision integer NOT NULL CHECK (persona_revision >= 1),
  customer_group_id text NOT NULL CHECK (length(customer_group_id) BETWEEN 3 AND 160),
  payload_sha256 text NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  draft_payload jsonb NOT NULL CHECK (
    jsonb_typeof(draft_payload)='object' AND draft_payload->>'type'='draft'
  ),
  state text NOT NULL DEFAULT 'PREPARED'
    CHECK (state IN ('PREPARED','ATTEMPTED','CONFIRMED','NEEDS_RECONCILIATION','REJECTED')),
  provider_posts jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(provider_posts)='array'),
  prepared_at timestamptz NOT NULL DEFAULT now(),
  attempted_at timestamptz,
  completed_at timestamptz,
  CONSTRAINT social_postiz_state_timing CHECK (
    (state='PREPARED' AND attempted_at IS NULL AND completed_at IS NULL)
    OR (state='ATTEMPTED' AND attempted_at IS NOT NULL AND completed_at IS NULL)
    OR (state IN ('CONFIRMED','NEEDS_RECONCILIATION','REJECTED')
      AND attempted_at IS NOT NULL AND completed_at IS NOT NULL)
  ),
  CONSTRAINT social_postiz_confirmed_ids CHECK (
    (state='CONFIRMED' AND jsonb_array_length(provider_posts)>0)
    OR (state<>'CONFIRMED' AND jsonb_array_length(provider_posts)=0)
  )
);
CREATE INDEX social_postiz_dispatches_by_client
  ON postbro_social.postiz_draft_dispatches (client_id, prepared_at);

-- Untrusted client sessions cannot read content/payload or write dispatch state.
ALTER TABLE postbro_social.postiz_draft_dispatches ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON postbro_social.postiz_draft_dispatches FROM PUBLIC, anon, authenticated;
