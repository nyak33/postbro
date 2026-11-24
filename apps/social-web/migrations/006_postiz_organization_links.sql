-- PB-SOCIAL-006D: Postiz organization ↔ PostBro client binding (source only).
-- DO NOT run against the live postbro-core project until a separate reviewed
-- migration is approved. No customer-facing API may write this table.
-- An admin must verify the specific Postiz org via authenticated GET /public/v1/me
-- before setting VERIFIED; this table alone never proves ownership or permission.
CREATE TABLE postbro_social.postiz_organization_links (
  client_id uuid PRIMARY KEY REFERENCES postbro_social.clients(id) ON DELETE RESTRICT,
  postiz_instance_origin text NOT NULL CHECK (
    postiz_instance_origin ~ '^https://[a-z0-9][a-z0-9.-]{1,220}$'
    AND postiz_instance_origin NOT LIKE '%..%'
  ),
  postiz_organization_id text NOT NULL CHECK (
    postiz_organization_id ~ '^[a-zA-Z0-9_-]{3,160}$'
  ),
  postiz_customer_group_id text NOT NULL CHECK (
    postiz_customer_group_id ~ '^[a-zA-Z0-9_-]{3,160}$'
  ),
  state text NOT NULL DEFAULT 'PENDING'
    CHECK (state IN ('PENDING', 'VERIFIED', 'REVOKED')),
  verification_method text CHECK (
    verification_method IS NULL
    OR verification_method IN ('OPERATOR_POSTIZ_ME_AND_MEMBERSHIP')
  ),
  verified_at timestamptz,
  verified_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT social_postiz_org_verification_consistency CHECK (
    (state='VERIFIED'
      AND verification_method='OPERATOR_POSTIZ_ME_AND_MEMBERSHIP'
      AND verified_at IS NOT NULL AND verified_by IS NOT NULL)
    OR (state IN ('PENDING','REVOKED')
      AND verified_at IS NULL)
  ),
  CONSTRAINT social_postiz_org_unique UNIQUE (postiz_instance_origin, postiz_organization_id),
  CONSTRAINT social_postiz_group_unique UNIQUE (postiz_instance_origin, postiz_customer_group_id)
);

-- Never expose Postiz connection metadata or operator link state through
-- PostgREST / customer sessions. Trusted provisioning only.
ALTER TABLE postbro_social.postiz_organization_links ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON postbro_social.postiz_organization_links FROM PUBLIC, anon, authenticated;
