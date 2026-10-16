ALTER TABLE wiki_pages ADD COLUMN parent_id TEXT;
ALTER TABLE wiki_pages ADD COLUMN created_by_id TEXT NOT NULL DEFAULT '';
ALTER TABLE wiki_pages ADD COLUMN updated_by_id TEXT NOT NULL DEFAULT '';
ALTER TABLE wiki_pages ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE wiki_pages ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;
INSERT OR IGNORE INTO wiki_purge_bypass(workspace_id,project_id) SELECT workspace_id,project_id FROM wiki_frozen_scopes;
UPDATE wiki_pages SET
 created_by_id=COALESCE((SELECT actor_id FROM wiki_revisions r WHERE r.workspace_id=wiki_pages.workspace_id AND r.page_id=wiki_pages.id ORDER BY occurred_at,version LIMIT 1),''),
 updated_by_id=COALESCE((SELECT actor_id FROM wiki_revisions r WHERE r.workspace_id=wiki_pages.workspace_id AND r.page_id=wiki_pages.id ORDER BY occurred_at DESC,version DESC LIMIT 1),''),
 created_at=COALESCE((SELECT occurred_at FROM wiki_revisions r WHERE r.workspace_id=wiki_pages.workspace_id AND r.page_id=wiki_pages.id ORDER BY occurred_at,version LIMIT 1),0),
 updated_at=COALESCE((SELECT occurred_at FROM wiki_revisions r WHERE r.workspace_id=wiki_pages.workspace_id AND r.page_id=wiki_pages.id ORDER BY occurred_at DESC,version DESC LIMIT 1),0);
WITH renames AS MATERIALIZED (SELECT page.rowid AS rid, page.slug||'-'||(SELECT COUNT(*)+1 FROM wiki_pages earlier WHERE earlier.workspace_id=page.workspace_id AND earlier.slug=page.slug COLLATE NOCASE AND (earlier.created_at<page.created_at OR (earlier.created_at=page.created_at AND earlier.id<page.id))) AS renamed FROM wiki_pages page WHERE EXISTS(SELECT 1 FROM wiki_pages earlier WHERE earlier.workspace_id=page.workspace_id AND earlier.slug=page.slug COLLATE NOCASE AND (earlier.created_at<page.created_at OR (earlier.created_at=page.created_at AND earlier.id<page.id)))) UPDATE wiki_pages SET slug=(SELECT renamed FROM renames WHERE rid=wiki_pages.rowid) WHERE rowid IN (SELECT rid FROM renames);
DELETE FROM wiki_purge_bypass WHERE EXISTS(SELECT 1 FROM wiki_frozen_scopes f WHERE f.workspace_id=wiki_purge_bypass.workspace_id AND f.project_id=wiki_purge_bypass.project_id);
CREATE UNIQUE INDEX wiki_workspace_slug ON wiki_pages(workspace_id,slug COLLATE NOCASE);
CREATE INDEX wiki_parent ON wiki_pages(workspace_id,parent_id);
