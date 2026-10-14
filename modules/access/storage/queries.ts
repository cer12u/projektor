export const queries = {
  oauthPruneForms:
    "DELETE FROM access_oauth_forms WHERE workspace_id=? AND principal_id=? AND expires_at<=?",
  oauthIssueForm:
    "INSERT INTO access_oauth_forms(workspace_id,token_hash,principal_id,expires_at) SELECT ?,?,?,? WHERE (SELECT COUNT(*) FROM access_oauth_forms WHERE workspace_id=? AND principal_id=?)<16",
  oauthConsumeForm:
    "DELETE FROM access_oauth_forms WHERE workspace_id=? AND token_hash=? AND principal_id=? AND expires_at>?",

  principal: "SELECT id, kind, issuer, subject FROM access_principals WHERE id=?",
  putPrincipal:
    "INSERT INTO access_principals(id,kind,issuer,subject) VALUES(?,?,?,?) ON CONFLICT(id) DO NOTHING",
  workspace:
    "SELECT workspace_id, name, version, archived FROM access_workspaces WHERE workspace_id=?",
  createWorkspace: "INSERT INTO access_workspaces(workspace_id,name,version) VALUES(?,?,1)",
  bootstrap: "INSERT INTO access_bootstrap(id,workspace_id) VALUES(1,?)",
  membership:
    "SELECT role, active, version FROM access_memberships WHERE workspace_id=? AND principal_id=?",
  admission:
    "SELECT m.role, m.version FROM access_memberships m JOIN access_workspaces w ON w.workspace_id=m.workspace_id WHERE m.workspace_id=? AND m.principal_id=? AND m.active=1 AND w.archived=0",
  listWorkspaces:
    "SELECT w.workspace_id, w.name, w.version, m.role FROM access_workspaces w JOIN access_memberships m ON m.workspace_id=w.workspace_id WHERE m.principal_id=? AND m.active=1 AND w.archived=0 AND (? IS NULL OR w.workspace_id=?) ORDER BY w.workspace_id LIMIT 100",
  addMember:
    "INSERT INTO access_memberships(workspace_id,principal_id,role,active,version) SELECT ?,?,?,1,1 WHERE ?=0 ON CONFLICT(workspace_id,principal_id) DO NOTHING",
  restoreMember:
    "UPDATE access_memberships SET role=?, active=1, version=version+1 WHERE workspace_id=? AND principal_id=? AND active=0 AND version=?",
  changeRole:
    "UPDATE access_memberships SET role=?, version=version+1 WHERE workspace_id=? AND principal_id=? AND active=1 AND version=? AND (role!='owner' OR ?='owner' OR (SELECT COUNT(*) FROM access_memberships WHERE workspace_id=? AND role='owner' AND active=1)>1) AND (?='owner' OR role IN ('member','viewer'))",
  removeMember:
    "UPDATE access_memberships SET active=0, version=version+1 WHERE workspace_id=? AND principal_id=? AND active=1 AND version=? AND (role!='owner' OR (SELECT COUNT(*) FROM access_memberships WHERE workspace_id=? AND role='owner' AND active=1)>1) AND (?='owner' OR role IN ('member','viewer'))",
  credential:
    "SELECT id, principal_id, token_hash, scope, expires_at, revoked, version FROM access_credentials WHERE workspace_id=? AND id=?",
  issueCredential:
    "INSERT INTO access_credentials(workspace_id,id,principal_id,token_hash,scope,expires_at,version) VALUES(?,?,?,?,?,?,1)",
  revokeCredential:
    "UPDATE access_credentials SET revoked=1, version=version+1 WHERE workspace_id=? AND id=? AND version=? AND revoked=0",
  revokeMemberCredentials:
    "UPDATE access_credentials SET revoked=1, version=version+1 WHERE workspace_id=? AND principal_id=? AND revoked=0",
  archiveWorkspace:
    "UPDATE access_workspaces SET archived=1, version=version+1 WHERE workspace_id=? AND version=? AND archived=0",
  guard: "INSERT INTO access_guards(workspace_id,id,changed) VALUES(?,?,changes())",
  clearGuard: "DELETE FROM access_guards WHERE workspace_id=? AND id=?",
  receipt:
    "INSERT INTO access_receipts(workspace_id,principal_id,operation_id,fingerprint,result_id,result_version) VALUES(?,?,?,?,?,?)",
  readReceipt:
    "SELECT fingerprint, result_id, result_version FROM access_receipts WHERE workspace_id=? AND principal_id=? AND operation_id=?",
  event:
    "INSERT INTO access_events(workspace_id,sequence,event_id,aggregate_id,aggregate_version,type,occurred_at,actor_id) VALUES(?,(SELECT COALESCE(MAX(sequence),0)+1 FROM access_events WHERE workspace_id=?),?,?,?,?,?,?)",
  events:
    "SELECT sequence, event_id, aggregate_id, aggregate_version, type, occurred_at, actor_id FROM access_events WHERE workspace_id=? AND sequence>? ORDER BY sequence LIMIT ?",
  oauthRegister:
    "INSERT INTO access_oauth_clients(id,name,redirect_uris,scope,refresh_allowed,created_at) SELECT ?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM access_oauth_clients)<10000 AND (SELECT COUNT(*) FROM access_oauth_clients WHERE created_at>?)<100",
  oauthClient:
    "SELECT id,name,redirect_uris,scope,refresh_allowed,created_at FROM access_oauth_clients WHERE id=?",
  oauthWorkspaceClient:
    "SELECT version,revoked FROM access_oauth_workspace_clients WHERE workspace_id=? AND client_id=?",
  oauthBindClient:
    "INSERT INTO access_oauth_workspace_clients(workspace_id,client_id) VALUES(?,?) ON CONFLICT(workspace_id,client_id) DO NOTHING",
  oauthRevokeClient:
    "UPDATE access_oauth_workspace_clients SET revoked=1,version=version+1 WHERE workspace_id=? AND client_id=? AND version=? AND revoked=0",
  oauthCode: "SELECT * FROM access_oauth_codes WHERE workspace_id=? AND code_hash=?",
  oauthIssueCode:
    "INSERT INTO access_oauth_codes(workspace_id,code_hash,client_id,principal_id,membership_version,redirect_uri,challenge,resource,scope,expires_at) SELECT ?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM access_oauth_workspace_clients WHERE workspace_id=? AND client_id=? AND revoked=0)",
  oauthConsumeCode:
    "UPDATE access_oauth_codes SET used=1 WHERE workspace_id=? AND code_hash=? AND used=0 AND expires_at>?",
  oauthFamily: "SELECT * FROM access_oauth_families WHERE workspace_id=? AND id=?",
  oauthCreateFamily:
    "INSERT INTO access_oauth_families(workspace_id,id,client_id,principal_id,membership_version,resource,scope,expires_at) VALUES(?,?,?,?,?,?,?,?)",
  oauthAdvanceFamily:
    "UPDATE access_oauth_families SET version=version+1,scope=? WHERE workspace_id=? AND id=? AND version=? AND revoked=0",
  oauthRevokeFamily:
    "UPDATE access_oauth_families SET revoked=1,version=version+1 WHERE workspace_id=? AND id=? AND revoked=0",
  oauthFamilyEvent:
    "INSERT INTO access_events(workspace_id,sequence,event_id,aggregate_id,aggregate_version,type,occurred_at,actor_id) SELECT ?, (SELECT COALESCE(MAX(sequence),0)+1 FROM access_events WHERE workspace_id=?), ?, id, version, ?, ?, principal_id FROM access_oauth_families WHERE workspace_id=? AND id=? AND changes()=1",
  oauthToken: "SELECT * FROM access_oauth_tokens WHERE workspace_id=? AND token_hash=?",
  oauthIssueToken:
    "INSERT INTO access_oauth_tokens(workspace_id,token_hash,family_id,kind,scope,expires_at) VALUES(?,?,?,?,?,?)",
  oauthConsumeRefresh:
    "UPDATE access_oauth_tokens SET used=1 WHERE workspace_id=? AND token_hash=? AND kind='refresh' AND used=0 AND expires_at>?",
} as const;
