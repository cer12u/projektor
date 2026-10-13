-- P2-02: explicit project records are retained for management/display after permission removal.
-- These records are not membership and are never used to grant login/access.
ALTER TABLE operation_results ADD COLUMN authority_kind TEXT NOT NULL DEFAULT 'project'
  CHECK(authority_kind IN ('project','global-administrator'));
CREATE TABLE principal_management (
  principal_id TEXT PRIMARY KEY REFERENCES principals(id),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>=1),
  global_administrator INTEGER NOT NULL DEFAULT 0 CHECK(global_administrator IN (0,1)),
  before_snapshot TEXT CHECK(before_snapshot IS NULL OR json_valid(before_snapshot))
);
CREATE TABLE principal_project_records (
  principal_id TEXT NOT NULL REFERENCES principals(id), project_id TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>=1),
  before_snapshot TEXT CHECK(before_snapshot IS NULL OR json_valid(before_snapshot)),
  PRIMARY KEY(principal_id,project_id)
);
CREATE TABLE credential_management (
  credential_id TEXT PRIMARY KEY REFERENCES api_credentials(id),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>=1),
  before_snapshot TEXT CHECK(before_snapshot IS NULL OR json_valid(before_snapshot))
);
CREATE TABLE credential_project_records (
  credential_id TEXT NOT NULL REFERENCES api_credentials(id), project_id TEXT NOT NULL,
  PRIMARY KEY(credential_id,project_id)
);
INSERT INTO principal_management(principal_id) SELECT id FROM principals;
INSERT INTO credential_management(credential_id) SELECT id FROM api_credentials;
INSERT INTO principal_project_records(principal_id,project_id)
  SELECT principal_id,project_id FROM memberships UNION
  SELECT c.principal_id,g.project_id FROM api_credentials c JOIN api_grants g ON g.credential_id=c.id;
INSERT INTO credential_project_records(credential_id,project_id)
  SELECT DISTINCT credential_id,project_id FROM api_grants;
CREATE TRIGGER initialize_principal_management AFTER INSERT ON principals
BEGIN INSERT INTO principal_management(principal_id) VALUES(NEW.id); END;
CREATE TRIGGER initialize_credential_management AFTER INSERT ON api_credentials
BEGIN INSERT INTO credential_management(credential_id) VALUES(NEW.id); END;
CREATE TRIGGER retain_principal_project AFTER INSERT ON memberships
BEGIN INSERT OR IGNORE INTO principal_project_records(principal_id,project_id) VALUES(NEW.principal_id,NEW.project_id); END;
CREATE TRIGGER retain_credential_project AFTER INSERT ON api_grants
BEGIN
  INSERT OR IGNORE INTO credential_project_records(credential_id,project_id) VALUES(NEW.credential_id,NEW.project_id);
  INSERT OR IGNORE INTO principal_project_records(principal_id,project_id)
    SELECT principal_id,NEW.project_id FROM api_credentials WHERE id=NEW.credential_id;
END;
CREATE TABLE management_audit (
  actor_id TEXT NOT NULL REFERENCES principals(id), operation_id TEXT NOT NULL,
  actor_display_name TEXT NOT NULL, operation_kind TEXT NOT NULL,
  target_id TEXT NOT NULL, project_id TEXT NOT NULL,
  before_revision INTEGER NOT NULL, after_revision INTEGER NOT NULL CHECK(after_revision=before_revision+1),
  before_snapshot TEXT NOT NULL CHECK(json_valid(before_snapshot)),
  after_snapshot TEXT NOT NULL CHECK(json_valid(after_snapshot)),
  recorded_at INTEGER NOT NULL,
  PRIMARY KEY(actor_id,operation_id),
  FOREIGN KEY(actor_id,operation_id) REFERENCES operation_results(principal_id,operation_id)
);
CREATE TRIGGER management_audit_no_update BEFORE UPDATE ON management_audit
BEGIN SELECT RAISE(ABORT,'management audit is immutable'); END;
CREATE TRIGGER management_audit_no_delete BEFORE DELETE ON management_audit
BEGIN SELECT RAISE(ABORT,'management audit is immutable'); END;
