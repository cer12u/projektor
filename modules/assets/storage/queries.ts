export const queries = {
  blob: "SELECT id,project_id,size,content_type,filename,sha256,version,state FROM assets_blobs WHERE workspace_id=? AND id=?",
  begin:
    "INSERT INTO assets_blobs(workspace_id,id,project_id,size,content_type,filename,sha256,version,state,created_at) VALUES(?,?,?,?,?,?,?,1,'pending',?)",
  complete:
    "UPDATE assets_blobs SET state='ready',version=version+1 WHERE workspace_id=? AND id=? AND version=? AND state='pending'",
  bump: "UPDATE assets_blobs SET version=version+1 WHERE workspace_id=? AND id=? AND version=? AND state='ready'",
  retire:
    "UPDATE assets_blobs SET state='retired' WHERE workspace_id=? AND id=? AND state IN ('pending','ready') AND NOT EXISTS(SELECT 1 FROM assets_links WHERE workspace_id=? AND asset_id=?)",
  insertLink:
    "INSERT INTO assets_links(workspace_id,id,asset_id,target_kind,target_id) VALUES(?,?,?,?,?)",
  link: "SELECT id,asset_id,target_kind,target_id FROM assets_links WHERE workspace_id=? AND id=? AND asset_id=?",
  deleteLink: "DELETE FROM assets_links WHERE workspace_id=? AND id=? AND asset_id=?",
  list: "SELECT l.id,l.asset_id,l.target_kind,l.target_id,b.filename FROM assets_links l JOIN assets_blobs b ON b.workspace_id=l.workspace_id AND b.id=l.asset_id WHERE l.workspace_id=? AND l.target_kind=? AND l.target_id=? AND l.id>? ORDER BY l.id LIMIT ?",
  linksForBlob:
    "SELECT id,target_kind,target_id FROM assets_links WHERE workspace_id=? AND asset_id=? AND id>? ORDER BY id LIMIT ?",
  gcAdd:
    "INSERT INTO assets_gc_jobs(workspace_id,asset_id,due_at) VALUES(?,?,?) ON CONFLICT(workspace_id,asset_id) DO UPDATE SET due_at=excluded.due_at",
  gcRemove: "DELETE FROM assets_gc_jobs WHERE workspace_id=? AND asset_id=?",
  gcDue: "SELECT workspace_id,asset_id FROM assets_gc_jobs WHERE due_at<=? ORDER BY due_at LIMIT ?",
  gcJob: "SELECT due_at FROM assets_gc_jobs WHERE workspace_id=? AND asset_id=?",
  gcDeleteHistory: "DELETE FROM assets_history WHERE workspace_id=? AND asset_id=?",
  gcDeleteBlob:
    "DELETE FROM assets_blobs WHERE workspace_id=? AND id=? AND state IN ('pending','retired') AND NOT EXISTS(SELECT 1 FROM assets_links WHERE workspace_id=? AND asset_id=?)",
  guard: "INSERT INTO assets_guards(workspace_id,id,changed) VALUES(?,?,changes())",
  clearGuard: "DELETE FROM assets_guards WHERE workspace_id=? AND id=?",
  history:
    "INSERT INTO assets_history(workspace_id,asset_id,version,action,actor_id,occurred_at) SELECT workspace_id,id,version,?,?,? FROM assets_blobs WHERE workspace_id=? AND id=?",
  receipt:
    "INSERT INTO assets_receipts(workspace_id,principal_id,operation_id,fingerprint,result_id,result_version) SELECT ?,?,?,?,id,version FROM assets_blobs WHERE workspace_id=? AND id=?",
  readReceipt:
    "SELECT fingerprint,result_id,result_version FROM assets_receipts WHERE workspace_id=? AND principal_id=? AND operation_id=?",
  event:
    "INSERT INTO assets_events(workspace_id,sequence,event_id,aggregate_id,aggregate_version,type,occurred_at,actor_id) VALUES(?,(SELECT COALESCE(MAX(sequence),0)+1 FROM assets_events WHERE workspace_id=?),?,?,?,?,?,?)",
  events:
    "SELECT sequence,event_id,aggregate_id,aggregate_version,type,occurred_at,actor_id FROM assets_events WHERE workspace_id=? AND sequence>? ORDER BY sequence LIMIT ?",
} as const;
