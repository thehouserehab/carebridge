-- Inert on ordinary databases. Only an explicit operator transaction inserts
-- this terminal quarantine receipt into an already verified restore target.
-- No release, automatic restore, role grant, credential reset or worker start.
CREATE TABLE public.cb_recovery_quarantine (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  operation_id uuid NOT NULL UNIQUE,
  bundle_id uuid NOT NULL,
  source_name text NOT NULL,
  source_oid oid NOT NULL,
  source_owner_oid oid NOT NULL,
  target_name text NOT NULL,
  target_oid oid NOT NULL,
  owner_oid oid NOT NULL,
  disabled_users integer NOT NULL CHECK (disabled_users >= 0),
  revoked_sessions integer NOT NULL CHECK (revoked_sessions >= 0),
  revoked_invitations integer NOT NULL CHECK (revoked_invitations >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (operation_id::text ~ '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'),
  CHECK (bundle_id::text ~ '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$')
);
REVOKE ALL ON public.cb_recovery_quarantine FROM PUBLIC;

CREATE FUNCTION public.cb_recovery_receipt_guard() RETURNS trigger LANGUAGE plpgsql
  SET search_path = pg_catalog,pg_temp AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'recovery quarantine is retained' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_database d
      JOIN pg_catalog.pg_roles r ON r.rolname = current_user
      WHERE d.datname = current_database() AND NOT d.datistemplate
        AND d.datname = NEW.target_name AND d.oid = NEW.target_oid
        AND d.datdba = NEW.owner_oid AND d.datdba = r.oid
        AND current_user = session_user) THEN
    RAISE EXCEPTION 'recovery target is unavailable' USING ERRCODE = '42501';
  END IF;
  IF NEW.source_oid = NEW.target_oid OR NEW.source_name = NEW.target_name OR NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_database d WHERE d.datname = NEW.source_name AND d.oid = NEW.source_oid
        AND d.datdba = NEW.source_owner_oid AND NOT d.datistemplate) THEN
    RAISE EXCEPTION 'recovery source is unavailable' USING ERRCODE = '42501';
  END IF;
  NEW.created_at := clock_timestamp();
  RETURN NEW;
END; $$;
REVOKE ALL ON FUNCTION public.cb_recovery_receipt_guard() FROM PUBLIC;
CREATE TRIGGER cb_recovery_receipt_guard BEFORE INSERT OR UPDATE OR DELETE ON public.cb_recovery_quarantine
  FOR EACH ROW EXECUTE FUNCTION public.cb_recovery_receipt_guard();
CREATE TRIGGER cb_recovery_receipt_truncate_guard BEFORE TRUNCATE ON public.cb_recovery_quarantine
  FOR EACH STATEMENT EXECUTE FUNCTION public.cb_recovery_receipt_guard();

-- Trigger-only privilege elevation reads ONE private gate, never user rows or
-- caller SQL. Fully qualified relation; no public/temp search-path shadowing.
CREATE FUNCTION public.cb_recovery_write_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog,pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.cb_recovery_quarantine) THEN
    IF TG_TABLE_NAME <> 'cb_users' OR TG_OP NOT IN ('INSERT','UPDATE') THEN
      RAISE EXCEPTION 'restored service remains quarantined' USING ERRCODE = '23514';
    END IF;
    IF NEW.active THEN
      RAISE EXCEPTION 'restored service remains quarantined' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  IF TG_OP = 'TRUNCATE' THEN RETURN NULL; END IF;
  RETURN NEW;
END; $$;
REVOKE ALL ON FUNCTION public.cb_recovery_write_guard() FROM PUBLIC;

DO $$
DECLARE relation text;
BEGIN
  FOREACH relation IN ARRAY ARRAY['cb_users','cb_auth_accounts','cb_auth_sessions','cb_auth_invitations',
      'cb_decoder_engines','cb_decoder_jobs','cb_media_uploads','cb_media_objects',
      'cb_media_preparations','cb_media_work_queue'] LOOP
    EXECUTE format('CREATE TRIGGER cb_000_recovery_guard BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.cb_recovery_write_guard()',relation);
    EXECUTE format('CREATE TRIGGER cb_recovery_truncate_guard BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.cb_recovery_write_guard()',relation);
  END LOOP;
END; $$;
