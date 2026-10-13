CREATE TABLE IF NOT EXISTS platform_schema_versions (
  owner TEXT NOT NULL,
  version TEXT NOT NULL,
  checksum TEXT NOT NULL,
  PRIMARY KEY (owner, version)
);
