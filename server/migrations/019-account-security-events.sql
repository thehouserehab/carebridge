-- Additive, empty on upgrade. Historical credential actions are not invented.
-- Subject IDs are pseudonymous identifiers, not anonymous data. No email,
-- password/hash, session/token, IP, user agent, child or clinical content.
-- No FK to an account/user: deleting an identity must not erase its events or
-- prevent unrelated identity lifecycle work. Trusted services establish the
-- actual subject before writing; this is not a public event-ingestion API.
CREATE TABLE public.cb_account_security_events (
  id uuid PRIMARY KEY CHECK (id::text ~ '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'),
  user_id text NOT NULL CHECK (user_id ~ '^[a-zA-Z0-9_-]{1,100}$'),
  action text NOT NULL CHECK (action IN ('password.changed','sessions.revoked')),
  revoked_sessions integer NOT NULL CHECK (revoked_sessions > 0),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX cb_account_security_events_subject_time_idx
  ON public.cb_account_security_events(user_id,occurred_at DESC,id);
REVOKE ALL ON public.cb_account_security_events FROM PUBLIC;

-- Invoker trigger only, no privileged reads, dynamic SQL or role escalation.
-- Normal application grants are INSERT-only. A DB owner can still disable a
-- trigger/alter schema: this is not an external or cryptographic audit ledger.
CREATE FUNCTION public.cb_account_security_event_guard() RETURNS trigger LANGUAGE plpgsql
  SET search_path = pg_catalog,pg_temp AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'account security events are retained' USING ERRCODE = '23514';
  END IF;
  NEW.occurred_at := clock_timestamp();
  RETURN NEW;
END; $$;
REVOKE ALL ON FUNCTION public.cb_account_security_event_guard() FROM PUBLIC;
CREATE TRIGGER cb_account_security_event_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.cb_account_security_events
  FOR EACH ROW EXECUTE FUNCTION public.cb_account_security_event_guard();
CREATE TRIGGER cb_account_security_event_truncate_guard
  BEFORE TRUNCATE ON public.cb_account_security_events
  FOR EACH STATEMENT EXECUTE FUNCTION public.cb_account_security_event_guard();
