-- Durable observed lifecycle events. Do not backfill from updated_at: historical
-- completion times and actors are unknown, and activity has a retention window.
CREATE TABLE issue_resolution_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT UNIQUE NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  occurred_at INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('completed', 'reopened', 'cancelled')),
  actor_id TEXT,
  auth_kind TEXT,
  auth_method TEXT,
  from_status TEXT,
  to_status TEXT NOT NULL
);
CREATE INDEX idx_issue_resolution_workspace_time ON issue_resolution_events(workspace_id, occurred_at, sequence);
CREATE INDEX idx_issue_resolution_issue_time ON issue_resolution_events(workspace_id, issue_id, occurred_at, sequence);
PRAGMA optimize;
