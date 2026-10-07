-- Read-only production preflight, after database-read approval. Both queries must
-- return zero rows. Do not run a cleanup UPDATE/DELETE from these findings.
SELECT workspace_id, upper(key) AS normalized_key, count(*) AS count,
       group_concat(id) AS project_ids
FROM projects
GROUP BY workspace_id, key COLLATE NOCASE
HAVING count(*) > 1
ORDER BY workspace_id, normalized_key;

-- Noncanonical legacy keys require review, even if no duplicate currently exists.
SELECT id, workspace_id, key, archived_at
FROM projects
WHERE key != upper(key) OR length(key) NOT BETWEEN 1 AND 10
   OR key NOT GLOB '[A-Z]*' OR key GLOB '*[^A-Z0-9]*'
ORDER BY workspace_id, id;
