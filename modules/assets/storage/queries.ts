export const queries = {
  maintenanceUnattributed:
    "SELECT (SELECT COUNT(*) FROM assets_receipts WHERE workspace_id=? AND project_id IS NULL)+(SELECT COUNT(*) FROM assets_events WHERE workspace_id=? AND project_id IS NULL) AS n",
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
    "INSERT INTO assets_events(workspace_id,sequence,event_id,aggregate_id,aggregate_version,type,occurred_at,actor_id,client_id,schema_version) VALUES(?,(SELECT COALESCE(MAX(sequence),0)+1 FROM assets_events WHERE workspace_id=?),?,?,?,?,?,?,?,2)",
  events:
    "SELECT sequence,event_id,aggregate_id,aggregate_version,type,occurred_at,actor_id,client_id,schema_version,project_id FROM assets_events WHERE workspace_id=? AND sequence>? ORDER BY sequence LIMIT ?",
  maintenanceFreeze:
    "INSERT INTO assets_frozen(workspace_id,project_id,state) VALUES(?,?,'frozen') ON CONFLICT(workspace_id,project_id) DO NOTHING",
  maintenanceMarker:
    "SELECT state,sweeping_until FROM assets_frozen WHERE workspace_id=? AND project_id=?",
  maintenanceBegin:
    "UPDATE assets_frozen SET state='purging' WHERE workspace_id=? AND project_id=? AND state='frozen'",
  maintenanceDone:
    "UPDATE assets_frozen SET state='purged',sweeping_until=? WHERE workspace_id=? AND project_id=?",
  tombstoneAdd:
    "INSERT INTO assets_r2_tombstones(workspace_id,object_key,sweep_until) VALUES(?,?,?) ON CONFLICT(workspace_id,object_key) DO UPDATE SET sweep_until=MAX(sweep_until,excluded.sweep_until)",
  tombstoneDue:
    "SELECT workspace_id,object_key,sweep_until FROM assets_r2_tombstones ORDER BY workspace_id,object_key LIMIT ?",
  tombstoneRemove: "DELETE FROM assets_r2_tombstones WHERE workspace_id=? AND object_key=?",
  workspaceSweeps:
    "SELECT workspace_id,sweeping_until FROM assets_frozen WHERE project_id='' AND state='purged' AND sweeping_until>? ORDER BY workspace_id LIMIT ?",
  maintenanceBypass: "INSERT INTO assets_maintenance_bypass(workspace_id) VALUES(?)",
  maintenanceUnbypass: "DELETE FROM assets_maintenance_bypass WHERE workspace_id=?",
  maintenancePending:
    "SELECT COUNT(*) AS n FROM assets_uploads WHERE workspace_id=? AND (?='' OR project_id=?)",
  maintenancePendingUploads:
    "SELECT id,asset_id FROM assets_uploads WHERE workspace_id=? AND (?='' OR project_id=?) ORDER BY id LIMIT 10",
  maintenanceCollectUpload: "DELETE FROM assets_uploads WHERE workspace_id=? AND id=?",
  uploadStart:
    "INSERT INTO assets_uploads(workspace_id,id,asset_id,project_id) SELECT ?,?,id,project_id FROM assets_blobs WHERE workspace_id=? AND id=? AND state='pending'",
  uploadFinish: "DELETE FROM assets_uploads WHERE workspace_id=? AND id=?",
  uploadFrozen:
    "SELECT 1 AS frozen FROM assets_frozen WHERE workspace_id=? AND (project_id='' OR project_id=?)",
  maintenanceBlobs:
    "SELECT id FROM assets_blobs WHERE workspace_id=? AND (?='' OR project_id=?) ORDER BY id LIMIT 10",
  maintenanceRetire: "UPDATE assets_blobs SET state='retired' WHERE workspace_id=? AND id=?",
  maintenanceBlobDone:
    "DELETE FROM assets_blobs WHERE workspace_id=? AND id=? AND NOT EXISTS(SELECT 1 FROM assets_uploads WHERE workspace_id=? AND asset_id=?) AND NOT EXISTS(SELECT 1 FROM assets_links WHERE workspace_id=? AND asset_id=?) AND NOT EXISTS(SELECT 1 FROM assets_history WHERE workspace_id=? AND asset_id=?)",
  maintenanceBlobReady:
    "SELECT id FROM assets_blobs WHERE workspace_id=? AND id=? AND NOT EXISTS(SELECT 1 FROM assets_uploads WHERE workspace_id=? AND asset_id=?) AND NOT EXISTS(SELECT 1 FROM assets_links WHERE workspace_id=? AND asset_id=?) AND NOT EXISTS(SELECT 1 FROM assets_history WHERE workspace_id=? AND asset_id=?)",
  maintenanceCountLinks:
    "SELECT COUNT(*) AS n FROM assets_links WHERE workspace_id=? AND (?='' OR asset_id IN(SELECT id FROM assets_blobs WHERE workspace_id=assets_links.workspace_id AND project_id=?))",
  maintenanceDeleteLinks:
    "DELETE FROM assets_links WHERE rowid IN(SELECT rowid FROM assets_links WHERE workspace_id=? AND (?='' OR asset_id IN(SELECT id FROM assets_blobs WHERE workspace_id=assets_links.workspace_id AND project_id=?)) LIMIT 50)",
  maintenanceCountHistory:
    "SELECT COUNT(*) AS n FROM assets_history WHERE workspace_id=? AND (?='' OR asset_id IN(SELECT id FROM assets_blobs WHERE workspace_id=assets_history.workspace_id AND project_id=?))",
  maintenanceDeleteHistory:
    "DELETE FROM assets_history WHERE rowid IN(SELECT rowid FROM assets_history WHERE workspace_id=? AND (?='' OR asset_id IN(SELECT id FROM assets_blobs WHERE workspace_id=assets_history.workspace_id AND project_id=?)) LIMIT 50)",
  maintenanceCountGcJobs:
    "SELECT COUNT(*) AS n FROM assets_gc_jobs WHERE workspace_id=? AND (?='' OR asset_id IN(SELECT id FROM assets_blobs WHERE workspace_id=assets_gc_jobs.workspace_id AND project_id=?))",
  maintenanceCountBlobs:
    "SELECT COUNT(*) AS n FROM assets_blobs WHERE workspace_id=? AND (?='' OR project_id=?)",
  maintenanceCountReceipts:
    "SELECT COUNT(*) AS n FROM assets_receipts WHERE workspace_id=? AND (?='' OR project_id=?)",
  maintenanceDeleteReceipts:
    "DELETE FROM assets_receipts WHERE rowid IN(SELECT rowid FROM assets_receipts WHERE workspace_id=? AND (?='' OR project_id=?) LIMIT 50)",
  maintenanceCountEvents:
    "SELECT COUNT(*) AS n FROM assets_events WHERE workspace_id=? AND (?='' OR project_id=?)",
  maintenanceDeleteEvents:
    "DELETE FROM assets_events WHERE rowid IN(SELECT rowid FROM assets_events WHERE workspace_id=? AND (?='' OR project_id=?) LIMIT 50)",
} as const;
