-- Trusted deployment management only. No product HTTP route calls these operations.
CREATE TABLE deployment_operations(
 operator_id TEXT NOT NULL,operation_id TEXT NOT NULL,
 operation_kind TEXT NOT NULL CHECK(operation_kind IN ('principal.create','credential.create','bootstrap.issue')),
 target_id TEXT NOT NULL,input_hash TEXT NOT NULL,
 snapshot TEXT NOT NULL CHECK(json_valid(snapshot) AND length(CAST(snapshot AS BLOB))<=65536),
 recorded_at INTEGER NOT NULL,
 PRIMARY KEY(operator_id,operation_id)
);
CREATE TRIGGER deployment_operations_no_update BEFORE UPDATE ON deployment_operations
BEGIN SELECT RAISE(ABORT,'deployment operation immutable'); END;
CREATE TRIGGER deployment_operations_no_delete BEFORE DELETE ON deployment_operations
BEGIN SELECT RAISE(ABORT,'deployment operation immutable'); END;
