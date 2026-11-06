-- Internal credential recovery only. Raw bearer tokens never enter this table.
-- Existing accounts, sessions, events and clinical histories are unchanged on
-- upgrade. Delivery, HTTP rate limits and physical retention remain separate.
CREATE TABLE public.cb_auth_password_resets (
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  user_id text NOT NULL REFERENCES public.cb_auth_accounts(user_id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  revoked_at timestamptz,
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '900 seconds'),
  CHECK (consumed_at IS NULL OR revoked_at IS NULL),
  CHECK (consumed_at IS NULL OR consumed_at >= created_at),
  CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);
CREATE UNIQUE INDEX cb_auth_password_resets_pending_user_idx
  ON public.cb_auth_password_resets(user_id)
  WHERE consumed_at IS NULL AND revoked_at IS NULL;
CREATE INDEX cb_auth_password_resets_user_created_idx
  ON public.cb_auth_password_resets(user_id,created_at DESC);
REVOKE ALL ON public.cb_auth_password_resets FROM PUBLIC;

-- Invoker-only lifecycle validation. Identity/lifetime cannot be rewritten,
-- consumed/revoked credentials cannot be reopened, and terminal timestamps
-- come from the database rather than a supplied date. No deletion/retention
-- policy is invented here; ordinary runtime grants do not include DELETE.
CREATE FUNCTION public.cb_password_reset_guard() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
  SET search_path = pg_catalog,pg_temp AS $$
DECLARE current_time_value timestamptz := clock_timestamp();
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.consumed_at IS NOT NULL OR NEW.revoked_at IS NOT NULL THEN
      RAISE EXCEPTION 'password recovery state is unavailable' USING ERRCODE = '23514';
    END IF;
    NEW.created_at := current_time_value;
    IF NEW.expires_at IS NULL OR NEW.expires_at <= current_time_value
        OR NEW.expires_at > current_time_value + interval '900 seconds' THEN
      RAISE EXCEPTION 'password recovery lifetime is unavailable' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.token_hash IS DISTINCT FROM OLD.token_hash OR NEW.user_id IS DISTINCT FROM OLD.user_id
      OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
    RAISE EXCEPTION 'password recovery identity is retained' USING ERRCODE = '23514';
  END IF;
  IF OLD.consumed_at IS NOT NULL OR OLD.revoked_at IS NOT NULL THEN
    IF NEW.consumed_at IS DISTINCT FROM OLD.consumed_at OR NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
      RAISE EXCEPTION 'password recovery state is retained' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.consumed_at IS NOT NULL AND NEW.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'password recovery state is unavailable' USING ERRCODE = '23514';
  END IF;
  IF NEW.consumed_at IS NOT NULL THEN
    IF OLD.expires_at <= current_time_value THEN
      RAISE EXCEPTION 'password recovery has expired'
        USING ERRCODE = '23514', CONSTRAINT = 'cb_password_reset_expired';
    END IF;
    NEW.consumed_at := current_time_value;
  ELSIF NEW.revoked_at IS NOT NULL THEN
    NEW.revoked_at := current_time_value;
  END IF;
  RETURN NEW;
END; $$;
REVOKE ALL ON FUNCTION public.cb_password_reset_guard() FROM PUBLIC;
CREATE TRIGGER cb_password_reset_guard BEFORE INSERT OR UPDATE ON public.cb_auth_password_resets
  FOR EACH ROW EXECUTE FUNCTION public.cb_password_reset_guard();

-- Every credential replacement or actual account deactivation closes pending
-- recovery capabilities, including paths other than the recovery service.
-- Services lock account -> user -> token; this helper changes only tokens for
-- the already-locked subject. It grants no access or activation authority.
CREATE FUNCTION public.cb_password_reset_invalidate() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
  SET search_path = pg_catalog,pg_temp AS $$
DECLARE subject_user_id text;
BEGIN
  IF TG_TABLE_NAME = 'cb_auth_accounts' THEN
    IF NEW.password_hash IS NOT DISTINCT FROM OLD.password_hash AND NEW.email IS NOT DISTINCT FROM OLD.email THEN
      RETURN NEW;
    END IF;
    subject_user_id := NEW.user_id;
  ELSIF TG_TABLE_NAME = 'cb_users' THEN
    IF NOT OLD.active OR NEW.active THEN RETURN NEW; END IF;
    subject_user_id := NEW.id;
  ELSE
    RAISE EXCEPTION 'password recovery subject is unavailable' USING ERRCODE = '23514';
  END IF;
  UPDATE public.cb_auth_password_resets SET revoked_at = clock_timestamp()
    WHERE user_id = subject_user_id AND consumed_at IS NULL AND revoked_at IS NULL;
  RETURN NEW;
END; $$;
REVOKE ALL ON FUNCTION public.cb_password_reset_invalidate() FROM PUBLIC;
CREATE TRIGGER cb_password_reset_credential_invalidate AFTER UPDATE OF password_hash,email ON public.cb_auth_accounts
  FOR EACH ROW EXECUTE FUNCTION public.cb_password_reset_invalidate();
CREATE TRIGGER cb_password_reset_user_invalidate AFTER UPDATE OF active ON public.cb_users
  FOR EACH ROW EXECUTE FUNCTION public.cb_password_reset_invalidate();

-- A restored database may not issue, consume, modify or truncate recovery
-- credentials after its terminal quarantine receipt has been installed.
CREATE TRIGGER cb_000_recovery_guard BEFORE INSERT OR UPDATE OR DELETE ON public.cb_auth_password_resets
  FOR EACH ROW EXECUTE FUNCTION public.cb_recovery_write_guard();
CREATE TRIGGER cb_recovery_truncate_guard BEFORE TRUNCATE ON public.cb_auth_password_resets
  FOR EACH STATEMENT EXECUTE FUNCTION public.cb_recovery_write_guard();

-- Recovery may legitimately close zero sessions. Existing password-change and
-- session-revocation events continue to require a positive revoked count.
ALTER TABLE public.cb_account_security_events
  DROP CONSTRAINT cb_account_security_events_action_check,
  DROP CONSTRAINT cb_account_security_events_revoked_sessions_check,
  ADD CONSTRAINT cb_account_security_events_action_check
    CHECK (action IN ('password.changed','sessions.revoked','password.recovered')),
  ADD CONSTRAINT cb_account_security_events_revoked_sessions_check
    CHECK (revoked_sessions >= 0 AND (action = 'password.recovered' OR revoked_sessions > 0));
