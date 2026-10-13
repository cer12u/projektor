-- P1a / M1-M2 only. No public registration, Issue data or scheduled cleanup.
PRAGMA foreign_keys = ON;
CREATE TABLE principals (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('human','agent')),
  display_name TEXT NOT NULL, login_id TEXT UNIQUE,
  active INTEGER NOT NULL CHECK(active IN (0,1)), auth_version INTEGER NOT NULL DEFAULT 1,
  CHECK((kind='human' AND login_id IS NOT NULL) OR (kind='agent' AND login_id IS NULL))
);
CREATE TABLE passwords (principal_id TEXT PRIMARY KEY REFERENCES principals(id), encoded_hash TEXT NOT NULL);
CREATE TABLE memberships (
  principal_id TEXT NOT NULL REFERENCES principals(id), project_id TEXT NOT NULL,
  permission TEXT NOT NULL CHECK(permission IN ('view','edit','assign','transition','execute','manage')),
  PRIMARY KEY(principal_id,project_id,permission)
);
CREATE TABLE api_credentials (
  id TEXT PRIMARY KEY, principal_id TEXT NOT NULL REFERENCES principals(id),
  token_hash TEXT NOT NULL UNIQUE, expires_at INTEGER NOT NULL, revoked_at INTEGER
);
CREATE TABLE api_grants (
  credential_id TEXT NOT NULL REFERENCES api_credentials(id), project_id TEXT NOT NULL,
  permission TEXT NOT NULL CHECK(permission IN ('view','edit','assign','transition','execute','manage')),
  PRIMARY KEY(credential_id,project_id,permission)
);
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY, principal_id TEXT NOT NULL REFERENCES principals(id),
  auth_version INTEGER NOT NULL, api_credential_id TEXT REFERENCES api_credentials(id),
  csrf_token TEXT NOT NULL, created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL,
  absolute_expires_at INTEGER NOT NULL, revoked_at INTEGER
);
CREATE INDEX sessions_principal ON sessions(principal_id);
CREATE TABLE login_challenges (
  token_hash TEXT PRIMARY KEY, csrf_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL, consumed_at INTEGER
);
CREATE TABLE login_limits (key_hash TEXT PRIMARY KEY, window_start INTEGER NOT NULL, attempts INTEGER NOT NULL);
CREATE TABLE auth_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE auth_guards (id TEXT PRIMARY KEY, valid INTEGER NOT NULL CHECK(valid=1));
