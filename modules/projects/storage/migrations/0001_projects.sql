CREATE TABLE projects_projects (
 workspace_id TEXT NOT NULL, id TEXT NOT NULL, project_key TEXT NOT NULL,
 name TEXT NOT NULL, version INTEGER NOT NULL CHECK(version > 0),
 archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1)),
 PRIMARY KEY(workspace_id,id)
);
CREATE UNIQUE INDEX projects_key_unique ON projects_projects(workspace_id, project_key COLLATE NOCASE);
CREATE TABLE projects_grants (
 workspace_id TEXT NOT NULL, project_id TEXT NOT NULL, principal_id TEXT NOT NULL,
 role TEXT NOT NULL CHECK(role IN ('manager','editor','viewer')),
 active INTEGER NOT NULL CHECK(active IN (0,1)),
 PRIMARY KEY(workspace_id,project_id,principal_id),
 FOREIGN KEY(workspace_id,project_id) REFERENCES projects_projects(workspace_id,id)
);
CREATE TABLE projects_receipts (
 workspace_id TEXT NOT NULL, principal_id TEXT NOT NULL, operation_id TEXT NOT NULL,
 fingerprint TEXT NOT NULL, result_id TEXT NOT NULL, result_version INTEGER NOT NULL,
 PRIMARY KEY(workspace_id,principal_id,operation_id)
);
CREATE TABLE projects_events (
 workspace_id TEXT NOT NULL, sequence INTEGER NOT NULL, event_id TEXT NOT NULL,
 aggregate_id TEXT NOT NULL, aggregate_version INTEGER NOT NULL, type TEXT NOT NULL,
 occurred_at INTEGER NOT NULL, actor_id TEXT NOT NULL,
 PRIMARY KEY(workspace_id,sequence), UNIQUE(workspace_id,event_id)
);
CREATE TABLE projects_guards (
 workspace_id TEXT NOT NULL, id TEXT NOT NULL, changed INTEGER NOT NULL CHECK(changed = 1),
 PRIMARY KEY(workspace_id,id)
);
