-- Canonical additive migration. Existing databases must pass docs/database-migrations.md preflight.
CREATE TABLE issue_execution_reports (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  principal_id TEXT NOT NULL REFERENCES principals(id),
  operation_id TEXT NOT NULL,
  issue_id TEXT NOT NULL REFERENCES issues(id),
  project_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  report_kind TEXT NOT NULL CHECK(report_kind IN ('progress','failed','completed','imported')),
  message TEXT NOT NULL CHECK(length(CAST(message AS BLOB)) BETWEEN 1 AND 4096),
  failure_reason TEXT CHECK(failure_reason IS NULL OR length(CAST(failure_reason AS BLOB)) BETWEEN 1 AND 2048),
  references_json TEXT NOT NULL CHECK(json_valid(references_json) AND json_type(references_json)='array' AND length(CAST(references_json AS BLOB))<=4096),
  recorded_at INTEGER NOT NULL,
  UNIQUE(principal_id,operation_id),
  FOREIGN KEY(principal_id,operation_id) REFERENCES operation_results(principal_id,operation_id),
  FOREIGN KEY(attempt_id,issue_id) REFERENCES issue_execution_attempts(attempt_id,issue_id),
  CHECK((report_kind='failed' AND failure_reason IS NOT NULL) OR (report_kind<>'failed' AND failure_reason IS NULL))
);
CREATE UNIQUE INDEX issue_execution_one_final_report ON issue_execution_reports(attempt_id) WHERE report_kind IN ('completed','imported');
CREATE INDEX issue_execution_reports_lookup ON issue_execution_reports(issue_id,sequence);
CREATE TABLE issue_execution_confirmations (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  principal_id TEXT NOT NULL REFERENCES principals(id),
  operation_id TEXT NOT NULL,
  issue_id TEXT NOT NULL REFERENCES issues(id),
  project_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  lease_version INTEGER NOT NULL CHECK(lease_version>=1),
  outcome TEXT NOT NULL CHECK(outcome IN ('not_performed','applied','unknown')),
  external_operation_id TEXT CHECK(external_operation_id IS NULL OR length(CAST(external_operation_id AS BLOB)) BETWEEN 1 AND 256),
  references_json TEXT NOT NULL CHECK(json_valid(references_json) AND json_type(references_json)='array' AND length(CAST(references_json AS BLOB))<=4096),
  message TEXT NOT NULL CHECK(length(CAST(message AS BLOB)) BETWEEN 1 AND 4096),
  recorded_at INTEGER NOT NULL,
  UNIQUE(principal_id,operation_id),
  FOREIGN KEY(principal_id,operation_id) REFERENCES operation_results(principal_id,operation_id),
  FOREIGN KEY(attempt_id,issue_id) REFERENCES issue_execution_attempts(attempt_id,issue_id),
  CHECK(external_operation_id IS NOT NULL OR json_array_length(references_json)>0),
  CHECK(outcome<>'applied' OR json_array_length(references_json)>0)
);
CREATE INDEX issue_execution_confirmations_lookup ON issue_execution_confirmations(issue_id,sequence);
CREATE TABLE issue_execution_confirmation_uses (
  principal_id TEXT NOT NULL,
  confirmation_operation_id TEXT NOT NULL,
  restart_principal_id TEXT NOT NULL,
  restart_operation_id TEXT NOT NULL,
  new_attempt_id TEXT NOT NULL UNIQUE REFERENCES issue_execution_attempts(attempt_id),
  recorded_at INTEGER NOT NULL,
  PRIMARY KEY(principal_id,confirmation_operation_id),
  FOREIGN KEY(principal_id,confirmation_operation_id) REFERENCES issue_execution_confirmations(principal_id,operation_id),
  FOREIGN KEY(restart_principal_id,restart_operation_id) REFERENCES operation_results(principal_id,operation_id)
);
CREATE TABLE issue_execution_report_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  principal_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  issue_id TEXT NOT NULL REFERENCES issues(id),
  attempt_id TEXT NOT NULL REFERENCES issue_execution_attempts(attempt_id),
  event_kind TEXT NOT NULL CHECK(event_kind IN ('execution-report.progress','execution-report.failed','execution-report.completed','execution-report.reconcile','execution-report.restart')),
  recorded_at INTEGER NOT NULL,
  snapshot TEXT NOT NULL CHECK(json_valid(snapshot)),
  UNIQUE(principal_id,operation_id),
  FOREIGN KEY(principal_id,operation_id) REFERENCES operation_results(principal_id,operation_id)
);
CREATE TRIGGER execution_reports_no_update BEFORE UPDATE ON issue_execution_reports BEGIN SELECT RAISE(ABORT,'report immutable'); END;
CREATE TRIGGER execution_reports_no_delete BEFORE DELETE ON issue_execution_reports BEGIN SELECT RAISE(ABORT,'report retained'); END;
CREATE TRIGGER execution_confirmations_no_update BEFORE UPDATE ON issue_execution_confirmations BEGIN SELECT RAISE(ABORT,'confirmation immutable'); END;
CREATE TRIGGER execution_confirmations_no_delete BEFORE DELETE ON issue_execution_confirmations BEGIN SELECT RAISE(ABORT,'confirmation retained'); END;
CREATE TRIGGER execution_confirmation_uses_no_update BEFORE UPDATE ON issue_execution_confirmation_uses BEGIN SELECT RAISE(ABORT,'confirmation use immutable'); END;
CREATE TRIGGER execution_confirmation_uses_no_delete BEFORE DELETE ON issue_execution_confirmation_uses BEGIN SELECT RAISE(ABORT,'confirmation use retained'); END;
CREATE TRIGGER execution_report_events_no_update BEFORE UPDATE ON issue_execution_report_events BEGIN SELECT RAISE(ABORT,'report event immutable'); END;
CREATE TRIGGER execution_report_events_no_delete BEFORE DELETE ON issue_execution_report_events BEGIN SELECT RAISE(ABORT,'report event retained'); END;
