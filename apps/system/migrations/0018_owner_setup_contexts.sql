-- @module identity
-- @role schema
-- Identity: pre-established browser capability; no recoverable bearer grant secret.
CREATE TABLE owner_setup_contexts (
 context_hash TEXT PRIMARY KEY CHECK(length(context_hash)=64),
 csrf_hash TEXT NOT NULL CHECK(length(csrf_hash)=64),
 created_at INTEGER NOT NULL,
 expires_at INTEGER NOT NULL CHECK(expires_at>created_at),
 revoked_at INTEGER,
 owner_id TEXT REFERENCES principals(id),
 operation_id TEXT,
 right_id TEXT UNIQUE REFERENCES password_setup_rights(id),
 issuer TEXT,
 audience TEXT,
 subject TEXT,
 CHECK((owner_id IS NULL AND operation_id IS NULL AND right_id IS NULL AND issuer IS NULL AND audience IS NULL AND subject IS NULL)
  OR (owner_id IS NOT NULL AND operation_id IS NOT NULL AND right_id IS NOT NULL AND issuer IS NOT NULL AND audience IS NOT NULL AND subject IS NOT NULL))
);
CREATE UNIQUE INDEX owner_setup_operation ON owner_setup_contexts(owner_id,operation_id) WHERE owner_id IS NOT NULL;
CREATE TRIGGER owner_setup_context_binding_immutable BEFORE UPDATE ON owner_setup_contexts
 WHEN OLD.right_id IS NOT NULL AND (NEW.context_hash IS NOT OLD.context_hash OR NEW.owner_id IS NOT OLD.owner_id OR NEW.operation_id IS NOT OLD.operation_id OR NEW.right_id IS NOT OLD.right_id OR NEW.issuer IS NOT OLD.issuer OR NEW.audience IS NOT OLD.audience OR NEW.subject IS NOT OLD.subject OR NEW.expires_at IS NOT OLD.expires_at OR NEW.created_at IS NOT OLD.created_at)
 BEGIN SELECT RAISE(ABORT,'owner setup binding is immutable'); END;
CREATE TRIGGER owner_setup_context_no_extend BEFORE UPDATE ON owner_setup_contexts
 WHEN NEW.expires_at>OLD.expires_at OR NEW.created_at IS NOT OLD.created_at
 BEGIN SELECT RAISE(ABORT,'owner setup context lifetime is fixed'); END;
