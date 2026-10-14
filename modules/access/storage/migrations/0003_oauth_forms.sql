CREATE TABLE access_oauth_forms (
  workspace_id TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, token_hash)
);
