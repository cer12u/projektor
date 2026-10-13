ALTER TABLE sessions ADD COLUMN scope_ceiling_json TEXT CHECK(scope_ceiling_json IS NULL OR json_valid(scope_ceiling_json));
CREATE TABLE browser_exchange_nonces (
 nonce_hash TEXT PRIMARY KEY NOT NULL,cookie_hash TEXT NOT NULL UNIQUE,csrf_hash TEXT NOT NULL,
 expires_at INTEGER NOT NULL,consumed_at INTEGER
);
CREATE TABLE browser_exchange_tickets (
 id TEXT PRIMARY KEY NOT NULL,token_hash TEXT NOT NULL UNIQUE,
 nonce_hash TEXT NOT NULL REFERENCES browser_exchange_nonces(nonce_hash),
 principal_id TEXT NOT NULL REFERENCES principals(id),credential_id TEXT NOT NULL REFERENCES api_credentials(id),
 auth_version INTEGER NOT NULL,scope_json TEXT NOT NULL CHECK(json_valid(scope_json)),
 issued_at INTEGER NOT NULL,expires_at INTEGER NOT NULL CHECK(expires_at>issued_at AND expires_at<=issued_at+60),consumed_at INTEGER
);
CREATE TABLE browser_exchange_audit (
 ticket_id TEXT PRIMARY KEY NOT NULL REFERENCES browser_exchange_tickets(id),
 principal_id TEXT NOT NULL REFERENCES principals(id),credential_id TEXT NOT NULL REFERENCES api_credentials(id),recorded_at INTEGER NOT NULL
);
CREATE TRIGGER browser_exchange_audit_no_update BEFORE UPDATE ON browser_exchange_audit
BEGIN SELECT RAISE(ABORT,'exchange audit is immutable'); END;
CREATE TRIGGER browser_exchange_audit_no_delete BEFORE DELETE ON browser_exchange_audit
BEGIN SELECT RAISE(ABORT,'exchange audit is immutable'); END;
