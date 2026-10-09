-- Offline additive schema step; caller must pin original schema and keep Store FROZEN.
-- Imported current-Issue compatibility, not inferred historical authority.
CREATE TABLE issue_compat_status(id TEXT PRIMARY KEY,status_key TEXT NOT NULL,name TEXT NOT NULL,category TEXT NOT NULL CHECK(category IN ('backlog','ready','in_progress','blocked','done','canceled')),is_review_step INTEGER NOT NULL CHECK(is_review_step IN (0,1)),position INTEGER NOT NULL CHECK(position>=0));
CREATE TABLE issue_compat_state(issue_id TEXT PRIMARY KEY REFERENCES issue(id),status_id TEXT NOT NULL REFERENCES issue_compat_status(id),type_id TEXT,type_name TEXT,completion_report_at INTEGER CHECK(completion_report_at IS NULL OR completion_report_at>=0),dor_ready INTEGER CHECK(dor_ready IS NULL OR dor_ready IN (0,1)),dor_missing_raw TEXT,dor_revision_id TEXT REFERENCES content_revision(id),import_baseline_json TEXT NOT NULL);
CREATE TRIGGER compat_status_no_update BEFORE UPDATE ON issue_compat_status BEGIN SELECT RAISE(ABORT,'immutable imported status'); END;
CREATE TRIGGER compat_status_no_delete BEFORE DELETE ON issue_compat_status BEGIN SELECT RAISE(ABORT,'immutable imported status'); END;
CREATE TRIGGER compat_baseline_no_update BEFORE UPDATE OF import_baseline_json ON issue_compat_state BEGIN SELECT RAISE(ABORT,'immutable compatibility baseline'); END;
CREATE TRIGGER query_compat_insert AFTER INSERT ON issue_compat_state BEGIN UPDATE query_state SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER query_compat_update AFTER UPDATE ON issue_compat_state BEGIN UPDATE query_state SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER query_compat_delete AFTER DELETE ON issue_compat_state BEGIN UPDATE query_state SET revision=revision+1 WHERE id=1; END;
