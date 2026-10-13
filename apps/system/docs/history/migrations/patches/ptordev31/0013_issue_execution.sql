-- PTORDEV-31 additive candidate. Existing v17 migrations/import SQL are unchanged.
CREATE TABLE issue_execution_attempts (
  attempt_id TEXT PRIMARY KEY NOT NULL,
  issue_id TEXT NOT NULL REFERENCES issues(id),
  project_id TEXT NOT NULL,
  principal_id TEXT NOT NULL REFERENCES principals(id),
  start_operation_id TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  lease_version INTEGER NOT NULL CHECK(lease_version>=1),
  state TEXT NOT NULL CHECK(state IN ('running','ended','interrupted')),
  ended_at INTEGER,
  end_reason TEXT CHECK(end_reason IN ('released','disconnected','expired')),
  UNIQUE(principal_id,start_operation_id),
  UNIQUE(attempt_id,issue_id),
  FOREIGN KEY(principal_id,start_operation_id) REFERENCES operation_results(principal_id,operation_id),
  CHECK(updated_at>=started_at AND expires_at=updated_at+300),
  CHECK((state='running' AND ended_at IS NULL AND end_reason IS NULL)
    OR (state='ended' AND ended_at IS NOT NULL AND ended_at>=started_at AND end_reason IS NOT NULL AND end_reason='released')
    OR (state='interrupted' AND ended_at IS NOT NULL AND ended_at>=started_at AND end_reason IS NOT NULL AND end_reason IN ('disconnected','expired')))
);
CREATE UNIQUE INDEX issue_execution_one_running ON issue_execution_attempts(issue_id) WHERE state='running';
CREATE TABLE issue_execution_heads (
  issue_id TEXT PRIMARY KEY NOT NULL REFERENCES issues(id),
  attempt_id TEXT NOT NULL,
  FOREIGN KEY(attempt_id,issue_id) REFERENCES issue_execution_attempts(attempt_id,issue_id)
);
CREATE TABLE issue_execution_events (
  principal_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL REFERENCES issue_execution_attempts(attempt_id),
  event_kind TEXT NOT NULL CHECK(event_kind IN ('execution.acquire','execution.renew','execution.end','execution.interrupt')),
  recorded_at INTEGER NOT NULL,
  snapshot TEXT NOT NULL CHECK(json_valid(snapshot)),
  PRIMARY KEY(principal_id,operation_id),
  FOREIGN KEY(principal_id,operation_id) REFERENCES operation_results(principal_id,operation_id)
);
CREATE TRIGGER issue_execution_fixed_identity BEFORE UPDATE ON issue_execution_attempts
WHEN NEW.attempt_id<>OLD.attempt_id OR NEW.issue_id<>OLD.issue_id OR NEW.project_id<>OLD.project_id
  OR NEW.principal_id<>OLD.principal_id OR NEW.start_operation_id<>OLD.start_operation_id
  OR NEW.started_at<>OLD.started_at OR OLD.state<>'running' OR NEW.lease_version<>OLD.lease_version+1
BEGIN SELECT RAISE(ABORT,'execution identity or terminal state is immutable'); END;
CREATE TRIGGER issue_execution_no_delete BEFORE DELETE ON issue_execution_attempts
BEGIN SELECT RAISE(ABORT,'execution attempt is retained'); END;
CREATE TRIGGER issue_execution_events_no_update BEFORE UPDATE ON issue_execution_events
BEGIN SELECT RAISE(ABORT,'execution event is immutable'); END;
CREATE TRIGGER issue_execution_events_no_delete BEFORE DELETE ON issue_execution_events
BEGIN SELECT RAISE(ABORT,'execution event is immutable'); END;
