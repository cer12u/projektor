-- Principals are global identity, never authorization. Memberships are tenant-local.
CREATE TABLE access_principals (
 id TEXT PRIMARY KEY NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('human','machine')),
 issuer TEXT NOT NULL, subject TEXT NOT NULL, UNIQUE(kind, issuer, subject)
);
CREATE TABLE access_workspaces (
 workspace_id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL,
 version INTEGER NOT NULL CHECK(version > 0), archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1))
);
CREATE TABLE access_memberships (
 workspace_id TEXT NOT NULL, principal_id TEXT NOT NULL,
 role TEXT NOT NULL CHECK(role IN ('owner','admin','member','viewer')),
 active INTEGER NOT NULL CHECK(active IN (0,1)), version INTEGER NOT NULL CHECK(version > 0),
 PRIMARY KEY(workspace_id,principal_id),
 FOREIGN KEY(workspace_id) REFERENCES access_workspaces(workspace_id),
 FOREIGN KEY(principal_id) REFERENCES access_principals(id)
);
CREATE TABLE access_credentials (
 workspace_id TEXT NOT NULL, id TEXT NOT NULL, principal_id TEXT NOT NULL,
 token_hash TEXT NOT NULL, scope TEXT NOT NULL CHECK(scope IN ('read','write')),
 expires_at INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0 CHECK(revoked IN (0,1)),
 version INTEGER NOT NULL CHECK(version > 0), PRIMARY KEY(workspace_id,id),
 UNIQUE(workspace_id,token_hash),
 FOREIGN KEY(workspace_id,principal_id) REFERENCES access_memberships(workspace_id,principal_id)
);
CREATE TABLE access_receipts (
 workspace_id TEXT NOT NULL, principal_id TEXT NOT NULL, operation_id TEXT NOT NULL,
 fingerprint TEXT NOT NULL, result_id TEXT NOT NULL, result_version INTEGER NOT NULL,
 PRIMARY KEY(workspace_id,principal_id,operation_id)
);
-- Immutable history and producer outbox are the same records; no consumer state here.
CREATE TABLE access_events (
 workspace_id TEXT NOT NULL, sequence INTEGER NOT NULL, event_id TEXT NOT NULL,
 aggregate_id TEXT NOT NULL, aggregate_version INTEGER NOT NULL, type TEXT NOT NULL,
 occurred_at INTEGER NOT NULL, actor_id TEXT NOT NULL,
 PRIMARY KEY(workspace_id,sequence), UNIQUE(workspace_id,event_id)
);
CREATE TABLE access_guards (
 workspace_id TEXT NOT NULL, id TEXT NOT NULL, changed INTEGER NOT NULL CHECK(changed = 1),
 PRIMARY KEY(workspace_id,id)
);
-- Global installation latch: exactly one operator bootstrap, even across concurrent workspaces.
CREATE TABLE access_bootstrap (id INTEGER PRIMARY KEY CHECK(id = 1), workspace_id TEXT NOT NULL);
