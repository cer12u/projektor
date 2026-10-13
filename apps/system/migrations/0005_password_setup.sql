-- P1b-01: scoped one-use setup rights; no normal authentication or project permissions.
CREATE TABLE password_setup_states (
  principal_id TEXT PRIMARY KEY REFERENCES principals(id),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>=1),
  latest_right_id TEXT,
  before_snapshot TEXT CHECK(before_snapshot IS NULL OR json_valid(before_snapshot))
);
INSERT INTO password_setup_states(principal_id) SELECT id FROM principals WHERE kind='human';
CREATE TRIGGER initialize_password_setup AFTER INSERT ON principals WHEN NEW.kind='human'
BEGIN INSERT INTO password_setup_states(principal_id) VALUES(NEW.id); END;
CREATE TABLE password_setup_rights (
  id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principals(id),
  token_hash TEXT NOT NULL UNIQUE CHECK(length(token_hash)=64),
  purpose TEXT NOT NULL CHECK(purpose IN ('initial','reset')),
  target_auth_version INTEGER NOT NULL,
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK(expires_at>issued_at),
  consumed_at INTEGER,
  revoked_at INTEGER,
  completed_operation_id TEXT,
  input_hash TEXT CHECK(input_hash IS NULL OR length(input_hash)=64),
  completed_auth_version INTEGER,
  completion_snapshot TEXT CHECK(completion_snapshot IS NULL OR json_valid(completion_snapshot)),
  CHECK((consumed_at IS NULL AND completed_operation_id IS NULL AND input_hash IS NULL AND completed_auth_version IS NULL AND completion_snapshot IS NULL)
    OR (consumed_at IS NOT NULL AND completed_operation_id IS NOT NULL AND input_hash IS NOT NULL AND completed_auth_version IS NOT NULL AND completion_snapshot IS NOT NULL))
);
CREATE INDEX password_setup_subject ON password_setup_rights(principal_id);
CREATE TRIGGER password_setup_consumed_immutable BEFORE UPDATE ON password_setup_rights WHEN OLD.consumed_at IS NOT NULL
BEGIN SELECT RAISE(ABORT,'consumed setup right is immutable'); END;
CREATE TABLE password_setup_audit (
  kind TEXT NOT NULL CHECK(kind IN ('issue','revoke','complete','bootstrap')),
  actor_id TEXT NOT NULL REFERENCES principals(id),
  actor_kind TEXT NOT NULL CHECK(actor_kind IN ('authenticated','setup-right-holder','deployment-management')),
  operation_id TEXT NOT NULL,
  principal_id TEXT NOT NULL REFERENCES principals(id),
  right_id TEXT NOT NULL REFERENCES password_setup_rights(id),
  snapshot TEXT NOT NULL CHECK(json_valid(snapshot)),
  recorded_at INTEGER NOT NULL,
  PRIMARY KEY(kind,actor_id,operation_id)
);
CREATE TRIGGER password_setup_audit_no_update BEFORE UPDATE ON password_setup_audit
BEGIN SELECT RAISE(ABORT,'setup audit is immutable'); END;
CREATE TRIGGER password_setup_audit_no_delete BEFORE DELETE ON password_setup_audit
BEGIN SELECT RAISE(ABORT,'setup audit is immutable'); END;
