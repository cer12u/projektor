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
    "INSERT INTO wiki_receipts(workspace_id,principal_id,operation_id,fingerprint,result_id,result_version,project_id) SELECT ?,?,?,?,id,version,project_id FROM wiki_pages WHERE workspace_id=? AND id=?",
  readReceipt:
    "SELECT fingerprint,result_id,result_version FROM wiki_receipts WHERE workspace_id=? AND principal_id=? AND operation_id=?",
  event:
    "INSERT INTO wiki_events(workspace_id,sequence,event_id,aggregate_id,aggregate_version,type,occurred_at,actor_id,actor_kind,client_id,project_id) VALUES(?,(SELECT COALESCE(MAX(sequence),0)+1 FROM wiki_events WHERE workspace_id=?),?,?,?,?,?,?,?,?,(SELECT project_id FROM wiki_pages WHERE workspace_id=? AND id=?))",
  events:
    "SELECT sequence,event_id,aggregate_id,aggregate_version,type,occurred_at,actor_id,actor_kind,client_id,project_id FROM wiki_events WHERE workspace_id=? AND sequence>? ORDER BY sequence LIMIT ?",
  maintenanceFreeze:
    "INSERT INTO wiki_frozen_scopes(workspace_id,project_id,state) VALUES(?,?,'frozen') ON CONFLICT(workspace_id,project_id) DO NOTHING",
  maintenanceMarker: "SELECT state FROM wiki_frozen_scopes WHERE workspace_id=? AND project_id=?",
  maintenanceBegin:
    "UPDATE wiki_frozen_scopes SET state='purging' WHERE workspace_id=? AND project_id=? AND state='frozen'",
  maintenanceDone:
    "UPDATE wiki_frozen_scopes SET state='purged' WHERE workspace_id=? AND project_id=? AND state='purging'",
  maintenanceBypass: "INSERT INTO wiki_purge_bypass(workspace_id,project_id) VALUES(?,?)",
  maintenanceUnbypass: "DELETE FROM wiki_purge_bypass WHERE workspace_id=? AND project_id=?",
  maintenanceCountSearch:
    "SELECT COUNT(*) AS n FROM wiki_search t WHERE t.workspace_id=? AND (?='' OR t.project_id=?)",
  maintenanceDeleteSearch:
    "DELETE FROM wiki_search WHERE rowid IN (SELECT t.rowid FROM wiki_search t WHERE t.workspace_id=? AND (?='' OR t.project_id=?) ORDER BY t.rowid LIMIT 50)",
  maintenanceCountRevisions:
    "SELECT COUNT(*) AS n FROM wiki_revisions t WHERE t.workspace_id=? AND (?='' OR (SELECT project_id FROM wiki_pages WHERE workspace_id=t.workspace_id AND id=t.page_id)=?)",
  maintenanceDeleteRevisions:
    "DELETE FROM wiki_revisions WHERE rowid IN (SELECT t.rowid FROM wiki_revisions t WHERE t.workspace_id=? AND (?='' OR (SELECT project_id FROM wiki_pages WHERE workspace_id=t.workspace_id AND id=t.page_id)=?) ORDER BY t.rowid LIMIT 50)",
  maintenanceCountReceipts:
    "SELECT COUNT(*) AS n FROM wiki_receipts t WHERE t.workspace_id=? AND (?='' OR t.project_id=?)",
  maintenanceDeleteReceipts:
    "DELETE FROM wiki_receipts WHERE rowid IN (SELECT t.rowid FROM wiki_receipts t WHERE t.workspace_id=? AND (?='' OR t.project_id=?) ORDER BY t.rowid LIMIT 50)",
  maintenanceCountEvents:
    "SELECT COUNT(*) AS n FROM wiki_events t WHERE t.workspace_id=? AND (?='' OR t.project_id=?)",
  maintenanceDeleteEvents:
    "DELETE FROM wiki_events WHERE rowid IN (SELECT t.rowid FROM wiki_events t WHERE t.workspace_id=? AND (?='' OR t.project_id=?) ORDER BY t.rowid LIMIT 50)",
  maintenanceCountGuards: "SELECT COUNT(*) AS n FROM wiki_guards t WHERE t.workspace_id=? AND ?=''",
  maintenanceDeleteGuards:
    "DELETE FROM wiki_guards WHERE rowid IN (SELECT t.rowid FROM wiki_guards t WHERE t.workspace_id=? AND ?='' ORDER BY t.rowid LIMIT 50)",
  maintenanceCountPages:
    "SELECT COUNT(*) AS n FROM wiki_pages t WHERE t.workspace_id=? AND (?='' OR t.project_id=?)",
  maintenanceDeletePages:
    "DELETE FROM wiki_pages WHERE rowid IN (SELECT t.rowid FROM wiki_pages t WHERE t.workspace_id=? AND (?='' OR t.project_id=?) AND NOT EXISTS (SELECT 1 FROM wiki_revisions c WHERE c.workspace_id=t.workspace_id AND c.page_id=t.id) AND NOT EXISTS (SELECT 1 FROM wiki_receipts c WHERE c.workspace_id=t.workspace_id AND c.result_id=t.id) AND NOT EXISTS (SELECT 1 FROM wiki_events c WHERE c.workspace_id=t.workspace_id AND c.aggregate_id=t.id) ORDER BY t.rowid LIMIT 50)",
} as const;
