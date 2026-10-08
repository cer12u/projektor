-- Offline additive schema step; caller must pin original schema and keep Store FROZEN.
-- Current project URL metadata. No historical project-key aliases are inferred.
CREATE TABLE project_url(project_id TEXT PRIMARY KEY REFERENCES project(id),project_key TEXT NOT NULL UNIQUE,project_slug TEXT NOT NULL UNIQUE,import_baseline_json TEXT);
CREATE TRIGGER project_url_baseline_no_update BEFORE UPDATE OF import_baseline_json,project_id ON project_url BEGIN SELECT RAISE(ABORT,'immutable project URL import identity'); END;
CREATE TRIGGER project_url_no_delete BEFORE DELETE ON project_url BEGIN SELECT RAISE(ABORT,'immutable project URL import identity'); END;
CREATE TRIGGER query_project_url_insert AFTER INSERT ON project_url BEGIN UPDATE query_state SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER query_project_url_update AFTER UPDATE ON project_url BEGIN UPDATE query_state SET revision=revision+1 WHERE id=1; END;
