export const queries = {
  session:
    "SELECT id,principal_id,agent_label,client_kind,repo,ttl_seconds,expires_at,ended FROM coord_sessions WHERE workspace_id=? AND id=?",
  sessions:
    "SELECT id,principal_id,agent_label,client_kind,repo,ttl_seconds,expires_at,ended FROM coord_sessions WHERE workspace_id=? ORDER BY id LIMIT 100",
  projectSessions:
    "SELECT s.id,s.principal_id,s.agent_label,s.client_kind,s.repo,s.ttl_seconds,s.expires_at,s.ended FROM coord_sessions s WHERE s.workspace_id=? AND s.id>? AND s.ended=0 AND s.expires_at>? AND EXISTS (SELECT 1 FROM coord_leases l WHERE l.workspace_id=s.workspace_id AND l.project_id=? AND l.session_id=s.id AND l.expires_at>?) ORDER BY s.id LIMIT ?",
  start:
    "INSERT INTO coord_sessions(workspace_id,id,principal_id,agent_label,client_kind,repo,ttl_seconds,expires_at) VALUES(?,?,?,?,?,?,?,?)",
  touch:
    "UPDATE coord_sessions SET expires_at=? WHERE workspace_id=? AND id=? AND principal_id=? AND ended=0 AND expires_at>?",
  releaseSessionLeases:
    "UPDATE coord_leases SET session_id=NULL,expires_at=?,release_reason='session_ended' WHERE workspace_id=? AND session_id=?",
  end: "UPDATE coord_sessions SET ended=1,expires_at=? WHERE workspace_id=? AND id=? AND principal_id=? AND ended=0 AND expires_at>?",
  lease:
    "SELECT issue_id,project_id,session_id,fencing_token,expires_at,release_reason FROM coord_leases WHERE workspace_id=? AND issue_id=?",
  leases:
    "SELECT issue_id,project_id,session_id,fencing_token,expires_at,release_reason FROM coord_leases WHERE workspace_id=? AND project_id=? ORDER BY issue_id LIMIT 100",
  projectLeases:
    "SELECT l.issue_id,l.project_id,l.session_id,l.fencing_token,l.expires_at,l.release_reason,s.principal_id,s.agent_label,s.client_kind FROM coord_leases l JOIN coord_sessions s ON s.workspace_id=l.workspace_id AND s.id=l.session_id WHERE l.workspace_id=? AND l.project_id=? AND l.issue_id>? AND l.session_id IS NOT NULL AND l.expires_at>? AND s.ended=0 AND s.expires_at>? ORDER BY l.issue_id LIMIT ?",
  acquire:
    "INSERT INTO coord_leases(workspace_id,issue_id,project_id,session_id,fencing_token,expires_at,release_reason) SELECT ?,?,?,?,1,?,NULL WHERE (SELECT COUNT(*) FROM coord_leases WHERE workspace_id=? AND project_id=? AND session_id IS NOT NULL AND expires_at>?) < COALESCE((SELECT cap FROM coord_limits WHERE workspace_id=? AND project_id=?),3)",
  acquireCap:
    "UPDATE coord_leases SET session_id=?,fencing_token=fencing_token+1,expires_at=?,release_reason=CASE WHEN session_id IS NULL THEN release_reason ELSE 'expired' END WHERE workspace_id=? AND issue_id=? AND (session_id IS NULL OR expires_at<=?) AND (SELECT COUNT(*) FROM coord_leases WHERE workspace_id=? AND project_id=? AND session_id IS NOT NULL AND expires_at>?) < COALESCE((SELECT cap FROM coord_limits WHERE workspace_id=? AND project_id=?),3)",
  renew:
    "UPDATE coord_leases SET expires_at=? WHERE workspace_id=? AND issue_id=? AND session_id=? AND fencing_token=? AND expires_at>?",
  release:
    "UPDATE coord_leases SET session_id=NULL,expires_at=?,release_reason='released' WHERE workspace_id=? AND issue_id=? AND session_id=? AND fencing_token=? AND expires_at>?",
  openLeaseSpan:
    "INSERT INTO coord_lease_spans(workspace_id,project_id,issue_id,session_id,principal_id,fencing_token,claimed_at) SELECT l.workspace_id,l.project_id,l.issue_id,l.session_id,s.principal_id,l.fencing_token,? FROM coord_leases l JOIN coord_sessions s ON s.workspace_id=l.workspace_id AND s.id=l.session_id WHERE l.workspace_id=? AND l.issue_id=? AND l.fencing_token=?",
  closeLeaseSpan:
    "UPDATE coord_lease_spans SET released_at=?,release_reason=? WHERE workspace_id=? AND issue_id=? AND fencing_token=? AND released_at IS NULL",
  closeSessionLeaseSpans:
    "UPDATE coord_lease_spans SET released_at=?,release_reason='session_ended' WHERE workspace_id=? AND session_id=? AND released_at IS NULL",
  activeLeaseCount:
    "SELECT COUNT(*) AS n FROM coord_leases WHERE workspace_id=? AND project_id=? AND session_id IS NOT NULL AND expires_at>?",
  recordWipDenial:
    "INSERT INTO coord_wip_denials(workspace_id,project_id,issue_id,principal_id,occurred_at) SELECT ?,?,?,?,MAX(?,COALESCE((SELECT MAX(occurred_at)+1 FROM coord_wip_denials WHERE workspace_id=? AND project_id=? AND issue_id=? AND principal_id=?),0)) WHERE NOT EXISTS(SELECT 1 FROM coord_frozen_scopes WHERE workspace_id=? AND (project_id='' OR project_id=?))",
  limit: "SELECT cap,version FROM coord_limits WHERE workspace_id=? AND project_id=?",
  projectClaims:
    "SELECT c.repo,c.path,c.session_id,c.lease_issue_id,c.expires_at FROM coord_file_claims c JOIN coord_leases l ON l.workspace_id=c.workspace_id AND l.issue_id=c.lease_issue_id AND l.session_id=c.session_id WHERE c.workspace_id=? AND l.project_id=? AND c.expires_at>? AND l.expires_at>? AND (c.repo>? OR (c.repo=? AND c.path>?)) ORDER BY c.repo,c.path LIMIT ?",
  projectProgress:
    "SELECT r.issue_id,r.session_id,r.fencing_token,r.text,r.status,r.reported_at,l.project_id FROM coord_reports r JOIN coord_leases l ON l.workspace_id=r.workspace_id AND l.issue_id=r.issue_id WHERE r.workspace_id=? AND l.project_id=? AND (r.reported_at<? OR (r.reported_at=? AND r.issue_id<?)) ORDER BY r.reported_at DESC,r.issue_id DESC LIMIT ?",
  setLimit:
    "INSERT INTO coord_limits(workspace_id,project_id,cap,version) SELECT ?,?,?,1 WHERE ?=0 AND (SELECT COUNT(*) FROM coord_leases WHERE workspace_id=? AND project_id=? AND session_id IS NOT NULL AND expires_at>?)<=? ON CONFLICT(workspace_id,project_id) DO UPDATE SET cap=excluded.cap,version=coord_limits.version+1 WHERE coord_limits.version=? AND (SELECT COUNT(*) FROM coord_leases WHERE workspace_id=? AND project_id=? AND session_id IS NOT NULL AND expires_at>?)<=?",
  claim:
    "SELECT repo,path,session_id,lease_issue_id,expires_at FROM coord_file_claims WHERE workspace_id=? AND repo=? AND path=?",
  claims:
    "SELECT repo,path,session_id,lease_issue_id,expires_at FROM coord_file_claims WHERE workspace_id=? AND repo=? ORDER BY path LIMIT 100",
  putClaim:
    "INSERT INTO coord_file_claims(workspace_id,repo,path,session_id,lease_issue_id,expires_at,project_id) SELECT ?,?,?,?,?,?,(SELECT project_id FROM coord_leases WHERE workspace_id=? AND issue_id=?) WHERE (? IS NULL OR EXISTS (SELECT 1 FROM coord_leases WHERE workspace_id=? AND issue_id=? AND session_id=? AND fencing_token=? AND expires_at>?)) ON CONFLICT(workspace_id,repo,path) DO UPDATE SET session_id=excluded.session_id,lease_issue_id=excluded.lease_issue_id,expires_at=excluded.expires_at,project_id=excluded.project_id WHERE (coord_file_claims.expires_at<=? OR coord_file_claims.session_id=? OR ?=1) AND coord_file_claims.session_id=?",
  touchClaims:
    "UPDATE coord_file_claims SET expires_at=? WHERE workspace_id=? AND session_id=? AND expires_at>?",
  dropClaim:
    "DELETE FROM coord_file_claims WHERE workspace_id=? AND repo=? AND path=? AND session_id=?",
  dropSessionClaims: "DELETE FROM coord_file_claims WHERE workspace_id=? AND session_id=?",
  openFileClaimSpan:
    "INSERT INTO coord_file_claim_spans(workspace_id,project_id,repo,path,session_id,lease_issue_id,claimed_at) SELECT c.workspace_id,c.project_id,c.repo,c.path,c.session_id,c.lease_issue_id,MAX(?,COALESCE((SELECT MAX(claimed_at)+1 FROM coord_file_claim_spans WHERE workspace_id=c.workspace_id AND repo=c.repo AND path=c.path AND session_id=c.session_id),0)) FROM coord_file_claims c WHERE c.workspace_id=? AND c.repo=? AND c.path=? AND c.session_id=? AND NOT EXISTS(SELECT 1 FROM coord_file_claim_spans s WHERE s.workspace_id=c.workspace_id AND s.repo=c.repo AND s.path=c.path AND s.session_id=c.session_id AND s.released_at IS NULL)",
  closeFileClaimSpan:
    "UPDATE coord_file_claim_spans SET released_at=?,release_reason=? WHERE workspace_id=? AND repo=? AND path=? AND session_id=? AND released_at IS NULL",
  closeSessionFileClaimSpans:
    "UPDATE coord_file_claim_spans SET released_at=?,release_reason='agent_ended' WHERE workspace_id=? AND session_id=? AND released_at IS NULL",
  leaseHeldSeconds:
    "SELECT issue_id,claimed_at,released_at FROM coord_lease_spans WHERE workspace_id=? AND project_id=? AND issue_id IN (WITH RECURSIVE seq(n,js) AS (SELECT 0,? UNION ALL SELECT n+1,js FROM seq WHERE n+1<json_array_length(js)) SELECT json_extract(js,'$['||n||']') FROM seq WHERE n<json_array_length(js))",
  flowWindowCounts:
    "SELECT (SELECT COUNT(*) FROM coord_lease_spans WHERE workspace_id=? AND project_id=? AND release_reason='expired' AND released_at>=? AND released_at<=?) AS lease_expiries,(SELECT COUNT(*) FROM coord_file_claim_spans WHERE workspace_id=? AND project_id=? AND release_reason='agent_ended' AND released_at>=? AND released_at<=?) AS abandoned_claims,(SELECT COUNT(*) FROM coord_wip_denials WHERE workspace_id=? AND project_id=? AND occurred_at>=? AND occurred_at<=?) AS wip_cap_pressure",
  report:
    "INSERT INTO coord_reports(workspace_id,issue_id,session_id,fencing_token,text,status,reported_at,project_id) SELECT ?,?,?,?,?,?,?,(SELECT project_id FROM coord_leases WHERE workspace_id=? AND issue_id=?) WHERE EXISTS (SELECT 1 FROM coord_leases WHERE workspace_id=? AND issue_id=? AND session_id=? AND fencing_token=? AND expires_at>?) ON CONFLICT(workspace_id,issue_id) DO UPDATE SET session_id=excluded.session_id,fencing_token=excluded.fencing_token,text=excluded.text,status=excluded.status,reported_at=excluded.reported_at,project_id=excluded.project_id",
  appendReport:
    "INSERT INTO coord_report_history(workspace_id,issue_id,sequence,session_id,fencing_token,text,status,reported_at,project_id) SELECT r.workspace_id,r.issue_id,(SELECT COALESCE(MAX(sequence),0)+1 FROM coord_report_history WHERE workspace_id=? AND issue_id=?),r.session_id,r.fencing_token,r.text,r.status,r.reported_at,r.project_id FROM coord_reports r WHERE r.workspace_id=? AND r.issue_id=?",
  trimReports:
    "DELETE FROM coord_report_history WHERE workspace_id=? AND issue_id=? AND sequence <= (SELECT MAX(sequence)-1000 FROM coord_report_history WHERE workspace_id=? AND issue_id=?)",
  progressHistory:
    "SELECT issue_id,sequence,session_id,fencing_token,text,status,reported_at FROM coord_report_history WHERE workspace_id=? AND issue_id=? AND sequence<? ORDER BY sequence DESC LIMIT ?",
  progress:
    "SELECT issue_id,session_id,fencing_token,text,status,reported_at FROM coord_reports WHERE workspace_id=? AND issue_id=?",
  receipt:
    "INSERT INTO coord_receipts(workspace_id,principal_id,operation_id,fingerprint,result_json,project_id) SELECT workspace_id,principal_id,operation_id,fingerprint,result_json,COALESCE(json_extract(result_json,'$.projectId'),(SELECT project_id FROM coord_leases WHERE workspace_id=receipt_data.workspace_id AND issue_id=COALESCE(json_extract(receipt_data.result_json,'$.issueId'),json_extract(receipt_data.result_json,'$[0].leaseIssueId')))) FROM (SELECT ? AS workspace_id,? AS principal_id,? AS operation_id,? AS fingerprint,? AS result_json) receipt_data",
  readReceipt:
    "SELECT fingerprint,result_json FROM coord_receipts WHERE workspace_id=? AND principal_id=? AND operation_id=?",
  event:
    "INSERT INTO coord_events(workspace_id,sequence,event_id,type,subject_id,actor_id,other_session_id,occurred_at,client_id,schema_version,issue_id,project_id) VALUES(?,(SELECT COALESCE(MAX(sequence),0)+1 FROM coord_events WHERE workspace_id=?),?,?,?,?,?,?,?,2,?,COALESCE(?,(SELECT project_id FROM coord_leases WHERE workspace_id=? AND issue_id=?)))",
  agentEvents:
    "SELECT sequence,event_id,type,subject_id,actor_id,other_session_id,occurred_at,client_id,schema_version,issue_id,project_id FROM coord_events WHERE workspace_id=? AND sequence>? AND (actor_id=? OR other_session_id IN (SELECT id FROM coord_sessions WHERE workspace_id=? AND principal_id=?)) ORDER BY sequence LIMIT ?",
  events:
    "SELECT sequence,event_id,type,subject_id,actor_id,other_session_id,occurred_at,client_id,schema_version,issue_id,project_id FROM coord_events WHERE workspace_id=? AND sequence>? ORDER BY sequence LIMIT ?",
  guard: "INSERT INTO coord_guards(workspace_id,id,changed) VALUES(?,?,changes())",
  clearGuard: "DELETE FROM coord_guards WHERE workspace_id=? AND id=?",
  maintenanceFreeze:
    "INSERT INTO coord_frozen_scopes(workspace_id,project_id,state) VALUES(?,?,'frozen') ON CONFLICT(workspace_id,project_id) DO NOTHING",
  maintenanceMarker: "SELECT state FROM coord_frozen_scopes WHERE workspace_id=? AND project_id=?",
  maintenanceBegin:
    "UPDATE coord_frozen_scopes SET state='purging' WHERE workspace_id=? AND project_id=? AND state='frozen'",
  maintenanceDone:
    "UPDATE coord_frozen_scopes SET state='purged' WHERE workspace_id=? AND project_id=? AND state='purging'",
  maintenanceBypass: "INSERT INTO coord_purge_bypass(workspace_id,project_id) VALUES(?,?)",
  maintenanceUnbypass: "DELETE FROM coord_purge_bypass WHERE workspace_id=? AND project_id=?",
  maintenanceCountLeaseSpans:
    "SELECT COUNT(*) AS n FROM coord_lease_spans WHERE workspace_id=? AND (?='' OR project_id=?)",
  maintenanceDeleteLeaseSpans:
    "DELETE FROM coord_lease_spans WHERE rowid IN (SELECT rowid FROM coord_lease_spans WHERE workspace_id=? AND (?='' OR project_id=?) ORDER BY rowid LIMIT 50)",
  maintenanceCountFileClaimSpans:
    "SELECT COUNT(*) AS n FROM coord_file_claim_spans WHERE workspace_id=? AND (?='' OR project_id=?)",
  maintenanceDeleteFileClaimSpans:
    "DELETE FROM coord_file_claim_spans WHERE rowid IN (SELECT rowid FROM coord_file_claim_spans WHERE workspace_id=? AND (?='' OR project_id=?) ORDER BY rowid LIMIT 50)",
  maintenanceCountWipDenials:
    "SELECT COUNT(*) AS n FROM coord_wip_denials WHERE workspace_id=? AND (?='' OR project_id=?)",
  maintenanceDeleteWipDenials:
    "DELETE FROM coord_wip_denials WHERE rowid IN (SELECT rowid FROM coord_wip_denials WHERE workspace_id=? AND (?='' OR project_id=?) ORDER BY rowid LIMIT 50)",
  maintenanceCountFileClaims:
    "SELECT COUNT(*) AS n FROM coord_file_claims t WHERE t.workspace_id=? AND (?='' OR t.project_id=?)",
  maintenanceDeleteFileClaims:
    "DELETE FROM coord_file_claims WHERE rowid IN (SELECT t.rowid FROM coord_file_claims t WHERE t.workspace_id=? AND (?='' OR t.project_id=?) ORDER BY t.rowid LIMIT 50)",
  maintenanceCountReportHistory:
    "SELECT COUNT(*) AS n FROM coord_report_history t WHERE t.workspace_id=? AND (?='' OR t.project_id=?)",
  maintenanceDeleteReportHistory:
    "DELETE FROM coord_report_history WHERE rowid IN (SELECT t.rowid FROM coord_report_history t WHERE t.workspace_id=? AND (?='' OR t.project_id=?) ORDER BY t.rowid LIMIT 50)",
  maintenanceCountReports:
    "SELECT COUNT(*) AS n FROM coord_reports t WHERE t.workspace_id=? AND (?='' OR t.project_id=?)",
  maintenanceDeleteReports:
    "DELETE FROM coord_reports WHERE rowid IN (SELECT t.rowid FROM coord_reports t WHERE t.workspace_id=? AND (?='' OR t.project_id=?) ORDER BY t.rowid LIMIT 50)",
  maintenanceCountReceipts:
    "SELECT COUNT(*) AS n FROM coord_receipts t WHERE t.workspace_id=? AND (?='' OR t.project_id=?)",
  maintenanceDeleteReceipts:
    "DELETE FROM coord_receipts WHERE rowid IN (SELECT t.rowid FROM coord_receipts t WHERE t.workspace_id=? AND (?='' OR t.project_id=?) ORDER BY t.rowid LIMIT 50)",
  maintenanceCountEvents:
    "SELECT COUNT(*) AS n FROM coord_events t WHERE t.workspace_id=? AND (?='' OR t.project_id=?)",
  maintenanceDeleteEvents:
    "DELETE FROM coord_events WHERE rowid IN (SELECT t.rowid FROM coord_events t WHERE t.workspace_id=? AND (?='' OR t.project_id=?) ORDER BY t.rowid LIMIT 50)",
  maintenanceCountGuards:
    "SELECT COUNT(*) AS n FROM coord_guards t WHERE t.workspace_id=? AND ?=''",
  maintenanceDeleteGuards:
    "DELETE FROM coord_guards WHERE rowid IN (SELECT t.rowid FROM coord_guards t WHERE t.workspace_id=? AND ?='' ORDER BY t.rowid LIMIT 50)",
  maintenanceCountLimits:
    "SELECT COUNT(*) AS n FROM coord_limits t WHERE t.workspace_id=? AND (?='' OR t.project_id=?)",
  maintenanceDeleteLimits:
    "DELETE FROM coord_limits WHERE rowid IN (SELECT t.rowid FROM coord_limits t WHERE t.workspace_id=? AND (?='' OR t.project_id=?) ORDER BY t.rowid LIMIT 50)",
  maintenanceCountLeases:
    "SELECT COUNT(*) AS n FROM coord_leases t WHERE t.workspace_id=? AND (?='' OR t.project_id=?)",
  maintenanceDeleteLeases:
    "DELETE FROM coord_leases WHERE rowid IN (SELECT t.rowid FROM coord_leases t WHERE t.workspace_id=? AND (?='' OR t.project_id=?) ORDER BY t.rowid LIMIT 50)",
  maintenanceCountSessions:
    "SELECT COUNT(*) AS n FROM coord_sessions t WHERE t.workspace_id=? AND ?=''",
  maintenanceDeleteSessions:
    "DELETE FROM coord_sessions WHERE rowid IN (SELECT t.rowid FROM coord_sessions t WHERE t.workspace_id=? AND ?='' ORDER BY t.rowid LIMIT 50)",
} as const;
