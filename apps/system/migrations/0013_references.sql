-- Canonical additive migration. Existing databases must pass docs/database-migrations.md preflight.
ALTER TABLE issues ADD COLUMN references_json TEXT NOT NULL DEFAULT '[]'
 CHECK(json_valid(references_json) AND json_type(references_json)='array' AND length(CAST(references_json AS BLOB))<=4096);
ALTER TABLE content_documents ADD COLUMN references_json TEXT NOT NULL DEFAULT '[]'
 CHECK(json_valid(references_json) AND json_type(references_json)='array' AND length(CAST(references_json AS BLOB))<=4096 AND (kind='wiki' OR references_json='[]'));
ALTER TABLE content_documents ADD COLUMN before_references_json TEXT
 CHECK(before_references_json IS NULL OR (json_valid(before_references_json) AND json_type(before_references_json)='array'));
-- NULL on pre-feature histories means references were not recorded then, not a fabricated empty list.
ALTER TABLE content_history ADD COLUMN before_references_json TEXT
 CHECK(before_references_json IS NULL OR (json_valid(before_references_json) AND json_type(before_references_json)='array'));
ALTER TABLE content_history ADD COLUMN after_references_json TEXT
 CHECK(after_references_json IS NULL OR (json_valid(after_references_json) AND json_type(after_references_json)='array'));
