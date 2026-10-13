CREATE TABLE wiki_pages (
 workspace_id TEXT NOT NULL, id TEXT NOT NULL, project_id TEXT NOT NULL, slug TEXT NOT NULL,
 title TEXT NOT NULL, body TEXT NOT NULL, version INTEGER NOT NULL CHECK(version > 0),
 archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1)),
 PRIMARY KEY(workspace_id,id)
);
CREATE UNIQUE INDEX wiki_project_slug ON wiki_pages(workspace_id,project_id,slug COLLATE NOCASE);
CREATE TABLE wiki_revisions (
 workspace_id TEXT NOT NULL, page_id TEXT NOT NULL, version INTEGER NOT NULL, action TEXT NOT NULL CHECK(action IN ('create','edit','archive')),
 title TEXT NOT NULL, body TEXT NOT NULL, actor_id TEXT NOT NULL, actor_kind TEXT NOT NULL CHECK(actor_kind IN ('human','machine')),
 client_id TEXT, occurred_at INTEGER NOT NULL,
 PRIMARY KEY(workspace_id,page_id,version), FOREIGN KEY(workspace_id,page_id) REFERENCES wiki_pages(workspace_id,id)
);
CREATE TABLE wiki_receipts (
 workspace_id TEXT NOT NULL, principal_id TEXT NOT NULL, operation_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
 result_id TEXT NOT NULL, result_version INTEGER NOT NULL,
 PRIMARY KEY(workspace_id,principal_id,operation_id)
);
CREATE TABLE wiki_events (
 workspace_id TEXT NOT NULL, sequence INTEGER NOT NULL, event_id TEXT NOT NULL, aggregate_id TEXT NOT NULL,
 aggregate_version INTEGER NOT NULL, type TEXT NOT NULL CHECK(type IN ('PageCreated','PageChanged','PageArchived')),
 occurred_at INTEGER NOT NULL, actor_id TEXT NOT NULL, actor_kind TEXT NOT NULL CHECK(actor_kind IN ('human','machine')), client_id TEXT,
 PRIMARY KEY(workspace_id,sequence), UNIQUE(workspace_id,event_id)
);
CREATE TABLE wiki_guards (
 workspace_id TEXT NOT NULL, id TEXT NOT NULL, changed INTEGER NOT NULL CHECK(changed = 1),
 PRIMARY KEY(workspace_id,id)
);
CREATE VIRTUAL TABLE wiki_search USING fts5(workspace_id UNINDEXED, project_id UNINDEXED, page_id UNINDEXED, title, body, archived UNINDEXED, tokenize='trigram');
