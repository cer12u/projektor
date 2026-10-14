ALTER TABLE assets_frozen ADD COLUMN sweeping_until INTEGER;
CREATE TABLE assets_r2_tombstones(workspace_id TEXT NOT NULL, object_key TEXT NOT NULL, sweep_until INTEGER NOT NULL, PRIMARY KEY(workspace_id,object_key));
