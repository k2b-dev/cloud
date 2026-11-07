CREATE TABLE pads (
  read_id text PRIMARY KEY CHECK (read_id ~ '^[0-9A-Za-z]{22}$'),
  edit_id_hash text NOT NULL UNIQUE CHECK (edit_id_hash ~ '^[0-9a-f]{64}$'),
  snapshot bytea NOT NULL,
  applied_through bigint NOT NULL DEFAULT 0,
  content_md text NOT NULL DEFAULT '',
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_human_open_on date NOT NULL DEFAULT CURRENT_DATE,
  blocked_at timestamptz,
  deleted_at timestamptz,
  status_reason text
);
CREATE INDEX pads_expiry ON pads(last_human_open_on) WHERE deleted_at IS NULL AND blocked_at IS NULL;
CREATE TABLE pad_updates (
  id bigserial PRIMARY KEY,
  read_id text NOT NULL REFERENCES pads(read_id) ON DELETE CASCADE,
  client_update_id text NOT NULL CHECK (length(client_update_id) BETWEEN 1 AND 128),
  update bytea NOT NULL CHECK (octet_length(update) <= 16777216),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(read_id, client_update_id)
);
CREATE TABLE pad_files (
  read_id text NOT NULL REFERENCES pads(read_id) ON DELETE CASCADE,
  key text NOT NULL,
  name text NOT NULL,
  bytes bytea NOT NULL CHECK (octet_length(bytes) <= 5242880),
  type text NOT NULL,
  checked_type text NOT NULL,
  PRIMARY KEY(read_id, key)
);
CREATE TABLE pad_previews (
  read_id text PRIMARY KEY REFERENCES pads(read_id) ON DELETE CASCADE,
  content_hash text NOT NULL,
  png bytea NOT NULL
);
CREATE TABLE reports (
  id bigserial PRIMARY KEY,
  read_id text NOT NULL REFERENCES pads(read_id),
  reason text NOT NULL,
  text text NOT NULL,
  email text,
  created_at timestamptz NOT NULL DEFAULT now(),
  state text NOT NULL DEFAULT 'open' CHECK(state IN ('open', 'decided')),
  decision text CHECK(decision IN ('keep', 'block', 'delete')),
  reason_text text,
  decided_at timestamptz
);
CREATE TABLE moderation_log (
  id bigserial PRIMARY KEY,
  read_id text NOT NULL REFERENCES pads(read_id),
  report_id bigint REFERENCES reports(id),
  action text NOT NULL CHECK(action IN ('keep', 'block', 'delete', 'expire')),
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE admin_sessions (
  id_hash text PRIMARY KEY,
  csrf_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  password_fingerprint text NOT NULL
);
CREATE INDEX admin_sessions_expiry ON admin_sessions(expires_at);
CREATE TABLE notes_storage (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  used_bytes bigint NOT NULL DEFAULT 0 CHECK (used_bytes >= 0)
);
INSERT INTO notes_storage(singleton) VALUES(true);
