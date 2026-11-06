-- Additive text lifecycle. Original send rows, request hashes, file lists and
-- sealed clinical revisions remain immutable; no original body is rewritten.
CREATE TABLE cb_message_text_heads (
  center_id text NOT NULL, conversation_id text NOT NULL, message_id text NOT NULL,
  current_revision integer NOT NULL CHECK (current_revision > 0),
  PRIMARY KEY (center_id,conversation_id,message_id),
  FOREIGN KEY (center_id,conversation_id,message_id) REFERENCES cb_messages(center_id,conversation_id,id)
);
CREATE TABLE cb_message_text_revisions (
  center_id text NOT NULL, conversation_id text NOT NULL, message_id text NOT NULL,
  revision integer NOT NULL CHECK (revision > 0), actor_id text NOT NULL,
  operation text NOT NULL CHECK (operation IN ('sent','edit','all')),
  body text, changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (center_id,conversation_id,message_id,revision),
  CHECK ((revision = 1 AND operation = 'sent') OR (revision > 1 AND operation IN ('edit','all'))),
  CHECK ((operation = 'all' AND body IS NULL) OR (operation <> 'all' AND body IS NOT NULL AND length(body) <= 2000)),
  FOREIGN KEY (center_id,conversation_id,message_id) REFERENCES cb_message_text_heads(center_id,conversation_id,message_id),
  FOREIGN KEY (center_id,conversation_id,actor_id) REFERENCES cb_participants(center_id,conversation_id,user_id)
);
ALTER TABLE cb_message_text_heads ADD CONSTRAINT cb_message_text_current
  FOREIGN KEY (center_id,conversation_id,message_id,current_revision)
  REFERENCES cb_message_text_revisions(center_id,conversation_id,message_id,revision) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE cb_message_reply_versions (
  center_id text NOT NULL, conversation_id text NOT NULL, message_id text NOT NULL,
  source_id text NOT NULL, source_revision integer NOT NULL,
  PRIMARY KEY (center_id,conversation_id,message_id),
  FOREIGN KEY (center_id,conversation_id,message_id) REFERENCES cb_messages(center_id,conversation_id,id),
  FOREIGN KEY (center_id,conversation_id,source_id,source_revision)
    REFERENCES cb_message_text_revisions(center_id,conversation_id,message_id,revision)
);
CREATE TABLE cb_message_hides (
  center_id text NOT NULL, conversation_id text NOT NULL, message_id text NOT NULL, user_id text NOT NULL,
  hidden_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (center_id,conversation_id,message_id,user_id),
  FOREIGN KEY (center_id,conversation_id,message_id) REFERENCES cb_message_text_heads(center_id,conversation_id,message_id),
  FOREIGN KEY (center_id,conversation_id,user_id) REFERENCES cb_participants(center_id,conversation_id,user_id)
);
CREATE TABLE cb_message_change_requests (
  center_id text NOT NULL, conversation_id text NOT NULL, actor_id text NOT NULL,
  client_id text NOT NULL CHECK (client_id ~ '^[a-zA-Z0-9-]{8,100}$'),
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  operation text NOT NULL CHECK (operation IN ('edit','self','all')),
  message_id text NOT NULL, message_revision integer NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (center_id,actor_id,client_id),
  FOREIGN KEY (center_id,conversation_id,actor_id) REFERENCES cb_participants(center_id,conversation_id,user_id),
  FOREIGN KEY (center_id,conversation_id,message_id,message_revision)
    REFERENCES cb_message_text_revisions(center_id,conversation_id,message_id,revision)
);
ALTER TABLE cb_record_references ADD CONSTRAINT cb_record_reference_source_identity
  UNIQUE (center_id,conversation_id,record_id,revision,ordinal,message_id);
CREATE TABLE cb_record_text_sources (
  center_id text NOT NULL, conversation_id text NOT NULL, record_id text NOT NULL, revision integer NOT NULL,
  ordinal integer NOT NULL, message_id text NOT NULL, message_revision integer NOT NULL,
  PRIMARY KEY (center_id,conversation_id,record_id,revision,ordinal),
  FOREIGN KEY (center_id,conversation_id,record_id,revision,ordinal,message_id)
    REFERENCES cb_record_references(center_id,conversation_id,record_id,revision,ordinal,message_id),
  FOREIGN KEY (center_id,conversation_id,message_id,message_revision)
    REFERENCES cb_message_text_revisions(center_id,conversation_id,message_id,revision)
);
-- Backfill only NEW sidecars: existing body/attachments/clinical rows unchanged.
INSERT INTO cb_message_text_heads SELECT center_id,conversation_id,id,1 FROM cb_messages WHERE kind='text';
INSERT INTO cb_message_text_revisions
  SELECT center_id,conversation_id,id,1,author_id,'sent',body,created_at FROM cb_messages WHERE kind='text';
INSERT INTO cb_message_reply_versions
  SELECT m.center_id,m.conversation_id,m.id,q.id,1 FROM cb_messages m JOIN cb_messages q
  ON (q.center_id,q.conversation_id,q.id)=(m.center_id,m.conversation_id,m.reply_to) WHERE q.kind='text';
INSERT INTO cb_record_text_sources
  SELECT r.center_id,r.conversation_id,r.record_id,r.revision,r.ordinal,r.message_id,1
  FROM cb_record_references r JOIN cb_messages m
  ON (m.center_id,m.conversation_id,m.id)=(r.center_id,r.conversation_id,r.message_id) WHERE m.kind='text';
ALTER TABLE cb_message_reviews ADD COLUMN message_revision integer NOT NULL DEFAULT 1,
  ADD FOREIGN KEY (center_id,conversation_id,message_id,message_revision)
    REFERENCES cb_message_text_revisions(center_id,conversation_id,message_id,revision);

CREATE FUNCTION cb_message_text_revision_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE original cb_messages%ROWTYPE; head integer; previous cb_message_text_revisions%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'text history is immutable' USING ERRCODE='23514'; END IF;
  SELECT * INTO original FROM cb_messages WHERE (center_id,conversation_id,id)=(NEW.center_id,NEW.conversation_id,NEW.message_id);
  SELECT current_revision INTO head FROM cb_message_text_heads WHERE
    (center_id,conversation_id,message_id)=(NEW.center_id,NEW.conversation_id,NEW.message_id) FOR UPDATE;
  IF original.kind IS DISTINCT FROM 'text' OR NEW.actor_id IS DISTINCT FROM original.author_id THEN
    RAISE EXCEPTION 'invalid text identity' USING ERRCODE='23514'; END IF;
  IF NEW.revision=1 THEN
    IF head IS DISTINCT FROM 1 OR NEW.body IS DISTINCT FROM original.body OR NEW.changed_at IS DISTINCT FROM original.created_at THEN
      RAISE EXCEPTION 'invalid initial text' USING ERRCODE='23514'; END IF;
  ELSE
    SELECT * INTO previous FROM cb_message_text_revisions WHERE
      (center_id,conversation_id,message_id,revision)=(NEW.center_id,NEW.conversation_id,NEW.message_id,head);
    IF NEW.revision::bigint <> head::bigint+1 OR previous.operation='all' OR NOT original.attachments_sealed OR
        NEW.changed_at < previous.changed_at OR NEW.changed_at > clock_timestamp() THEN
      RAISE EXCEPTION 'invalid text advance' USING ERRCODE='23514'; END IF;
    IF clock_timestamp() > original.created_at+interval '24 hours' OR NEW.changed_at < original.created_at THEN
      RAISE EXCEPTION 'text change expired' USING ERRCODE='23514',CONSTRAINT='cb_message_change_window'; END IF;
    IF NEW.operation='edit' AND (NEW.body IS DISTINCT FROM btrim(NEW.body) OR NEW.body IS NOT DISTINCT FROM previous.body OR
        (NEW.body='' AND NOT EXISTS (SELECT 1 FROM cb_message_attachments WHERE
          (center_id,conversation_id,message_id)=(NEW.center_id,NEW.conversation_id,NEW.message_id)))) THEN
      RAISE EXCEPTION 'invalid edited text' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END; $$;
CREATE FUNCTION cb_message_text_head_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR TG_OP='INSERT' AND (NEW.current_revision<>1 OR NOT EXISTS
      (SELECT 1 FROM cb_messages WHERE (center_id,conversation_id,id)=(NEW.center_id,NEW.conversation_id,NEW.message_id) AND kind='text')) OR
      TG_OP='UPDATE' AND ((to_jsonb(NEW)-'current_revision') IS DISTINCT FROM (to_jsonb(OLD)-'current_revision') OR
        NEW.current_revision::bigint<>OLD.current_revision::bigint+1) THEN
    RAISE EXCEPTION 'invalid text head' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END; $$;
CREATE FUNCTION cb_require_message_text_head() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM cb_message_text_heads h WHERE
      (h.center_id,h.conversation_id,h.message_id)=(NEW.center_id,NEW.conversation_id,NEW.message_id) AND
      h.current_revision=(SELECT max(r.revision) FROM cb_message_text_revisions r WHERE
        (r.center_id,r.conversation_id,r.message_id)=(h.center_id,h.conversation_id,h.message_id))) THEN
    RAISE EXCEPTION 'text head and history differ' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END; $$;
CREATE FUNCTION cb_message_text_reference_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target text; selected integer; source cb_message_text_revisions%ROWTYPE;
BEGIN
  IF TG_TABLE_NAME='cb_message_reply_versions' THEN
    SELECT reply_to INTO target FROM cb_messages WHERE
      (center_id,conversation_id,id)=(NEW.center_id,NEW.conversation_id,NEW.message_id) AND kind='text';
    IF target IS DISTINCT FROM NEW.source_id OR NOT EXISTS (SELECT 1 FROM cb_message_text_heads WHERE
        (center_id,conversation_id,message_id,current_revision)=(NEW.center_id,NEW.conversation_id,NEW.source_id,NEW.source_revision)) THEN
      RAISE EXCEPTION 'reply version differs' USING ERRCODE='23514'; END IF;
    target:=NEW.source_id; selected:=NEW.source_revision;
  ELSE target:=NEW.message_id; selected:=NEW.message_revision;
  END IF;
  SELECT * INTO source FROM cb_message_text_revisions WHERE
    (center_id,conversation_id,message_id,revision)=(NEW.center_id,NEW.conversation_id,target,selected);
  IF source.operation IS NULL OR source.operation='all' THEN
    RAISE EXCEPTION 'invalid text reference' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END; $$;
CREATE FUNCTION cb_require_text_reference() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM cb_messages WHERE (center_id,conversation_id,id)=(NEW.center_id,NEW.conversation_id,NEW.message_id) AND kind='text')
      AND NOT EXISTS (SELECT 1 FROM cb_record_text_sources WHERE
        (center_id,conversation_id,record_id,revision,ordinal,message_id)=
        (NEW.center_id,NEW.conversation_id,NEW.record_id,NEW.revision,NEW.ordinal,NEW.message_id)) THEN
    RAISE EXCEPTION 'clinical text reference must pin a version' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END; $$;
CREATE FUNCTION cb_message_hide_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.hidden_at>clock_timestamp() OR NOT EXISTS (SELECT 1 FROM cb_messages WHERE
      (center_id,conversation_id,id)=(NEW.center_id,NEW.conversation_id,NEW.message_id) AND kind='text' AND created_at<=NEW.hidden_at) THEN
    RAISE EXCEPTION 'invalid hidden text' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END; $$;
CREATE FUNCTION cb_message_text_capture() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind='text' THEN
    INSERT INTO cb_message_text_heads VALUES (NEW.center_id,NEW.conversation_id,NEW.id,1);
    INSERT INTO cb_message_text_revisions VALUES (NEW.center_id,NEW.conversation_id,NEW.id,1,NEW.author_id,'sent',NEW.body,NEW.created_at);
    INSERT INTO cb_message_reply_versions
      SELECT NEW.center_id,NEW.conversation_id,NEW.id,h.message_id,h.current_revision FROM cb_message_text_heads h WHERE
      (h.center_id,h.conversation_id,h.message_id)=(NEW.center_id,NEW.conversation_id,NEW.reply_to);
  END IF;
  RETURN NULL;
END; $$;
CREATE TRIGGER cb_message_text_capture AFTER INSERT ON cb_messages FOR EACH ROW EXECUTE FUNCTION cb_message_text_capture();
CREATE TRIGGER cb_message_text_revision_guard BEFORE INSERT OR UPDATE OR DELETE ON cb_message_text_revisions FOR EACH ROW EXECUTE FUNCTION cb_message_text_revision_guard();
CREATE TRIGGER cb_message_text_head_guard BEFORE INSERT OR UPDATE OR DELETE ON cb_message_text_heads FOR EACH ROW EXECUTE FUNCTION cb_message_text_head_guard();
CREATE CONSTRAINT TRIGGER cb_message_text_head_complete AFTER INSERT OR UPDATE ON cb_message_text_heads DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION cb_require_message_text_head();
CREATE CONSTRAINT TRIGGER cb_message_text_history_complete AFTER INSERT ON cb_message_text_revisions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION cb_require_message_text_head();
CREATE TRIGGER cb_message_reply_version_guard BEFORE INSERT ON cb_message_reply_versions FOR EACH ROW EXECUTE FUNCTION cb_message_text_reference_guard();
CREATE TRIGGER cb_record_text_source_guard BEFORE INSERT ON cb_record_text_sources FOR EACH ROW EXECUTE FUNCTION cb_message_text_reference_guard();
CREATE TRIGGER cb_record_text_source_seal BEFORE INSERT ON cb_record_text_sources FOR EACH ROW EXECUTE FUNCTION cb_check_record_detail_insert();
CREATE CONSTRAINT TRIGGER cb_record_text_source_complete AFTER INSERT ON cb_record_references DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION cb_require_text_reference();
CREATE TRIGGER cb_message_hide_guard BEFORE INSERT ON cb_message_hides FOR EACH ROW EXECUTE FUNCTION cb_message_hide_guard();
CREATE TRIGGER cb_message_reply_immutable BEFORE UPDATE OR DELETE ON cb_message_reply_versions FOR EACH ROW EXECUTE FUNCTION cb_immutable_record_data();
CREATE TRIGGER cb_record_text_source_immutable BEFORE UPDATE OR DELETE ON cb_record_text_sources FOR EACH ROW EXECUTE FUNCTION cb_immutable_record_data();
CREATE TRIGGER cb_message_hide_immutable BEFORE UPDATE OR DELETE ON cb_message_hides FOR EACH ROW EXECUTE FUNCTION cb_immutable_record_data();
CREATE TRIGGER cb_message_change_request_immutable BEFORE UPDATE OR DELETE ON cb_message_change_requests FOR EACH ROW EXECUTE FUNCTION cb_immutable_record_data();
ALTER TABLE cb_audit_events DROP CONSTRAINT cb_audit_events_action_check,
  ADD CONSTRAINT cb_audit_events_action_check CHECK (action IN (
    'message.sent','publication.shared','publication.withdrawn','message.reviewed',
    'feedback.submitted','feedback.updated','feedback.reviewed','message.edited','message.hidden','message.deleted'));
