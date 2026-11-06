CREATE TABLE cb_auth_invitations (
  id text PRIMARY KEY CHECK (id ~ '^inv_[a-f0-9]{32}$'),
  center_id text NOT NULL REFERENCES cb_centers(id),
  email text NOT NULL
    CHECK (email = lower(email) AND length(email) BETWEEN 3 AND 254),
  role text NOT NULL CHECK (role IN ('therapist', 'guardian')),
  token_hash text NOT NULL UNIQUE
    CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  invited_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  accepted_user_id text REFERENCES cb_users(id),
  accepted_at timestamptz,
  revoked_at timestamptz,
  CHECK (expires_at > created_at),
  FOREIGN KEY (center_id, invited_by) REFERENCES cb_memberships(center_id, user_id)
);

CREATE UNIQUE INDEX cb_one_pending_invitation
  ON cb_auth_invitations(center_id, email, role)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;

CREATE INDEX cb_auth_invitations_center_idx
  ON cb_auth_invitations(center_id, created_at DESC);

CREATE TABLE cb_auth_audit_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  center_id text NOT NULL REFERENCES cb_centers(id),
  actor_user_id text NOT NULL REFERENCES cb_users(id),
  invitation_id text REFERENCES cb_auth_invitations(id),
  action text NOT NULL CHECK (action IN ('invitation.created', 'invitation.accepted', 'invitation.revoked')),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (center_id, actor_user_id) REFERENCES cb_memberships(center_id, user_id)
);
