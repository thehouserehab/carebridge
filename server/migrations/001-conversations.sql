CREATE TABLE cb_centers (
  id text PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 100)
);
-- The authentication provider will link to these internal IDs. No passwords,
-- tokens, email addresses or demo role selectors are authentication here.
CREATE TABLE cb_users (
  id text PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 100),
  active boolean NOT NULL DEFAULT false
);
CREATE TABLE cb_memberships (
  center_id text NOT NULL REFERENCES cb_centers(id),
  user_id text NOT NULL REFERENCES cb_users(id),
  role text NOT NULL CHECK (role IN ('therapist', 'guardian', 'center')),
  active boolean NOT NULL DEFAULT false,
  PRIMARY KEY (center_id, user_id),
  UNIQUE (center_id, user_id, role)
);
CREATE TABLE cb_children (
  center_id text NOT NULL REFERENCES cb_centers(id),
  id text NOT NULL CHECK (length(id) BETWEEN 1 AND 100),
  PRIMARY KEY (center_id, id)
);
CREATE TABLE cb_conversations (
  center_id text NOT NULL,
  id text NOT NULL CHECK (length(id) BETWEEN 1 AND 100),
  child_id text NOT NULL,
  last_sequence bigint NOT NULL DEFAULT 0
    CHECK (last_sequence BETWEEN 0 AND 9007199254740991),
  revision bigint NOT NULL DEFAULT 0
    CHECK (revision BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY (center_id, id),
  UNIQUE (center_id, child_id),
  FOREIGN KEY (center_id, child_id) REFERENCES cb_children(center_id, id)
);
CREATE TABLE cb_participants (
  center_id text NOT NULL,
  conversation_id text NOT NULL,
  user_id text NOT NULL,
  role text NOT NULL CHECK (role IN ('therapist', 'guardian')),
  active boolean NOT NULL DEFAULT false,
  -- Must be chosen explicitly by the future provisioning policy. Adding a
  -- participant must never silently grant access to the entire history.
  first_sequence bigint NOT NULL CHECK (first_sequence BETWEEN 1 AND 9007199254740991),
  PRIMARY KEY (center_id, conversation_id, user_id),
  FOREIGN KEY (center_id, conversation_id) REFERENCES cb_conversations(center_id, id),
  FOREIGN KEY (center_id, user_id, role) REFERENCES cb_memberships(center_id, user_id, role)
);
CREATE UNIQUE INDEX cb_one_active_therapist
  ON cb_participants(center_id, conversation_id)
  WHERE role = 'therapist' AND active;
-- A history-grant change must invalidate old client projections even when no
-- new message was sent. Provisioning must lock the room before its participants.
CREATE FUNCTION cb_participant_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND to_jsonb(NEW) IS NOT DISTINCT FROM to_jsonb(OLD) THEN
    RETURN NEW;
  END IF;
  IF TG_OP <> 'INSERT' THEN
    UPDATE cb_conversations SET revision = revision + 1
      WHERE center_id = OLD.center_id AND id = OLD.conversation_id;
  END IF;
  IF TG_OP = 'INSERT' OR (TG_OP = 'UPDATE' AND
      (NEW.center_id, NEW.conversation_id) IS DISTINCT FROM (OLD.center_id, OLD.conversation_id)) THEN
    UPDATE cb_conversations SET revision = revision + 1
      WHERE center_id = NEW.center_id AND id = NEW.conversation_id;
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER cb_participant_revision_guard AFTER INSERT OR UPDATE OR DELETE ON cb_participants
  FOR EACH ROW EXECUTE FUNCTION cb_participant_revision();
CREATE TABLE cb_publications (
  center_id text NOT NULL,
  conversation_id text NOT NULL,
  id text NOT NULL,
  record_id text NOT NULL CHECK (length(record_id) BETWEEN 1 AND 100),
  version integer NOT NULL CHECK (version > 0),
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 100),
  summary text NOT NULL CHECK (length(btrim(summary)) BETWEEN 1 AND 2000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  revoked_at timestamptz,
  PRIMARY KEY (center_id, conversation_id, id),
  UNIQUE (center_id, conversation_id, record_id, version),
  FOREIGN KEY (center_id, conversation_id) REFERENCES cb_conversations(center_id, id)
);
CREATE UNIQUE INDEX cb_one_current_publication
  ON cb_publications(center_id, conversation_id, record_id)
  WHERE revoked_at IS NULL;
CREATE FUNCTION cb_immutable_publication() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - 'revoked_at') IS DISTINCT FROM (to_jsonb(OLD) - 'revoked_at')
     OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at) THEN
    RAISE EXCEPTION 'publication snapshots are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER cb_publication_snapshot_guard BEFORE UPDATE ON cb_publications
  FOR EACH ROW EXECUTE FUNCTION cb_immutable_publication();
CREATE TABLE cb_messages (
  center_id text NOT NULL,
  conversation_id text NOT NULL,
  id text NOT NULL,
  sequence bigint NOT NULL CHECK (sequence BETWEEN 1 AND 9007199254740991),
  author_id text NOT NULL,
  client_id text NOT NULL CHECK (client_id ~ '^[a-zA-Z0-9-]{8,100}$'),
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  kind text NOT NULL CHECK (kind IN ('text', 'publication')),
  body text,
  publication_id text,
  reply_to text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (center_id, conversation_id, id),
  UNIQUE (center_id, conversation_id, sequence),
  CONSTRAINT cb_message_request_id UNIQUE (center_id, author_id, client_id),
  UNIQUE (center_id, conversation_id, publication_id),
  CHECK ((kind = 'text' AND publication_id IS NULL AND body IS NOT NULL AND length(btrim(body)) BETWEEN 1 AND 2000)
      OR (kind = 'publication' AND publication_id IS NOT NULL AND body IS NULL AND reply_to IS NULL)),
  FOREIGN KEY (center_id, conversation_id) REFERENCES cb_conversations(center_id, id),
  FOREIGN KEY (center_id, conversation_id, author_id) REFERENCES cb_participants(center_id, conversation_id, user_id),
  FOREIGN KEY (center_id, conversation_id, publication_id) REFERENCES cb_publications(center_id, conversation_id, id),
  FOREIGN KEY (center_id, conversation_id, reply_to) REFERENCES cb_messages(center_id, conversation_id, id)
);
CREATE TABLE cb_read_states (
  center_id text NOT NULL,
  conversation_id text NOT NULL,
  user_id text NOT NULL,
  sequence bigint NOT NULL,
  PRIMARY KEY (center_id, conversation_id, user_id),
  FOREIGN KEY (center_id, conversation_id, user_id) REFERENCES cb_participants(center_id, conversation_id, user_id),
  FOREIGN KEY (center_id, conversation_id, sequence) REFERENCES cb_messages(center_id, conversation_id, sequence)
);
CREATE TABLE cb_message_reviews (
  center_id text NOT NULL,
  conversation_id text NOT NULL,
  message_id text NOT NULL,
  reviewer_id text NOT NULL,
  note text NOT NULL CHECK (length(btrim(note)) BETWEEN 1 AND 2000),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (center_id, conversation_id, message_id),
  FOREIGN KEY (center_id, conversation_id, message_id) REFERENCES cb_messages(center_id, conversation_id, id),
  FOREIGN KEY (center_id, conversation_id, reviewer_id) REFERENCES cb_participants(center_id, conversation_id, user_id)
);
-- Content-free audit events. HTTP, auth and infrastructure logging remain
-- separate work; never add request bodies, query arguments or credentials here.
CREATE TABLE cb_audit_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  center_id text NOT NULL,
  conversation_id text NOT NULL,
  actor_id text NOT NULL,
  action text NOT NULL CHECK (action IN ('message.sent', 'publication.shared', 'publication.withdrawn', 'message.reviewed')),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (center_id, conversation_id) REFERENCES cb_conversations(center_id, id),
  FOREIGN KEY (center_id, actor_id) REFERENCES cb_memberships(center_id, user_id)
);
