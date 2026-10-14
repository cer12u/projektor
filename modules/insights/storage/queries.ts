export const queries = {
  cursor: "SELECT sequence,consumed_at FROM insights_cursors WHERE workspace_id=? AND source=?",
  cursors:
    "SELECT source,sequence,consumed_at FROM insights_cursors WHERE workspace_id=? ORDER BY source",
  seedCursor:
    "INSERT OR IGNORE INTO insights_cursors(workspace_id,source,sequence,consumed_at) VALUES(?,?,0,?)",
  advanceCursor:
    "UPDATE insights_cursors SET sequence=?,consumed_at=? WHERE workspace_id=? AND source=? AND sequence=?",
  activity:
    "INSERT OR IGNORE INTO insights_activity(workspace_id,source,sequence,event_id,entity_id,aggregate_version,type,actor_id,client_id,occurred_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
  feed: "SELECT source,sequence,entity_id,aggregate_version,type,actor_id,client_id,occurred_at FROM insights_activity WHERE workspace_id=? AND (occurred_at<? OR (occurred_at=? AND (source>? OR (source=? AND sequence<?)))) ORDER BY occurred_at DESC,source,sequence DESC LIMIT ?",
  subscription:
    "SELECT version,active FROM insights_subscriptions WHERE workspace_id=? AND principal_id=? AND issue_id=?",
  subscriptionsForIssue:
    "SELECT principal_id FROM insights_subscriptions WHERE workspace_id=? AND issue_id=? AND active=1",
  createSubscription:
    "INSERT INTO insights_subscriptions(workspace_id,principal_id,issue_id,version,active) VALUES(?,?,?,1,1)",
  updateSubscription:
    "UPDATE insights_subscriptions SET version=version+1,active=? WHERE workspace_id=? AND principal_id=? AND issue_id=? AND version=? AND active=?",
  insertNotification:
    "INSERT OR IGNORE INTO insights_notifications(workspace_id,principal_id,id,issue_id,kind,occurred_at,version,read) VALUES(?,?,?,?,?,?,1,0)",
  notifications:
    "SELECT id,issue_id,kind,occurred_at,version,read FROM insights_notifications WHERE workspace_id=? AND principal_id=? AND (occurred_at<? OR (occurred_at=? AND id<?)) ORDER BY occurred_at DESC,id DESC LIMIT ?",
  unread:
    "SELECT COUNT(*) AS n FROM insights_notifications WHERE workspace_id=? AND principal_id=? AND read=0",
  notification:
    "SELECT issue_id,version,read FROM insights_notifications WHERE workspace_id=? AND principal_id=? AND id=?",
  markRead:
    "UPDATE insights_notifications SET read=1,version=version+1 WHERE workspace_id=? AND principal_id=? AND id=? AND version=? AND read=0",
  receipt:
    "INSERT INTO insights_receipts(workspace_id,principal_id,operation_id,fingerprint,result_id,result_version,active) VALUES(?,?,?,?,?,?,?)",
  readReceipt:
    "SELECT fingerprint,result_id,result_version,active FROM insights_receipts WHERE workspace_id=? AND principal_id=? AND operation_id=?",
  guard: "INSERT INTO insights_guards(workspace_id,id,changed) VALUES(?,?,changes())",
  clearGuard: "DELETE FROM insights_guards WHERE workspace_id=? AND id=?",
  saveMetrics:
    "INSERT INTO insights_metrics(workspace_id,project_id,calculated_at,todo,in_progress,done,active_leases,active_sessions) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(workspace_id,project_id) DO UPDATE SET calculated_at=excluded.calculated_at,todo=excluded.todo,in_progress=excluded.in_progress,done=excluded.done,active_leases=excluded.active_leases,active_sessions=excluded.active_sessions",
} as const;
