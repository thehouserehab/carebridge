-- Additive only: retain historical manifests, original bytes, IDs and links.
-- Historical approvals are not retroactively presented as preparation proof.
ALTER TABLE cb_media_uploads
  ADD COLUMN preparation_required boolean NOT NULL DEFAULT false,
  ADD COLUMN candidate_key text,
  ADD COLUMN preparation_id text,
  ADD COLUMN prepared_size integer,
  ADD COLUMN prepared_sha256 text;
ALTER TABLE cb_media_uploads ALTER COLUMN preparation_required SET DEFAULT true;

CREATE FUNCTION cb_media_clean_scan(scan jsonb, bytes integer, hash text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$ SELECT COALESCE(
  jsonb_typeof(scan) = 'object' AND scan - ARRAY['engine','engineVersion','databaseVersion','databaseUpdatedAt','verdict','checkedBytes','sha256','mediaAcceptanceReady'] = '{}'::jsonb
  AND scan->>'engine' = 'clamav' AND scan->>'engineVersion' ~ '^\d{1,3}\.\d{1,3}\.\d{1,3}$'
  AND jsonb_typeof(scan->'databaseVersion') = 'number' AND (scan->>'databaseVersion')::numeric BETWEEN 1 AND 4294967295
  AND (scan->>'databaseVersion')::numeric = trunc((scan->>'databaseVersion')::numeric)
  AND scan->>'databaseUpdatedAt' ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$'
  AND scan->>'verdict' = 'clean' AND scan->'checkedBytes' = to_jsonb(bytes) AND scan->>'sha256' = hash
  AND scan->'mediaAcceptanceReady' = 'false'::jsonb,false) $$;

CREATE TABLE cb_media_preparations (
  id text PRIMARY KEY CHECK (id ~ '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'),
  center_id text NOT NULL, conversation_id text NOT NULL, upload_id text NOT NULL,
  upload_version integer NOT NULL CHECK (upload_version > 0), lease_id text NOT NULL,
  source_key text NOT NULL, derivative_key text NOT NULL UNIQUE CHECK (derivative_key <> source_key),
  type text NOT NULL, source_size integer NOT NULL CHECK (source_size > 0), derivative_size integer NOT NULL CHECK (derivative_size > 0),
  source_sha256 text NOT NULL CHECK (source_sha256 ~ '^[a-f0-9]{64}$'),
  derivative_sha256 text NOT NULL CHECK (derivative_sha256 ~ '^[a-f0-9]{64}$'),
  evidence jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (center_id,conversation_id,upload_id,id),
  FOREIGN KEY (center_id,conversation_id,upload_id) REFERENCES cb_media_uploads(center_id,conversation_id,id),
  FOREIGN KEY (center_id,conversation_id,upload_id,source_key) REFERENCES cb_media_objects(center_id,conversation_id,upload_id,key),
  FOREIGN KEY (center_id,conversation_id,upload_id,derivative_key) REFERENCES cb_media_objects(center_id,conversation_id,upload_id,key),
  CHECK (type IN ('image/jpeg','image/png','image/webp','image/gif','video/mp4','video/webm')),
  CHECK (greatest(source_size,derivative_size) <= CASE WHEN type LIKE 'image/%' THEN 10485760 ELSE 52428800 END),
  CONSTRAINT cb_media_preparation_evidence CHECK (COALESCE(
    jsonb_typeof(evidence) = 'object' AND octet_length(evidence::text) <= 16384
    AND evidence - ARRAY['source','derivative','sourceScan','derivativeScan','preparation','mediaAcceptanceReady'] = '{}'::jsonb
    AND evidence->'mediaAcceptanceReady' = 'false'::jsonb
    AND evidence->'source' = jsonb_build_object('type',type,'size',source_size,'sha256',source_sha256)
    AND evidence->'derivative' = jsonb_build_object('type',type,'size',derivative_size,'sha256',derivative_sha256)
    AND cb_media_clean_scan(evidence->'sourceScan',source_size,source_sha256)
    AND cb_media_clean_scan(evidence->'derivativeScan',derivative_size,derivative_sha256)
    AND ((evidence->'sourceScan') - ARRAY['verdict','checkedBytes','sha256']) = ((evidence->'derivativeScan') - ARRAY['verdict','checkedBytes','sha256'])
    AND evidence->'preparation'->'source' = evidence->'source'
    AND evidence->'preparation'->'derivative' = evidence->'derivative'
    AND evidence->'preparation'->'mediaAcceptanceReady' = 'false'::jsonb
    AND evidence->'preparation'->>'sourceTimelineSha256' ~ '^[a-f0-9]{64}$'
    AND evidence->'preparation'->'sourceTimelineSha256' = evidence->'preparation'->'derivativeTimelineSha256'
    AND evidence->'preparation'->'sourceDecode'->>'engine' = 'ffmpeg'
    AND evidence->'preparation'->'derivativeDecode'->>'engine' = 'ffmpeg'
    AND evidence->'preparation'->'sourceDecode'->>'engineVersion' = '9.0.2'
    AND evidence->'preparation'->'derivativeDecode'->>'engineVersion' = '9.0.2'
    AND evidence->'preparation'->'sourceDecode'->'mediaAcceptanceReady' = 'false'::jsonb
    AND evidence->'preparation'->'derivativeDecode'->'mediaAcceptanceReady' = 'false'::jsonb
    AND evidence->'preparation'->'sourceDecode'->'checkedBytes' = to_jsonb(source_size)
    AND evidence->'preparation'->'derivativeDecode'->'checkedBytes' = to_jsonb(derivative_size)
    AND evidence->'preparation'->'sourceDecode'->>'sha256' = source_sha256
    AND evidence->'preparation'->'derivativeDecode'->>'sha256' = derivative_sha256
    AND evidence->'preparation'->'sourceDecode'->'media' = evidence->'preparation'->'derivativeDecode'->'media'
    AND evidence->'preparation'->'sourceDecode'->'decodedVideoFrames' = evidence->'preparation'->'derivativeDecode'->'decodedVideoFrames'
    AND (evidence->'preparation'->'sourceDecode'->>'decodedVideoFrames')::numeric BETWEEN 1 AND 200000
    AND evidence->'preparation'->'sourceDecode'->'decodedAudioFrames' = evidence->'preparation'->'derivativeDecode'->'decodedAudioFrames'
    AND (evidence->'preparation'->'sourceDecode'->>'decodedAudioFrames')::numeric BETWEEN 0 AND 200000
    AND CASE WHEN type LIKE 'image/%' THEN evidence->'preparation'->'metadata'->>'policyVersion' = 'carebridge-image-metadata-v2'
      ELSE evidence->'preparation'->'metadata'->>'policyVersion' = 'carebridge-video-metadata-v1' END,false))
);
CREATE TRIGGER cb_media_preparation_immutable BEFORE UPDATE OR DELETE ON cb_media_preparations
  FOR EACH ROW EXECUTE FUNCTION cb_immutable_record_data();
ALTER TABLE cb_media_uploads
  ADD FOREIGN KEY (center_id,conversation_id,id,candidate_key) REFERENCES cb_media_objects(center_id,conversation_id,upload_id,key),
  ADD FOREIGN KEY (center_id,conversation_id,id,preparation_id) REFERENCES cb_media_preparations(center_id,conversation_id,upload_id,id),
  ADD CONSTRAINT cb_media_prepared_manifest CHECK ((num_nonnulls(preparation_id,prepared_size,prepared_sha256) = 0) OR
    (num_nonnulls(preparation_id,prepared_size,prepared_sha256) = 3 AND candidate_key IS NOT NULL AND prepared_size > 0
      AND prepared_size <= CASE WHEN type LIKE 'image/%' THEN 10485760 ELSE 52428800 END AND prepared_sha256 ~ '^[a-f0-9]{64}$')),
  ADD CONSTRAINT cb_media_new_approval CHECK (NOT preparation_required OR state NOT IN ('ready','bound') OR preparation_id IS NOT NULL),
  ADD CONSTRAINT cb_media_candidate_state CHECK (candidate_key IS NULL OR state IN ('inspecting','ready','bound','delete_pending','deleted'));

CREATE FUNCTION cb_media_preparation_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE u cb_media_uploads%ROWTYPE;
BEGIN
  SELECT * INTO u FROM cb_media_uploads WHERE (center_id,conversation_id,id) = (NEW.center_id,NEW.conversation_id,NEW.upload_id) FOR SHARE;
  IF u.state IS DISTINCT FROM 'inspecting' OR u.version IS DISTINCT FROM NEW.upload_version OR u.lease_id IS DISTINCT FROM NEW.lease_id
    OR u.object_key IS DISTINCT FROM NEW.source_key OR u.candidate_key IS DISTINCT FROM NEW.derivative_key
    OR (u.type,u.size,u.sha256) IS DISTINCT FROM (NEW.type,NEW.source_size,NEW.source_sha256)
    OR u.lease_until <= clock_timestamp() OR u.expires_at <= clock_timestamp()
    OR (SELECT count(*) FROM cb_media_objects WHERE key IN (NEW.source_key,NEW.derivative_key) AND state = 'active') <> 2 THEN
    RAISE EXCEPTION 'preparation requires a current lease and separate active objects' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER cb_media_preparation_insert BEFORE INSERT ON cb_media_preparations FOR EACH ROW EXECUTE FUNCTION cb_media_preparation_insert_guard();
CREATE FUNCTION cb_require_media_preparation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM cb_media_uploads WHERE (center_id,conversation_id,id,preparation_id) = (NEW.center_id,NEW.conversation_id,NEW.upload_id,NEW.id)
    AND state IN ('ready','bound','delete_pending','deleted')) THEN
    RAISE EXCEPTION 'preparation and approval must commit together' USING ERRCODE = '23514'; END IF;
  RETURN NULL;
END; $$;
CREATE CONSTRAINT TRIGGER cb_media_preparation_committed AFTER INSERT ON cb_media_preparations
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION cb_require_media_preparation();

CREATE OR REPLACE FUNCTION cb_media_root_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'media manifests are retained' USING ERRCODE = '23514'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.version <> 1 OR NEW.state <> 'pending' OR NEW.object_key IS NOT NULL OR NEW.scan_report IS NOT NULL
      OR NOT NEW.preparation_required OR NEW.candidate_key IS NOT NULL OR NEW.preparation_id IS NOT NULL OR NEW.prepared_size IS NOT NULL OR NEW.prepared_sha256 IS NOT NULL THEN
      RAISE EXCEPTION 'new uploads require preparation and start pending' USING ERRCODE = '23514'; END IF;
  ELSE
    IF (to_jsonb(NEW) - ARRAY['version','state','object_key','lease_id','lease_until','scan_report','failure_code','bound_message_id','bound_record_id','bound_feedback_id','candidate_key','preparation_id','prepared_size','prepared_sha256'])
      IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['version','state','object_key','lease_id','lease_until','scan_report','failure_code','bound_message_id','bound_record_id','bound_feedback_id','candidate_key','preparation_id','prepared_size','prepared_sha256'])
      OR NEW.version::bigint <> OLD.version::bigint + 1 OR NOT (
        (OLD.state = 'pending' AND NEW.state IN ('receiving','delete_pending')) OR
        (OLD.state = 'receiving' AND NEW.state IN ('pending','quarantined','rejected','delete_pending')) OR
        (OLD.state = 'receiving' AND NEW.state = 'receiving' AND OLD.lease_until <= clock_timestamp()) OR
        (OLD.state = 'quarantined' AND NEW.state IN ('inspecting','delete_pending')) OR
        (OLD.state = 'inspecting' AND NEW.state IN ('quarantined','ready','rejected','delete_pending')) OR
        (OLD.state = 'inspecting' AND NEW.state = 'inspecting' AND OLD.lease_until <= clock_timestamp()) OR
        (OLD.state = 'ready' AND NEW.state = 'bound' AND OLD.expires_at > clock_timestamp()) OR
        (OLD.state IN ('ready','rejected') AND NEW.state = 'delete_pending') OR
        (OLD.state = 'delete_pending' AND NEW.state = 'deleted')) THEN RAISE EXCEPTION 'invalid media transition' USING ERRCODE = '23514'; END IF;
    IF OLD.state = 'deleted' OR (OLD.state NOT IN ('pending','receiving') AND NEW.object_key IS DISTINCT FROM OLD.object_key) THEN
      RAISE EXCEPTION 'original media object is immutable' USING ERRCODE = '23514'; END IF;
    IF OLD.state <> 'inspecting' AND NEW.scan_report IS DISTINCT FROM OLD.scan_report THEN RAISE EXCEPTION 'inspection proof is immutable' USING ERRCODE = '23514'; END IF;
    IF (NEW.bound_message_id,NEW.bound_record_id,NEW.bound_feedback_id) IS DISTINCT FROM (OLD.bound_message_id,OLD.bound_record_id,OLD.bound_feedback_id)
      AND NOT (OLD.state = 'ready' AND NEW.state = 'bound') THEN RAISE EXCEPTION 'file origin is immutable' USING ERRCODE = '23514'; END IF;
    IF NEW.candidate_key IS DISTINCT FROM OLD.candidate_key AND NOT (
      (OLD.state = 'quarantined' AND NEW.state = 'inspecting') OR
      (OLD.state = 'inspecting' AND NEW.state = 'inspecting' AND OLD.lease_until <= clock_timestamp() AND NEW.candidate_key IS NOT NULL) OR
      (OLD.state = 'inspecting' AND NEW.state IN ('quarantined','rejected') AND NEW.candidate_key IS NULL)) THEN
      RAISE EXCEPTION 'candidate object is immutable outside an inspection attempt' USING ERRCODE = '23514'; END IF;
    IF (NEW.preparation_id,NEW.prepared_size,NEW.prepared_sha256) IS DISTINCT FROM (OLD.preparation_id,OLD.prepared_size,OLD.prepared_sha256)
      AND NOT (OLD.state = 'inspecting' AND NEW.state = 'ready' AND OLD.preparation_id IS NULL) THEN
      RAISE EXCEPTION 'prepared evidence link is immutable' USING ERRCODE = '23514'; END IF;
    IF OLD.state = 'inspecting' AND NEW.state = 'ready' AND NOT EXISTS (
      SELECT 1 FROM cb_media_preparations p WHERE (p.center_id,p.conversation_id,p.upload_id,p.id,p.upload_version,p.lease_id,p.source_key,p.derivative_key,p.derivative_size,p.derivative_sha256) =
        (NEW.center_id,NEW.conversation_id,NEW.id,NEW.preparation_id,OLD.version,OLD.lease_id,NEW.object_key,NEW.candidate_key,NEW.prepared_size,NEW.prepared_sha256)
      AND NEW.scan_report = jsonb_build_object('verdict','clean','engine','clamav','engineVersion',p.evidence->'sourceScan'->>'engineVersion',
        'policyVersion','carebridge-media-v1','media',p.evidence->'preparation'->'derivativeDecode'->'media')) THEN
      RAISE EXCEPTION 'approval requires exact committed preparation evidence' USING ERRCODE = '23514'; END IF;
  END IF;
  IF NEW.state IN ('receiving','quarantined','inspecting','ready','bound') AND NOT EXISTS (
    SELECT 1 FROM cb_media_objects WHERE key = NEW.object_key AND state = 'active') THEN RAISE EXCEPTION 'original object must be active' USING ERRCODE = '23514'; END IF;
  IF NEW.candidate_key IS NOT NULL AND NEW.state IN ('inspecting','ready','bound') AND NOT EXISTS (
    SELECT 1 FROM cb_media_objects WHERE key = NEW.candidate_key AND state = 'active') THEN RAISE EXCEPTION 'candidate object must be active' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END; $$;
CREATE OR REPLACE FUNCTION cb_media_object_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'object ledger is retained' USING ERRCODE = '23514'; END IF;
  IF EXISTS (SELECT 1 FROM cb_media_uploads WHERE state = 'bound' AND (object_key = OLD.key OR candidate_key = OLD.key)) THEN
    RAISE EXCEPTION 'bound original and derivative bytes are retained' USING ERRCODE = '23514'; END IF;
  IF (to_jsonb(NEW) - 'state') IS DISTINCT FROM (to_jsonb(OLD) - 'state') OR NOT (
    (OLD.state = 'active' AND NEW.state = 'delete_pending') OR (OLD.state = 'delete_pending' AND NEW.state = 'deleted')) THEN
    RAISE EXCEPTION 'invalid object transition' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END; $$;
CREATE FUNCTION cb_require_active_media_object() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Deferred to allow cancellation intent + root transition in one transaction.
  IF EXISTS (SELECT 1 FROM cb_media_uploads u JOIN cb_media_objects o ON o.key = NEW.key
    WHERE o.state <> 'active' AND u.state IN ('receiving','quarantined','inspecting','ready','bound') AND (u.object_key = o.key OR u.candidate_key = o.key)) THEN
    RAISE EXCEPTION 'current media objects cannot be abandoned' USING ERRCODE = '23514'; END IF;
  RETURN NULL;
END; $$;
CREATE CONSTRAINT TRIGGER cb_media_active_object AFTER UPDATE ON cb_media_objects
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION cb_require_active_media_object();
CREATE INDEX cb_media_candidate_lookup ON cb_media_uploads(candidate_key) WHERE candidate_key IS NOT NULL;
CREATE INDEX cb_media_expired_inspection ON cb_media_uploads(lease_until) WHERE state = 'inspecting';

-- Budget both original and serving byte counts, including a larger derivative.
CREATE OR REPLACE FUNCTION cb_attachment_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE media cb_media_uploads%ROWTYPE; is_sealed boolean; author text; previous_bytes bigint;
BEGIN
  SELECT * INTO media FROM cb_media_uploads WHERE center_id = NEW.center_id AND conversation_id = NEW.conversation_id AND id = NEW.upload_id FOR SHARE;
  IF media.state IS DISTINCT FROM 'bound' THEN RAISE EXCEPTION 'attachment must be approved and bound' USING ERRCODE = '23514'; END IF;
  IF TG_TABLE_NAME = 'cb_message_attachments' THEN
    SELECT attachments_sealed,author_id INTO is_sealed,author FROM cb_messages WHERE center_id = NEW.center_id AND conversation_id = NEW.conversation_id AND id = NEW.message_id AND kind = 'text' FOR UPDATE;
    IF media.bound_message_id IS DISTINCT FROM NEW.message_id OR media.owner_id IS DISTINCT FROM author THEN RAISE EXCEPTION 'message origin mismatch' USING ERRCODE = '23514'; END IF;
    SELECT COALESCE(sum(greatest(u.size,COALESCE(u.prepared_size,0))),0) INTO previous_bytes FROM cb_message_attachments a JOIN cb_media_uploads u ON (u.center_id,u.conversation_id,u.id) = (a.center_id,a.conversation_id,a.upload_id)
      WHERE a.center_id = NEW.center_id AND a.conversation_id = NEW.conversation_id AND a.message_id = NEW.message_id;
  ELSIF TG_TABLE_NAME = 'cb_record_attachments' THEN
    SELECT sealed,author_id INTO is_sealed,author FROM cb_record_revisions WHERE center_id = NEW.center_id AND conversation_id = NEW.conversation_id AND record_id = NEW.record_id AND revision = NEW.revision FOR UPDATE;
    IF media.bound_record_id IS DISTINCT FROM NEW.record_id OR (media.owner_id IS DISTINCT FROM author AND NOT EXISTS (
      SELECT 1 FROM cb_record_attachments WHERE center_id = NEW.center_id AND conversation_id = NEW.conversation_id AND record_id = NEW.record_id AND upload_id = NEW.upload_id)) THEN
      RAISE EXCEPTION 'record origin mismatch' USING ERRCODE = '23514'; END IF;
    SELECT COALESCE(sum(greatest(u.size,COALESCE(u.prepared_size,0))),0) INTO previous_bytes FROM cb_record_attachments a JOIN cb_media_uploads u ON (u.center_id,u.conversation_id,u.id) = (a.center_id,a.conversation_id,a.upload_id)
      WHERE a.center_id = NEW.center_id AND a.conversation_id = NEW.conversation_id AND a.record_id = NEW.record_id AND a.revision = NEW.revision;
  ELSIF TG_TABLE_NAME = 'cb_feedback_attachments' THEN
    SELECT v.attachments_sealed,f.author_id INTO is_sealed,author FROM cb_feedback_revisions v JOIN cb_activity_feedback f
      ON (f.center_id,f.conversation_id,f.id) = (v.center_id,v.conversation_id,v.feedback_id)
      WHERE v.center_id = NEW.center_id AND v.conversation_id = NEW.conversation_id AND v.feedback_id = NEW.feedback_id AND v.revision = NEW.revision FOR UPDATE OF v;
    IF media.bound_feedback_id IS DISTINCT FROM NEW.feedback_id OR media.owner_id IS DISTINCT FROM author THEN RAISE EXCEPTION 'feedback origin mismatch' USING ERRCODE = '23514'; END IF;
    SELECT COALESCE(sum(greatest(u.size,COALESCE(u.prepared_size,0))),0) INTO previous_bytes FROM cb_feedback_attachments a JOIN cb_media_uploads u ON (u.center_id,u.conversation_id,u.id) = (a.center_id,a.conversation_id,a.upload_id)
      WHERE a.center_id = NEW.center_id AND a.conversation_id = NEW.conversation_id AND a.feedback_id = NEW.feedback_id AND a.revision = NEW.revision;
  ELSE
    SELECT attachments_sealed INTO is_sealed FROM cb_record_publications WHERE center_id = NEW.center_id AND conversation_id = NEW.conversation_id AND publication_id = NEW.publication_id FOR UPDATE;
    IF media.bound_record_id IS DISTINCT FROM NEW.record_id THEN RAISE EXCEPTION 'publication origin mismatch' USING ERRCODE = '23514'; END IF;
    SELECT COALESCE(sum(greatest(u.size,COALESCE(u.prepared_size,0))),0) INTO previous_bytes FROM cb_publication_attachments a JOIN cb_media_uploads u ON (u.center_id,u.conversation_id,u.id) = (a.center_id,a.conversation_id,a.upload_id)
      WHERE a.center_id = NEW.center_id AND a.conversation_id = NEW.conversation_id AND a.publication_id = NEW.publication_id;
  END IF;
  IF is_sealed IS DISTINCT FROM false OR previous_bytes + greatest(media.size,COALESCE(media.prepared_size,0)) > 104857600 THEN
    RAISE EXCEPTION 'sealed list or attachment budget exceeded' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END; $$;
