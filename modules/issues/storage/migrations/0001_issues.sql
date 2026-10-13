CREATE TABLE issues_counters (
 workspace_id TEXT NOT NULL, project_id TEXT NOT NULL, next_number INTEGER NOT NULL CHECK(next_number > 0),
 PRIMARY KEY(workspace_id,project_id)
);
CREATE TABLE issues_issues (
 workspace_id TEXT NOT NULL, id TEXT NOT NULL, project_id TEXT NOT NULL, number INTEGER NOT NULL CHECK(number > 0),
 title TEXT NOT NULL, description TEXT NOT NULL, priority TEXT NOT NULL CHECK(priority IN ('low','medium','high','urgent')),
 state TEXT NOT NULL CHECK(state IN ('todo','in_progress','done','cancelled')),
 assignee_id TEXT, version INTEGER NOT NULL CHECK(version > 0), archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1)),
 PRIMARY KEY(workspace_id,id)
);
CREATE UNIQUE INDEX issues_project_number ON issues_issues(workspace_id,project_id,number);
CREATE TABLE issues_comments (
 workspace_id TEXT NOT NULL, id TEXT NOT NULL, issue_id TEXT NOT NULL, body TEXT NOT NULL,
 actor_id TEXT NOT NULL, actor_kind TEXT NOT NULL CHECK(actor_kind IN ('human','machine')), created_at INTEGER NOT NULL,
 PRIMARY KEY(workspace_id,id), FOREIGN KEY(workspace_id,issue_id) REFERENCES issues_issues(workspace_id,id)
);
CREATE TABLE issues_history (
 workspace_id TEXT NOT NULL, issue_id TEXT NOT NULL, version INTEGER NOT NULL, action TEXT NOT NULL,
 actor_id TEXT NOT NULL, actor_kind TEXT NOT NULL CHECK(actor_kind IN ('human','machine')), occurred_at INTEGER NOT NULL, detail TEXT NOT NULL,
 PRIMARY KEY(workspace_id,issue_id,version), FOREIGN KEY(workspace_id,issue_id) REFERENCES issues_issues(workspace_id,id)
);
CREATE TABLE issues_receipts (
 workspace_id TEXT NOT NULL, principal_id TEXT NOT NULL, operation_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
 result_id TEXT NOT NULL, result_number INTEGER NOT NULL, result_version INTEGER NOT NULL,
 PRIMARY KEY(workspace_id,principal_id,operation_id)
);
CREATE TABLE issues_events (
 workspace_id TEXT NOT NULL, sequence INTEGER NOT NULL, event_id TEXT NOT NULL, aggregate_id TEXT NOT NULL,
 aggregate_version INTEGER NOT NULL, type TEXT NOT NULL, occurred_at INTEGER NOT NULL, actor_id TEXT NOT NULL,
 actor_kind TEXT NOT NULL CHECK(actor_kind IN ('human','machine')),
 PRIMARY KEY(workspace_id,sequence), UNIQUE(workspace_id,event_id)
);
CREATE TABLE issues_guards (
 workspace_id TEXT NOT NULL, id TEXT NOT NULL, changed INTEGER NOT NULL CHECK(changed = 1),
 PRIMARY KEY(workspace_id,id)
);
CREATE VIRTUAL TABLE issues_search USING fts5(workspace_id UNINDEXED, project_id UNINDEXED, issue_id UNINDEXED, title, description, archived UNINDEXED);
