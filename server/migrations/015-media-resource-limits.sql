-- Explicit per-center admission policy; no operating budget is chosen here.
-- A separate mutex avoids the schedule gate's center -> room lock order.
CREATE TABLE cb_media_resource_limits (
  center_id text PRIMARY KEY REFERENCES cb_centers(id),
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  storage_bytes bigint CHECK (storage_bytes BETWEEN 0 AND 9007199254740991),
  pending_uploads integer CHECK (pending_uploads BETWEEN 0 AND 1000000),
  uploads_per_window integer CHECK (uploads_per_window BETWEEN 0 AND 1000000),
  window_milliseconds integer CHECK (window_milliseconds BETWEEN 50 AND 86400000),
  accepting_uploads boolean NOT NULL DEFAULT false,
  CHECK ((revision = 0 AND num_nonnulls(storage_bytes,pending_uploads,uploads_per_window,window_milliseconds) = 0 AND NOT accepting_uploads)
    OR (revision > 0 AND num_nonnulls(storage_bytes,pending_uploads,uploads_per_window,window_milliseconds) = 4))
);
INSERT INTO cb_media_resource_limits(center_id) SELECT id FROM cb_centers;
CREATE FUNCTION cb_media_resource_center() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO cb_media_resource_limits(center_id) VALUES (NEW.id);
  RETURN NULL;
END; $$;
CREATE TRIGGER cb_media_resource_center AFTER INSERT ON cb_centers FOR EACH ROW EXECUTE FUNCTION cb_media_resource_center();

-- Bytes are a conservative CAPACITY RESERVATION, not measured disk usage.
-- Every live object consumes its format ceiling (10 MiB image / 50 MiB video).
-- Future original/candidate slots are held before IO; retired objects stay
-- charged until confirmed deleted. Expiry alone never refunds capacity.
CREATE FUNCTION cb_media_resource_usage(target text) RETURNS TABLE(reserved_bytes bigint,pending_count bigint) LANGUAGE sql VOLATILE AS $$
  SELECT COALESCE(sum(GREATEST(o.live_objects,
    CASE WHEN u.state IN ('pending','receiving','quarantined','inspecting','ready') THEN CASE WHEN u.preparation_required THEN 2 ELSE 1 END ELSE 0 END)
    * CASE WHEN u.type LIKE 'image/%' THEN 10485760::bigint ELSE 52428800::bigint END),0)::bigint,
    count(*) FILTER (WHERE u.state IN ('pending','receiving','quarantined','inspecting'))::bigint
  FROM cb_media_uploads u CROSS JOIN LATERAL (
    SELECT count(*) FILTER (WHERE state <> 'deleted') AS live_objects
    FROM cb_media_objects WHERE (center_id,conversation_id,upload_id) = (u.center_id,u.conversation_id,u.id)
  ) o WHERE u.center_id = target;
$$;
CREATE FUNCTION cb_media_lock_resources(target text) RETURNS cb_media_resource_limits LANGUAGE plpgsql AS $$
DECLARE policy cb_media_resource_limits%ROWTYPE;
BEGIN
  SELECT * INTO policy FROM cb_media_resource_limits WHERE center_id = target FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'media resource policy is unavailable' USING ERRCODE = '23514',CONSTRAINT = 'cb_media_resource_configured'; END IF;
  RETURN policy;
END; $$;
CREATE FUNCTION cb_media_resource_admission() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE policy cb_media_resource_limits%ROWTYPE;
BEGIN
  policy := cb_media_lock_resources(NEW.center_id);
  IF TG_OP = 'INSERT' THEN
    IF policy.revision = 0 THEN RAISE EXCEPTION 'media limits require explicit configuration' USING ERRCODE = '23514',CONSTRAINT = 'cb_media_resource_configured'; END IF;
    IF TG_TABLE_NAME = 'cb_media_uploads' THEN
      IF NOT policy.accepting_uploads THEN RAISE EXCEPTION 'new media reservations are paused' USING ERRCODE = '23514',CONSTRAINT = 'cb_media_resource_paused'; END IF;
      NEW.created_at := clock_timestamp();
      IF (SELECT count(*) FROM cb_media_uploads WHERE center_id = NEW.center_id
        AND created_at > NEW.created_at - policy.window_milliseconds * interval '1 millisecond') >= policy.uploads_per_window THEN
        RAISE EXCEPTION 'center media rate limit reached' USING ERRCODE = '23514',CONSTRAINT = 'cb_media_resource_rate';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER cb_media_resource_admission BEFORE INSERT OR UPDATE ON cb_media_uploads FOR EACH ROW EXECUTE FUNCTION cb_media_resource_admission();
-- Only insertion can increase object usage. Deletion is monotonic and does
-- not acquire this mutex after an object-row lock (avoids cleanup lock cycles).
CREATE TRIGGER cb_media_resource_object_admission BEFORE INSERT ON cb_media_objects FOR EACH ROW EXECUTE FUNCTION cb_media_resource_admission();

CREATE FUNCTION cb_media_resource_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE policy cb_media_resource_limits%ROWTYPE; usage record;
BEGIN
  SELECT * INTO policy FROM cb_media_resource_limits WHERE center_id = NEW.center_id;
  IF policy.revision > 0 THEN
    SELECT * INTO usage FROM cb_media_resource_usage(NEW.center_id);
    IF usage.reserved_bytes > policy.storage_bytes THEN RAISE EXCEPTION 'center media capacity exceeded' USING ERRCODE = '23514',CONSTRAINT = 'cb_media_resource_capacity'; END IF;
    IF usage.pending_count > policy.pending_uploads THEN RAISE EXCEPTION 'center media backlog exceeded' USING ERRCODE = '23514',CONSTRAINT = 'cb_media_resource_backlog'; END IF;
  END IF;
  RETURN NULL;
END; $$;
-- Check the final transaction state, not the temporary overlap of a new object
-- and its preallocated slot. The admission mutex remains held through commit.
CREATE CONSTRAINT TRIGGER cb_media_resource_capacity AFTER INSERT OR UPDATE ON cb_media_uploads
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION cb_media_resource_check();
CREATE CONSTRAINT TRIGGER cb_media_resource_capacity AFTER INSERT ON cb_media_objects
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION cb_media_resource_check();
CREATE CONSTRAINT TRIGGER cb_media_resource_capacity AFTER UPDATE ON cb_media_resource_limits
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION cb_media_resource_check();
CREATE FUNCTION cb_media_resource_policy_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'media policies are retained' USING ERRCODE = '23514'; END IF;
  IF NEW.center_id IS DISTINCT FROM OLD.center_id OR NEW.revision::bigint <> OLD.revision::bigint + 1 THEN
    RAISE EXCEPTION 'media policy revision is required' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER cb_media_resource_policy_guard BEFORE UPDATE OR DELETE ON cb_media_resource_limits FOR EACH ROW EXECUTE FUNCTION cb_media_resource_policy_guard();
CREATE TABLE cb_media_resource_events (
  center_id text NOT NULL REFERENCES cb_media_resource_limits(center_id),
  revision integer NOT NULL,
  policy jsonb NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(center_id,revision)
);
CREATE FUNCTION cb_media_resource_capture() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO cb_media_resource_events(center_id,revision,policy) VALUES (NEW.center_id,NEW.revision,to_jsonb(NEW) - 'center_id');
  RETURN NULL;
END; $$;
CREATE TRIGGER cb_media_resource_capture AFTER UPDATE ON cb_media_resource_limits FOR EACH ROW EXECUTE FUNCTION cb_media_resource_capture();
CREATE TRIGGER cb_media_resource_event_immutable BEFORE UPDATE OR DELETE ON cb_media_resource_events FOR EACH ROW EXECUTE FUNCTION cb_immutable_record_data();
CREATE INDEX cb_media_resource_rate_window ON cb_media_uploads(center_id,created_at);
