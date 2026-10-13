-- @module identity
-- @role schema
-- Recipient establishes this capability before an administrator binds a setup grant.
-- request_id is a non-secret correlation handle; it never authorizes status/completion.
CREATE TABLE recipient_setup_contexts (
 context_hash TEXT PRIMARY KEY CHECK(length(context_hash)=64),
 request_id TEXT NOT NULL UNIQUE CHECK(length(request_id)=43),
 replaces_context_hash TEXT UNIQUE CHECK(replaces_context_hash IS NULL OR length(replaces_context_hash)=64),
 csrf_hash TEXT NOT NULL CHECK(length(csrf_hash)=64),
 created_at INTEGER NOT NULL,
 expires_at INTEGER NOT NULL CHECK(expires_at>created_at),
 revoked_at INTEGER,
 issuer_id TEXT REFERENCES principals(id),
 issuer_display_name TEXT,
 operation_id TEXT,
 principal_id TEXT REFERENCES principals(id),
 right_id TEXT UNIQUE REFERENCES password_setup_rights(id),
 purpose TEXT CHECK(purpose IN ('initial','reset')),
 target_auth_version INTEGER,
 CHECK((issuer_id IS NULL AND issuer_display_name IS NULL AND operation_id IS NULL AND principal_id IS NULL AND right_id IS NULL AND purpose IS NULL AND target_auth_version IS NULL)
  OR (issuer_id IS NOT NULL AND issuer_display_name IS NOT NULL AND operation_id IS NOT NULL AND principal_id IS NOT NULL AND right_id IS NOT NULL AND purpose IS NOT NULL AND target_auth_version IS NOT NULL))
);
CREATE UNIQUE INDEX recipient_setup_operation ON recipient_setup_contexts(issuer_id,operation_id) WHERE issuer_id IS NOT NULL;
CREATE TRIGGER recipient_setup_binding_immutable BEFORE UPDATE ON recipient_setup_contexts
 WHEN NEW.context_hash IS NOT OLD.context_hash OR NEW.request_id IS NOT OLD.request_id OR NEW.replaces_context_hash IS NOT OLD.replaces_context_hash
 OR (OLD.right_id IS NOT NULL AND (NEW.issuer_id IS NOT OLD.issuer_id OR NEW.issuer_display_name IS NOT OLD.issuer_display_name OR NEW.operation_id IS NOT OLD.operation_id OR NEW.principal_id IS NOT OLD.principal_id OR NEW.right_id IS NOT OLD.right_id OR NEW.purpose IS NOT OLD.purpose OR NEW.target_auth_version IS NOT OLD.target_auth_version OR NEW.expires_at IS NOT OLD.expires_at))
 BEGIN SELECT RAISE(ABORT,'recipient setup binding is immutable'); END;
CREATE TRIGGER recipient_setup_no_extend BEFORE UPDATE ON recipient_setup_contexts
 WHEN NEW.expires_at>OLD.expires_at OR NEW.created_at IS NOT OLD.created_at OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NOT OLD.revoked_at)
 BEGIN SELECT RAISE(ABORT,'recipient setup context lifetime is fixed'); END;
