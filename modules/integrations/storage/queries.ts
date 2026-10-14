export const queries = {
  receipt:
    "SELECT fingerprint,result_id FROM integrations_receipts WHERE workspace_id=? AND principal_id=? AND operation_id=?",
  putReceipt:
    "INSERT INTO integrations_receipts(workspace_id,principal_id,operation_id,fingerprint,result_id) VALUES(?,?,?,?,?)",
  link: "SELECT id,target_kind,target_id,kind,url,version,active FROM integrations_links WHERE workspace_id=? AND id=?",
  links:
    "SELECT id,target_kind,target_id,kind,url,version FROM integrations_links WHERE workspace_id=? AND target_kind=? AND target_id=? AND active=1 AND id>? ORDER BY id LIMIT ?",
  addLink:
    "INSERT INTO integrations_links(workspace_id,id,target_kind,target_id,kind,url,version,active) VALUES(?,?,?,?,?,?,1,1)",
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
    "INSERT INTO integrations_deliveries(workspace_id,id,source_id,external_id,event_type,body,status,attempts,next_attempt_at) VALUES(?,?,?,?,?,?,'pending',0,?) ON CONFLICT(workspace_id,source_id,external_id) DO NOTHING",
  deliveryByExternal:
    "SELECT id,source_id,event_type,body,status,attempts,next_attempt_at FROM integrations_deliveries WHERE workspace_id=? AND source_id=? AND external_id=?",
  putDeliveryReceipt:
    "INSERT INTO integrations_receipts(workspace_id,principal_id,operation_id,fingerprint,result_id) SELECT ?,?,?,?,id FROM integrations_deliveries WHERE workspace_id=? AND source_id=? AND external_id=?",
  due: "SELECT d.workspace_id,d.id,d.source_id,d.event_type,d.body,d.attempts,s.webhook_url,s.webhook_cipher FROM integrations_deliveries d JOIN integrations_sources s ON s.workspace_id=d.workspace_id AND s.id=d.source_id WHERE d.status='pending' AND d.next_attempt_at<=? ORDER BY d.next_attempt_at LIMIT ?",
  updateDelivery:
    "UPDATE integrations_deliveries SET status=?,attempts=?,next_attempt_at=? WHERE workspace_id=? AND id=? AND status='pending' AND attempts=?",
  guard: "INSERT INTO integrations_guards(workspace_id,id,changed) VALUES(?,?,changes())",
  clearGuard: "DELETE FROM integrations_guards WHERE workspace_id=? AND id=?",
  history:
    "INSERT INTO integrations_history(workspace_id,id,action,actor_id,occurred_at) VALUES(?,?,?,?,?)",
  event:
    "INSERT INTO integrations_events(workspace_id,id,aggregate_id,type,occurred_at) VALUES(?,?,?,?,?)",
} as const;
