ALTER TABLE coord_events ADD COLUMN client_id TEXT;
ALTER TABLE coord_events ADD COLUMN schema_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE coord_events ADD COLUMN issue_id TEXT;
ALTER TABLE coord_events ADD COLUMN project_id TEXT;
