-- NOT an automatic migration. Do not run against E/operating databases yet.
-- Requires runtime/backup privilege plans, recovery manifests, retention and
-- native PostgreSQL concurrency review before becoming a numbered migration.
CREATE TABLE public.cb_auth_email_logins (
  id_hash text PRIMARY KEY CHECK (id_hash ~ '^[a-f0-9]{64}$'),
  user_id text NOT NULL REFERENCES public.cb_auth_accounts(user_id) ON DELETE CASCADE,
  binding_hash text NOT NULL CHECK (binding_hash ~ '^[a-f0-9]{64}$'),
  code_hash text NOT NULL CHECK (code_hash ~ '^[a-f0-9]{64}$'),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  revoked_at timestamptz,
  session_hash text CHECK (session_hash ~ '^[a-f0-9]{64}$'),
  CHECK (expires_at > created_at AND expires_at <= created_at+interval '600 seconds'),
  CHECK ((consumed_at IS NULL) = (session_hash IS NULL)),
  CHECK (consumed_at IS NULL OR revoked_at IS NULL)
);
CREATE UNIQUE INDEX cb_email_login_pending_user ON public.cb_auth_email_logins(user_id)
  WHERE consumed_at IS NULL AND revoked_at IS NULL;
CREATE INDEX cb_email_login_user_created ON public.cb_auth_email_logins(user_id,created_at DESC);
REVOKE ALL ON public.cb_auth_email_logins FROM PUBLIC;

CREATE FUNCTION public.cb_email_login_guard() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
  SET search_path=pg_catalog,pg_temp AS $$
DECLARE moment timestamptz := clock_timestamp();
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.attempts<>0 OR NEW.consumed_at IS NOT NULL OR NEW.revoked_at IS NOT NULL OR NEW.session_hash IS NOT NULL
      OR NEW.expires_at<=moment OR NEW.expires_at>moment+interval '600 seconds' THEN
      RAISE EXCEPTION 'email login state unavailable' USING ERRCODE='23514';
    END IF;
    NEW.created_at:=moment;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW)-ARRAY['attempts','consumed_at','revoked_at','session_hash']) IS DISTINCT FROM
     (to_jsonb(OLD)-ARRAY['attempts','consumed_at','revoked_at','session_hash']) THEN
    RAISE EXCEPTION 'email login identity retained' USING ERRCODE='23514';
  END IF;
  IF OLD.consumed_at IS NOT NULL OR OLD.revoked_at IS NOT NULL THEN
    IF NEW IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION 'email login terminal state retained' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.attempts<>OLD.attempts AND (NEW.attempts<>OLD.attempts+1 OR NEW.attempts>5 OR
      NEW.consumed_at IS NOT NULL OR NEW.revoked_at IS NOT NULL OR NEW.session_hash IS NOT NULL) THEN
    RAISE EXCEPTION 'email login attempt state unavailable' USING ERRCODE='23514';
  END IF;
  IF NEW.consumed_at IS NOT NULL THEN
    IF OLD.expires_at<=moment OR OLD.attempts>=5 OR NEW.revoked_at IS NOT NULL THEN
      RAISE EXCEPTION 'email login proof unavailable' USING ERRCODE='23514',CONSTRAINT='cb_email_login_expired';
    END IF;
    NEW.consumed_at:=moment;
  ELSIF NEW.revoked_at IS NOT NULL THEN
    NEW.revoked_at:=moment;
  END IF;
  RETURN NEW;
END; $$;
REVOKE ALL ON FUNCTION public.cb_email_login_guard() FROM PUBLIC;
CREATE TRIGGER cb_email_login_guard BEFORE INSERT OR UPDATE ON public.cb_auth_email_logins
  FOR EACH ROW EXECUTE FUNCTION public.cb_email_login_guard();

CREATE FUNCTION public.cb_email_login_invalidate() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
  SET search_path=pg_catalog,pg_temp AS $$
DECLARE subject_id text;
BEGIN
  IF TG_TABLE_NAME='cb_auth_accounts' THEN
    IF NEW.password_hash IS NOT DISTINCT FROM OLD.password_hash AND NEW.email IS NOT DISTINCT FROM OLD.email THEN RETURN NEW; END IF;
    subject_id:=NEW.user_id;
  ELSE
    IF NOT OLD.active OR NEW.active THEN RETURN NEW; END IF;
    subject_id:=NEW.id;
  END IF;
  UPDATE public.cb_auth_email_logins SET revoked_at=clock_timestamp()
    WHERE user_id=subject_id AND consumed_at IS NULL AND revoked_at IS NULL;
  RETURN NEW;
END; $$;
REVOKE ALL ON FUNCTION public.cb_email_login_invalidate() FROM PUBLIC;
CREATE TRIGGER cb_email_login_credentials AFTER UPDATE OF password_hash,email ON public.cb_auth_accounts
  FOR EACH ROW EXECUTE FUNCTION public.cb_email_login_invalidate();
CREATE TRIGGER cb_email_login_user AFTER UPDATE OF active ON public.cb_users
  FOR EACH ROW EXECUTE FUNCTION public.cb_email_login_invalidate();
CREATE TRIGGER cb_000_recovery_guard BEFORE INSERT OR UPDATE OR DELETE ON public.cb_auth_email_logins
  FOR EACH ROW EXECUTE FUNCTION public.cb_recovery_write_guard();
CREATE TRIGGER cb_recovery_truncate_guard BEFORE TRUNCATE ON public.cb_auth_email_logins
  FOR EACH STATEMENT EXECUTE FUNCTION public.cb_recovery_write_guard();
