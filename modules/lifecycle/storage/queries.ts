export const queries = {
  job: "SELECT * FROM lifecycle_jobs WHERE workspace_id=? AND id=?",
  scopeJob: "SELECT * FROM lifecycle_jobs WHERE workspace_id=? AND scope_id=?",
  steps:
    "SELECT owner,state,remaining,pending,error FROM lifecycle_steps WHERE workspace_id=? AND job_id=? ORDER BY ordinal",
  due: "SELECT * FROM lifecycle_jobs WHERE state!='complete' AND next_attempt_at<=? ORDER BY next_attempt_at,workspace_id,id LIMIT ?",
  create:
    "INSERT INTO lifecycle_jobs(workspace_id,id,scope_id,project_id,requester_id,version,state,updated_at,next_attempt_at) VALUES(?,?,?,?,?,1,'freezing',?,0)",
  step: "INSERT INTO lifecycle_steps(workspace_id,job_id,owner,ordinal,state) VALUES(?,?,?,?,'pending')",
  advance:
    "UPDATE lifecycle_jobs SET version=version+1,state=?,updated_at=?,next_attempt_at=? WHERE workspace_id=? AND id=? AND version=? AND state!='complete'",
  saveStep:
    "UPDATE lifecycle_steps SET state=?,remaining=?,pending=?,error=? WHERE workspace_id=? AND job_id=? AND owner=?",
  guard: "INSERT INTO lifecycle_guards(workspace_id,id,changed) VALUES(?,?,changes())",
  clearGuard: "DELETE FROM lifecycle_guards WHERE workspace_id=? AND id=?",
  receipt:
    "INSERT INTO lifecycle_receipts(workspace_id,principal_id,operation_id,fingerprint,result_json) VALUES(?,?,?,?,?)",
  readReceipt:
    "SELECT fingerprint,result_json FROM lifecycle_receipts WHERE workspace_id=? AND principal_id=? AND operation_id=?",
  history:
    "INSERT INTO lifecycle_history(workspace_id,job_id,version,action,actor_id,occurred_at) VALUES(?,?,?,?,?,?)",
  event:
    "INSERT INTO lifecycle_events(workspace_id,event_id,aggregate_id,aggregate_version,type,occurred_at) VALUES(?,?,?,?,?,?)",
} as const;
