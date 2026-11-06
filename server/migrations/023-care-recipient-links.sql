-- A care recipient signs in independently. Membership, participation and the
-- communication preference remain different concepts; no age-based transfer.
ALTER TABLE cb_memberships DROP CONSTRAINT cb_memberships_role_check;
ALTER TABLE cb_memberships ADD CONSTRAINT cb_memberships_role_check
  CHECK (role IN ('therapist','guardian','center','care_recipient'));
ALTER TABLE cb_auth_invitations DROP CONSTRAINT cb_auth_invitations_role_check;
ALTER TABLE cb_auth_invitations ADD CONSTRAINT cb_auth_invitations_role_check
  CHECK (role IN ('therapist','guardian','care_recipient'));
ALTER TABLE cb_participants DROP CONSTRAINT cb_participants_role_check;
ALTER TABLE cb_participants ADD CONSTRAINT cb_participants_role_check
  CHECK (role IN ('therapist','guardian','care_recipient'));
ALTER TABLE cb_relationship_changes DROP CONSTRAINT cb_relationship_changes_role_check;
ALTER TABLE cb_relationship_changes ADD CONSTRAINT cb_relationship_changes_role_check
  CHECK (role IN ('therapist','guardian','care_recipient'));

-- Contact eligibility is revocable without changing clinical permissions.
-- Independent row-local generations avoid cross-row invalidation writes and
-- prevent a previous contact preference from reviving after reactivation.
ALTER TABLE cb_users ADD COLUMN communication_generation bigint NOT NULL DEFAULT 0
  CHECK (communication_generation BETWEEN 0 AND 9007199254740991);
ALTER TABLE cb_memberships ADD COLUMN communication_generation bigint NOT NULL DEFAULT 0
  CHECK (communication_generation BETWEEN 0 AND 9007199254740991);
ALTER TABLE cb_participants ADD COLUMN communication_generation bigint NOT NULL DEFAULT 0
  CHECK (communication_generation BETWEEN 0 AND 9007199254740991);
CREATE FUNCTION cb_communication_qualification_generation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.communication_generation IS DISTINCT FROM OLD.communication_generation THEN
    RAISE EXCEPTION 'communication qualification generation is managed' USING ERRCODE = '23514';
  END IF;
  IF NEW.active IS DISTINCT FROM OLD.active OR
      (to_jsonb(NEW)->>'role') IS DISTINCT FROM (to_jsonb(OLD)->>'role') THEN
    IF OLD.communication_generation = 9007199254740991 THEN
      RAISE EXCEPTION 'communication qualification generation is exhausted' USING ERRCODE = '23514';
    END IF;
    NEW.communication_generation := OLD.communication_generation + 1;
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER cb_communication_qualification_generation BEFORE UPDATE ON cb_users
  FOR EACH ROW EXECUTE FUNCTION cb_communication_qualification_generation();
CREATE TRIGGER cb_communication_qualification_generation BEFORE UPDATE ON cb_memberships
  FOR EACH ROW EXECUTE FUNCTION cb_communication_qualification_generation();
CREATE TRIGGER cb_communication_qualification_generation BEFORE UPDATE ON cb_participants
  FOR EACH ROW EXECUTE FUNCTION cb_communication_qualification_generation();

-- Even a disconnected recipient cannot be reassigned to another person's
-- retained record or replaced by a second identity through ordinary writes.
CREATE UNIQUE INDEX cb_one_care_recipient_per_room ON cb_participants(center_id,conversation_id)
  WHERE role = 'care_recipient';
CREATE UNIQUE INDEX cb_one_care_recipient_record_per_account ON cb_participants(center_id,user_id)
  WHERE role = 'care_recipient';
CREATE TABLE cb_care_recipient_links (
  center_id text NOT NULL, conversation_id text NOT NULL, child_id text NOT NULL,
  user_id text NOT NULL, role text NOT NULL DEFAULT 'care_recipient' CHECK (role = 'care_recipient'),
  linked_by text NOT NULL, linked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (center_id,conversation_id),
  UNIQUE (center_id,user_id), UNIQUE (center_id,child_id),
  FOREIGN KEY (center_id,conversation_id,child_id) REFERENCES cb_conversations(center_id,id,child_id),
  FOREIGN KEY (center_id,conversation_id,user_id) REFERENCES cb_participants(center_id,conversation_id,user_id),
  FOREIGN KEY (center_id,user_id,role) REFERENCES cb_memberships(center_id,user_id,role),
  FOREIGN KEY (center_id,linked_by) REFERENCES cb_memberships(center_id,user_id)
);
CREATE TRIGGER cb_care_recipient_link_immutable BEFORE UPDATE OR DELETE ON cb_care_recipient_links
  FOR EACH ROW EXECUTE FUNCTION cb_immutable_record_data();

CREATE FUNCTION cb_care_recipient_participant_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE boundary bigint;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.role = 'care_recipient' THEN
      RAISE EXCEPTION 'care recipient identity is retained' USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (OLD.role = 'care_recipient' OR NEW.role = 'care_recipient') AND
       (NEW.center_id,NEW.conversation_id,NEW.user_id,NEW.role) IS DISTINCT FROM
       (OLD.center_id,OLD.conversation_id,OLD.user_id,OLD.role) THEN
      RAISE EXCEPTION 'care recipient identity is immutable' USING ERRCODE = '23514';
    END IF;
    IF NEW.role <> 'care_recipient' THEN RETURN NEW; END IF;
    IF NEW.first_sequence < OLD.first_sequence OR
       ((OLD.active OR NOT NEW.active) AND NEW.first_sequence <> OLD.first_sequence) THEN
      RAISE EXCEPTION 'care recipient history cannot expand' USING ERRCODE = '23514';
    END IF;
    IF OLD.active OR NOT NEW.active THEN RETURN NEW; END IF;
  ELSIF NEW.role <> 'care_recipient' THEN RETURN NEW;
  ELSIF NOT NEW.active THEN
    RAISE EXCEPTION 'care recipient starts with an explicit connection' USING ERRCODE = '23514';
  END IF;
  SELECT last_sequence + 1 INTO boundary FROM cb_conversations
    WHERE center_id = NEW.center_id AND id = NEW.conversation_id FOR UPDATE;
  IF boundary IS NULL OR NEW.first_sequence <> boundary THEN
    RAISE EXCEPTION 'care recipient starts after current history' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER cb_care_recipient_participant_guard BEFORE INSERT OR UPDATE OR DELETE ON cb_participants
  FOR EACH ROW EXECUTE FUNCTION cb_care_recipient_participant_guard();

-- The participant is inserted before its FK-backed identity link in the same
-- transaction. No committed recipient participant may exist without that link.
CREATE FUNCTION cb_care_recipient_link_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.role = 'care_recipient' AND NOT EXISTS (
      SELECT 1 FROM cb_care_recipient_links l JOIN cb_conversations c
        ON (c.center_id,c.id,c.child_id)=(l.center_id,l.conversation_id,l.child_id)
      WHERE (l.center_id,l.conversation_id,l.user_id)=(NEW.center_id,NEW.conversation_id,NEW.user_id)) THEN
    RAISE EXCEPTION 'care recipient identity link is required' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END; $$;
CREATE CONSTRAINT TRIGGER cb_care_recipient_link_guard AFTER INSERT OR UPDATE ON cb_participants
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION cb_care_recipient_link_guard();

-- A contact preference is not a capability. These rows cannot grant a role,
-- history range, clinical record recipient, consent or management authority.
CREATE TABLE cb_primary_communicators (
  center_id text NOT NULL, conversation_id text NOT NULL, user_id text,
  user_generation bigint, membership_generation bigint, participant_generation bigint,
  revision bigint NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
  updated_by text NOT NULL, updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (center_id,conversation_id),
  CHECK ((user_id IS NULL AND user_generation IS NULL AND membership_generation IS NULL AND participant_generation IS NULL) OR
    (user_id IS NOT NULL AND user_generation BETWEEN 0 AND 9007199254740991 AND membership_generation BETWEEN 0 AND 9007199254740991
      AND participant_generation BETWEEN 0 AND 9007199254740991 AND user_generation IS NOT NULL AND membership_generation IS NOT NULL AND participant_generation IS NOT NULL)),
  FOREIGN KEY (center_id,conversation_id) REFERENCES cb_conversations(center_id,id),
  FOREIGN KEY (center_id,conversation_id,user_id) REFERENCES cb_participants(center_id,conversation_id,user_id),
  FOREIGN KEY (center_id,updated_by) REFERENCES cb_memberships(center_id,user_id)
);
CREATE FUNCTION cb_primary_communicator_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'primary communicator roots are retained' USING ERRCODE = '23514'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.revision <> 1 THEN RAISE EXCEPTION 'primary communicator starts at revision one' USING ERRCODE = '23514'; END IF;
  ELSIF NEW.revision <> OLD.revision + 1 OR
    (to_jsonb(NEW) - ARRAY['user_id','user_generation','membership_generation','participant_generation','revision','updated_by','updated_at']) IS DISTINCT FROM
    (to_jsonb(OLD) - ARRAY['user_id','user_generation','membership_generation','participant_generation','revision','updated_by','updated_at']) THEN
    RAISE EXCEPTION 'primary communicator identity/version is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.user_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM cb_participants p JOIN cb_memberships m
        ON (m.center_id,m.user_id,m.role)=(p.center_id,p.user_id,p.role)
      JOIN cb_users u ON u.id=p.user_id
      WHERE (p.center_id,p.conversation_id,p.user_id)=(NEW.center_id,NEW.conversation_id,NEW.user_id)
        AND p.role IN ('guardian','care_recipient') AND p.active AND m.active AND u.active AND
        (u.communication_generation,m.communication_generation,p.communication_generation) =
          (NEW.user_generation,NEW.membership_generation,NEW.participant_generation) AND
        (p.role <> 'care_recipient' OR EXISTS (SELECT 1 FROM cb_care_recipient_links l
          WHERE (l.center_id,l.conversation_id,l.user_id)=(p.center_id,p.conversation_id,p.user_id)))) THEN
    RAISE EXCEPTION 'primary communicator must be a current linked contact' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER cb_primary_communicator_guard BEFORE INSERT OR UPDATE OR DELETE ON cb_primary_communicators
  FOR EACH ROW EXECUTE FUNCTION cb_primary_communicator_guard();
CREATE TABLE cb_primary_communicator_requests (
  center_id text NOT NULL, conversation_id text NOT NULL, actor_id text NOT NULL,
  client_id text NOT NULL CHECK (client_id ~ '^[a-zA-Z0-9-]{8,100}$'),
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  expected_revision bigint NOT NULL CHECK (expected_revision BETWEEN 0 AND 9007199254740991),
  applied_revision bigint NOT NULL CHECK (applied_revision BETWEEN 0 AND 9007199254740991),
  changed boolean NOT NULL, occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (center_id,actor_id,client_id),
  CHECK (applied_revision >= expected_revision),
  FOREIGN KEY (center_id,conversation_id) REFERENCES cb_conversations(center_id,id),
  FOREIGN KEY (center_id,actor_id) REFERENCES cb_memberships(center_id,user_id)
);
CREATE TRIGGER cb_primary_communicator_request_immutable BEFORE UPDATE OR DELETE ON cb_primary_communicator_requests
  FOR EACH ROW EXECUTE FUNCTION cb_immutable_record_data();

-- Adding a feature must not reopen an explicitly quarantined restore target.
DO $$
DECLARE relation text;
BEGIN
  FOREACH relation IN ARRAY ARRAY['cb_care_recipient_links','cb_primary_communicators','cb_primary_communicator_requests'] LOOP
    EXECUTE format('CREATE TRIGGER cb_000_recovery_guard BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.cb_recovery_write_guard()',relation);
    EXECUTE format('CREATE TRIGGER cb_recovery_truncate_guard BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.cb_recovery_write_guard()',relation);
  END LOOP;
END; $$;
