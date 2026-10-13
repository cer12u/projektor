CREATE TABLE fixture_b_items (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  value TEXT NOT NULL,
  PRIMARY KEY (workspace_id, id)
);
CREATE TABLE fixture_b_guards (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  changed INTEGER NOT NULL CHECK (changed = 1),
  PRIMARY KEY (workspace_id, id)
);
CREATE TABLE fixture_b_receipts (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  result TEXT NOT NULL,
  PRIMARY KEY (workspace_id, id)
);
