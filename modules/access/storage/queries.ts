export const queries = {
  activeWorkspaceIds:
    "SELECT workspace_id FROM access_workspaces WHERE archived=0 AND workspace_id>? ORDER BY workspace_id LIMIT ?",
  oauthPruneForms:
    "DELETE FROM access_oauth_forms WHERE workspace_id=? AND principal_id=? AND expires_at<=?",
  oauthIssueForm:
    "INSERT INTO access_oauth_forms(workspace_id,token_hash,principal_id,expires_at) SELECT ?,?,?,? WHERE (SELECT COUNT(*) FROM access_oauth_forms WHERE workspace_id=? AND principal_id=?)<16",
  oauthConsumeForm:
    "DELETE FROM access_oauth_forms WHERE workspace_id=? AND token_hash=? AND principal_id=? AND expires_at>?",

  principal:
    "SELECT id, kind, issuer, subject, email, display_name FROM access_principals WHERE id=?",
  refreshProfile:
    "UPDATE access_principals SET email=?, display_name=? WHERE id=? AND (email IS NOT ? OR display_name IS NOT ?)",
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
  machineAdmission:
    "SELECT c.principal_id,c.token_hash,c.scope,c.expires_at,c.revoked,m.role,m.version FROM access_credentials c LEFT JOIN access_memberships m ON m.workspace_id=c.workspace_id AND m.principal_id=c.principal_id AND m.active=1 LEFT JOIN access_workspaces w ON w.workspace_id=c.workspace_id WHERE c.workspace_id=? AND c.id=? AND w.archived=0",
  listWorkspaces:
    "SELECT w.workspace_id, w.name, w.version, m.role FROM access_workspaces w JOIN access_memberships m ON m.workspace_id=w.workspace_id WHERE m.principal_id=? AND m.active=1 AND w.archived=0 AND (? IS NULL OR w.workspace_id=?) ORDER BY w.workspace_id LIMIT 100",
  discoverWorkspaces:
    "SELECT w.workspace_id,w.name,w.version,m.role FROM access_workspaces w JOIN access_memberships m ON m.workspace_id=w.workspace_id WHERE m.principal_id=? AND m.active=1 AND w.archived=0 AND (? IS NULL OR w.workspace_id=?) AND w.workspace_id>? ORDER BY w.workspace_id LIMIT ?",
  listMembers:
    "SELECT m.principal_id,m.role,m.version,p.kind,p.subject,p.email,p.display_name FROM access_memberships m JOIN access_principals p ON p.id=m.principal_id WHERE m.workspace_id=? AND m.active=1 AND m.principal_id>? ORDER BY m.principal_id LIMIT ?",
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
  listCredentials:
    "SELECT id,name,principal_id,scope,expires_at,created_at,revoked,version FROM access_credentials WHERE workspace_id=? AND id>? ORDER BY id LIMIT ?",
  issueCredential:
    "INSERT INTO access_credentials(workspace_id,id,principal_id,token_hash,scope,expires_at,name,created_at,version) VALUES(?,?,?,?,?,?,?,?,1)",
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
  oauthListClients:
    "SELECT w.client_id,w.version,w.revoked,c.name FROM access_oauth_workspace_clients w JOIN access_oauth_clients c ON c.id=w.client_id WHERE w.workspace_id=? AND w.client_id>? ORDER BY w.client_id LIMIT ?",
  oauthRevokeClientFamilies:
    "UPDATE access_oauth_families SET revoked=1,version=version+1 WHERE workspace_id=? AND client_id=? AND revoked=0",
  oauthRevokeClientTokens:
    "UPDATE access_oauth_tokens SET used=1 WHERE workspace_id=? AND family_id IN (SELECT id FROM access_oauth_families WHERE workspace_id=? AND client_id=?)",
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
  maintenanceFreeze:
    "INSERT INTO access_frozen_scopes(workspace_id,project_id,state) VALUES(?,?,'frozen') ON CONFLICT(workspace_id,project_id) DO NOTHING",
  maintenanceMarker: "SELECT state FROM access_frozen_scopes WHERE workspace_id=? AND project_id=?",
  maintenanceBegin:
    "UPDATE access_frozen_scopes SET state='purging' WHERE workspace_id=? AND project_id=? AND state='frozen'",
  maintenanceDone:
    "UPDATE access_frozen_scopes SET state='purged' WHERE workspace_id=? AND project_id=? AND state='purging'",
  maintenanceBypass: "INSERT INTO access_purge_bypass(workspace_id,project_id) VALUES(?,?)",
  maintenanceUnbypass: "DELETE FROM access_purge_bypass WHERE workspace_id=? AND project_id=?",
  maintenanceCountOauthForms:
    "SELECT COUNT(*) AS n FROM access_oauth_forms t WHERE t.workspace_id=? AND ?=''",
  maintenanceDeleteOauthForms:
    "DELETE FROM access_oauth_forms WHERE rowid IN (SELECT t.rowid FROM access_oauth_forms t WHERE t.workspace_id=? AND ?='' ORDER BY t.rowid LIMIT 50)",
  maintenanceCountOauthTokens:
    "SELECT COUNT(*) AS n FROM access_oauth_tokens t WHERE t.workspace_id=? AND ?=''",
  maintenanceDeleteOauthTokens:
    "DELETE FROM access_oauth_tokens WHERE rowid IN (SELECT t.rowid FROM access_oauth_tokens t WHERE t.workspace_id=? AND ?='' ORDER BY t.rowid LIMIT 50)",
  maintenanceCountOauthCodes:
    "SELECT COUNT(*) AS n FROM access_oauth_codes t WHERE t.workspace_id=? AND ?=''",
  maintenanceDeleteOauthCodes:
    "DELETE FROM access_oauth_codes WHERE rowid IN (SELECT t.rowid FROM access_oauth_codes t WHERE t.workspace_id=? AND ?='' ORDER BY t.rowid LIMIT 50)",
  maintenanceCountOauthFamilies:
    "SELECT COUNT(*) AS n FROM access_oauth_families t WHERE t.workspace_id=? AND ?=''",
  maintenanceDeleteOauthFamilies:
    "DELETE FROM access_oauth_families WHERE rowid IN (SELECT t.rowid FROM access_oauth_families t WHERE t.workspace_id=? AND ?='' AND NOT EXISTS (SELECT 1 FROM access_oauth_tokens c WHERE c.workspace_id=t.workspace_id AND c.family_id=t.id) ORDER BY t.rowid LIMIT 50)",
  maintenanceCountCredentials:
    "SELECT COUNT(*) AS n FROM access_credentials t WHERE t.workspace_id=? AND ?=''",
  maintenanceDeleteCredentials:
    "DELETE FROM access_credentials WHERE rowid IN (SELECT t.rowid FROM access_credentials t WHERE t.workspace_id=? AND ?='' ORDER BY t.rowid LIMIT 50)",
  maintenanceCountOauthWorkspaceClients:
    "SELECT COUNT(*) AS n FROM access_oauth_workspace_clients t WHERE t.workspace_id=? AND ?=''",
  maintenanceDeleteOauthWorkspaceClients:
    "DELETE FROM access_oauth_workspace_clients WHERE rowid IN (SELECT t.rowid FROM access_oauth_workspace_clients t WHERE t.workspace_id=? AND ?='' AND NOT EXISTS (SELECT 1 FROM access_oauth_codes c WHERE c.workspace_id=t.workspace_id AND c.client_id=t.client_id) AND NOT EXISTS (SELECT 1 FROM access_oauth_families c WHERE c.workspace_id=t.workspace_id AND c.client_id=t.client_id) ORDER BY t.rowid LIMIT 50)",
  maintenanceCountMemberships:
    "SELECT COUNT(*) AS n FROM access_memberships t WHERE t.workspace_id=? AND ?=''",
  maintenanceDeleteMemberships:
    "DELETE FROM access_memberships WHERE rowid IN (SELECT t.rowid FROM access_memberships t WHERE t.workspace_id=? AND ?='' AND NOT EXISTS (SELECT 1 FROM access_credentials c WHERE c.workspace_id=t.workspace_id AND c.principal_id=t.principal_id) AND NOT EXISTS (SELECT 1 FROM access_oauth_codes c WHERE c.workspace_id=t.workspace_id AND c.principal_id=t.principal_id) AND NOT EXISTS (SELECT 1 FROM access_oauth_families c WHERE c.workspace_id=t.workspace_id AND c.principal_id=t.principal_id) ORDER BY t.rowid LIMIT 50)",
  maintenanceCountReceipts:
    "SELECT COUNT(*) AS n FROM access_receipts t WHERE t.workspace_id=? AND ?=''",
  maintenanceDeleteReceipts:
    "DELETE FROM access_receipts WHERE rowid IN (SELECT t.rowid FROM access_receipts t WHERE t.workspace_id=? AND ?='' ORDER BY t.rowid LIMIT 50)",
  maintenanceCountEvents:
    "SELECT COUNT(*) AS n FROM access_events t WHERE t.workspace_id=? AND ?=''",
  maintenanceDeleteEvents:
    "DELETE FROM access_events WHERE rowid IN (SELECT t.rowid FROM access_events t WHERE t.workspace_id=? AND ?='' ORDER BY t.rowid LIMIT 50)",
  maintenanceCountGuards:
    "SELECT COUNT(*) AS n FROM access_guards t WHERE t.workspace_id=? AND ?=''",
  maintenanceDeleteGuards:
    "DELETE FROM access_guards WHERE rowid IN (SELECT t.rowid FROM access_guards t WHERE t.workspace_id=? AND ?='' ORDER BY t.rowid LIMIT 50)",
  maintenanceCountWorkspaces:
    "SELECT COUNT(*) AS n FROM access_workspaces t WHERE t.workspace_id=? AND ?=''",
  maintenanceDeleteWorkspaces:
    "DELETE FROM access_workspaces WHERE rowid IN (SELECT t.rowid FROM access_workspaces t WHERE t.workspace_id=? AND ?='' AND NOT EXISTS (SELECT 1 FROM access_memberships c WHERE c.workspace_id=t.workspace_id) AND NOT EXISTS (SELECT 1 FROM access_oauth_workspace_clients c WHERE c.workspace_id=t.workspace_id) AND NOT EXISTS (SELECT 1 FROM access_receipts c WHERE c.workspace_id=t.workspace_id) AND NOT EXISTS (SELECT 1 FROM access_events c WHERE c.workspace_id=t.workspace_id) AND NOT EXISTS (SELECT 1 FROM access_oauth_forms c WHERE c.workspace_id=t.workspace_id) ORDER BY t.rowid LIMIT 50)",
} as const;
