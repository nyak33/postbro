-- PB-SOCIAL-003A: standalone social domain foundation.
-- NOT part of root db/migrations: must not be auto-applied to live PostBro.
-- Requires Supabase Auth (auth.users and auth.uid()) and provisioned roles.
-- Roll out only after separate explicit review and authorized migration.
CREATE SCHEMA IF NOT EXISTS postbro_social;

REVOKE ALL ON SCHEMA postbro_social FROM PUBLIC;
REVOKE ALL ON SCHEMA postbro_social FROM anon;
REVOKE ALL ON SCHEMA postbro_social FROM authenticated;

CREATE TABLE postbro_social.organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name text NOT NULL CHECK (length(trim(display_name)) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE postbro_social.memberships (
  organization_id uuid NOT NULL REFERENCES postbro_social.organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, user_id)
);
CREATE INDEX social_memberships_user ON postbro_social.memberships (user_id, organization_id);

CREATE TABLE postbro_social.clients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES postbro_social.organizations(id) ON DELETE RESTRICT,
  plan text NOT NULL CHECK (plan IN ('STARTER', 'GROWTH')),
  business_name text NOT NULL CHECK (length(trim(business_name)) BETWEEN 1 AND 200),
  niche text NOT NULL DEFAULT '',
  audience text NOT NULL DEFAULT '',
  language text NOT NULL DEFAULT '',
  tone text NOT NULL DEFAULT '',
  restrictions text NOT NULL DEFAULT '',
  sample_posts text NOT NULL DEFAULT '',
  history_consent boolean NOT NULL DEFAULT false,
  history_decision_recorded boolean NOT NULL DEFAULT false,
  persona_revision integer NOT NULL DEFAULT 0 CHECK (persona_revision >= 0),
  persona_draft jsonb,
  persona_approved_revision integer CHECK (persona_approved_revision IS NULL OR persona_approved_revision >= 1),
  persona_approved_at timestamptz,
  status text NOT NULL DEFAULT 'ONBOARDING' CHECK (status IN ('ONBOARDING', 'PERSONA_REVIEW', 'READY')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT persona_approval_consistent CHECK (
    (persona_approved_revision IS NULL AND persona_approved_at IS NULL)
    OR (persona_approved_revision = persona_revision AND persona_approved_at IS NOT NULL AND status = 'READY')
  )
);
CREATE INDEX social_clients_org ON postbro_social.clients (organization_id, id);

-- All inserts are administrator provisioned. Serialize the global pilot cap
-- even when two onboarding requests race each other.
CREATE FUNCTION postbro_social.limit_pilot_clients() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(72742033);
  IF (SELECT count(*) FROM postbro_social.clients) >= 5 THEN
    RAISE EXCEPTION 'five-client pilot capacity reached' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER social_limit_client_insert BEFORE INSERT ON postbro_social.clients
FOR EACH ROW EXECUTE FUNCTION postbro_social.limit_pilot_clients();

-- Brand edits and history decisions must invalidate any previously approved
-- persona, including a stale approval attempt using an old revision.
-- Server code may only approve a new revision through a separately reviewed flow.
CREATE FUNCTION postbro_social.invalidate_persona_on_change() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  brand_changed boolean;
  history_changed boolean;
BEGIN
  brand_changed := ROW(OLD.business_name, OLD.niche, OLD.audience, OLD.language,
    OLD.tone, OLD.restrictions, OLD.sample_posts)
    IS DISTINCT FROM
    ROW(NEW.business_name, NEW.niche, NEW.audience, NEW.language,
    NEW.tone, NEW.restrictions, NEW.sample_posts);

  IF brand_changed THEN
    NEW.history_consent := false;
    NEW.history_decision_recorded := false;
  END IF;

  history_changed := OLD.history_consent IS DISTINCT FROM NEW.history_consent
    OR OLD.history_decision_recorded IS DISTINCT FROM NEW.history_decision_recorded;

  IF brand_changed OR history_changed THEN
    NEW.persona_revision := OLD.persona_revision + 1;
    NEW.persona_draft := NULL;
    NEW.persona_approved_revision := NULL;
    NEW.persona_approved_at := NULL;
    NEW.status := 'ONBOARDING';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER social_invalidate_persona BEFORE UPDATE ON postbro_social.clients
FOR EACH ROW EXECUTE FUNCTION postbro_social.invalidate_persona_on_change();

ALTER TABLE postbro_social.organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE postbro_social.memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE postbro_social.clients ENABLE ROW LEVEL SECURITY;

-- Memberships: users see only their own row. No authenticated writes.
CREATE POLICY social_membership_self ON postbro_social.memberships
FOR SELECT TO authenticated USING (user_id = (SELECT auth.uid()));

-- Organizations: visible if the signed-in identity is a member.
CREATE POLICY social_organization_member ON postbro_social.organizations
FOR SELECT TO authenticated USING (
  EXISTS (
    SELECT 1 FROM postbro_social.memberships AS m
    WHERE m.organization_id = id AND m.user_id = (SELECT auth.uid())
  )
);

-- Clients: all member roles may read, but only owners/editors may modify
-- non-privileged brand/consent columns.
CREATE POLICY social_client_member_read ON postbro_social.clients
FOR SELECT TO authenticated USING (
  EXISTS (
    SELECT 1 FROM postbro_social.memberships AS m
    WHERE m.organization_id = clients.organization_id
      AND m.user_id = (SELECT auth.uid())
  )
);

CREATE POLICY social_client_editor_update ON postbro_social.clients
FOR UPDATE TO authenticated USING (
  EXISTS (
    SELECT 1 FROM postbro_social.memberships AS m
    WHERE m.organization_id = clients.organization_id
      AND m.user_id = (SELECT auth.uid())
      AND m.role IN ('owner', 'editor')
  )
) WITH CHECK (
  EXISTS (
    SELECT 1 FROM postbro_social.memberships AS m
    WHERE m.organization_id = clients.organization_id
      AND m.user_id = (SELECT auth.uid())
      AND m.role IN ('owner', 'editor')
  )
);

-- Only authenticated read and brand/consent writes. No INSERT, DELETE,
-- membership writes, plan changes or persona-status/approval updates.
-- Do NOT grant schema access to 'anon'.
GRANT USAGE ON SCHEMA postbro_social TO authenticated;
GRANT SELECT ON postbro_social.organizations TO authenticated;
GRANT SELECT ON postbro_social.memberships TO authenticated;
GRANT SELECT ON postbro_social.clients TO authenticated;
GRANT UPDATE (business_name, niche, audience, language, tone,
  restrictions, sample_posts, history_consent, history_decision_recorded)
ON postbro_social.clients TO authenticated;

-- Function invocation remains internal to triggers.
REVOKE ALL ON FUNCTION postbro_social.limit_pilot_clients() FROM PUBLIC;
REVOKE ALL ON FUNCTION postbro_social.invalidate_persona_on_change() FROM PUBLIC;
