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
    "INSERT INTO issues_receipts(workspace_id,principal_id,operation_id,fingerprint,result_id,result_number,result_version) SELECT ?,?,?,?,id,number,version FROM issues_issues WHERE workspace_id=? AND id=?",
  readReceipt:
    "SELECT fingerprint,result_id,result_number,result_version FROM issues_receipts WHERE workspace_id=? AND principal_id=? AND operation_id=?",
  event:
    "INSERT INTO issues_events(workspace_id,sequence,event_id,aggregate_id,aggregate_version,type,occurred_at,actor_id,actor_kind,client_id) VALUES(?,(SELECT COALESCE(MAX(sequence),0)+1 FROM issues_events WHERE workspace_id=?),?,?,?,?,?,?,?,?)",
  events:
    "SELECT sequence,event_id,aggregate_id,aggregate_version,type,occurred_at,actor_id,actor_kind,client_id FROM issues_events WHERE workspace_id=? AND sequence>? ORDER BY sequence LIMIT ?",
} as const;
