export const queries = {
  receipt:
    "SELECT fingerprint,result_id FROM integrations_receipts WHERE workspace_id=? AND principal_id=? AND operation_id=?",
  putReceipt:
    "INSERT INTO integrations_receipts(workspace_id,principal_id,operation_id,fingerprint,result_id,project_id) VALUES(?,?,?,?,?,?)",
  link: "SELECT id,target_kind,target_id,kind,url,version,active,project_id FROM integrations_links WHERE workspace_id=? AND id=?",
  links:
    "SELECT id,target_kind,target_id,kind,url,version FROM integrations_links WHERE workspace_id=? AND target_kind=? AND target_id=? AND active=1 AND id>? ORDER BY id LIMIT ?",
  addLink:
    "INSERT INTO integrations_links(workspace_id,id,target_kind,target_id,kind,url,project_id,version,active) VALUES(?,?,?,?,?,?,?,1,1)",
  removeLink:
    "UPDATE integrations_links SET active=0,version=version+1 WHERE workspace_id=? AND id=? AND version=? AND active=1",
  source:
    "SELECT id,project_id,name,secret_hash,webhook_url,webhook_events,webhook_cipher FROM integrations_sources WHERE workspace_id=? AND id=?",

  sources:
    "SELECT id,project_id,name,webhook_url,webhook_events FROM integrations_sources WHERE workspace_id=? AND id>? ORDER BY id LIMIT ?",
  addSource:
    "INSERT INTO integrations_sources(workspace_id,id,project_id,name,secret_hash,webhook_events) VALUES(?,?,?,?,?, '[]')",
  webhook:
    "UPDATE integrations_sources SET webhook_url=?,webhook_events=?,webhook_cipher=? WHERE workspace_id=? AND id=? AND webhook_url IS NULL",
  feedback:
    "SELECT id,source_id,project_id,title,body,issue_id,version,received_at FROM integrations_feedback WHERE workspace_id=? AND id=?",
  feedbackByDelivery:
    "SELECT id FROM integrations_feedback WHERE workspace_id=? AND source_id=? AND delivery_id=?",
  feedbackPage:
    "SELECT id,source_id,project_id,title,body,issue_id,version,received_at FROM integrations_feedback WHERE workspace_id=? AND id>? ORDER BY id LIMIT ?",
  addFeedback:
    "INSERT INTO integrations_feedback(workspace_id,id,source_id,delivery_id,project_id,title,body,version,received_at) VALUES(?,?,?,?,?,?,?,1,?)",
  convert:
    "UPDATE integrations_feedback SET issue_id=?,version=version+1 WHERE workspace_id=? AND id=? AND version=? AND issue_id IS NULL",
  delivery:
    "SELECT id,source_id,event_type,status,attempts,next_attempt_at FROM integrations_deliveries WHERE workspace_id=? AND id=?",
  deliveries:
    "SELECT id,source_id,event_type,status,attempts,next_attempt_at FROM integrations_deliveries WHERE workspace_id=? AND id>? ORDER BY id LIMIT ?",
  addDelivery:
    "INSERT INTO integrations_deliveries(workspace_id,id,source_id,external_id,event_type,body,project_id,status,attempts,next_attempt_at) VALUES(?,?,?,?,?,?,?,'pending',0,?) ON CONFLICT(workspace_id,source_id,external_id) DO NOTHING",
  deliveryByExternal:
    "SELECT id,source_id,event_type,body,status,attempts,next_attempt_at FROM integrations_deliveries WHERE workspace_id=? AND source_id=? AND external_id=?",
  putDeliveryReceipt:
    "INSERT INTO integrations_receipts(workspace_id,principal_id,operation_id,fingerprint,result_id,project_id) SELECT ?,?,?,?,id,project_id FROM integrations_deliveries WHERE workspace_id=? AND source_id=? AND external_id=?",
  due: "SELECT d.workspace_id,d.id,d.source_id,d.project_id,d.event_type,d.body,d.attempts,s.webhook_url,s.webhook_cipher FROM integrations_deliveries d JOIN integrations_sources s ON s.workspace_id=d.workspace_id AND s.id=d.source_id WHERE d.status='pending' AND d.next_attempt_at<=? AND NOT EXISTS(SELECT 1 FROM integrations_maintenance m WHERE m.workspace_id=d.workspace_id AND (m.project_id='' OR m.project_id=d.project_id)) ORDER BY d.next_attempt_at LIMIT ?",
  updateDelivery:
    "UPDATE integrations_deliveries SET status=?,attempts=?,next_attempt_at=? WHERE workspace_id=? AND id=? AND status='pending' AND attempts=?",
  guard: "INSERT INTO integrations_guards(workspace_id,id,changed) VALUES(?,?,changes())",
  clearGuard: "DELETE FROM integrations_guards WHERE workspace_id=? AND id=?",
  history:
    "INSERT INTO integrations_history(workspace_id,id,action,actor_id,occurred_at,project_id) VALUES(?,?,?,?,?,?)",
  event:
    "INSERT INTO integrations_events(workspace_id,id,aggregate_id,type,occurred_at,project_id) VALUES(?,?,?,?,?,?)",
  maintenanceMarker:
    "SELECT state FROM integrations_maintenance WHERE workspace_id=? AND project_id=?",
  maintenanceFreeze:
    "INSERT OR IGNORE INTO integrations_maintenance(workspace_id,project_id,state) VALUES(?,?,'frozen')",
  maintenancePurging:
    "UPDATE integrations_maintenance SET state='purging' WHERE workspace_id=? AND project_id=? AND state='frozen'",
  maintenanceCount:
    "WITH scope(workspace_id,project_id) AS (VALUES(?,?)) SELECT (SELECT COUNT(*) FROM integrations_links,scope WHERE integrations_links.workspace_id=scope.workspace_id AND (scope.project_id='' OR integrations_links.project_id=scope.project_id))+(SELECT COUNT(*) FROM integrations_sources,scope WHERE integrations_sources.workspace_id=scope.workspace_id AND (scope.project_id='' OR integrations_sources.project_id=scope.project_id))+(SELECT COUNT(*) FROM integrations_feedback,scope WHERE integrations_feedback.workspace_id=scope.workspace_id AND (scope.project_id='' OR integrations_feedback.project_id=scope.project_id))+(SELECT COUNT(*) FROM integrations_deliveries,scope WHERE integrations_deliveries.workspace_id=scope.workspace_id AND (scope.project_id='' OR integrations_deliveries.project_id=scope.project_id))+(SELECT COUNT(*) FROM integrations_receipts,scope WHERE integrations_receipts.workspace_id=scope.workspace_id AND (scope.project_id='' OR integrations_receipts.project_id=scope.project_id))+(SELECT COUNT(*) FROM integrations_history,scope WHERE integrations_history.workspace_id=scope.workspace_id AND (scope.project_id='' OR integrations_history.project_id=scope.project_id))+(SELECT COUNT(*) FROM integrations_events,scope WHERE integrations_events.workspace_id=scope.workspace_id AND (scope.project_id='' OR integrations_events.project_id=scope.project_id))+(SELECT COUNT(*) FROM integrations_guards,scope WHERE integrations_guards.workspace_id=scope.workspace_id AND scope.project_id='') AS n",
  maintenanceUnknown:
    "SELECT (SELECT COUNT(*) FROM integrations_links WHERE workspace_id=? AND project_id IS NULL)+(SELECT COUNT(*) FROM integrations_deliveries WHERE workspace_id=? AND project_id IS NULL)+(SELECT COUNT(*) FROM integrations_receipts WHERE workspace_id=? AND project_id IS NULL)+(SELECT COUNT(*) FROM integrations_history WHERE workspace_id=? AND project_id IS NULL)+(SELECT COUNT(*) FROM integrations_events WHERE workspace_id=? AND project_id IS NULL) AS n",
  purgeLinks:
    "DELETE FROM integrations_links WHERE rowid IN (SELECT rowid FROM integrations_links WHERE workspace_id=? AND (?='' OR project_id=?) ORDER BY rowid LIMIT 50)",
  purgeFeedback:
    "DELETE FROM integrations_feedback WHERE rowid IN (SELECT rowid FROM integrations_feedback WHERE workspace_id=? AND (?='' OR project_id=?) ORDER BY rowid LIMIT 50)",
  purgeDeliveries:
    "DELETE FROM integrations_deliveries WHERE rowid IN (SELECT rowid FROM integrations_deliveries WHERE workspace_id=? AND (?='' OR project_id=?) ORDER BY rowid LIMIT 50)",
  purgeReceipts:
    "DELETE FROM integrations_receipts WHERE rowid IN (SELECT rowid FROM integrations_receipts WHERE workspace_id=? AND (?='' OR project_id=?) ORDER BY rowid LIMIT 50)",
  purgeHistory:
    "DELETE FROM integrations_history WHERE rowid IN (SELECT rowid FROM integrations_history WHERE workspace_id=? AND (?='' OR project_id=?) ORDER BY rowid LIMIT 50)",
  purgeEvents:
    "DELETE FROM integrations_events WHERE rowid IN (SELECT rowid FROM integrations_events WHERE workspace_id=? AND (?='' OR project_id=?) ORDER BY rowid LIMIT 50)",
  purgeSources:
    "DELETE FROM integrations_sources WHERE rowid IN (SELECT rowid FROM integrations_sources WHERE workspace_id=? AND (?='' OR project_id=?) AND NOT EXISTS(SELECT 1 FROM integrations_feedback WHERE integrations_feedback.workspace_id=integrations_sources.workspace_id AND integrations_feedback.source_id=integrations_sources.id) AND NOT EXISTS(SELECT 1 FROM integrations_deliveries WHERE integrations_deliveries.workspace_id=integrations_sources.workspace_id AND integrations_deliveries.source_id=integrations_sources.id) ORDER BY rowid LIMIT 50)",
  purgeGuards:
    "DELETE FROM integrations_guards WHERE rowid IN (SELECT rowid FROM integrations_guards WHERE workspace_id=? AND ?='' ORDER BY rowid LIMIT 50)",
} as const;
