-- Operator-only receipt. No email, password, token, name or clinical content.
-- The application runtime role must NOT receive INSERT permission here.
CREATE TABLE cb_center_bootstraps (
  operation_id uuid PRIMARY KEY,
  center_id text NOT NULL UNIQUE REFERENCES cb_centers(id),
  manager_user_id text NOT NULL REFERENCES cb_users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (center_id, manager_user_id) REFERENCES cb_memberships(center_id, user_id)
);
REVOKE ALL ON cb_center_bootstraps FROM PUBLIC;

CREATE FUNCTION cb_bootstrap_receipt_guard() RETURNS trigger LANGUAGE plpgsql
  SET search_path = pg_catalog,public,pg_temp AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'bootstrap receipts are immutable' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM cb_memberships m
    JOIN cb_users u ON u.id = m.user_id
    JOIN cb_auth_accounts a ON a.user_id = u.id
    WHERE m.center_id = NEW.center_id AND m.user_id = NEW.manager_user_id
      AND m.role = 'center' AND m.active AND u.active
  ) THEN
    RAISE EXCEPTION 'bootstrap requires an active manager account' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER cb_bootstrap_receipt_guard BEFORE INSERT OR UPDATE OR DELETE ON cb_center_bootstraps
  FOR EACH ROW EXECUTE FUNCTION cb_bootstrap_receipt_guard();
