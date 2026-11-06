-- Unbound uploads only. Clinical binding/access is a separate subsequent step.
CREATE TABLE cb_media_uploads (
  center_id text NOT NULL,
  conversation_id text NOT NULL,
  id text NOT NULL CHECK (id ~ '^[a-f0-9-]{36}$'),
  owner_id text NOT NULL,
  client_id text NOT NULL CHECK (client_id ~ '^[a-zA-Z0-9-]{8,100}$'),
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 255 AND name !~ '[[:cntrl:]/\\]'),
  type text NOT NULL CHECK (type IN ('image/jpeg','image/png','image/webp','image/gif','video/mp4','video/webm')),
  size integer NOT NULL CHECK (size > 0 AND size <= CASE WHEN type LIKE 'image/%' THEN 10485760 ELSE 52428800 END),
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  created_sequence bigint NOT NULL CHECK (created_sequence BETWEEN 1 AND 9007199254740991),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','receiving','quarantined','inspecting','ready','rejected','delete_pending','deleted')),
  object_key text,
  lease_id text,
  lease_until timestamptz,
  scan_report jsonb,
  failure_code text CHECK (failure_code IN ('UPLOAD_INTERRUPTED','SIZE_MISMATCH','HASH_MISMATCH','FORMAT_MISMATCH','SCAN_UNAVAILABLE','SCAN_REJECTED','SCAN_INVALID')),
  PRIMARY KEY (center_id,conversation_id,id),
  CONSTRAINT cb_media_request_id UNIQUE (center_id,owner_id,client_id),
  CHECK (expires_at > created_at),
  CHECK ((state IN ('receiving','inspecting')) = (lease_id IS NOT NULL AND lease_until IS NOT NULL)),
  CHECK (state IN ('receiving','inspecting') OR (lease_id IS NULL AND lease_until IS NULL)),
  CHECK (state NOT IN ('receiving','quarantined','inspecting','ready') OR object_key IS NOT NULL),
  CHECK (state <> 'ready' OR (scan_report IS NOT NULL AND failure_code IS NULL)),
  CHECK (scan_report IS NULL OR COALESCE((jsonb_typeof(scan_report) = 'object'
    AND scan_report->>'verdict' IN ('clean','rejected')
    AND scan_report->>'engine' ~ '^[a-zA-Z0-9._+-]{1,80}$'
    AND scan_report->>'engineVersion' ~ '^[a-zA-Z0-9._+-]{1,80}$'
    AND scan_report->>'policyVersion' = 'carebridge-media-v1'),false)),
  CHECK (state <> 'ready' OR COALESCE(scan_report->>'verdict' = 'clean',false)),
  CHECK (state <> 'ready' OR COALESCE((scan_report->'media'->>'type' = type
    AND (scan_report->'media'->>'width')::integer BETWEEN 1 AND 8192
    AND (scan_report->'media'->>'height')::integer BETWEEN 1 AND 8192
    AND (scan_report->'media'->>'width')::bigint * (scan_report->'media'->>'height')::bigint <= 40000000
    AND (type LIKE 'image/%' OR (scan_report->'media'->>'duration')::numeric > 0
      AND (scan_report->'media'->>'duration')::numeric <= 600)),false)),
  FOREIGN KEY (center_id,conversation_id,owner_id) REFERENCES cb_participants(center_id,conversation_id,user_id)
);
CREATE TABLE cb_media_objects (
  key text PRIMARY KEY CHECK (key ~ '^[a-f0-9-]{36}$'),
  center_id text NOT NULL,
  conversation_id text NOT NULL,
  upload_id text NOT NULL,
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active','delete_pending','deleted')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (center_id,conversation_id,upload_id,key),
  FOREIGN KEY (center_id,conversation_id,upload_id) REFERENCES cb_media_uploads(center_id,conversation_id,id)
);
ALTER TABLE cb_media_uploads ADD CONSTRAINT cb_media_current_object FOREIGN KEY (center_id,conversation_id,id,object_key)
  REFERENCES cb_media_objects(center_id,conversation_id,upload_id,key) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE cb_media_events (
  center_id text NOT NULL,
  conversation_id text NOT NULL,
  upload_id text NOT NULL,
  version integer NOT NULL,
  state text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (center_id,conversation_id,upload_id,version),
  FOREIGN KEY (center_id,conversation_id,upload_id) REFERENCES cb_media_uploads(center_id,conversation_id,id)
);
CREATE TRIGGER cb_media_event_immutable BEFORE UPDATE OR DELETE ON cb_media_events
  FOR EACH ROW EXECUTE FUNCTION cb_immutable_record_data();
CREATE FUNCTION cb_media_root_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'media manifests are retained' USING ERRCODE = '23514'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.version <> 1 OR NEW.state <> 'pending' OR NEW.object_key IS NOT NULL OR NEW.scan_report IS NOT NULL THEN
      RAISE EXCEPTION 'upload starts pending' USING ERRCODE = '23514'; END IF;
  ELSE
    IF (to_jsonb(NEW) - ARRAY['version','state','object_key','lease_id','lease_until','scan_report','failure_code'])
      IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['version','state','object_key','lease_id','lease_until','scan_report','failure_code'])
      OR NEW.version::bigint <> OLD.version::bigint + 1 OR NOT (
        (OLD.state = 'pending' AND NEW.state IN ('receiving','delete_pending')) OR
        (OLD.state = 'receiving' AND NEW.state IN ('pending','quarantined','rejected','delete_pending')) OR
        (OLD.state = 'receiving' AND NEW.state = 'receiving' AND OLD.lease_until <= clock_timestamp()) OR
        (OLD.state = 'quarantined' AND NEW.state IN ('inspecting','delete_pending')) OR
        (OLD.state = 'inspecting' AND NEW.state IN ('quarantined','ready','rejected','delete_pending')) OR
        (OLD.state = 'inspecting' AND NEW.state = 'inspecting' AND OLD.lease_until <= clock_timestamp()) OR
        (OLD.state IN ('ready','rejected') AND NEW.state = 'delete_pending') OR
        (OLD.state = 'delete_pending' AND NEW.state = 'deleted')) THEN
      RAISE EXCEPTION 'invalid media transition' USING ERRCODE = '23514';
    END IF;
    IF OLD.state = 'deleted' OR (OLD.state NOT IN ('pending','receiving') AND NEW.object_key IS DISTINCT FROM OLD.object_key) THEN
      RAISE EXCEPTION 'media object is immutable' USING ERRCODE = '23514'; END IF;
    IF OLD.state <> 'inspecting' AND NEW.scan_report IS DISTINCT FROM OLD.scan_report THEN
      RAISE EXCEPTION 'inspection proof is immutable' USING ERRCODE = '23514'; END IF;
  END IF;
  IF NEW.state IN ('receiving','quarantined','inspecting','ready') AND NOT EXISTS (
    SELECT 1 FROM cb_media_objects o WHERE (o.center_id,o.conversation_id,o.upload_id,o.key) =
      (NEW.center_id,NEW.conversation_id,NEW.id,NEW.object_key) AND o.state = 'active') THEN
    RAISE EXCEPTION 'current object must be active' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER cb_media_root_guard BEFORE INSERT OR UPDATE OR DELETE ON cb_media_uploads
  FOR EACH ROW EXECUTE FUNCTION cb_media_root_guard();
CREATE FUNCTION cb_media_capture_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO cb_media_events(center_id,conversation_id,upload_id,version,state)
    VALUES (NEW.center_id,NEW.conversation_id,NEW.id,NEW.version,NEW.state);
  RETURN NULL;
END;
$$;
CREATE TRIGGER cb_media_capture_event AFTER INSERT OR UPDATE ON cb_media_uploads FOR EACH ROW EXECUTE FUNCTION cb_media_capture_event();
CREATE FUNCTION cb_media_object_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'object ledger is retained' USING ERRCODE = '23514'; END IF;
  IF (to_jsonb(NEW) - 'state') IS DISTINCT FROM (to_jsonb(OLD) - 'state') OR NOT (
    (OLD.state = 'active' AND NEW.state = 'delete_pending') OR (OLD.state = 'delete_pending' AND NEW.state = 'deleted')) THEN
    RAISE EXCEPTION 'invalid object transition' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER cb_media_object_guard BEFORE UPDATE OR DELETE ON cb_media_objects FOR EACH ROW EXECUTE FUNCTION cb_media_object_guard();
CREATE INDEX cb_media_owner_quota ON cb_media_uploads(center_id,conversation_id,owner_id,state);
CREATE INDEX cb_media_expiry ON cb_media_uploads(expires_at) WHERE state NOT IN ('delete_pending','deleted');
CREATE INDEX cb_media_cleanup ON cb_media_objects(state) WHERE state = 'delete_pending';
