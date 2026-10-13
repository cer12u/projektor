-- @module persistence
-- @role schema
-- Preserve recorded inputs and sequence cursors while extending the closed command set.
CREATE TABLE operation_intents_next (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  principal_id TEXT NOT NULL REFERENCES principals(id),
  operation_id TEXT NOT NULL CHECK(length(operation_id) BETWEEN 1 AND 128),
  format_version INTEGER NOT NULL CHECK(format_version>=1),
  operation_kind TEXT NOT NULL CHECK(operation_kind IN (
    'issue.create','issue.edit','wiki.create','wiki.edit','comment.create','comment.edit',
    'execution.acquire','execution.renew','execution.end','execution.interrupt',
    'execution-report.progress','execution-report.failed','execution-report.completed',
    'execution-report.reconcile','execution-report.restart',
    'directory.project.create','directory.project.edit','directory.workspace.create','directory.workspace.edit')),
  target_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  route_json TEXT NOT NULL CHECK(json_valid(route_json) AND json_type(route_json)='object' AND length(CAST(route_json AS BLOB))<=4096),
  input_json TEXT NOT NULL CHECK(json_valid(input_json) AND json_type(input_json)='object' AND length(CAST(input_json AS BLOB))<=65536),
  input_hash TEXT NOT NULL CHECK(length(input_hash)=64),
  required_permissions TEXT NOT NULL CHECK(json_valid(required_permissions) AND json_type(required_permissions)='array'),
  prepared_at INTEGER NOT NULL,
  UNIQUE(principal_id,operation_id)
);
INSERT INTO operation_intents_next SELECT * FROM operation_intents;
DROP TRIGGER operation_results_match_intent;
DROP TABLE operation_intents;
ALTER TABLE operation_intents_next RENAME TO operation_intents;
CREATE INDEX operation_intents_principal_sequence ON operation_intents(principal_id,sequence);
CREATE TRIGGER operation_intents_no_update BEFORE UPDATE ON operation_intents
BEGIN SELECT RAISE(ABORT,'operation intent is immutable'); END;
CREATE TRIGGER operation_intents_no_delete BEFORE DELETE ON operation_intents
BEGIN SELECT RAISE(ABORT,'operation intent is immutable'); END;
-- An existing REST path cannot commit different input under a durably prepared ID.
CREATE TRIGGER operation_results_match_intent BEFORE INSERT ON operation_results
WHEN EXISTS(SELECT 1 FROM operation_intents i WHERE i.principal_id=NEW.principal_id AND i.operation_id=NEW.operation_id
  AND (i.operation_kind<>NEW.operation_kind OR i.target_id<>NEW.target_id OR i.project_id<>NEW.project_id OR i.input_hash<>NEW.input_hash))
BEGIN SELECT RAISE(ABORT,'operation intent input mismatch'); END;

-- INSERT OR REPLACE must not bypass immutable UPDATE/DELETE triggers. SQLite may
-- disable recursive delete triggers; this check runs before conflict replacement.
CREATE TRIGGER operation_intents_no_replace BEFORE INSERT ON operation_intents
WHEN EXISTS(SELECT 1 FROM operation_intents WHERE sequence=NEW.sequence OR (principal_id=NEW.principal_id AND operation_id=NEW.operation_id))
BEGIN SELECT RAISE(ABORT,'operation intent is immutable'); END;
