-- @module work
-- @role schema
-- Additive lifecycle metadata; imported source identifiers and records remain unchanged.
ALTER TABLE workspaces ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>=1);
ALTER TABLE projects ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>=1);
ALTER TABLE workspaces ADD COLUMN before_snapshot TEXT;
ALTER TABLE projects ADD COLUMN before_snapshot TEXT;
CREATE TABLE directory_history(
 kind TEXT NOT NULL CHECK(kind IN('project','workspace')),
 target_id TEXT NOT NULL,
 revision INTEGER NOT NULL,
 operation_id TEXT NOT NULL,
 actor_id TEXT NOT NULL REFERENCES principals(id),
 recorded_at TEXT NOT NULL,
 before_snapshot TEXT CHECK(before_snapshot IS NULL OR json_valid(before_snapshot)),
 after_snapshot TEXT NOT NULL CHECK(json_valid(after_snapshot)),
 PRIMARY KEY(kind,target_id,revision),
 FOREIGN KEY(actor_id,operation_id) REFERENCES operation_results(principal_id,operation_id)
);
CREATE TRIGGER directory_history_no_update BEFORE UPDATE ON directory_history BEGIN SELECT RAISE(ABORT,'directory history is immutable'); END;
CREATE TRIGGER directory_history_no_delete BEFORE DELETE ON directory_history BEGIN SELECT RAISE(ABORT,'directory history is immutable'); END;

-- Preserve existing receipts and every referencing history while broadening the named authority.
PRAGMA defer_foreign_keys=ON;
CREATE TABLE directory_operation_results_upgrade (
  principal_id TEXT NOT NULL REFERENCES principals(id),
  operation_id TEXT NOT NULL CHECK(length(operation_id) BETWEEN 1 AND 128),
  operation_kind TEXT NOT NULL,
  target_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  input_hash TEXT NOT NULL CHECK(length(input_hash)=64),
  required_permissions TEXT NOT NULL CHECK(json_valid(required_permissions) AND json_type(required_permissions)='array'),
  state TEXT NOT NULL CHECK(state IN ('pending','confirmed')),
  snapshot TEXT,
  created_at INTEGER NOT NULL,
  confirmed_at INTEGER,
  authority_kind TEXT NOT NULL DEFAULT 'project' CHECK(authority_kind IN ('project','global-administrator','global-administrator-or-scoped-manager')),
  PRIMARY KEY(principal_id,operation_id),
  CHECK((state='pending' AND snapshot IS NULL AND confirmed_at IS NULL)
    OR (state='confirmed' AND snapshot IS NOT NULL AND json_valid(snapshot)
      AND length(CAST(snapshot AS BLOB))<=65536 AND confirmed_at IS NOT NULL))
);
INSERT INTO directory_operation_results_upgrade SELECT principal_id,operation_id,operation_kind,target_id,project_id,input_hash,required_permissions,state,snapshot,created_at,confirmed_at,authority_kind FROM operation_results;
DROP TRIGGER operation_results_immutable;
DROP TRIGGER operation_results_match_intent;
DROP TABLE operation_results;
ALTER TABLE directory_operation_results_upgrade RENAME TO operation_results;
CREATE TRIGGER operation_results_immutable BEFORE UPDATE ON operation_results WHEN OLD.state='confirmed'
BEGIN SELECT RAISE(ABORT,'confirmed operation is immutable'); END;
CREATE TRIGGER operation_results_match_intent BEFORE INSERT ON operation_results
WHEN EXISTS(SELECT 1 FROM operation_intents i WHERE i.principal_id=NEW.principal_id AND i.operation_id=NEW.operation_id
 AND (i.operation_kind<>NEW.operation_kind OR i.target_id<>NEW.target_id OR i.project_id<>NEW.project_id OR i.input_hash<>NEW.input_hash))
BEGIN SELECT RAISE(ABORT,'operation intent input mismatch'); END;
-- SQLite retains deferred DELETE counters across the parent-table replacement even
-- after the same referenced rows are restored. Verify all references before clearing
-- those stale counters; any real violation aborts the migration transaction.
CREATE TABLE directory_upgrade_guard(valid INTEGER NOT NULL CHECK(valid=1));
INSERT INTO directory_upgrade_guard SELECT CASE WHEN EXISTS(SELECT 1 FROM pragma_foreign_key_check) THEN 0 ELSE 1 END;
DROP TABLE directory_upgrade_guard;
PRAGMA defer_foreign_keys=OFF;
