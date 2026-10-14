export const queries = {
  sprint:
    "SELECT id,project_id,name,version,closed FROM planning_sprints WHERE workspace_id=? AND id=?",
  list: "SELECT id,project_id,name,version,closed FROM planning_sprints WHERE workspace_id=? AND project_id=? ORDER BY id",
  items:
    "SELECT issue_id FROM planning_items WHERE workspace_id=? AND sprint_id=? AND present=1 ORDER BY issue_id",
  create:
    "INSERT INTO planning_sprints(workspace_id,id,project_id,name,version,closed) VALUES(?,?,?,?,1,0)",
  bump: "UPDATE planning_sprints SET version=version+1 WHERE workspace_id=? AND id=? AND version=? AND closed=0",
  close:
    "UPDATE planning_sprints SET version=version+1,closed=1 WHERE workspace_id=? AND id=? AND version=? AND closed=0",
  addItem:
    "INSERT INTO planning_items(workspace_id,sprint_id,issue_id,active,present) VALUES(?,?,?,1,1) ON CONFLICT(workspace_id,sprint_id,issue_id) DO UPDATE SET active=1,present=1 WHERE active=0",
  removeItem:
    "UPDATE planning_items SET active=0,present=0 WHERE workspace_id=? AND sprint_id=? AND issue_id=? AND active=1",
  closeItems:
    "UPDATE planning_items SET active=0 WHERE workspace_id=? AND sprint_id=? AND active=1",
  guard: "INSERT INTO planning_guards(workspace_id,id,changed) VALUES(?,?,changes())",
  clearGuard: "DELETE FROM planning_guards WHERE workspace_id=? AND id=?",
  history:
    "INSERT INTO planning_history(workspace_id,sprint_id,version,action,issue_id,actor_id,occurred_at) SELECT workspace_id,id,version,?,?,?,? FROM planning_sprints WHERE workspace_id=? AND id=?",
  receipt:
    "INSERT INTO planning_receipts(workspace_id,principal_id,operation_id,fingerprint,result_id,result_version) SELECT ?,?,?,?,id,version FROM planning_sprints WHERE workspace_id=? AND id=?",
  readReceipt:
    "SELECT fingerprint,result_id,result_version FROM planning_receipts WHERE workspace_id=? AND principal_id=? AND operation_id=?",
  event:
    "INSERT INTO planning_events(workspace_id,sequence,event_id,aggregate_id,aggregate_version,type,issue_id,actor_id,occurred_at) VALUES(?,(SELECT COALESCE(MAX(sequence),0)+1 FROM planning_events WHERE workspace_id=?),?,?,?,?,?,?,?)",
  events:
    "SELECT sequence,event_id,aggregate_id,aggregate_version,type,issue_id,actor_id,occurred_at FROM planning_events WHERE workspace_id=? AND sequence>? ORDER BY sequence LIMIT ?",
} as const;
