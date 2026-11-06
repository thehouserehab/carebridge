CREATE TABLE cb_auth_accounts (
  user_id text PRIMARY KEY REFERENCES cb_users(id) ON DELETE CASCADE,
  email text NOT NULL UNIQUE
    CHECK (email = lower(email) AND length(email) BETWEEN 3 AND 254),
  password_hash text NOT NULL
    CHECK (password_hash LIKE 'scrypt$%' AND length(password_hash) BETWEEN 100 AND 400),
  failed_attempts integer NOT NULL DEFAULT 0
    CHECK (failed_attempts BETWEEN 0 AND 5),
  locked_until timestamptz,
  password_updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE cb_auth_sessions (
  token_hash text PRIMARY KEY
    CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  user_id text NOT NULL REFERENCES cb_users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  revoked_at timestamptz,
  CHECK (expires_at > created_at)
);

CREATE INDEX cb_auth_sessions_user_idx
  ON cb_auth_sessions(user_id, expires_at)
  WHERE revoked_at IS NULL;

CREATE INDEX cb_auth_sessions_expiry_idx
  ON cb_auth_sessions(expires_at)
  WHERE revoked_at IS NULL;
