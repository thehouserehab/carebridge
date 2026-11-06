-- Preserve 001-008 histories. Each file has one immutable clinical origin;
-- later revisions/publications reference it rather than copying its bytes.
ALTER TABLE cb_media_uploads
  ADD COLUMN bound_message_id text,
  ADD COLUMN bound_record_id text,
  ADD COLUMN bound_feedback_id text,
  ADD FOREIGN KEY (center_id,conversation_id,bound_message_id) REFERENCES cb_messages(center_id,conversation_id,id),
  ADD FOREIGN KEY (center_id,conversation_id,bound_record_id) REFERENCES cb_records(center_id,conversation_id,id),
  ADD FOREIGN KEY (center_id,conversation_id,bound_feedback_id) REFERENCES cb_activity_feedback(center_id,conversation_id,id);
-- Replace only checks containing ready; all manifest/lease/scan-shape checks
-- remain. Explicit names below avoid depending on generated check ordinals.
DO $$ DECLARE item record; BEGIN
  FOR item IN SELECT conname FROM pg_constraint WHERE conrelid = 'cb_media_uploads'::regclass
    AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%ready%' LOOP
    EXECUTE format('ALTER TABLE cb_media_uploads DROP CONSTRAINT %I',item.conname);
  END LOOP;
END; $$;
ALTER TABLE cb_media_uploads
  ADD CONSTRAINT cb_media_state CHECK (state IN ('pending','receiving','quarantined','inspecting','ready','bound','rejected','delete_pending','deleted')),
  ADD CONSTRAINT cb_media_origin CHECK (num_nonnulls(bound_message_id,bound_record_id,bound_feedback_id) = CASE WHEN state = 'bound' THEN 1 ELSE 0 END),
  ADD CONSTRAINT cb_media_has_object CHECK (state NOT IN ('receiving','quarantined','inspecting','ready','bound') OR object_key IS NOT NULL),
  ADD CONSTRAINT cb_media_approved CHECK (state NOT IN ('ready','bound') OR (scan_report IS NOT NULL AND failure_code IS NULL AND COALESCE(scan_report->>'verdict' = 'clean',false))),
  ADD CONSTRAINT cb_media_decoded CHECK (state NOT IN ('ready','bound') OR COALESCE((scan_report->'media'->>'type' = type
    AND (scan_report->'media'->>'width')::integer BETWEEN 1 AND 8192
    AND (scan_report->'media'->>'height')::integer BETWEEN 1 AND 8192
    AND (scan_report->'media'->>'width')::bigint * (scan_report->'media'->>'height')::bigint <= 40000000
    AND (type LIKE 'image/%' OR (scan_report->'media'->>'duration')::numeric > 0
      AND (scan_report->'media'->>'duration')::numeric <= 600)),false));
DROP INDEX cb_media_expiry;
CREATE INDEX cb_media_expiry ON cb_media_uploads(expires_at) WHERE state NOT IN ('bound','delete_pending','deleted');
CREATE INDEX cb_media_bound_object ON cb_media_uploads(object_key) WHERE state = 'bound';

ALTER TABLE cb_messages ADD COLUMN attachments_sealed boolean NOT NULL DEFAULT true;
ALTER TABLE cb_feedback_revisions ADD COLUMN attachments_sealed boolean NOT NULL DEFAULT true;
ALTER TABLE cb_record_publications
  ADD COLUMN attachments_sealed boolean NOT NULL DEFAULT true,
  ADD UNIQUE (center_id,conversation_id,publication_id,record_id,record_revision);
ALTER TABLE cb_messages DROP CONSTRAINT cb_message_content,
  ADD CONSTRAINT cb_message_content CHECK (
    (kind = 'text' AND feedback_id IS NULL AND publication_id IS NULL AND body IS NOT NULL AND length(btrim(body)) BETWEEN 0 AND 2000) OR
    (kind = 'publication' AND feedback_id IS NULL AND publication_id IS NOT NULL AND body IS NULL AND reply_to IS NULL) OR
    (kind = 'feedback' AND feedback_id IS NOT NULL AND publication_id IS NULL AND body IS NULL AND reply_to IS NULL));

CREATE TABLE cb_message_attachments (
  center_id text NOT NULL, conversation_id text NOT NULL, message_id text NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 0 AND 5), upload_id text NOT NULL,
  PRIMARY KEY (center_id,conversation_id,message_id,ordinal),
  UNIQUE (center_id,conversation_id,message_id,upload_id),
  FOREIGN KEY (center_id,conversation_id,message_id) REFERENCES cb_messages(center_id,conversation_id,id),
  FOREIGN KEY (center_id,conversation_id,upload_id) REFERENCES cb_media_uploads(center_id,conversation_id,id)
);
CREATE TABLE cb_record_attachments (
  center_id text NOT NULL, conversation_id text NOT NULL, record_id text NOT NULL, revision integer NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 0 AND 5), upload_id text NOT NULL, share boolean NOT NULL DEFAULT false,
  PRIMARY KEY (center_id,conversation_id,record_id,revision,ordinal),
  UNIQUE (center_id,conversation_id,record_id,revision,upload_id),
  UNIQUE (center_id,conversation_id,record_id,revision,upload_id,share),
  FOREIGN KEY (center_id,conversation_id,record_id,revision) REFERENCES cb_record_revisions(center_id,conversation_id,record_id,revision),
  FOREIGN KEY (center_id,conversation_id,upload_id) REFERENCES cb_media_uploads(center_id,conversation_id,id)
);
CREATE TABLE cb_feedback_attachments (
  center_id text NOT NULL, conversation_id text NOT NULL, feedback_id text NOT NULL, revision integer NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 0 AND 5), upload_id text NOT NULL,
  PRIMARY KEY (center_id,conversation_id,feedback_id,revision,ordinal),
  UNIQUE (center_id,conversation_id,feedback_id,revision,upload_id),
  FOREIGN KEY (center_id,conversation_id,feedback_id,revision) REFERENCES cb_feedback_revisions(center_id,conversation_id,feedback_id,revision),
  FOREIGN KEY (center_id,conversation_id,upload_id) REFERENCES cb_media_uploads(center_id,conversation_id,id)
);
CREATE TABLE cb_publication_attachments (
  center_id text NOT NULL, conversation_id text NOT NULL, publication_id text NOT NULL,
  record_id text NOT NULL, record_revision integer NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 0 AND 5), upload_id text NOT NULL, share boolean NOT NULL DEFAULT true CHECK (share),
  PRIMARY KEY (center_id,conversation_id,publication_id,ordinal),
  UNIQUE (center_id,conversation_id,publication_id,upload_id),
  FOREIGN KEY (center_id,conversation_id,publication_id,record_id,record_revision)
    REFERENCES cb_record_publications(center_id,conversation_id,publication_id,record_id,record_revision),
  FOREIGN KEY (center_id,conversation_id,record_id,record_revision,upload_id,share)
    REFERENCES cb_record_attachments(center_id,conversation_id,record_id,revision,upload_id,share)
);

CREATE OR REPLACE FUNCTION cb_media_root_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'media manifests are retained' USING ERRCODE = '23514'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.version <> 1 OR NEW.state <> 'pending' OR NEW.object_key IS NOT NULL OR NEW.scan_report IS NOT NULL THEN
      RAISE EXCEPTION 'upload starts pending' USING ERRCODE = '23514'; END IF;
  ELSE
    IF (to_jsonb(NEW) - ARRAY['version','state','object_key','lease_id','lease_until','scan_report','failure_code','bound_message_id','bound_record_id','bound_feedback_id'])
      IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['version','state','object_key','lease_id','lease_until','scan_report','failure_code','bound_message_id','bound_record_id','bound_feedback_id'])
      OR NEW.version::bigint <> OLD.version::bigint + 1 OR NOT (
        (OLD.state = 'pending' AND NEW.state IN ('receiving','delete_pending')) OR
        (OLD.state = 'receiving' AND NEW.state IN ('pending','quarantined','rejected','delete_pending')) OR
        (OLD.state = 'receiving' AND NEW.state = 'receiving' AND OLD.lease_until <= clock_timestamp()) OR
        (OLD.state = 'quarantined' AND NEW.state IN ('inspecting','delete_pending')) OR
        (OLD.state = 'inspecting' AND NEW.state IN ('quarantined','ready','rejected','delete_pending')) OR
        (OLD.state = 'inspecting' AND NEW.state = 'inspecting' AND OLD.lease_until <= clock_timestamp()) OR
        (OLD.state = 'ready' AND NEW.state = 'bound' AND OLD.expires_at > clock_timestamp()) OR
        (OLD.state IN ('ready','rejected') AND NEW.state = 'delete_pending') OR
        (OLD.state = 'delete_pending' AND NEW.state = 'deleted')) THEN
      RAISE EXCEPTION 'invalid media transition' USING ERRCODE = '23514';
    END IF;
    IF OLD.state = 'deleted' OR (OLD.state NOT IN ('pending','receiving') AND NEW.object_key IS DISTINCT FROM OLD.object_key) THEN
      RAISE EXCEPTION 'media object is immutable' USING ERRCODE = '23514'; END IF;
    IF OLD.state <> 'inspecting' AND NEW.scan_report IS DISTINCT FROM OLD.scan_report THEN
      RAISE EXCEPTION 'inspection proof is immutable' USING ERRCODE = '23514'; END IF;
    IF (NEW.bound_message_id,NEW.bound_record_id,NEW.bound_feedback_id) IS DISTINCT FROM (OLD.bound_message_id,OLD.bound_record_id,OLD.bound_feedback_id)
      AND NOT (OLD.state = 'ready' AND NEW.state = 'bound') THEN
      RAISE EXCEPTION 'file origin is immutable' USING ERRCODE = '23514'; END IF;
  END IF;
  IF NEW.state IN ('receiving','quarantined','inspecting','ready','bound') AND NOT EXISTS (
    SELECT 1 FROM cb_media_objects o WHERE (o.center_id,o.conversation_id,o.upload_id,o.key) =
      (NEW.center_id,NEW.conversation_id,NEW.id,NEW.object_key) AND o.state = 'active') THEN
    RAISE EXCEPTION 'current object must be active' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END; $$;
CREATE OR REPLACE FUNCTION cb_media_object_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'object ledger is retained' USING ERRCODE = '23514'; END IF;
  IF EXISTS (SELECT 1 FROM cb_media_uploads u WHERE u.state = 'bound' AND u.object_key = OLD.key) THEN
    RAISE EXCEPTION 'bound bytes are retained' USING ERRCODE = '23514'; END IF;
  IF (to_jsonb(NEW) - 'state') IS DISTINCT FROM (to_jsonb(OLD) - 'state') OR NOT (
    (OLD.state = 'active' AND NEW.state = 'delete_pending') OR (OLD.state = 'delete_pending' AND NEW.state = 'deleted')) THEN
    RAISE EXCEPTION 'invalid object transition' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END; $$;
CREATE FUNCTION cb_require_media_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state = 'bound' AND NOT (
    EXISTS (SELECT 1 FROM cb_message_attachments WHERE center_id = NEW.center_id AND conversation_id = NEW.conversation_id AND message_id = NEW.bound_message_id AND upload_id = NEW.id) OR
    EXISTS (SELECT 1 FROM cb_record_attachments WHERE center_id = NEW.center_id AND conversation_id = NEW.conversation_id AND record_id = NEW.bound_record_id AND upload_id = NEW.id) OR
    EXISTS (SELECT 1 FROM cb_feedback_attachments WHERE center_id = NEW.center_id AND conversation_id = NEW.conversation_id AND feedback_id = NEW.bound_feedback_id AND upload_id = NEW.id)) THEN
    RAISE EXCEPTION 'bound file requires an immutable origin link' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END; $$;
CREATE CONSTRAINT TRIGGER cb_media_binding_guard AFTER UPDATE ON cb_media_uploads
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION cb_require_media_binding();

-- Freeze attachment lists before committing the parent. Existing parents have
-- empty sealed lists: a later INSERT cannot alter historical sharing scope.
CREATE FUNCTION cb_seal_attachments_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NOT OLD.attachments_sealed AND NEW.attachments_sealed AND
    (to_jsonb(NEW) - 'attachments_sealed') IS NOT DISTINCT FROM (to_jsonb(OLD) - 'attachments_sealed') THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'attachment parent history is immutable' USING ERRCODE = '23514';
END; $$;
DROP TRIGGER cb_feedback_revision_guard ON cb_feedback_revisions;
CREATE TRIGGER cb_feedback_revision_guard BEFORE UPDATE OR DELETE ON cb_feedback_revisions FOR EACH ROW EXECUTE FUNCTION cb_seal_attachments_only();
DROP TRIGGER cb_record_publication_guard ON cb_record_publications;
CREATE TRIGGER cb_record_publication_guard BEFORE UPDATE OR DELETE ON cb_record_publications FOR EACH ROW EXECUTE FUNCTION cb_seal_attachments_only();
CREATE TRIGGER cb_message_immutable_guard BEFORE UPDATE OR DELETE ON cb_messages FOR EACH ROW EXECUTE FUNCTION cb_seal_attachments_only();
CREATE FUNCTION cb_require_attachments_sealed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE is_sealed boolean; body_text text; message_kind text;
BEGIN
  IF TG_TABLE_NAME = 'cb_messages' THEN
    SELECT attachments_sealed,body,kind INTO is_sealed,body_text,message_kind FROM cb_messages WHERE center_id = NEW.center_id AND conversation_id = NEW.conversation_id AND id = NEW.id;
    IF message_kind = 'text' AND length(btrim(body_text)) = 0 AND NOT EXISTS (
      SELECT 1 FROM cb_message_attachments WHERE center_id = NEW.center_id AND conversation_id = NEW.conversation_id AND message_id = NEW.id) THEN
      RAISE EXCEPTION 'empty message requires media' USING ERRCODE = '23514'; END IF;
  ELSIF TG_TABLE_NAME = 'cb_feedback_revisions' THEN
    SELECT attachments_sealed INTO is_sealed FROM cb_feedback_revisions WHERE center_id = NEW.center_id AND conversation_id = NEW.conversation_id AND feedback_id = NEW.feedback_id AND revision = NEW.revision;
  ELSE
    SELECT attachments_sealed INTO is_sealed FROM cb_record_publications WHERE center_id = NEW.center_id AND conversation_id = NEW.conversation_id AND publication_id = NEW.publication_id;
  END IF;
  IF NOT is_sealed THEN RAISE EXCEPTION 'attachment list must be sealed' USING ERRCODE = '23514'; END IF;
  RETURN NULL;
END; $$;
CREATE CONSTRAINT TRIGGER cb_message_media_sealed AFTER INSERT ON cb_messages DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION cb_require_attachments_sealed();
CREATE CONSTRAINT TRIGGER cb_feedback_media_sealed AFTER INSERT ON cb_feedback_revisions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION cb_require_attachments_sealed();
CREATE CONSTRAINT TRIGGER cb_publication_media_sealed AFTER INSERT ON cb_record_publications DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION cb_require_attachments_sealed();

CREATE FUNCTION cb_attachment_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE media cb_media_uploads%ROWTYPE; is_sealed boolean; author text; previous_bytes bigint;
BEGIN
  SELECT * INTO media FROM cb_media_uploads WHERE center_id = NEW.center_id AND conversation_id = NEW.conversation_id AND id = NEW.upload_id FOR SHARE;
  IF media.state IS DISTINCT FROM 'bound' THEN RAISE EXCEPTION 'attachment must be approved and bound' USING ERRCODE = '23514'; END IF;
  IF TG_TABLE_NAME = 'cb_message_attachments' THEN
    SELECT attachments_sealed,author_id INTO is_sealed,author FROM cb_messages WHERE center_id = NEW.center_id AND conversation_id = NEW.conversation_id AND id = NEW.message_id AND kind = 'text' FOR UPDATE;
    IF media.bound_message_id IS DISTINCT FROM NEW.message_id OR media.owner_id IS DISTINCT FROM author THEN RAISE EXCEPTION 'message origin mismatch' USING ERRCODE = '23514'; END IF;
    SELECT COALESCE(sum(u.size),0) INTO previous_bytes FROM cb_message_attachments a JOIN cb_media_uploads u ON (u.center_id,u.conversation_id,u.id) = (a.center_id,a.conversation_id,a.upload_id)
      WHERE a.center_id = NEW.center_id AND a.conversation_id = NEW.conversation_id AND a.message_id = NEW.message_id;
  ELSIF TG_TABLE_NAME = 'cb_record_attachments' THEN
    SELECT sealed,author_id INTO is_sealed,author FROM cb_record_revisions WHERE center_id = NEW.center_id AND conversation_id = NEW.conversation_id AND record_id = NEW.record_id AND revision = NEW.revision FOR UPDATE;
    IF media.bound_record_id IS DISTINCT FROM NEW.record_id OR (media.owner_id IS DISTINCT FROM author AND NOT EXISTS (
      SELECT 1 FROM cb_record_attachments WHERE center_id = NEW.center_id AND conversation_id = NEW.conversation_id AND record_id = NEW.record_id AND upload_id = NEW.upload_id)) THEN
      RAISE EXCEPTION 'record origin mismatch' USING ERRCODE = '23514'; END IF;
    SELECT COALESCE(sum(u.size),0) INTO previous_bytes FROM cb_record_attachments a JOIN cb_media_uploads u ON (u.center_id,u.conversation_id,u.id) = (a.center_id,a.conversation_id,a.upload_id)
      WHERE a.center_id = NEW.center_id AND a.conversation_id = NEW.conversation_id AND a.record_id = NEW.record_id AND a.revision = NEW.revision;
  ELSIF TG_TABLE_NAME = 'cb_feedback_attachments' THEN
    SELECT v.attachments_sealed,f.author_id INTO is_sealed,author FROM cb_feedback_revisions v JOIN cb_activity_feedback f
      ON (f.center_id,f.conversation_id,f.id) = (v.center_id,v.conversation_id,v.feedback_id)
      WHERE v.center_id = NEW.center_id AND v.conversation_id = NEW.conversation_id AND v.feedback_id = NEW.feedback_id AND v.revision = NEW.revision FOR UPDATE OF v;
    IF media.bound_feedback_id IS DISTINCT FROM NEW.feedback_id OR media.owner_id IS DISTINCT FROM author THEN RAISE EXCEPTION 'feedback origin mismatch' USING ERRCODE = '23514'; END IF;
    SELECT COALESCE(sum(u.size),0) INTO previous_bytes FROM cb_feedback_attachments a JOIN cb_media_uploads u ON (u.center_id,u.conversation_id,u.id) = (a.center_id,a.conversation_id,a.upload_id)
      WHERE a.center_id = NEW.center_id AND a.conversation_id = NEW.conversation_id AND a.feedback_id = NEW.feedback_id AND a.revision = NEW.revision;
  ELSE
    SELECT attachments_sealed INTO is_sealed FROM cb_record_publications WHERE center_id = NEW.center_id AND conversation_id = NEW.conversation_id AND publication_id = NEW.publication_id FOR UPDATE;
    IF media.bound_record_id IS DISTINCT FROM NEW.record_id THEN RAISE EXCEPTION 'publication origin mismatch' USING ERRCODE = '23514'; END IF;
    SELECT COALESCE(sum(u.size),0) INTO previous_bytes FROM cb_publication_attachments a JOIN cb_media_uploads u ON (u.center_id,u.conversation_id,u.id) = (a.center_id,a.conversation_id,a.upload_id)
      WHERE a.center_id = NEW.center_id AND a.conversation_id = NEW.conversation_id AND a.publication_id = NEW.publication_id;
  END IF;
  IF is_sealed IS DISTINCT FROM false OR previous_bytes + media.size > 104857600 THEN
    RAISE EXCEPTION 'sealed list or attachment budget exceeded' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER cb_message_attachment_insert BEFORE INSERT ON cb_message_attachments FOR EACH ROW EXECUTE FUNCTION cb_attachment_insert_guard();
CREATE TRIGGER cb_record_attachment_insert BEFORE INSERT ON cb_record_attachments FOR EACH ROW EXECUTE FUNCTION cb_attachment_insert_guard();
CREATE TRIGGER cb_feedback_attachment_insert BEFORE INSERT ON cb_feedback_attachments FOR EACH ROW EXECUTE FUNCTION cb_attachment_insert_guard();
CREATE TRIGGER cb_publication_attachment_insert BEFORE INSERT ON cb_publication_attachments FOR EACH ROW EXECUTE FUNCTION cb_attachment_insert_guard();
CREATE TRIGGER cb_message_attachment_immutable BEFORE UPDATE OR DELETE ON cb_message_attachments FOR EACH ROW EXECUTE FUNCTION cb_immutable_record_data();
CREATE TRIGGER cb_record_attachment_immutable BEFORE UPDATE OR DELETE ON cb_record_attachments FOR EACH ROW EXECUTE FUNCTION cb_immutable_record_data();
CREATE TRIGGER cb_feedback_attachment_immutable BEFORE UPDATE OR DELETE ON cb_feedback_attachments FOR EACH ROW EXECUTE FUNCTION cb_immutable_record_data();
CREATE TRIGGER cb_publication_attachment_immutable BEFORE UPDATE OR DELETE ON cb_publication_attachments FOR EACH ROW EXECUTE FUNCTION cb_immutable_record_data();
