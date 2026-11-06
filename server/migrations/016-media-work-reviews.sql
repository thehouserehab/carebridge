-- Explicit additional reinspection, NEVER resetting an attempt or approving
-- media. Each immutable review grants ONE attempt; three lifetime reviews max.
ALTER TABLE cb_media_work_queue
  ADD approved_retries integer NOT NULL DEFAULT 0 CHECK (approved_retries BETWEEN 0 AND 3),
  ADD last_review_id text,
  DROP CONSTRAINT cb_media_work_queue_attempts_check,
  ADD CONSTRAINT cb_media_work_attempt_limit CHECK (attempts BETWEEN 0 AND 8 AND attempts <= 5 + approved_retries),
  ADD CONSTRAINT cb_media_work_review_link CHECK ((approved_retries = 0) = (last_review_id IS NULL));
CREATE TABLE cb_media_work_reviews (
  center_id text NOT NULL,conversation_id text NOT NULL,id text NOT NULL CHECK (id ~ '^[a-f0-9-]{36}$'),upload_id text NOT NULL,
  reviewer_id text NOT NULL,client_id text NOT NULL CHECK (client_id ~ '^[a-zA-Z0-9-]{8,100}$'),
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  upload_version integer NOT NULL CHECK (upload_version > 0),
  attempts integer NOT NULL CHECK (attempts BETWEEN 5 AND 7),
  review_number integer NOT NULL CHECK (review_number BETWEEN 1 AND 3),
  reason text NOT NULL CHECK (reason IN ('ENGINE_RESTORED','STORAGE_RESTORED','CONFIGURATION_CORRECTED')),
  reviewed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(center_id,conversation_id,id),
  UNIQUE(center_id,conversation_id,upload_id,id),
  UNIQUE(center_id,conversation_id,upload_id,review_number),
  CONSTRAINT cb_media_review_request_id UNIQUE(center_id,reviewer_id,client_id),
  FOREIGN KEY(center_id,conversation_id,upload_id) REFERENCES cb_media_work_queue(center_id,conversation_id,upload_id),
  FOREIGN KEY(center_id,reviewer_id) REFERENCES cb_memberships(center_id,user_id)
);
ALTER TABLE cb_media_work_queue ADD CONSTRAINT cb_media_work_current_review
  FOREIGN KEY(center_id,conversation_id,upload_id,last_review_id)
  REFERENCES cb_media_work_reviews(center_id,conversation_id,upload_id,id) DEFERRABLE INITIALLY DEFERRED;
CREATE FUNCTION cb_media_review_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE u cb_media_uploads%ROWTYPE; q cb_media_work_queue%ROWTYPE;
BEGIN
  SELECT * INTO u FROM cb_media_uploads WHERE (center_id,conversation_id,id) = (NEW.center_id,NEW.conversation_id,NEW.upload_id) FOR SHARE;
  SELECT * INTO q FROM cb_media_work_queue WHERE (center_id,conversation_id,upload_id) = (NEW.center_id,NEW.conversation_id,NEW.upload_id) FOR SHARE;
  IF q.state IS DISTINCT FROM 'blocked' OR q.attempts IS DISTINCT FROM 5 + q.approved_retries OR q.approved_retries >= 3
    OR NEW.review_number IS DISTINCT FROM q.approved_retries + 1 OR NEW.attempts IS DISTINCT FROM q.attempts
    OR u.state IS DISTINCT FROM 'quarantined' OR u.version IS DISTINCT FROM NEW.upload_version OR u.version IS DISTINCT FROM q.upload_version
    OR u.object_key IS DISTINCT FROM q.source_key OR u.expires_at <= clock_timestamp()
    OR NOT EXISTS (SELECT 1 FROM cb_media_objects WHERE key = u.object_key AND state = 'active') THEN
    RAISE EXCEPTION 'review requires current unexpired blocked private work' USING ERRCODE = '23514'; END IF;
  PERFORM 1 FROM cb_memberships m JOIN cb_users user_account ON user_account.id = m.user_id
    WHERE m.center_id = NEW.center_id AND m.user_id = NEW.reviewer_id AND m.role = 'center' AND m.active AND user_account.active
    FOR SHARE OF m,user_account;
  IF NOT FOUND THEN RAISE EXCEPTION 'current center administrator required' USING ERRCODE = '23514'; END IF;
  PERFORM 1 FROM cb_participants p JOIN cb_memberships m ON (m.center_id,m.user_id,m.role) = (p.center_id,p.user_id,p.role)
    JOIN cb_users user_account ON user_account.id = p.user_id
    WHERE (p.center_id,p.conversation_id,p.user_id) = (NEW.center_id,NEW.conversation_id,u.owner_id)
      AND p.active AND m.active AND user_account.active AND p.role IN ('therapist','guardian') AND u.created_sequence >= p.first_sequence
    FOR SHARE OF p,m,user_account;
  IF NOT FOUND THEN RAISE EXCEPTION 'current original owner required' USING ERRCODE = '23514'; END IF;
  -- 015 prevents a configured revision from reverting to zero. This is a
  -- fail-closed SQL guard, not an allocation or a new capacity reservation.
  IF NOT EXISTS (SELECT 1 FROM cb_media_resource_limits WHERE center_id = NEW.center_id AND revision > 0) THEN
    RAISE EXCEPTION 'explicit resource configuration required' USING ERRCODE = '23514',CONSTRAINT = 'cb_media_resource_configured'; END IF;
  NEW.reviewed_at := clock_timestamp(); RETURN NEW;
END; $$;
CREATE TRIGGER cb_media_review_guard BEFORE INSERT ON cb_media_work_reviews FOR EACH ROW EXECUTE FUNCTION cb_media_review_guard();
CREATE TRIGGER cb_media_review_immutable BEFORE UPDATE OR DELETE ON cb_media_work_reviews FOR EACH ROW EXECUTE FUNCTION cb_immutable_record_data();
CREATE FUNCTION cb_media_review_committed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM cb_media_work_queue WHERE (center_id,conversation_id,upload_id) = (NEW.center_id,NEW.conversation_id,NEW.upload_id)
    AND approved_retries >= NEW.review_number) THEN
    RAISE EXCEPTION 'review and additional attempt must commit together' USING ERRCODE = '23514'; END IF;
  RETURN NULL;
END; $$;
CREATE CONSTRAINT TRIGGER cb_media_review_committed AFTER INSERT ON cb_media_work_reviews
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION cb_media_review_committed();

CREATE OR REPLACE FUNCTION cb_media_work_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE u cb_media_uploads%ROWTYPE; review cb_media_work_reviews%ROWTYPE; reopening boolean := false;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'media work is retained' USING ERRCODE = '23514'; END IF;
  SELECT * INTO u FROM cb_media_uploads WHERE (center_id,conversation_id,id) = (NEW.center_id,NEW.conversation_id,NEW.upload_id);
  IF u.id IS NULL OR NEW.source_key IS DISTINCT FROM u.object_key OR NEW.upload_version IS DISTINCT FROM u.version THEN
    RAISE EXCEPTION 'work requires the current upload' USING ERRCODE = '23514'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.approved_retries <> 0 OR NEW.last_review_id IS NOT NULL OR NOT (
      (NEW.state = 'queued' AND u.state = 'quarantined' AND NEW.attempts = 0) OR
      (NEW.state = 'running' AND u.state = 'inspecting' AND NEW.attempts = 1)) THEN
      RAISE EXCEPTION 'work starts only after private receipt' USING ERRCODE = '23514'; END IF;
    NEW.created_at := clock_timestamp();
  ELSE
    IF (NEW.center_id,NEW.conversation_id,NEW.upload_id,NEW.source_key,NEW.created_at) IS DISTINCT FROM
      (OLD.center_id,OLD.conversation_id,OLD.upload_id,OLD.source_key,OLD.created_at) OR OLD.state IN ('completed','cancelled') THEN
      RAISE EXCEPTION 'work identity and terminal outcome are immutable' USING ERRCODE = '23514'; END IF;
    reopening := OLD.state = 'blocked' AND NEW.state = 'retry';
    IF reopening THEN
      SELECT * INTO review FROM cb_media_work_reviews WHERE (center_id,conversation_id,upload_id,id) =
        (NEW.center_id,NEW.conversation_id,NEW.upload_id,NEW.last_review_id);
      IF OLD.approved_retries >= 3 OR NEW.approved_retries <> OLD.approved_retries + 1 OR NEW.attempts <> OLD.attempts
        OR review.id IS NULL OR review.review_number IS DISTINCT FROM NEW.approved_retries OR review.attempts IS DISTINCT FROM OLD.attempts
        OR review.upload_version IS DISTINCT FROM u.version OR u.state <> 'quarantined' OR u.expires_at <= clock_timestamp() THEN
        RAISE EXCEPTION 'one immutable review grants one additional attempt' USING ERRCODE = '23514'; END IF;
    ELSE
      IF (NEW.approved_retries,NEW.last_review_id) IS DISTINCT FROM (OLD.approved_retries,OLD.last_review_id) THEN
        RAISE EXCEPTION 'review grants cannot be reset or manufactured' USING ERRCODE = '23514'; END IF;
      IF NEW.state = 'running' THEN
        IF NOT (OLD.state IN ('queued','retry') OR OLD.state = 'running' AND OLD.lease_until <= clock_timestamp()) OR
          NEW.attempts <> OLD.attempts + 1 OR OLD.attempts >= 5 + OLD.approved_retries THEN
          RAISE EXCEPTION 'a new bounded attempt is required' USING ERRCODE = '23514'; END IF;
      ELSIF NEW.state IN ('retry','blocked','completed') THEN
        IF OLD.state <> 'running' OR NEW.attempts <> OLD.attempts THEN
          RAISE EXCEPTION 'only a running attempt can finish' USING ERRCODE = '23514'; END IF;
      ELSIF NEW.state = 'cancelled' THEN
        IF NEW.attempts <> OLD.attempts THEN RAISE EXCEPTION 'cancellation cannot create an attempt' USING ERRCODE = '23514'; END IF;
      ELSE RAISE EXCEPTION 'invalid work transition' USING ERRCODE = '23514'; END IF;
    END IF;
  END IF;
  NEW.updated_at := clock_timestamp(); NEW.failure_code := NULL; NEW.outcome := NULL; NEW.finished_at := NULL;
  NEW.available_at := NEW.updated_at;
  IF NEW.state = 'running' THEN
    IF u.state <> 'inspecting' OR NEW.lease_id IS DISTINCT FROM u.lease_id OR NEW.lease_until IS DISTINCT FROM u.lease_until THEN
      RAISE EXCEPTION 'work and inspection must share one lease' USING ERRCODE = '23514'; END IF;
  ELSE
    NEW.lease_id := NULL; NEW.lease_until := NULL;
    IF NEW.state IN ('retry','blocked') THEN
      IF u.state <> 'quarantined' OR NEW.attempts < 1 OR (NEW.state = 'blocked') <> (NEW.attempts = 5 + NEW.approved_retries) THEN
        RAISE EXCEPTION 'retry must respect inspection outcome and attempt bound' USING ERRCODE = '23514'; END IF;
      NEW.failure_code := CASE WHEN NEW.state = 'blocked' THEN 'ATTEMPTS_EXHAUSTED'
        WHEN u.failure_code = 'SCAN_INVALID' THEN 'SCAN_INVALID' ELSE 'SCAN_UNAVAILABLE' END;
      IF NOT reopening THEN NEW.available_at := NEW.updated_at + power(2,NEW.attempts-1) * interval '1 second'; END IF;
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
CREATE OR REPLACE FUNCTION cb_media_capture_work() RETURNS trigger LANGUAGE plpgsql AS $$
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
        WHEN attempts = 5 + approved_retries THEN 'blocked' ELSE 'retry' END,upload_version = NEW.version
      WHERE (center_id,conversation_id,upload_id) = (NEW.center_id,NEW.conversation_id,NEW.id);
    IF NOT FOUND THEN RAISE EXCEPTION 'inspection requires durable work' USING ERRCODE = '23514'; END IF;
  ELSIF NEW.state IN ('delete_pending','deleted') THEN
    UPDATE cb_media_work_queue SET state = 'cancelled',upload_version = NEW.version
      WHERE (center_id,conversation_id,upload_id) = (NEW.center_id,NEW.conversation_id,NEW.id) AND state NOT IN ('completed','cancelled');
  END IF;
  RETURN NULL;
END; $$;
CREATE INDEX cb_media_work_blocked ON cb_media_work_queue(center_id,conversation_id,upload_id) WHERE state = 'blocked';
