-- Existing history has unknown client attribution; never invent it on upgrade.
ALTER TABLE issues_comments ADD COLUMN client_id TEXT;
ALTER TABLE issues_history ADD COLUMN client_id TEXT;
ALTER TABLE issues_events ADD COLUMN client_id TEXT;

DROP TABLE issues_search;
CREATE VIRTUAL TABLE issues_search USING fts5(workspace_id UNINDEXED, project_id UNINDEXED, issue_id UNINDEXED, title, description, archived UNINDEXED, tokenize='trigram');
INSERT INTO issues_search(rowid,workspace_id,project_id,issue_id,title,description,archived)
 SELECT rowid,workspace_id,project_id,id,title,description,CAST(archived AS TEXT) FROM issues_issues;
