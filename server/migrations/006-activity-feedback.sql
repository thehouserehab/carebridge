-- Additive migration: existing messages/record revisions remain unchanged.
CREATE TABLE cb_activity_feedback (
  center_id text NOT NULL,
  conversation_id text NOT NULL,
  id text NOT NULL CHECK (length(id) BETWEEN 1 AND 100),
  publication_id text NOT NULL,
  author_id text NOT NULL,
  current_revision integer NOT NULL CHECK (current_revision > 0),
  PRIMARY KEY (center_id, conversation_id, id),
  UNIQUE (center_id, conversation_id, id, author_id),
  FOREIGN KEY (center_id, conversation_id, publication_id)
    REFERENCES cb_record_publications(center_id, conversation_id, publication_id),
  FOREIGN KEY (center_id, conversation_id, author_id)
    REFERENCES cb_participants(center_id, conversation_id, user_id)
);
CREATE TABLE cb_feedback_revisions (
  center_id text NOT NULL,
  conversation_id text NOT NULL,
  feedback_id text NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  activity_date date NOT NULL,
  result text NOT NULL CHECK (result IN ('done', 'partial', 'skipped')),
  reaction text NOT NULL CHECK (length(btrim(reaction)) BETWEEN 1 AND 1000),
  difficulty text NOT NULL CHECK (length(difficulty) <= 1000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (center_id, conversation_id, feedback_id, revision),
  FOREIGN KEY (center_id, conversation_id, feedback_id)
    REFERENCES cb_activity_feedback(center_id, conversation_id, id)
);
ALTER TABLE cb_activity_feedback ADD CONSTRAINT cb_feedback_current_revision
  FOREIGN KEY (center_id, conversation_id, id, current_revision)
  REFERENCES cb_feedback_revisions(center_id, conversation_id, feedback_id, revision)
  DEFERRABLE INITIALLY DEFERRED;

-- Reviews attach to the version actually examined, never automatically to a
-- guardian's later correction. Corrections to a review also retain history.
CREATE TABLE cb_feedback_reviews (
  center_id text NOT NULL,
  conversation_id text NOT NULL,
  feedback_id text NOT NULL,
  feedback_revision integer NOT NULL,
  review_version integer NOT NULL CHECK (review_version > 0),
  reviewer_id text NOT NULL,
  note text NOT NULL CHECK (length(btrim(note)) BETWEEN 1 AND 2000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (center_id, conversation_id, feedback_id, feedback_revision, review_version),
  FOREIGN KEY (center_id, conversation_id, feedback_id, feedback_revision)
    REFERENCES cb_feedback_revisions(center_id, conversation_id, feedback_id, revision),
  FOREIGN KEY (center_id, conversation_id, reviewer_id)
    REFERENCES cb_participants(center_id, conversation_id, user_id)
);

ALTER TABLE cb_messages
  DROP CONSTRAINT cb_messages_kind_check,
  DROP CONSTRAINT cb_messages_check,
  ADD COLUMN feedback_id text,
  ADD COLUMN reply_feedback_id text,
  ADD COLUMN reply_feedback_revision integer,
  ADD CONSTRAINT cb_message_feedback_card UNIQUE (center_id, conversation_id, feedback_id),
  ADD CONSTRAINT cb_message_feedback_identity UNIQUE (center_id, conversation_id, id, feedback_id),
  ADD CONSTRAINT cb_message_kind CHECK (kind IN ('text', 'publication', 'feedback')),
  ADD CONSTRAINT cb_message_content CHECK (
    (kind = 'text' AND feedback_id IS NULL AND publication_id IS NULL AND body IS NOT NULL AND length(btrim(body)) BETWEEN 1 AND 2000) OR
    (kind = 'publication' AND feedback_id IS NULL AND publication_id IS NOT NULL AND body IS NULL AND reply_to IS NULL) OR
    (kind = 'feedback' AND feedback_id IS NOT NULL AND publication_id IS NULL AND body IS NULL AND reply_to IS NULL)),
  ADD CONSTRAINT cb_message_reply_feedback CHECK (
    (reply_feedback_id IS NULL AND reply_feedback_revision IS NULL) OR
    (kind = 'text' AND reply_to IS NOT NULL AND reply_feedback_id IS NOT NULL AND reply_feedback_revision IS NOT NULL)),
  ADD FOREIGN KEY (center_id, conversation_id, feedback_id, author_id)
    REFERENCES cb_activity_feedback(center_id, conversation_id, id, author_id),
  ADD FOREIGN KEY (center_id, conversation_id, reply_feedback_id, reply_feedback_revision)
    REFERENCES cb_feedback_revisions(center_id, conversation_id, feedback_id, revision),
  ADD FOREIGN KEY (center_id, conversation_id, reply_to, reply_feedback_id)
    REFERENCES cb_messages(center_id, conversation_id, id, feedback_id);

-- Every committed feedback has exactly one card. Create root/revision/card in
-- one transaction; edits update the head, not the card's room sequence.
ALTER TABLE cb_activity_feedback ADD CONSTRAINT cb_feedback_has_card
  FOREIGN KEY (center_id, conversation_id, id)
  REFERENCES cb_messages(center_id, conversation_id, feedback_id)
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE cb_record_references
  ADD COLUMN feedback_id text,
  ADD COLUMN feedback_revision integer,
  ADD CONSTRAINT cb_record_reference_feedback CHECK (
    (feedback_id IS NULL AND feedback_revision IS NULL) OR
    (feedback_id IS NOT NULL AND feedback_revision IS NOT NULL)),
  ADD FOREIGN KEY (center_id, conversation_id, feedback_id, feedback_revision)
    REFERENCES cb_feedback_revisions(center_id, conversation_id, feedback_id, revision),
  ADD FOREIGN KEY (center_id, conversation_id, message_id, feedback_id)
    REFERENCES cb_messages(center_id, conversation_id, id, feedback_id);

CREATE TABLE cb_feedback_requests (
  center_id text NOT NULL,
  conversation_id text NOT NULL,
  actor_id text NOT NULL,
  client_id text NOT NULL CHECK (client_id ~ '^[a-zA-Z0-9-]{8,100}$'),
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  operation text NOT NULL CHECK (operation IN ('save', 'review')),
  feedback_id text NOT NULL,
  feedback_revision integer NOT NULL,
  review_version integer,
  message_id text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (center_id, actor_id, client_id),
  CHECK ((operation = 'save' AND review_version IS NULL) OR (operation = 'review' AND review_version IS NOT NULL)),
  FOREIGN KEY (center_id, conversation_id, feedback_id, feedback_revision)
    REFERENCES cb_feedback_revisions(center_id, conversation_id, feedback_id, revision),
  FOREIGN KEY (center_id, conversation_id, feedback_id, feedback_revision, review_version)
    REFERENCES cb_feedback_reviews(center_id, conversation_id, feedback_id, feedback_revision, review_version),
  FOREIGN KEY (center_id, conversation_id, message_id, feedback_id)
    REFERENCES cb_messages(center_id, conversation_id, id, feedback_id),
  FOREIGN KEY (center_id, conversation_id, actor_id)
    REFERENCES cb_participants(center_id, conversation_id, user_id)
);

CREATE FUNCTION cb_immutable_feedback_data() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'feedback history is immutable' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER cb_feedback_revision_guard BEFORE UPDATE OR DELETE ON cb_feedback_revisions
  FOR EACH ROW EXECUTE FUNCTION cb_immutable_feedback_data();
CREATE TRIGGER cb_feedback_review_guard BEFORE UPDATE OR DELETE ON cb_feedback_reviews
  FOR EACH ROW EXECUTE FUNCTION cb_immutable_feedback_data();
CREATE FUNCTION cb_feedback_head_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - 'current_revision') IS DISTINCT FROM (to_jsonb(OLD) - 'current_revision')
      OR NEW.current_revision::bigint <> OLD.current_revision::bigint + 1 THEN
    RAISE EXCEPTION 'feedback identity is immutable; revisions must advance' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER cb_feedback_head_guard BEFORE UPDATE ON cb_activity_feedback
  FOR EACH ROW EXECUTE FUNCTION cb_feedback_head_guard();

-- Do not allow a mutable feedback reference without a pinned version, even
-- when an internal caller bypasses a service helper.
CREATE FUNCTION cb_feedback_reference_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target text; expected text;
BEGIN
  IF TG_TABLE_NAME = 'cb_messages' THEN
    SELECT feedback_id INTO target FROM cb_messages WHERE center_id = NEW.center_id
      AND conversation_id = NEW.conversation_id AND id = NEW.reply_to;
    expected := NEW.reply_feedback_id;
  ELSE
    SELECT feedback_id INTO target FROM cb_messages WHERE center_id = NEW.center_id
      AND conversation_id = NEW.conversation_id AND id = NEW.message_id;
    expected := NEW.feedback_id;
  END IF;
  IF target IS DISTINCT FROM expected THEN
    RAISE EXCEPTION 'feedback references require the original version' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER cb_message_feedback_reference_guard BEFORE INSERT OR UPDATE ON cb_messages
  FOR EACH ROW EXECUTE FUNCTION cb_feedback_reference_guard();
CREATE TRIGGER cb_record_feedback_reference_guard BEFORE INSERT ON cb_record_references
  FOR EACH ROW EXECUTE FUNCTION cb_feedback_reference_guard();

ALTER TABLE cb_audit_events DROP CONSTRAINT cb_audit_events_action_check,
  ADD CONSTRAINT cb_audit_events_action_check CHECK (action IN (
    'message.sent', 'publication.shared', 'publication.withdrawn', 'message.reviewed',
    'feedback.submitted', 'feedback.updated', 'feedback.reviewed'));
