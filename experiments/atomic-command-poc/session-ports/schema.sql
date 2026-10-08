-- Proposal for shared schema owner. Apply once with its schema version change.
-- Key material is server-only sensitive storage, never included in normal exports/logs.
CREATE TABLE draft_key(key_id TEXT PRIMARY KEY,binding_json TEXT NOT NULL UNIQUE,key_material TEXT NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,revoked INTEGER NOT NULL DEFAULT 0 CHECK(revoked IN (0,1)));
-- Conservative session authorization generation. Existing query_state already
-- tracks membership/credential/project/resource ACL changes; complete scope ACLs.
CREATE TRIGGER session_principal_scope_insert AFTER INSERT ON principal_scope BEGIN UPDATE query_state SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER session_principal_scope_delete AFTER DELETE ON principal_scope BEGIN UPDATE query_state SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER session_principal_scope_update AFTER UPDATE ON principal_scope BEGIN UPDATE query_state SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER session_credential_scope_insert AFTER INSERT ON credential_scope BEGIN UPDATE query_state SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER session_credential_scope_delete AFTER DELETE ON credential_scope BEGIN UPDATE query_state SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER session_credential_scope_update AFTER UPDATE ON credential_scope BEGIN UPDATE query_state SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER session_shared_grant_insert AFTER INSERT ON shared_grant BEGIN UPDATE query_state SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER session_shared_grant_delete AFTER DELETE ON shared_grant BEGIN UPDATE query_state SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER session_shared_grant_update AFTER UPDATE ON shared_grant BEGIN UPDATE query_state SET revision=revision+1 WHERE id=1; END;
