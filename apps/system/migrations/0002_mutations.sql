-- P2-01 common local mutation infrastructure; no product Issue tables or endpoints.
CREATE TABLE operation_results (
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
  PRIMARY KEY(principal_id,operation_id),
  CHECK((state='pending' AND snapshot IS NULL AND confirmed_at IS NULL)
    OR (state='confirmed' AND snapshot IS NOT NULL AND json_valid(snapshot)
      AND length(CAST(snapshot AS BLOB))<=65536 AND confirmed_at IS NOT NULL))
);
CREATE TRIGGER operation_results_immutable
BEFORE UPDATE ON operation_results WHEN OLD.state='confirmed'
BEGIN SELECT RAISE(ABORT,'confirmed operation is immutable'); END;
CREATE TABLE mutation_guards (
  batch_id TEXT NOT NULL,
  step INTEGER NOT NULL,
  valid INTEGER NOT NULL CHECK(valid=1),
  PRIMARY KEY(batch_id,step)
);
