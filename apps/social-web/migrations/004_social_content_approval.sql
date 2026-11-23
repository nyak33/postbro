-- PB-SOCIAL-005A: client content reviews. NOT for root production migrations.
-- Apply only after 001, 002, 003 in disposable PG17 rehearsal.
CREATE TABLE postbro_social.content_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES postbro_social.clients(id) ON DELETE RESTRICT,
  persona_revision integer NOT NULL CHECK (persona_revision >= 1),
  content_revision integer NOT NULL DEFAULT 1 CHECK (content_revision >= 1),
  surface text NOT NULL CHECK (surface IN ('THREADS', 'FB_IG')),
  body text NOT NULL CHECK (length(trim(body)) BETWEEN 1 AND 3000),
  scheduled_for timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'IN_REVIEW'
    CHECK (status IN ('IN_REVIEW','APPROVED','CHANGES_REQUESTED','CANCELLED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX social_content_drafts_client_schedule
  ON postbro_social.content_drafts(client_id, scheduled_for, id);

CREATE TABLE postbro_social.content_review_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  draft_id uuid NOT NULL REFERENCES postbro_social.content_drafts(id) ON DELETE RESTRICT,
  content_revision integer NOT NULL CHECK (content_revision >= 1),
  requested_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  decision text NOT NULL CHECK (decision IN ('APPROVE', 'REQUEST_CHANGES')),
  comment text CHECK (comment IS NULL OR length(trim(comment)) BETWEEN 1 AND 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (draft_id, content_revision),
  CONSTRAINT content_change_comment_required CHECK (
    decision='APPROVE' AND comment IS NULL
    OR decision='REQUEST_CHANGES' AND comment IS NOT NULL
  )
);

CREATE TABLE postbro_social.content_review_actions (
  review_request_id uuid PRIMARY KEY
    REFERENCES postbro_social.content_review_requests(id) ON DELETE RESTRICT,
  draft_id uuid NOT NULL REFERENCES postbro_social.content_drafts(id) ON DELETE RESTRICT,
  content_revision integer NOT NULL CHECK (content_revision >= 1),
  result text NOT NULL CHECK (result IN ('APPROVED','CHANGES_REQUESTED','STALE')),
  processed_at timestamptz NOT NULL DEFAULT now()
);

-- Serialize quota checks for the small five-client pilot across transactions.
-- MYT calendar days, FB+IG crossposted as ONE unique content piece.
CREATE FUNCTION postbro_social.enforce_content_quota() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  p text;
  active_status text;
  approved_rev integer;
  daily_limit integer;
  weekly_limit integer;
  day_used integer;
  week_used integer;
  local_day date;
  local_week timestamp;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(72742036);
  SELECT plan, status, persona_approved_revision
    INTO p, active_status, approved_rev
    FROM postbro_social.clients WHERE id=NEW.client_id;

  IF p IS NULL THEN
    RAISE EXCEPTION 'unknown content client' USING ERRCODE='23514';
  END IF;
  IF NEW.status = 'CANCELLED' THEN
    NEW.updated_at := now();
    RETURN NEW;
  END IF;
  IF TG_OP='INSERT' OR NEW.status='APPROVED' THEN
    IF active_status <> 'READY' OR approved_rev IS DISTINCT FROM NEW.persona_revision THEN
      RAISE EXCEPTION 'approved active persona required for content'
        USING ERRCODE='23514';
    END IF;
  END IF;

  daily_limit := CASE WHEN NEW.surface='FB_IG'
    THEN CASE WHEN p='STARTER' THEN 2 ELSE 3 END
    ELSE CASE WHEN p='STARTER' THEN 3 ELSE 5 END END;
  weekly_limit := CASE WHEN p='STARTER' THEN 35 ELSE 56 END;
  local_day := (NEW.scheduled_for AT TIME ZONE 'Asia/Kuala_Lumpur')::date;
  local_week := pg_catalog.date_trunc('week', NEW.scheduled_for AT TIME ZONE 'Asia/Kuala_Lumpur');

  SELECT count(*) INTO day_used
    FROM postbro_social.content_drafts AS d
    WHERE d.client_id=NEW.client_id AND d.surface=NEW.surface
      AND d.status <> 'CANCELLED' AND d.id<>NEW.id
      AND (d.scheduled_for AT TIME ZONE 'Asia/Kuala_Lumpur')::date=local_day;
  SELECT count(*) INTO week_used
    FROM postbro_social.content_drafts AS d
    WHERE d.client_id=NEW.client_id AND d.status <> 'CANCELLED' AND d.id<>NEW.id
      AND pg_catalog.date_trunc('week',d.scheduled_for AT TIME ZONE 'Asia/Kuala_Lumpur')=local_week;
  IF day_used >= daily_limit OR week_used >= weekly_limit THEN
    RAISE EXCEPTION 'content package quota reached' USING ERRCODE='23514';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER social_content_quota
BEFORE INSERT OR UPDATE OF client_id, scheduled_for, surface, status
ON postbro_social.content_drafts
FOR EACH ROW EXECUTE FUNCTION postbro_social.enforce_content_quota();

ALTER TABLE postbro_social.content_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE postbro_social.content_review_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE postbro_social.content_review_actions ENABLE ROW LEVEL SECURITY;

CREATE POLICY social_content_member_read ON postbro_social.content_drafts
FOR SELECT TO authenticated USING (
  EXISTS (SELECT 1 FROM postbro_social.clients AS c
    JOIN postbro_social.memberships AS m ON m.organization_id=c.organization_id
    WHERE c.id=content_drafts.client_id AND m.user_id=(SELECT auth.uid()))
);

CREATE POLICY social_content_review_member_read ON postbro_social.content_review_requests
FOR SELECT TO authenticated USING (
  EXISTS (SELECT 1 FROM postbro_social.content_drafts AS d
    JOIN postbro_social.clients AS c ON c.id=d.client_id
    JOIN postbro_social.memberships AS m ON m.organization_id=c.organization_id
    WHERE d.id=content_review_requests.draft_id
      AND m.user_id=(SELECT auth.uid()))
);

CREATE POLICY social_content_review_editor_insert ON postbro_social.content_review_requests
FOR INSERT TO authenticated WITH CHECK (
  requested_by=(SELECT auth.uid())
  AND EXISTS (SELECT 1 FROM postbro_social.content_drafts AS d
    JOIN postbro_social.clients AS c ON c.id=d.client_id
    JOIN postbro_social.memberships AS m ON m.organization_id=c.organization_id
    WHERE d.id=content_review_requests.draft_id
      AND d.content_revision=content_review_requests.content_revision
      AND d.status='IN_REVIEW'
      AND c.status='READY'
      AND c.persona_approved_revision=d.persona_revision
      AND m.user_id=(SELECT auth.uid())
      AND m.role IN ('owner','editor'))
);

REVOKE ALL ON postbro_social.content_drafts FROM PUBLIC, anon, authenticated;
REVOKE ALL ON postbro_social.content_review_requests FROM PUBLIC, anon, authenticated;
REVOKE ALL ON postbro_social.content_review_actions FROM PUBLIC, anon, authenticated;
GRANT SELECT ON postbro_social.content_drafts TO authenticated;
GRANT SELECT, INSERT ON postbro_social.content_review_requests TO authenticated;
REVOKE ALL ON FUNCTION postbro_social.enforce_content_quota() FROM PUBLIC;
