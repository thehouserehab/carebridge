-- Relationship edits have their own optimistic version. New messages and read
-- receipts must not invalidate an otherwise current assignment form.
ALTER TABLE cb_conversations ADD COLUMN relationships_version bigint NOT NULL DEFAULT 0
  CHECK (relationships_version BETWEEN 0 AND 9007199254740991);

CREATE OR REPLACE FUNCTION cb_participant_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND to_jsonb(NEW) IS NOT DISTINCT FROM to_jsonb(OLD) THEN
    RETURN NEW;
  END IF;
  IF TG_OP <> 'INSERT' THEN
    UPDATE cb_conversations SET revision = revision + 1,
      relationships_version = relationships_version + 1
      WHERE center_id = OLD.center_id AND id = OLD.conversation_id;
  END IF;
  IF TG_OP = 'INSERT' OR (TG_OP = 'UPDATE' AND
      (NEW.center_id, NEW.conversation_id) IS DISTINCT FROM (OLD.center_id, OLD.conversation_id)) THEN
    UPDATE cb_conversations SET revision = revision + 1,
      relationships_version = relationships_version + 1
      WHERE center_id = NEW.center_id AND id = NEW.conversation_id;
  END IF;
  RETURN NULL;
END;
$$;

-- The request is also the content-free audit header. Neither clinical content,
-- credentials, nor the submitted payload is stored here.
CREATE TABLE cb_relationship_requests (
  center_id text NOT NULL,
  conversation_id text NOT NULL,
  actor_id text NOT NULL,
  client_id text NOT NULL CHECK (client_id ~ '^[a-zA-Z0-9-]{8,100}$'),
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  expected_version bigint NOT NULL CHECK (expected_version BETWEEN 0 AND 9007199254740991),
  applied_version bigint NOT NULL CHECK (applied_version BETWEEN 0 AND 9007199254740991),
  changed boolean NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (center_id, actor_id, client_id),
  UNIQUE (center_id, conversation_id, actor_id, client_id),
  CHECK (applied_version >= expected_version),
  FOREIGN KEY (center_id, conversation_id) REFERENCES cb_conversations(center_id, id),
  FOREIGN KEY (center_id, actor_id) REFERENCES cb_memberships(center_id, user_id)
);

CREATE TABLE cb_relationship_changes (
  center_id text NOT NULL,
  conversation_id text NOT NULL,
  actor_id text NOT NULL,
  client_id text NOT NULL,
  user_id text NOT NULL,
  role text NOT NULL CHECK (role IN ('therapist', 'guardian')),
  previous_active boolean,
  previous_first_sequence bigint,
  next_active boolean NOT NULL,
  next_first_sequence bigint NOT NULL CHECK (next_first_sequence BETWEEN 1 AND 9007199254740991),
  history_mode text NOT NULL CHECK (history_mode IN ('all', 'from_now', 'preserve', 'disconnect')),
  PRIMARY KEY (center_id, actor_id, client_id, user_id),
  CHECK ((previous_active IS NULL) = (previous_first_sequence IS NULL)),
  CHECK (previous_first_sequence IS NULL OR previous_first_sequence BETWEEN 1 AND 9007199254740991),
  CHECK ((history_mode = 'disconnect' AND NOT next_active) OR
         (history_mode <> 'disconnect' AND next_active)),
  FOREIGN KEY (center_id, conversation_id, actor_id, client_id)
    REFERENCES cb_relationship_requests(center_id, conversation_id, actor_id, client_id),
  FOREIGN KEY (center_id, conversation_id, user_id)
    REFERENCES cb_participants(center_id, conversation_id, user_id)
);
