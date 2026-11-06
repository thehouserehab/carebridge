-- Durable outbox, not a public API or an automatic operating worker.
-- Upload transitions and queue transitions commit/roll back together.
CREATE TABLE cb_media_work_queue (
  center_id text NOT NULL, conversation_id text NOT NULL, upload_id text NOT NULL,
  source_key text NOT NULL,
  state text NOT NULL CHECK (state IN ('queued','running','retry','completed','blocked','cancelled')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  upload_version integer NOT NULL CHECK (upload_version > 0),
  lease_id text, lease_until timestamptz,
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  failure_code text CHECK (failure_code IN ('SCAN_INVALID','SCAN_UNAVAILABLE','ATTEMPTS_EXHAUSTED')),
  outcome text CHECK (outcome IN ('ready','rejected')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(), finished_at timestamptz,
  PRIMARY KEY (center_id,conversation_id,upload_id),
  FOREIGN KEY (center_id,conversation_id,upload_id) REFERENCES cb_media_uploads(center_id,conversation_id,id),
  FOREIGN KEY (center_id,conversation_id,upload_id,source_key) REFERENCES cb_media_objects(center_id,conversation_id,upload_id,key),
  CHECK ((state = 'running' AND lease_id IS NOT NULL AND lease_until IS NOT NULL AND attempts > 0) OR
    (state <> 'running' AND lease_id IS NULL AND lease_until IS NULL)),
  CHECK ((state = 'completed') = (outcome IS NOT NULL)),
  CHECK ((state IN ('completed','blocked','cancelled')) = (finished_at IS NOT NULL))
);

CREATE FUNCTION cb_media_work_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE u cb_media_uploads%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'media work is retained' USING ERRCODE = '23514'; END IF;
  SELECT * INTO u FROM cb_media_uploads WHERE (center_id,conversation_id,id) = (NEW.center_id,NEW.conversation_id,NEW.upload_id);
  IF u.id IS NULL OR NEW.source_key IS DISTINCT FROM u.object_key OR NEW.upload_version IS DISTINCT FROM u.version THEN
    RAISE EXCEPTION 'work requires the current upload' USING ERRCODE = '23514'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NOT ((NEW.state = 'queued' AND u.state = 'quarantined' AND NEW.attempts = 0) OR
      (NEW.state = 'running' AND u.state = 'inspecting' AND NEW.attempts = 1)) THEN
      RAISE EXCEPTION 'work starts only after private receipt' USING ERRCODE = '23514'; END IF;
    NEW.created_at := clock_timestamp();
  ELSE
    IF (NEW.center_id,NEW.conversation_id,NEW.upload_id,NEW.source_key,NEW.created_at) IS DISTINCT FROM
      (OLD.center_id,OLD.conversation_id,OLD.upload_id,OLD.source_key,OLD.created_at) OR OLD.state IN ('completed','cancelled') THEN
      RAISE EXCEPTION 'work identity and terminal outcome are immutable' USING ERRCODE = '23514'; END IF;
    IF NEW.state = 'running' THEN
      IF NOT (OLD.state IN ('queued','retry') OR OLD.state = 'running' AND OLD.lease_until <= clock_timestamp()) OR
        NEW.attempts <> OLD.attempts + 1 OR OLD.attempts >= 5 THEN
        RAISE EXCEPTION 'a new bounded attempt is required' USING ERRCODE = '23514'; END IF;
    ELSIF NEW.state IN ('retry','blocked','completed') THEN
      IF OLD.state <> 'running' OR NEW.attempts <> OLD.attempts THEN
        RAISE EXCEPTION 'only a running attempt can finish' USING ERRCODE = '23514'; END IF;
    ELSIF NEW.state = 'cancelled' THEN
      IF NEW.attempts <> OLD.attempts THEN RAISE EXCEPTION 'cancellation cannot create an attempt' USING ERRCODE = '23514'; END IF;
    ELSE RAISE EXCEPTION 'invalid work transition' USING ERRCODE = '23514'; END IF;
  END IF;
  NEW.updated_at := clock_timestamp(); NEW.failure_code := NULL; NEW.outcome := NULL; NEW.finished_at := NULL;
  NEW.available_at := NEW.updated_at;
  IF NEW.state = 'running' THEN
    IF u.state <> 'inspecting' OR NEW.lease_id IS DISTINCT FROM u.lease_id OR NEW.lease_until IS DISTINCT FROM u.lease_until THEN
      RAISE EXCEPTION 'work and inspection must share one lease' USING ERRCODE = '23514'; END IF;
  ELSE
    NEW.lease_id := NULL; NEW.lease_until := NULL;
    IF NEW.state IN ('retry','blocked') THEN
      IF u.state <> 'quarantined' OR NEW.attempts < 1 OR (NEW.state = 'blocked') <> (NEW.attempts = 5) THEN
        RAISE EXCEPTION 'retry must respect inspection outcome and attempt bound' USING ERRCODE = '23514'; END IF;
      NEW.failure_code := CASE WHEN NEW.state = 'blocked' THEN 'ATTEMPTS_EXHAUSTED'
        WHEN u.failure_code = 'SCAN_INVALID' THEN 'SCAN_INVALID' ELSE 'SCAN_UNAVAILABLE' END;
      -- Fixed 1, 2, 4, 8 second backoff; DB clock, never a caller timestamp.
      NEW.available_at := NEW.updated_at + power(2,NEW.attempts-1) * interval '1 second';
    ELSIF NEW.state = 'completed' THEN
      IF u.state NOT IN ('ready','rejected') THEN RAISE EXCEPTION 'completed work requires exact file outcome' USING ERRCODE = '23514'; END IF;
      NEW.outcome := u.state;
    ELSIF NEW.state = 'cancelled' AND u.state NOT IN ('delete_pending','deleted') THEN
      RAISE EXCEPTION 'cancelled work requires a cancelled upload' USING ERRCODE = '23514';
    END IF;
    IF NEW.state IN ('completed','blocked','cancelled') THEN NEW.finished_at := NEW.updated_at; END IF;
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER cb_media_work_guard BEFORE INSERT OR UPDATE OR DELETE ON cb_media_work_queue
  FOR EACH ROW EXECUTE FUNCTION cb_media_work_guard();

CREATE FUNCTION cb_media_capture_work() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state = 'quarantined' AND OLD.state = 'receiving' THEN
    INSERT INTO cb_media_work_queue(center_id,conversation_id,upload_id,source_key,state,upload_version)
      VALUES (NEW.center_id,NEW.conversation_id,NEW.id,NEW.object_key,'queued',NEW.version);
  ELSIF NEW.state = 'inspecting' THEN
    UPDATE cb_media_work_queue SET state = 'running',attempts = attempts + 1,upload_version = NEW.version,
      lease_id = NEW.lease_id,lease_until = NEW.lease_until
      WHERE (center_id,conversation_id,upload_id) = (NEW.center_id,NEW.conversation_id,NEW.id);
    IF NOT FOUND THEN RAISE EXCEPTION 'inspection requires durable work' USING ERRCODE = '23514'; END IF;
  ELSIF OLD.state = 'inspecting' AND NEW.state IN ('quarantined','ready','rejected') THEN
    UPDATE cb_media_work_queue SET state = CASE WHEN NEW.state <> 'quarantined' THEN 'completed'
        WHEN attempts = 5 THEN 'blocked' ELSE 'retry' END,upload_version = NEW.version
      WHERE (center_id,conversation_id,upload_id) = (NEW.center_id,NEW.conversation_id,NEW.id);
    IF NOT FOUND THEN RAISE EXCEPTION 'inspection requires durable work' USING ERRCODE = '23514'; END IF;
  ELSIF NEW.state IN ('delete_pending','deleted') THEN
    UPDATE cb_media_work_queue SET state = 'cancelled',upload_version = NEW.version
      WHERE (center_id,conversation_id,upload_id) = (NEW.center_id,NEW.conversation_id,NEW.id)
      AND state NOT IN ('completed','cancelled');
  END IF;
  RETURN NULL;
END; $$;
CREATE TRIGGER cb_media_capture_work AFTER UPDATE ON cb_media_uploads FOR EACH ROW EXECUTE FUNCTION cb_media_capture_work();

-- Preserve historical approvals. Only unbound private work is backfilled;
-- no bytes are read and no inspection/worker is started by migration.
INSERT INTO cb_media_work_queue(center_id,conversation_id,upload_id,source_key,state,attempts,upload_version,lease_id,lease_until)
  SELECT center_id,conversation_id,id,object_key,CASE WHEN state = 'inspecting' THEN 'running' ELSE 'queued' END,
    CASE WHEN state = 'inspecting' THEN 1 ELSE 0 END,version,lease_id,lease_until
  FROM cb_media_uploads WHERE state IN ('quarantined','inspecting');
CREATE INDEX cb_media_work_due ON cb_media_work_queue(available_at,created_at,upload_id) WHERE state IN ('queued','retry');
