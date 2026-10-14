CREATE TABLE assets_blobs (
 workspace_id TEXT NOT NULL, id TEXT NOT NULL, project_id TEXT NOT NULL, size INTEGER NOT NULL CHECK(size >= 0),
 content_type TEXT NOT NULL, filename TEXT NOT NULL, sha256 TEXT NOT NULL, version INTEGER NOT NULL CHECK(version > 0),
 state TEXT NOT NULL CHECK(state IN ('pending','ready','retired')),
 created_at INTEGER NOT NULL, PRIMARY KEY(workspace_id,id)
);
CREATE TABLE assets_links (
 workspace_id TEXT NOT NULL, id TEXT NOT NULL, asset_id TEXT NOT NULL, target_kind TEXT NOT NULL CHECK(target_kind IN ('issue','wiki')),
 target_id TEXT NOT NULL, PRIMARY KEY(workspace_id,id),
 FOREIGN KEY(workspace_id,asset_id) REFERENCES assets_blobs(workspace_id,id)
);
CREATE INDEX assets_target ON assets_links(workspace_id,target_kind,target_id,id);
CREATE TABLE assets_gc_jobs (
 workspace_id TEXT NOT NULL, asset_id TEXT NOT NULL, due_at INTEGER NOT NULL,
 PRIMARY KEY(workspace_id,asset_id), FOREIGN KEY(workspace_id,asset_id) REFERENCES assets_blobs(workspace_id,id)
);
CREATE TABLE assets_history (
 workspace_id TEXT NOT NULL, asset_id TEXT NOT NULL, version INTEGER NOT NULL, action TEXT NOT NULL,
 actor_id TEXT NOT NULL, occurred_at INTEGER NOT NULL, PRIMARY KEY(workspace_id,asset_id,version),
 FOREIGN KEY(workspace_id,asset_id) REFERENCES assets_blobs(workspace_id,id)
);
CREATE TABLE assets_receipts (
 workspace_id TEXT NOT NULL, principal_id TEXT NOT NULL, operation_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
 result_id TEXT NOT NULL, result_version INTEGER NOT NULL, PRIMARY KEY(workspace_id,principal_id,operation_id)
);
CREATE TABLE assets_events (
 workspace_id TEXT NOT NULL, sequence INTEGER NOT NULL, event_id TEXT NOT NULL, aggregate_id TEXT NOT NULL,
 aggregate_version INTEGER NOT NULL, type TEXT NOT NULL, occurred_at INTEGER NOT NULL, actor_id TEXT NOT NULL,
 PRIMARY KEY(workspace_id,sequence), UNIQUE(workspace_id,event_id)
);
CREATE TABLE assets_guards (
 workspace_id TEXT NOT NULL, id TEXT NOT NULL, changed INTEGER NOT NULL CHECK(changed=1), PRIMARY KEY(workspace_id,id)
);
