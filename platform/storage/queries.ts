export const queries = {
  versions: "SELECT owner, version, checksum FROM platform_schema_versions ORDER BY owner, version",
  record: "INSERT INTO platform_schema_versions(owner, version, checksum) VALUES (?, ?, ?)",
} as const;
