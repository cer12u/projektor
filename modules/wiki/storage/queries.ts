export const queries = {
  page: "SELECT id,project_id,slug,title,body,version,archived FROM wiki_pages WHERE workspace_id=? AND id=?",
  bySlug:
    "SELECT id,project_id,slug,title,body,version,archived FROM wiki_pages WHERE workspace_id=? AND project_id=? AND slug=? COLLATE NOCASE",
  list: "SELECT id,project_id,slug,title,body,version,archived FROM wiki_pages WHERE workspace_id=? AND project_id=? AND archived=0 AND slug COLLATE NOCASE > ? COLLATE NOCASE ORDER BY slug COLLATE NOCASE LIMIT ?",
  search:
    "SELECT p.id,p.project_id,p.slug,p.title,p.body,p.version,p.archived FROM wiki_search s JOIN wiki_pages p ON p.rowid=s.rowid WHERE wiki_search MATCH ? AND s.workspace_id=? AND s.project_id=? AND s.archived='0' AND p.workspace_id=? AND p.project_id=? AND p.archived=0 ORDER BY bm25(wiki_search),p.slug COLLATE NOCASE LIMIT ?",
  searchShort:
    "WITH terms(pattern) AS (VALUES (?),(?),(?),(?),(?),(?),(?),(?),(?),(?),(?),(?)) SELECT p.id,p.project_id,p.slug,p.title,p.body,p.version,p.archived FROM wiki_pages p WHERE p.workspace_id=? AND p.project_id=? AND p.archived=0 AND NOT EXISTS (SELECT 1 FROM terms WHERE pattern IS NOT NULL AND NOT (p.title LIKE pattern ESCAPE '\\' OR p.body LIKE pattern ESCAPE '\\')) ORDER BY p.slug COLLATE NOCASE LIMIT ?",
  create:
    "INSERT INTO wiki_pages(workspace_id,id,project_id,slug,title,body,version) VALUES(?,?,?,?,?,?,1)",
  edit: "UPDATE wiki_pages SET title=?,body=?,version=version+1 WHERE workspace_id=? AND id=? AND version=? AND archived=0",
  archive:
    "UPDATE wiki_pages SET archived=1,version=version+1 WHERE workspace_id=? AND id=? AND version=? AND archived=0",
  guard: "INSERT INTO wiki_guards(workspace_id,id,changed) VALUES(?,?,changes())",
  clearGuard: "DELETE FROM wiki_guards WHERE workspace_id=? AND id=?",
  deleteSearch:
    "DELETE FROM wiki_search WHERE rowid=(SELECT rowid FROM wiki_pages WHERE workspace_id=? AND id=?)",
  upsertSearch:
    "INSERT INTO wiki_search(rowid,workspace_id,project_id,page_id,title,body,archived) SELECT rowid,workspace_id,project_id,id,title,body,CAST(archived AS TEXT) FROM wiki_pages WHERE workspace_id=? AND id=?",
  revision:
    "INSERT INTO wiki_revisions(workspace_id,page_id,version,action,title,body,actor_id,actor_kind,client_id,occurred_at) SELECT workspace_id,id,version,?,title,body,?,?,?,? FROM wiki_pages WHERE workspace_id=? AND id=?",
  getRevision:
    "SELECT page_id,version,action,title,body,actor_id,actor_kind,client_id,occurred_at FROM wiki_revisions WHERE workspace_id=? AND page_id=? AND version=?",
  listRevisions:
    "SELECT page_id,version,action,title,body,actor_id,actor_kind,client_id,occurred_at FROM wiki_revisions WHERE workspace_id=? AND page_id=? AND version<? ORDER BY version DESC LIMIT ?",
  receipt:
    "INSERT INTO wiki_receipts(workspace_id,principal_id,operation_id,fingerprint,result_id,result_version) SELECT ?,?,?,?,id,version FROM wiki_pages WHERE workspace_id=? AND id=?",
  readReceipt:
    "SELECT fingerprint,result_id,result_version FROM wiki_receipts WHERE workspace_id=? AND principal_id=? AND operation_id=?",
  event:
    "INSERT INTO wiki_events(workspace_id,sequence,event_id,aggregate_id,aggregate_version,type,occurred_at,actor_id,actor_kind,client_id) VALUES(?,(SELECT COALESCE(MAX(sequence),0)+1 FROM wiki_events WHERE workspace_id=?),?,?,?,?,?,?,?,?)",
  events:
    "SELECT sequence,event_id,aggregate_id,aggregate_version,type,occurred_at,actor_id,actor_kind,client_id FROM wiki_events WHERE workspace_id=? AND sequence>? ORDER BY sequence LIMIT ?",
} as const;
