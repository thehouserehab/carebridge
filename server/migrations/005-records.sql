-- Context identities preserve the existing child/goal/appointment links.
-- Their editing services are separate from clinical record commands.
CREATE TABLE cb_goals (
  center_id text NOT NULL,
  conversation_id text NOT NULL,
  id text NOT NULL CHECK (length(id) BETWEEN 1 AND 100),
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 100),
  description text NOT NULL DEFAULT '' CHECK (length(description) <= 2000),
  status text NOT NULL CHECK (status IN ('active', 'achieved', 'paused')),
  PRIMARY KEY (center_id, conversation_id, id),
  FOREIGN KEY (center_id, conversation_id) REFERENCES cb_conversations(center_id, id)
);
CREATE TABLE cb_appointments (
  center_id text NOT NULL,
  conversation_id text NOT NULL,
  id text NOT NULL CHECK (length(id) BETWEEN 1 AND 100),
  date date NOT NULL,
  time time NOT NULL,
  duration integer NOT NULL CHECK (duration BETWEEN 10 AND 180),
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 100),
  room text NOT NULL CHECK (length(btrim(room)) BETWEEN 1 AND 60),
  status text NOT NULL CHECK (status IN ('scheduled', 'attended', 'absent', 'cancelled')),
  PRIMARY KEY (center_id, conversation_id, id),
  FOREIGN KEY (center_id, conversation_id) REFERENCES cb_conversations(center_id, id)
);
CREATE TABLE cb_records (
  center_id text NOT NULL,
  conversation_id text NOT NULL,
  id text NOT NULL CHECK (length(id) BETWEEN 1 AND 100),
  created_by text NOT NULL,
  created_sequence bigint NOT NULL CHECK (created_sequence BETWEEN 1 AND 9007199254740991),
  current_revision integer NOT NULL CHECK (current_revision > 0),
  appointment_id text,
  PRIMARY KEY (center_id, conversation_id, id),
  CONSTRAINT cb_record_appointment UNIQUE (center_id, conversation_id, appointment_id),
  FOREIGN KEY (center_id, conversation_id) REFERENCES cb_conversations(center_id, id),
  FOREIGN KEY (center_id, conversation_id, created_by) REFERENCES cb_participants(center_id, conversation_id, user_id),
  FOREIGN KEY (center_id, conversation_id, appointment_id) REFERENCES cb_appointments(center_id, conversation_id, id)
);
CREATE TABLE cb_record_revisions (
  center_id text NOT NULL,
  conversation_id text NOT NULL,
  record_id text NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  author_id text NOT NULL,
  goal_id text NOT NULL,
  appointment_id text,
  record_date date NOT NULL,
  status text NOT NULL CHECK (status IN ('draft', 'saved')),
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 100),
  performed text NOT NULL CHECK (length(performed) <= 2000),
  response text NOT NULL CHECK (length(response) <= 2000),
  next_plan text NOT NULL CHECK (length(next_plan) <= 2000),
  summary text NOT NULL CHECK (length(summary) <= 2000),
  private_note text NOT NULL CHECK (length(private_note) <= 2000),
  observation jsonb CHECK (observation IS NULL OR jsonb_typeof(observation) = 'object'),
  activity jsonb CHECK (activity IS NULL OR jsonb_typeof(activity) = 'object'),
  sealed boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (center_id, conversation_id, record_id, revision),
  FOREIGN KEY (center_id, conversation_id, record_id) REFERENCES cb_records(center_id, conversation_id, id),
  FOREIGN KEY (center_id, conversation_id, author_id) REFERENCES cb_participants(center_id, conversation_id, user_id),
  FOREIGN KEY (center_id, conversation_id, goal_id) REFERENCES cb_goals(center_id, conversation_id, id),
  FOREIGN KEY (center_id, conversation_id, appointment_id) REFERENCES cb_appointments(center_id, conversation_id, id)
);
ALTER TABLE cb_records ADD CONSTRAINT cb_record_current_revision
  FOREIGN KEY (center_id, conversation_id, id, current_revision)
  REFERENCES cb_record_revisions(center_id, conversation_id, record_id, revision)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE cb_record_assessments (
  center_id text NOT NULL,
  conversation_id text NOT NULL,
  record_id text NOT NULL,
  revision integer NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 0 AND 19),
  tool text NOT NULL CHECK (length(btrim(tool)) BETWEEN 1 AND 100),
  item text NOT NULL CHECK (length(btrim(item)) BETWEEN 1 AND 100),
  value double precision NOT NULL CHECK (value > '-Infinity'::double precision AND value < 'Infinity'::double precision),
  unit text NOT NULL CHECK (length(btrim(unit)) BETWEEN 1 AND 100),
  context text NOT NULL CHECK (length(btrim(context)) BETWEEN 1 AND 300),
  PRIMARY KEY (center_id, conversation_id, record_id, revision, ordinal),
  FOREIGN KEY (center_id, conversation_id, record_id, revision)
    REFERENCES cb_record_revisions(center_id, conversation_id, record_id, revision)
);
CREATE TABLE cb_record_references (
  center_id text NOT NULL,
  conversation_id text NOT NULL,
  record_id text NOT NULL,
  revision integer NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 0 AND 19),
  message_id text NOT NULL,
  PRIMARY KEY (center_id, conversation_id, record_id, revision, ordinal),
  UNIQUE (center_id, conversation_id, record_id, revision, message_id),
  FOREIGN KEY (center_id, conversation_id, record_id, revision)
    REFERENCES cb_record_revisions(center_id, conversation_id, record_id, revision),
  FOREIGN KEY (center_id, conversation_id, message_id) REFERENCES cb_messages(center_id, conversation_id, id)
);

-- Existing summary-only publications remain intact and have no invented
-- clinical original. New full records are connected by this additive table.
ALTER TABLE cb_publications ADD CONSTRAINT cb_publication_record_identity
  UNIQUE (center_id, conversation_id, id, record_id);
CREATE TABLE cb_record_publications (
  center_id text NOT NULL,
  conversation_id text NOT NULL,
  publication_id text NOT NULL,
  record_id text NOT NULL,
  record_revision integer NOT NULL,
  record_date date NOT NULL,
  activity jsonb CHECK (activity IS NULL OR jsonb_typeof(activity) = 'object'),
  PRIMARY KEY (center_id, conversation_id, publication_id),
  FOREIGN KEY (center_id, conversation_id, publication_id, record_id)
    REFERENCES cb_publications(center_id, conversation_id, id, record_id),
  FOREIGN KEY (center_id, conversation_id, record_id, record_revision)
    REFERENCES cb_record_revisions(center_id, conversation_id, record_id, revision)
);
CREATE TABLE cb_record_recipients (
  center_id text NOT NULL,
  conversation_id text NOT NULL,
  publication_id text NOT NULL,
  user_id text NOT NULL,
  PRIMARY KEY (center_id, conversation_id, publication_id, user_id),
  FOREIGN KEY (center_id, conversation_id, publication_id)
    REFERENCES cb_record_publications(center_id, conversation_id, publication_id),
  FOREIGN KEY (center_id, conversation_id, user_id)
    REFERENCES cb_participants(center_id, conversation_id, user_id)
);

CREATE TABLE cb_record_requests (
  center_id text NOT NULL,
  conversation_id text NOT NULL,
  actor_id text NOT NULL,
  client_id text NOT NULL CHECK (client_id ~ '^[a-zA-Z0-9-]{8,100}$'),
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  operation text NOT NULL CHECK (operation IN ('save', 'publish')),
  record_id text NOT NULL,
  record_revision integer NOT NULL,
  message_id text,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (center_id, actor_id, client_id),
  CHECK ((operation = 'save' AND message_id IS NULL) OR (operation = 'publish' AND message_id IS NOT NULL)),
  FOREIGN KEY (center_id, conversation_id, record_id, record_revision)
    REFERENCES cb_record_revisions(center_id, conversation_id, record_id, revision),
  FOREIGN KEY (center_id, conversation_id, actor_id)
    REFERENCES cb_participants(center_id, conversation_id, user_id),
  FOREIGN KEY (center_id, conversation_id, message_id)
    REFERENCES cb_messages(center_id, conversation_id, id)
);

CREATE FUNCTION cb_immutable_record_data() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'record history is immutable' USING ERRCODE = '23514';
END;
$$;
CREATE FUNCTION cb_seal_record_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NOT OLD.sealed AND NEW.sealed AND
      (to_jsonb(NEW) - 'sealed') IS NOT DISTINCT FROM (to_jsonb(OLD) - 'sealed') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'record history is immutable' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER cb_record_revision_guard BEFORE UPDATE OR DELETE ON cb_record_revisions
  FOR EACH ROW EXECUTE FUNCTION cb_seal_record_revision();
CREATE FUNCTION cb_require_sealed_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM cb_record_revisions WHERE center_id = NEW.center_id
      AND conversation_id = NEW.conversation_id AND record_id = NEW.record_id AND revision = NEW.revision AND sealed) THEN
    RAISE EXCEPTION 'record revision must be sealed before commit' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER cb_record_sealed_guard AFTER INSERT ON cb_record_revisions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION cb_require_sealed_revision();
CREATE FUNCTION cb_check_record_detail_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE is_sealed boolean;
BEGIN
  SELECT sealed INTO is_sealed FROM cb_record_revisions WHERE center_id = NEW.center_id
    AND conversation_id = NEW.conversation_id AND record_id = NEW.record_id AND revision = NEW.revision FOR UPDATE;
  IF is_sealed THEN
    RAISE EXCEPTION 'sealed record details are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER cb_record_assessment_insert_guard BEFORE INSERT ON cb_record_assessments
  FOR EACH ROW EXECUTE FUNCTION cb_check_record_detail_insert();
CREATE TRIGGER cb_record_reference_insert_guard BEFORE INSERT ON cb_record_references
  FOR EACH ROW EXECUTE FUNCTION cb_check_record_detail_insert();
CREATE TRIGGER cb_record_assessment_guard BEFORE UPDATE OR DELETE ON cb_record_assessments
  FOR EACH ROW EXECUTE FUNCTION cb_immutable_record_data();
CREATE TRIGGER cb_record_reference_guard BEFORE UPDATE OR DELETE ON cb_record_references
  FOR EACH ROW EXECUTE FUNCTION cb_immutable_record_data();
CREATE TRIGGER cb_record_publication_guard BEFORE UPDATE OR DELETE ON cb_record_publications
  FOR EACH ROW EXECUTE FUNCTION cb_immutable_record_data();
CREATE TRIGGER cb_record_recipient_guard BEFORE UPDATE OR DELETE ON cb_record_recipients
  FOR EACH ROW EXECUTE FUNCTION cb_immutable_record_data();
