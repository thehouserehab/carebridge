-- Existing context content stays intact; unknown authors/times stay unknown.
ALTER TABLE cb_centers ADD COLUMN schedule_version bigint NOT NULL DEFAULT 0
  CHECK (schedule_version BETWEEN 0 AND 9007199254740991);
ALTER TABLE cb_goals
  ADD COLUMN current_revision integer NOT NULL DEFAULT 1 CHECK (current_revision > 0),
  ADD COLUMN updated_by text,
  ADD COLUMN updated_at timestamptz,
  ADD COLUMN changed_sequence bigint,
  ADD CHECK ((updated_by IS NULL AND updated_at IS NULL AND changed_sequence IS NULL) OR
    (updated_by IS NOT NULL AND updated_at IS NOT NULL AND changed_sequence IS NOT NULL AND changed_sequence BETWEEN 1 AND 9007199254740991)),
  ADD FOREIGN KEY (center_id,updated_by) REFERENCES cb_memberships(center_id,user_id);
ALTER TABLE cb_appointments
  ADD COLUMN current_revision integer NOT NULL DEFAULT 1 CHECK (current_revision > 0),
  ADD COLUMN updated_by text,
  ADD COLUMN updated_at timestamptz,
  ADD COLUMN changed_sequence bigint,
  ADD CHECK ((updated_by IS NULL AND updated_at IS NULL AND changed_sequence IS NULL) OR
    (updated_by IS NOT NULL AND updated_at IS NOT NULL AND changed_sequence IS NOT NULL AND changed_sequence BETWEEN 1 AND 9007199254740991)),
  ADD CONSTRAINT cb_appointment_same_day CHECK (EXTRACT(HOUR FROM time) * 60 + EXTRACT(MINUTE FROM time) + duration <= 1440),
  ADD CONSTRAINT cb_appointment_minute_precision CHECK (EXTRACT(SECOND FROM time) = 0),
  ADD FOREIGN KEY (center_id,updated_by) REFERENCES cb_memberships(center_id,user_id);
CREATE TABLE cb_goal_revisions (
  center_id text NOT NULL,
  conversation_id text NOT NULL,
  goal_id text NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 100),
  description text NOT NULL CHECK (length(description) <= 2000),
  status text NOT NULL CHECK (status IN ('active','achieved','paused')),
  author_id text,
  changed_at timestamptz,
  change_sequence bigint,
  captured_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (center_id,conversation_id,goal_id,revision),
  CHECK ((author_id IS NULL AND changed_at IS NULL AND change_sequence IS NULL) OR
    (author_id IS NOT NULL AND changed_at IS NOT NULL AND change_sequence IS NOT NULL AND change_sequence BETWEEN 1 AND 9007199254740991)),
  FOREIGN KEY (center_id,conversation_id,goal_id) REFERENCES cb_goals(center_id,conversation_id,id),
  FOREIGN KEY (center_id,author_id) REFERENCES cb_memberships(center_id,user_id)
);
CREATE TABLE cb_appointment_revisions (
  center_id text NOT NULL,
  conversation_id text NOT NULL,
  appointment_id text NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  date date NOT NULL,
  time time NOT NULL,
  duration integer NOT NULL CHECK (duration BETWEEN 10 AND 180),
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 100),
  room text NOT NULL CHECK (length(btrim(room)) BETWEEN 1 AND 60),
  status text NOT NULL CHECK (status IN ('scheduled','attended','absent','cancelled')),
  author_id text,
  changed_at timestamptz,
  change_sequence bigint,
  captured_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (center_id,conversation_id,appointment_id,revision),
  CHECK ((author_id IS NULL AND changed_at IS NULL AND change_sequence IS NULL) OR
    (author_id IS NOT NULL AND changed_at IS NOT NULL AND change_sequence IS NOT NULL AND change_sequence BETWEEN 1 AND 9007199254740991)),
  FOREIGN KEY (center_id,conversation_id,appointment_id) REFERENCES cb_appointments(center_id,conversation_id,id),
  FOREIGN KEY (center_id,author_id) REFERENCES cb_memberships(center_id,user_id)
);
INSERT INTO cb_goal_revisions(center_id,conversation_id,goal_id,revision,title,description,status)
  SELECT center_id,conversation_id,id,1,title,description,status FROM cb_goals;
INSERT INTO cb_appointment_revisions(center_id,conversation_id,appointment_id,revision,date,time,duration,title,room,status)
  SELECT center_id,conversation_id,id,1,date,time,duration,title,room,status FROM cb_appointments;
ALTER TABLE cb_goals ADD CONSTRAINT cb_goal_current_revision
  FOREIGN KEY (center_id,conversation_id,id,current_revision)
  REFERENCES cb_goal_revisions(center_id,conversation_id,goal_id,revision) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE cb_appointments ADD CONSTRAINT cb_appointment_current_revision
  FOREIGN KEY (center_id,conversation_id,id,current_revision)
  REFERENCES cb_appointment_revisions(center_id,conversation_id,appointment_id,revision) DEFERRABLE INITIALLY DEFERRED;
-- Earlier records did not capture context versions. Do not invent them.
ALTER TABLE cb_record_revisions
  ADD COLUMN goal_revision integer,
  ADD COLUMN appointment_revision integer,
  ADD CHECK (appointment_revision IS NULL OR appointment_id IS NOT NULL),
  ADD FOREIGN KEY (center_id,conversation_id,goal_id,goal_revision)
    REFERENCES cb_goal_revisions(center_id,conversation_id,goal_id,revision),
  ADD FOREIGN KEY (center_id,conversation_id,appointment_id,appointment_revision)
    REFERENCES cb_appointment_revisions(center_id,conversation_id,appointment_id,revision);
CREATE TABLE cb_context_requests (
  center_id text NOT NULL,
  conversation_id text NOT NULL,
  actor_id text NOT NULL,
  client_id text NOT NULL CHECK (client_id ~ '^[a-zA-Z0-9-]{8,100}$'),
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  kind text NOT NULL CHECK (kind IN ('goal','appointment')),
  goal_id text,
  appointment_id text,
  revision integer NOT NULL CHECK (revision > 0),
  changed boolean NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (center_id,actor_id,client_id),
  CHECK ((kind = 'goal' AND goal_id IS NOT NULL AND appointment_id IS NULL) OR
    (kind = 'appointment' AND appointment_id IS NOT NULL AND goal_id IS NULL)),
  FOREIGN KEY (center_id,actor_id) REFERENCES cb_memberships(center_id,user_id),
  FOREIGN KEY (center_id,conversation_id,goal_id,revision) REFERENCES cb_goal_revisions(center_id,conversation_id,goal_id,revision),
  FOREIGN KEY (center_id,conversation_id,appointment_id,revision) REFERENCES cb_appointment_revisions(center_id,conversation_id,appointment_id,revision)
);
CREATE FUNCTION cb_context_root_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.current_revision <> 1 THEN RAISE EXCEPTION 'context starts at revision one' USING ERRCODE = '23514'; END IF;
  ELSE
    IF (NEW.center_id,NEW.conversation_id,NEW.id) IS DISTINCT FROM (OLD.center_id,OLD.conversation_id,OLD.id)
      OR NEW.current_revision::bigint <> OLD.current_revision::bigint + 1
      OR NEW.updated_by IS NULL OR NEW.updated_at IS NULL OR NEW.changed_sequence IS NULL
      OR (OLD.changed_sequence IS NOT NULL AND NEW.changed_sequence <= OLD.changed_sequence) THEN
      RAISE EXCEPTION 'context identity is fixed; changes require a new revision' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER cb_goal_root_guard BEFORE INSERT OR UPDATE ON cb_goals
  FOR EACH ROW EXECUTE FUNCTION cb_context_root_guard();
CREATE TRIGGER cb_appointment_root_guard BEFORE INSERT OR UPDATE ON cb_appointments
  FOR EACH ROW EXECUTE FUNCTION cb_context_root_guard();
-- Acquire the center gate BEFORE child-room locks in every allocating service.
CREATE FUNCTION cb_assert_room_schedule(target_center text, target_room text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM cb_centers WHERE id = target_center FOR NO KEY UPDATE;
  IF EXISTS (
    SELECT 1 FROM cb_appointments a JOIN cb_appointments b ON b.center_id = a.center_id
    WHERE a.center_id = target_center AND a.conversation_id = target_room
      AND (a.conversation_id,a.id) <> (b.conversation_id,b.id)
      AND a.status <> 'cancelled' AND b.status <> 'cancelled' AND a.date = b.date
      AND EXTRACT(EPOCH FROM a.time) / 60 < EXTRACT(EPOCH FROM b.time) / 60 + b.duration
      AND EXTRACT(EPOCH FROM b.time) / 60 < EXTRACT(EPOCH FROM a.time) / 60 + a.duration
      AND (a.conversation_id = b.conversation_id OR a.room = b.room OR EXISTS (
        SELECT 1 FROM cb_participants pa JOIN cb_participants pb ON (pb.center_id,pb.user_id) = (pa.center_id,pa.user_id)
        JOIN cb_memberships cm ON (cm.center_id,cm.user_id,cm.role) = (pa.center_id,pa.user_id,pa.role)
        JOIN cb_users u ON u.id = pa.user_id
        WHERE pa.center_id = a.center_id AND pa.conversation_id = a.conversation_id
          AND pb.conversation_id = b.conversation_id AND pa.role = 'therapist' AND pb.role = 'therapist'
          AND pa.active AND pb.active AND cm.active AND u.active))) THEN
    RAISE EXCEPTION 'schedule resources overlap' USING ERRCODE = '23P01', CONSTRAINT = 'cb_schedule_overlap';
  END IF;
END;
$$;
CREATE FUNCTION cb_context_capture() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'cb_goals' THEN
    INSERT INTO cb_goal_revisions(center_id,conversation_id,goal_id,revision,title,description,status,author_id,changed_at,change_sequence)
      VALUES (NEW.center_id,NEW.conversation_id,NEW.id,NEW.current_revision,NEW.title,NEW.description,NEW.status,NEW.updated_by,NEW.updated_at,NEW.changed_sequence);
  ELSE
    INSERT INTO cb_appointment_revisions(center_id,conversation_id,appointment_id,revision,date,time,duration,title,room,status,author_id,changed_at,change_sequence)
      VALUES (NEW.center_id,NEW.conversation_id,NEW.id,NEW.current_revision,NEW.date,NEW.time,NEW.duration,NEW.title,NEW.room,NEW.status,NEW.updated_by,NEW.updated_at,NEW.changed_sequence);
    PERFORM cb_assert_room_schedule(NEW.center_id,NEW.conversation_id);
    UPDATE cb_centers SET schedule_version = schedule_version + 1 WHERE id = NEW.center_id;
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER cb_goal_capture AFTER INSERT OR UPDATE ON cb_goals FOR EACH ROW EXECUTE FUNCTION cb_context_capture();
CREATE TRIGGER cb_appointment_capture AFTER INSERT OR UPDATE ON cb_appointments FOR EACH ROW EXECUTE FUNCTION cb_context_capture();
CREATE TRIGGER cb_goal_revision_guard BEFORE UPDATE OR DELETE ON cb_goal_revisions
  FOR EACH ROW EXECUTE FUNCTION cb_immutable_record_data();
CREATE TRIGGER cb_appointment_revision_guard BEFORE UPDATE OR DELETE ON cb_appointment_revisions
  FOR EACH ROW EXECUTE FUNCTION cb_immutable_record_data();
-- Validate the final assignment, including cross-child therapist clashes.
CREATE FUNCTION cb_participant_schedule_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_center text; target_room text;
BEGIN
  IF TG_OP = 'UPDATE' AND to_jsonb(NEW) IS NOT DISTINCT FROM to_jsonb(OLD) THEN RETURN NULL; END IF;
  IF TG_OP = 'DELETE' THEN target_center := OLD.center_id; target_room := OLD.conversation_id;
  ELSE target_center := NEW.center_id; target_room := NEW.conversation_id; END IF;
  PERFORM cb_assert_room_schedule(target_center,target_room);
  UPDATE cb_centers SET schedule_version = schedule_version + 1 WHERE id = target_center;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER cb_participant_schedule_guard AFTER INSERT OR UPDATE OR DELETE ON cb_participants
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION cb_participant_schedule_check();
CREATE INDEX cb_appointments_date ON cb_appointments(center_id,date,time,conversation_id,id);
