-- P2-03 local Issue body/revision/history. No implied project permissions.
CREATE TABLE issues (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL,
  body TEXT NOT NULL CHECK(length(trim(body))>0 AND length(CAST(body AS BLOB))<=8192),
  revision INTEGER NOT NULL CHECK(revision>=1),
  created_at TEXT NOT NULL CHECK(julianday(created_at) IS NOT NULL),
  updated_at TEXT NOT NULL CHECK(julianday(updated_at) IS NOT NULL AND updated_at>=created_at),
  before_body TEXT
);
CREATE INDEX issues_project ON issues(project_id,id);
CREATE TRIGGER issues_fixed_identity BEFORE UPDATE ON issues
WHEN NEW.id<>OLD.id OR NEW.project_id<>OLD.project_id OR NEW.created_at<>OLD.created_at
BEGIN SELECT RAISE(ABORT,'issue identity is immutable'); END;
CREATE TABLE issue_history (
  issue_id TEXT NOT NULL REFERENCES issues(id),
  project_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision>=1),
  operation_id TEXT NOT NULL,
  actor_id TEXT NOT NULL REFERENCES principals(id),
  actor_name TEXT NOT NULL,
  change_kind TEXT NOT NULL CHECK(change_kind IN ('issue.create','issue.edit')),
  before_body TEXT,
  after_body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(issue_id,revision),
  UNIQUE(actor_id,operation_id),
  FOREIGN KEY(actor_id,operation_id) REFERENCES operation_results(principal_id,operation_id),
  CHECK((change_kind='issue.create' AND revision=1 AND before_body IS NULL)
    OR (change_kind='issue.edit' AND revision>1 AND before_body IS NOT NULL))
);
CREATE TRIGGER issue_history_no_update BEFORE UPDATE ON issue_history
BEGIN SELECT RAISE(ABORT,'issue history is immutable'); END;
CREATE TRIGGER issue_history_no_delete BEFORE DELETE ON issue_history
BEGIN SELECT RAISE(ABORT,'issue history is immutable'); END;
