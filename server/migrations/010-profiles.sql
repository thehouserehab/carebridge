-- Minimal current profiles only. Do not infer names, ages or family interests
-- from account email, clinical records, IDs or older local demo data.
CREATE TABLE cb_member_profiles (
  center_id text NOT NULL, user_id text NOT NULL,
  display_name text CHECK (display_name IS NULL OR (length(btrim(display_name)) BETWEEN 1 AND 30 AND display_name = btrim(display_name) AND display_name !~ '[[:cntrl:]]')),
  revision bigint NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (center_id,user_id),
  FOREIGN KEY (center_id,user_id) REFERENCES cb_memberships(center_id,user_id)
);
CREATE TABLE cb_child_profiles (
  center_id text NOT NULL, child_id text NOT NULL,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 30 AND name = btrim(name) AND name !~ '[[:cntrl:]]'),
  age smallint CHECK (age BETWEEN 0 AND 26),
  age_as_of date,
  revision bigint NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
  updated_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (center_id,child_id),
  CHECK ((age IS NULL) = (age_as_of IS NULL)),
  CHECK (age_as_of IS NULL OR age_as_of BETWEEN '1900-01-01' AND '9999-12-31'),
  FOREIGN KEY (center_id,child_id) REFERENCES cb_children(center_id,id),
  FOREIGN KEY (center_id,updated_by) REFERENCES cb_memberships(center_id,user_id)
);
-- Kept separate from the center's operational profile and roster projection.
CREATE TABLE cb_child_family_plans (
  center_id text NOT NULL, child_id text NOT NULL,
  concern text NOT NULL CHECK (length(concern) <= 1000 AND concern = btrim(concern)),
  revision bigint NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
  updated_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (center_id,child_id),
  FOREIGN KEY (center_id,child_id) REFERENCES cb_children(center_id,id),
  FOREIGN KEY (center_id,updated_by) REFERENCES cb_memberships(center_id,user_id)
);
ALTER TABLE cb_conversations ADD UNIQUE (center_id,id,child_id);
-- Content-free command receipts double as an audit. No name, interest text,
-- email, credentials or complete profile snapshots are copied into history.
CREATE TABLE cb_profile_requests (
  center_id text NOT NULL, actor_id text NOT NULL,
  client_id text NOT NULL CHECK (client_id ~ '^[a-zA-Z0-9-]{8,100}$'),
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  operation text NOT NULL CHECK (operation IN ('member.save','child.register','child.save','child.concern')),
  subject_user_id text, child_id text, conversation_id text,
  applied_version bigint NOT NULL CHECK (applied_version BETWEEN 0 AND 9007199254740991),
  changed boolean NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (center_id,actor_id,client_id),
  CHECK ((operation = 'member.save' AND subject_user_id IS NOT NULL AND subject_user_id = actor_id AND child_id IS NULL AND conversation_id IS NULL) OR
    (operation <> 'member.save' AND subject_user_id IS NULL AND child_id IS NOT NULL AND conversation_id IS NOT NULL)),
  FOREIGN KEY (center_id,actor_id) REFERENCES cb_memberships(center_id,user_id),
  FOREIGN KEY (center_id,subject_user_id) REFERENCES cb_memberships(center_id,user_id),
  FOREIGN KEY (center_id,conversation_id,child_id) REFERENCES cb_conversations(center_id,id,child_id)
);
CREATE TRIGGER cb_profile_request_immutable BEFORE UPDATE OR DELETE ON cb_profile_requests
  FOR EACH ROW EXECUTE FUNCTION cb_immutable_record_data();

CREATE FUNCTION cb_current_profile_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE editable text[];
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'profile roots are retained' USING ERRCODE = '23514'; END IF;
  IF TG_TABLE_NAME = 'cb_member_profiles' THEN editable := ARRAY['display_name','revision','updated_at'];
  ELSIF TG_TABLE_NAME = 'cb_child_profiles' THEN editable := ARRAY['name','age','age_as_of','revision','updated_by','updated_at'];
  ELSE editable := ARRAY['concern','revision','updated_by','updated_at']; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.revision <> 1 THEN RAISE EXCEPTION 'profile starts at revision one' USING ERRCODE = '23514'; END IF;
  ELSIF NEW.revision <> OLD.revision + 1 OR
    (to_jsonb(NEW) - editable) IS DISTINCT FROM (to_jsonb(OLD) - editable) THEN
    RAISE EXCEPTION 'profile identity/version is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER cb_member_profile_guard BEFORE INSERT OR UPDATE OR DELETE ON cb_member_profiles FOR EACH ROW EXECUTE FUNCTION cb_current_profile_guard();
CREATE TRIGGER cb_child_profile_guard BEFORE INSERT OR UPDATE OR DELETE ON cb_child_profiles FOR EACH ROW EXECUTE FUNCTION cb_current_profile_guard();
CREATE TRIGGER cb_family_plan_guard BEFORE INSERT OR UPDATE OR DELETE ON cb_child_family_plans FOR EACH ROW EXECUTE FUNCTION cb_current_profile_guard();
