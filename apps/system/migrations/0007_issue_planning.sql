-- P3-01/P3-04, same Issue revision; no external calendars or production import.
ALTER TABLE issues ADD COLUMN priority INTEGER CHECK(priority IS NULL OR priority BETWEEN 1 AND 5);
ALTER TABLE issues ADD COLUMN assignee_id TEXT REFERENCES principals(id);
ALTER TABLE issues ADD COLUMN state TEXT NOT NULL DEFAULT 'Backlog' CHECK(state IN('Backlog','Todo','In Progress','In Review','Done','Canceled'));
ALTER TABLE issues ADD COLUMN resolved_at TEXT;
ALTER TABLE issues ADD COLUMN resolution_json TEXT CHECK(resolution_json IS NULL OR json_valid(resolution_json));
ALTER TABLE issues ADD COLUMN schedule_json TEXT NOT NULL DEFAULT '{"start":null,"end":null,"due":null}' CHECK(json_valid(schedule_json));
ALTER TABLE issues ADD COLUMN before_meta_json TEXT CHECK(before_meta_json IS NULL OR json_valid(before_meta_json));
ALTER TABLE issue_history ADD COLUMN before_snapshot TEXT CHECK(before_snapshot IS NULL OR json_valid(before_snapshot));
ALTER TABLE issue_history ADD COLUMN after_snapshot TEXT CHECK(after_snapshot IS NULL OR json_valid(after_snapshot));
ALTER TABLE issue_history ADD COLUMN changed_fields TEXT NOT NULL DEFAULT '["body"]' CHECK(json_valid(changed_fields));
CREATE INDEX issues_my_order ON issues(project_id,assignee_id,priority DESC,created_at,id);
CREATE TABLE issue_resolution_events (
 issue_id TEXT NOT NULL REFERENCES issues(id),revision INTEGER NOT NULL,
 event_kind TEXT NOT NULL CHECK(event_kind IN('resolved','reopened')),
 time_json TEXT NOT NULL CHECK(json_valid(time_json)),recorded_at TEXT NOT NULL,
 PRIMARY KEY(issue_id,revision)
);
CREATE TRIGGER issue_resolution_event AFTER UPDATE OF state ON issues
WHEN NEW.state<>OLD.state AND (NEW.state='Done' OR OLD.state='Done')
BEGIN
 INSERT INTO issue_resolution_events VALUES(NEW.id,NEW.revision,
  CASE WHEN NEW.state='Done' THEN 'resolved' ELSE 'reopened' END,
  CASE WHEN NEW.state='Done' THEN NEW.resolution_json ELSE json_object('kind','instant','at',strftime('%Y-%m-%dT%H:%M:%fZ','now')) END,
  strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
CREATE TRIGGER issue_resolution_no_update BEFORE UPDATE ON issue_resolution_events
BEGIN SELECT RAISE(ABORT,'resolution event is immutable'); END;
CREATE TRIGGER issue_resolution_no_delete BEFORE DELETE ON issue_resolution_events
BEGIN SELECT RAISE(ABORT,'resolution event is immutable'); END;
