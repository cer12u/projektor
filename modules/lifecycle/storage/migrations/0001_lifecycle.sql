CREATE TABLE lifecycle_jobs (
 workspace_id TEXT NOT NULL, id TEXT NOT NULL, scope_id TEXT NOT NULL, project_id TEXT,
 requester_id TEXT NOT NULL, version INTEGER NOT NULL CHECK(version>0),
 state TEXT NOT NULL CHECK(state IN ('freezing','purging','complete')),
 updated_at INTEGER NOT NULL, next_attempt_at INTEGER NOT NULL,
 PRIMARY KEY(workspace_id,id), UNIQUE(workspace_id,scope_id)
);
CREATE TABLE lifecycle_steps (
 workspace_id TEXT NOT NULL, job_id TEXT NOT NULL, owner TEXT NOT NULL, ordinal INTEGER NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('pending','frozen','purging','purged')),
 remaining INTEGER NOT NULL DEFAULT 0, pending INTEGER NOT NULL DEFAULT 0, error TEXT,
 PRIMARY KEY(workspace_id,job_id,owner),
 FOREIGN KEY(workspace_id,job_id) REFERENCES lifecycle_jobs(workspace_id,id)
);
CREATE TABLE lifecycle_receipts (
 workspace_id TEXT NOT NULL, principal_id TEXT NOT NULL, operation_id TEXT NOT NULL,
 fingerprint TEXT NOT NULL, result_json TEXT NOT NULL,
 PRIMARY KEY(workspace_id,principal_id,operation_id)
);
CREATE TABLE lifecycle_guards (
 workspace_id TEXT NOT NULL, id TEXT NOT NULL, changed INTEGER NOT NULL CHECK(changed=1),
 PRIMARY KEY(workspace_id,id)
);
CREATE TABLE lifecycle_history (
 workspace_id TEXT NOT NULL, job_id TEXT NOT NULL, version INTEGER NOT NULL,
 action TEXT NOT NULL, actor_id TEXT NOT NULL, occurred_at INTEGER NOT NULL,
 PRIMARY KEY(workspace_id,job_id,version)
);
CREATE TABLE lifecycle_events (
 workspace_id TEXT NOT NULL, event_id TEXT NOT NULL, aggregate_id TEXT NOT NULL,
 aggregate_version INTEGER NOT NULL, type TEXT NOT NULL, occurred_at INTEGER NOT NULL,
 PRIMARY KEY(workspace_id,event_id)
);
