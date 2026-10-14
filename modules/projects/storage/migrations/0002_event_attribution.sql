ALTER TABLE projects_events ADD COLUMN client_id TEXT;
ALTER TABLE projects_events ADD COLUMN schema_version INTEGER NOT NULL DEFAULT 1;
