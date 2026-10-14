export const queries = {
  issue:
    "SELECT id,project_id,number,title,description,priority,state,assignee_id,version,archived FROM issues_issues WHERE workspace_id=? AND id=?",
  byNumber:
    "SELECT id,project_id,number,title,description,priority,state,assignee_id,version,archived FROM issues_issues WHERE workspace_id=? AND project_id=? AND number=?",
  list: "SELECT id,project_id,number,title,description,priority,state,assignee_id,version,archived FROM issues_issues WHERE workspace_id=? AND project_id=? AND archived=0 AND number<? AND (? IS NULL OR state=?) AND (? IS NULL OR priority=?) AND (?=0 OR (?=1 AND assignee_id IS NULL) OR (?=2 AND assignee_id=?)) ORDER BY number DESC LIMIT ?",
  search:
    "SELECT i.id,i.project_id,i.number,i.title,i.description,i.priority,i.state,i.assignee_id,i.version,i.archived FROM issues_search s JOIN issues_issues i ON i.rowid=s.rowid WHERE issues_search MATCH ? AND s.workspace_id=? AND s.project_id=? AND s.archived='0' AND i.workspace_id=? AND i.project_id=? AND i.archived=0 ORDER BY bm25(issues_search),i.number DESC LIMIT ?",
  searchShort:
    "WITH terms(pattern) AS (VALUES (?),(?),(?),(?),(?),(?),(?),(?),(?),(?),(?),(?)) SELECT i.id,i.project_id,i.number,i.title,i.description,i.priority,i.state,i.assignee_id,i.version,i.archived FROM issues_issues i WHERE i.workspace_id=? AND i.project_id=? AND i.archived=0 AND NOT EXISTS (SELECT 1 FROM terms WHERE pattern IS NOT NULL AND NOT (i.title LIKE pattern ESCAPE '\\' OR i.description LIKE pattern ESCAPE '\\')) ORDER BY i.number DESC LIMIT ?",
  allocate:
    "INSERT INTO issues_counters(workspace_id,project_id,next_number) VALUES(?,?,1) ON CONFLICT(workspace_id,project_id) DO UPDATE SET next_number=next_number+1",
  create:
    "INSERT INTO issues_issues(workspace_id,id,project_id,number,title,description,priority,state,version) SELECT ?,?,?,next_number,?,?,?,'todo',1 FROM issues_counters WHERE workspace_id=? AND project_id=?",
  edit: "UPDATE issues_issues SET title=?,description=?,priority=?,version=version+1 WHERE workspace_id=? AND id=? AND version=? AND archived=0",
  transition:
    "UPDATE issues_issues SET state=?,version=version+1 WHERE workspace_id=? AND id=? AND version=? AND archived=0",
  assign:
    "UPDATE issues_issues SET assignee_id=?,version=version+1 WHERE workspace_id=? AND id=? AND version=? AND archived=0",
  bump: "UPDATE issues_issues SET version=version+1 WHERE workspace_id=? AND id=? AND version=? AND archived=0",
  archive:
    "UPDATE issues_issues SET archived=1,version=version+1 WHERE workspace_id=? AND id=? AND version=? AND archived=0",
  comment:
    "INSERT INTO issues_comments(workspace_id,id,issue_id,body,actor_id,actor_kind,created_at,client_id) VALUES(?,?,?,?,?,?,?,?)",
  guard: "INSERT INTO issues_guards(workspace_id,id,changed) VALUES(?,?,changes())",
  clearGuard: "DELETE FROM issues_guards WHERE workspace_id=? AND id=?",
  deleteSearch:
    "DELETE FROM issues_search WHERE rowid=(SELECT rowid FROM issues_issues WHERE workspace_id=? AND id=?)",
  upsertSearch:
    "INSERT INTO issues_search(rowid,workspace_id,project_id,issue_id,title,description,archived) SELECT rowid,workspace_id,project_id,id,title,description,CAST(archived AS TEXT) FROM issues_issues WHERE workspace_id=? AND id=?",
  history:
    "INSERT INTO issues_history(workspace_id,issue_id,version,action,actor_id,actor_kind,occurred_at,detail,client_id) VALUES(?,?,?,?,?,?,?,?,?)",
  getHistory:
    "SELECT version,action,actor_id,actor_kind,occurred_at,detail,client_id FROM issues_history WHERE workspace_id=? AND issue_id=? ORDER BY version",
  receipt:
    "INSERT INTO issues_receipts(workspace_id,principal_id,operation_id,fingerprint,result_id,result_number,result_version,project_id) SELECT ?,?,?,?,id,number,version,project_id FROM issues_issues WHERE workspace_id=? AND id=?",
  readReceipt:
    "SELECT fingerprint,result_id,result_number,result_version FROM issues_receipts WHERE workspace_id=? AND principal_id=? AND operation_id=?",
  event:
    "INSERT INTO issues_events(workspace_id,sequence,event_id,aggregate_id,aggregate_version,type,occurred_at,actor_id,actor_kind,client_id,project_id) VALUES(?,(SELECT COALESCE(MAX(sequence),0)+1 FROM issues_events WHERE workspace_id=?),?,?,?,?,?,?,?,?,(SELECT project_id FROM issues_issues WHERE workspace_id=? AND id=?))",
  events:
    "SELECT sequence,event_id,aggregate_id,aggregate_version,type,occurred_at,actor_id,actor_kind,client_id,project_id FROM issues_events WHERE workspace_id=? AND sequence>? ORDER BY sequence LIMIT ?",
  maintenanceFreeze:
    "INSERT INTO issues_frozen_scopes(workspace_id,project_id,state) VALUES(?,?,'frozen') ON CONFLICT(workspace_id,project_id) DO NOTHING",
  maintenanceMarker: "SELECT state FROM issues_frozen_scopes WHERE workspace_id=? AND project_id=?",
  maintenanceBegin:
    "UPDATE issues_frozen_scopes SET state='purging' WHERE workspace_id=? AND project_id=? AND state='frozen'",
  maintenanceDone:
    "UPDATE issues_frozen_scopes SET state='purged' WHERE workspace_id=? AND project_id=? AND state='purging'",
  maintenanceBypass: "INSERT INTO issues_purge_bypass(workspace_id,project_id) VALUES(?,?)",
  maintenanceUnbypass: "DELETE FROM issues_purge_bypass WHERE workspace_id=? AND project_id=?",
  maintenanceCountSearch:
    "SELECT COUNT(*) AS n FROM issues_search t WHERE t.workspace_id=? AND (?='' OR t.project_id=?)",
  maintenanceDeleteSearch:
    "DELETE FROM issues_search WHERE rowid IN (SELECT t.rowid FROM issues_search t WHERE t.workspace_id=? AND (?='' OR t.project_id=?) ORDER BY t.rowid LIMIT 50)",
  maintenanceCountComments:
    "SELECT COUNT(*) AS n FROM issues_comments t WHERE t.workspace_id=? AND (?='' OR (SELECT project_id FROM issues_issues WHERE workspace_id=t.workspace_id AND id=t.issue_id)=?)",
  maintenanceDeleteComments:
    "DELETE FROM issues_comments WHERE rowid IN (SELECT t.rowid FROM issues_comments t WHERE t.workspace_id=? AND (?='' OR (SELECT project_id FROM issues_issues WHERE workspace_id=t.workspace_id AND id=t.issue_id)=?) ORDER BY t.rowid LIMIT 50)",
  maintenanceCountHistory:
    "SELECT COUNT(*) AS n FROM issues_history t WHERE t.workspace_id=? AND (?='' OR (SELECT project_id FROM issues_issues WHERE workspace_id=t.workspace_id AND id=t.issue_id)=?)",
  maintenanceDeleteHistory:
    "DELETE FROM issues_history WHERE rowid IN (SELECT t.rowid FROM issues_history t WHERE t.workspace_id=? AND (?='' OR (SELECT project_id FROM issues_issues WHERE workspace_id=t.workspace_id AND id=t.issue_id)=?) ORDER BY t.rowid LIMIT 50)",
  maintenanceCountReceipts:
    "SELECT COUNT(*) AS n FROM issues_receipts t WHERE t.workspace_id=? AND (?='' OR t.project_id=?)",
  maintenanceDeleteReceipts:
    "DELETE FROM issues_receipts WHERE rowid IN (SELECT t.rowid FROM issues_receipts t WHERE t.workspace_id=? AND (?='' OR t.project_id=?) ORDER BY t.rowid LIMIT 50)",
  maintenanceCountEvents:
    "SELECT COUNT(*) AS n FROM issues_events t WHERE t.workspace_id=? AND (?='' OR t.project_id=?)",
  maintenanceDeleteEvents:
    "DELETE FROM issues_events WHERE rowid IN (SELECT t.rowid FROM issues_events t WHERE t.workspace_id=? AND (?='' OR t.project_id=?) ORDER BY t.rowid LIMIT 50)",
  maintenanceCountGuards:
    "SELECT COUNT(*) AS n FROM issues_guards t WHERE t.workspace_id=? AND ?=''",
  maintenanceDeleteGuards:
    "DELETE FROM issues_guards WHERE rowid IN (SELECT t.rowid FROM issues_guards t WHERE t.workspace_id=? AND ?='' ORDER BY t.rowid LIMIT 50)",
  maintenanceCountIssues:
    "SELECT COUNT(*) AS n FROM issues_issues t WHERE t.workspace_id=? AND (?='' OR t.project_id=?)",
  maintenanceDeleteIssues:
    "DELETE FROM issues_issues WHERE rowid IN (SELECT t.rowid FROM issues_issues t WHERE t.workspace_id=? AND (?='' OR t.project_id=?) AND NOT EXISTS (SELECT 1 FROM issues_comments c WHERE c.workspace_id=t.workspace_id AND c.issue_id=t.id) AND NOT EXISTS (SELECT 1 FROM issues_history c WHERE c.workspace_id=t.workspace_id AND c.issue_id=t.id) AND NOT EXISTS (SELECT 1 FROM issues_receipts c WHERE c.workspace_id=t.workspace_id AND c.result_id=t.id) AND NOT EXISTS (SELECT 1 FROM issues_events c WHERE c.workspace_id=t.workspace_id AND c.aggregate_id=t.id) ORDER BY t.rowid LIMIT 50)",
  maintenanceCountCounters:
    "SELECT COUNT(*) AS n FROM issues_counters t WHERE t.workspace_id=? AND (?='' OR t.project_id=?)",
  maintenanceDeleteCounters:
    "DELETE FROM issues_counters WHERE rowid IN (SELECT t.rowid FROM issues_counters t WHERE t.workspace_id=? AND (?='' OR t.project_id=?) ORDER BY t.rowid LIMIT 50)",
} as const;
