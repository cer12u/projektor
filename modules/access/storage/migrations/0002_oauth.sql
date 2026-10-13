-- Registration precedes login/workspace selection. Client metadata grants no authority.
CREATE TABLE access_oauth_clients (
 id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, redirect_uris TEXT NOT NULL,
 scope TEXT NOT NULL, refresh_allowed INTEGER NOT NULL CHECK(refresh_allowed IN (0,1)),
 created_at INTEGER NOT NULL
);
CREATE TABLE access_oauth_workspace_clients (
 workspace_id TEXT NOT NULL, client_id TEXT NOT NULL,
 version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
 revoked INTEGER NOT NULL DEFAULT 0 CHECK(revoked IN (0,1)),
 PRIMARY KEY(workspace_id,client_id),
 FOREIGN KEY(workspace_id) REFERENCES access_workspaces(workspace_id),
 FOREIGN KEY(client_id) REFERENCES access_oauth_clients(id)
);
CREATE TABLE access_oauth_codes (
 workspace_id TEXT NOT NULL, code_hash TEXT NOT NULL, client_id TEXT NOT NULL,
 principal_id TEXT NOT NULL, membership_version INTEGER NOT NULL,
 redirect_uri TEXT NOT NULL, challenge TEXT NOT NULL, resource TEXT NOT NULL,
 scope TEXT NOT NULL, expires_at INTEGER NOT NULL,
 used INTEGER NOT NULL DEFAULT 0 CHECK(used IN (0,1)),
 PRIMARY KEY(workspace_id,code_hash),
 FOREIGN KEY(workspace_id,client_id) REFERENCES access_oauth_workspace_clients(workspace_id,client_id),
 FOREIGN KEY(workspace_id,principal_id) REFERENCES access_memberships(workspace_id,principal_id)
);
CREATE TABLE access_oauth_families (
 workspace_id TEXT NOT NULL, id TEXT NOT NULL, client_id TEXT NOT NULL,
 principal_id TEXT NOT NULL, membership_version INTEGER NOT NULL,
 resource TEXT NOT NULL, scope TEXT NOT NULL, expires_at INTEGER NOT NULL,
 version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
 revoked INTEGER NOT NULL DEFAULT 0 CHECK(revoked IN (0,1)),
 PRIMARY KEY(workspace_id,id),
 FOREIGN KEY(workspace_id,client_id) REFERENCES access_oauth_workspace_clients(workspace_id,client_id),
 FOREIGN KEY(workspace_id,principal_id) REFERENCES access_memberships(workspace_id,principal_id)
);
CREATE TABLE access_oauth_tokens (
 workspace_id TEXT NOT NULL, token_hash TEXT NOT NULL, family_id TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('access','refresh')), scope TEXT NOT NULL,
 expires_at INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0 CHECK(used IN (0,1)),
 PRIMARY KEY(workspace_id,token_hash),
 FOREIGN KEY(workspace_id,family_id) REFERENCES access_oauth_families(workspace_id,id)
);
