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
    "INSERT INTO coord_file_claims(workspace_id,repo,path,session_id,lease_issue_id,expires_at) SELECT ?,?,?,?,?,? WHERE (? IS NULL OR EXISTS (SELECT 1 FROM coord_leases WHERE workspace_id=? AND issue_id=? AND session_id=? AND fencing_token=? AND expires_at>?)) ON CONFLICT(workspace_id,repo,path) DO UPDATE SET session_id=excluded.session_id,lease_issue_id=excluded.lease_issue_id,expires_at=excluded.expires_at WHERE (coord_file_claims.expires_at<=? OR coord_file_claims.session_id=? OR ?=1) AND coord_file_claims.session_id=?",
  touchClaims:
    "UPDATE coord_file_claims SET expires_at=? WHERE workspace_id=? AND session_id=? AND expires_at>?",
  dropClaim:
    "DELETE FROM coord_file_claims WHERE workspace_id=? AND repo=? AND path=? AND session_id=?",
  dropSessionClaims: "DELETE FROM coord_file_claims WHERE workspace_id=? AND session_id=?",
  report:
    "INSERT INTO coord_reports(workspace_id,issue_id,session_id,fencing_token,text,status,reported_at) SELECT ?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM coord_leases WHERE workspace_id=? AND issue_id=? AND session_id=? AND fencing_token=? AND expires_at>?) ON CONFLICT(workspace_id,issue_id) DO UPDATE SET session_id=excluded.session_id,fencing_token=excluded.fencing_token,text=excluded.text,status=excluded.status,reported_at=excluded.reported_at",
  appendReport:
    "INSERT INTO coord_report_history(workspace_id,issue_id,sequence,session_id,fencing_token,text,status,reported_at) SELECT r.workspace_id,r.issue_id,(SELECT COALESCE(MAX(sequence),0)+1 FROM coord_report_history WHERE workspace_id=? AND issue_id=?),r.session_id,r.fencing_token,r.text,r.status,r.reported_at FROM coord_reports r WHERE r.workspace_id=? AND r.issue_id=?",
  trimReports:
    "DELETE FROM coord_report_history WHERE workspace_id=? AND issue_id=? AND sequence <= (SELECT MAX(sequence)-1000 FROM coord_report_history WHERE workspace_id=? AND issue_id=?)",
  progressHistory:
    "SELECT issue_id,sequence,session_id,fencing_token,text,status,reported_at FROM coord_report_history WHERE workspace_id=? AND issue_id=? AND sequence<? ORDER BY sequence DESC LIMIT ?",
  progress:
    "SELECT issue_id,session_id,fencing_token,text,status,reported_at FROM coord_reports WHERE workspace_id=? AND issue_id=?",
  receipt:
    "INSERT INTO coord_receipts(workspace_id,principal_id,operation_id,fingerprint,result_json) VALUES(?,?,?,?,?)",
  readReceipt:
    "SELECT fingerprint,result_json FROM coord_receipts WHERE workspace_id=? AND principal_id=? AND operation_id=?",
  event:
    "INSERT INTO coord_events(workspace_id,sequence,event_id,type,subject_id,actor_id,other_session_id,occurred_at,client_id,schema_version,issue_id,project_id) VALUES(?,(SELECT COALESCE(MAX(sequence),0)+1 FROM coord_events WHERE workspace_id=?),?,?,?,?,?,?,?,2,?,?)",
  agentEvents:
    "SELECT sequence,event_id,type,subject_id,actor_id,other_session_id,occurred_at,client_id,schema_version,issue_id,project_id FROM coord_events WHERE workspace_id=? AND sequence>? AND (actor_id=? OR other_session_id IN (SELECT id FROM coord_sessions WHERE workspace_id=? AND principal_id=?)) ORDER BY sequence LIMIT ?",
  events:
    "SELECT sequence,event_id,type,subject_id,actor_id,other_session_id,occurred_at,client_id,schema_version,issue_id,project_id FROM coord_events WHERE workspace_id=? AND sequence>? ORDER BY sequence LIMIT ?",
  guard: "INSERT INTO coord_guards(workspace_id,id,changed) VALUES(?,?,changes())",
  clearGuard: "DELETE FROM coord_guards WHERE workspace_id=? AND id=?",
} as const;
