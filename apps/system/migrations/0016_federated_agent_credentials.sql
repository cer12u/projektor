-- Optional MCP federation. Empty, disabled by default; no credentials, grants or business/gate changes.
CREATE TABLE federated_bindings (
 id TEXT PRIMARY KEY NOT NULL,
 principal_id TEXT NOT NULL REFERENCES principals(id),
 issuer TEXT NOT NULL CHECK(length(issuer)>0),
 audience TEXT NOT NULL CHECK(length(audience)>0),
 subject TEXT NOT NULL CHECK(length(subject)>0),
 created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at>=0),
 UNIQUE(issuer,audience,subject)
);
CREATE TRIGGER federated_binding_no_replace BEFORE INSERT ON federated_bindings
WHEN EXISTS(SELECT 1 FROM federated_bindings WHERE id=NEW.id
 OR (issuer=NEW.issuer AND audience=NEW.audience AND subject=NEW.subject))
BEGIN SELECT RAISE(ABORT,'federated binding already exists'); END;
CREATE TRIGGER federated_binding_agent BEFORE INSERT ON federated_bindings
WHEN NOT EXISTS(SELECT 1 FROM principals WHERE id=NEW.principal_id AND kind='agent')
BEGIN SELECT RAISE(ABORT,'federated binding requires agent'); END;
CREATE TRIGGER federated_binding_immutable_update BEFORE UPDATE ON federated_bindings
BEGIN SELECT RAISE(ABORT,'federated binding is immutable'); END;
CREATE TRIGGER federated_binding_immutable_delete BEFORE DELETE ON federated_bindings
BEGIN SELECT RAISE(ABORT,'federated binding is immutable'); END;
CREATE TABLE federated_credentials (
 id TEXT PRIMARY KEY NOT NULL,
 binding_id TEXT NOT NULL REFERENCES federated_bindings(id),
 principal_auth_version INTEGER NOT NULL CHECK(typeof(principal_auth_version)='integer' AND principal_auth_version>=1),
 revision INTEGER NOT NULL DEFAULT 1 CHECK(typeof(revision)='integer' AND revision>=1),
 created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at>=0),
 expires_at INTEGER NOT NULL CHECK(typeof(expires_at)='integer' AND expires_at>created_at),
 revoked_at INTEGER CHECK(revoked_at IS NULL OR (typeof(revoked_at)='integer' AND revoked_at>=created_at))
);
CREATE UNIQUE INDEX federated_one_active_credential ON federated_credentials(binding_id) WHERE revoked_at IS NULL;
CREATE TRIGGER federated_credential_no_replace BEFORE INSERT ON federated_credentials
WHEN EXISTS(SELECT 1 FROM federated_credentials WHERE id=NEW.id
 OR (binding_id=NEW.binding_id AND revoked_at IS NULL AND NEW.revoked_at IS NULL))
BEGIN SELECT RAISE(ABORT,'federated credential already exists'); END;
CREATE TRIGGER federated_credential_update BEFORE UPDATE ON federated_credentials
WHEN NEW.id<>OLD.id OR NEW.binding_id<>OLD.binding_id OR NEW.principal_auth_version<>OLD.principal_auth_version
 OR NEW.created_at<>OLD.created_at OR OLD.revoked_at IS NOT NULL OR NEW.revision<>OLD.revision+1
BEGIN SELECT RAISE(ABORT,'invalid federated credential update'); END;
CREATE TRIGGER federated_credential_delete BEFORE DELETE ON federated_credentials
BEGIN SELECT RAISE(ABORT,'federated credential is retained'); END;
CREATE TABLE federated_grants (
 credential_id TEXT NOT NULL REFERENCES federated_credentials(id),
 project_id TEXT NOT NULL,
 permission TEXT NOT NULL CHECK(permission IN ('view','edit','assign','transition','execute')),
 PRIMARY KEY(credential_id,project_id,permission)
);
CREATE TRIGGER federated_grant_no_replace BEFORE INSERT ON federated_grants
WHEN EXISTS(SELECT 1 FROM federated_grants WHERE credential_id=NEW.credential_id
 AND project_id=NEW.project_id AND permission=NEW.permission)
BEGIN SELECT RAISE(ABORT,'federated grant already exists'); END;
CREATE TRIGGER federated_grant_insert_guard BEFORE INSERT ON federated_grants
WHEN NOT EXISTS(SELECT 1 FROM federated_credentials WHERE id=NEW.credential_id AND revoked_at IS NULL)
BEGIN SELECT RAISE(ABORT,'federated credential inactive'); END;
CREATE TRIGGER federated_grant_delete_guard BEFORE DELETE ON federated_grants
WHEN NOT EXISTS(SELECT 1 FROM federated_credentials WHERE id=OLD.credential_id AND revoked_at IS NULL)
BEGIN SELECT RAISE(ABORT,'federated credential inactive'); END;
CREATE TRIGGER federated_grant_no_update BEFORE UPDATE ON federated_grants
BEGIN SELECT RAISE(ABORT,'replace federated grants transactionally'); END;
CREATE TRIGGER federated_grant_insert_revision AFTER INSERT ON federated_grants
BEGIN UPDATE federated_credentials SET revision=revision+1 WHERE id=NEW.credential_id; END;
CREATE TRIGGER federated_grant_delete_revision AFTER DELETE ON federated_grants
BEGIN UPDATE federated_credentials SET revision=revision+1 WHERE id=OLD.credential_id; END;
CREATE TABLE federated_credential_audit (
 id TEXT PRIMARY KEY NOT NULL,
 operation_id TEXT NOT NULL UNIQUE,
 actor_id TEXT NOT NULL REFERENCES principals(id),
 binding_id TEXT NOT NULL REFERENCES federated_bindings(id),
 credential_id TEXT NOT NULL REFERENCES federated_credentials(id),
 before_revision INTEGER CHECK(before_revision IS NULL OR (typeof(before_revision)='integer' AND before_revision>=1)),
 after_revision INTEGER NOT NULL CHECK(typeof(after_revision)='integer' AND after_revision>=1),
 change_json TEXT NOT NULL CHECK(json_valid(change_json)),
 recorded_at INTEGER NOT NULL CHECK(typeof(recorded_at)='integer' AND recorded_at>=0)
);
CREATE TRIGGER federated_audit_no_replace BEFORE INSERT ON federated_credential_audit
WHEN EXISTS(SELECT 1 FROM federated_credential_audit WHERE id=NEW.id OR operation_id=NEW.operation_id)
BEGIN SELECT RAISE(ABORT,'federated audit already exists'); END;
CREATE TRIGGER federated_audit_no_update BEFORE UPDATE ON federated_credential_audit
BEGIN SELECT RAISE(ABORT,'federated audit is immutable'); END;
CREATE TRIGGER federated_audit_no_delete BEFORE DELETE ON federated_credential_audit
BEGIN SELECT RAISE(ABORT,'federated audit is immutable'); END;
