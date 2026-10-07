#!/usr/bin/env node
// Read-only PTORDEV-6 preflight. Run only on an approved SQLite/D1 export.
// No network, mutation, automatic deduplication, or renamed keys.
import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function inspectProjectKeys(db) {
  const duplicates = db.prepare(`
    SELECT workspace_id, upper(key) AS normalized_key, count(*) AS count,
           group_concat(id) AS project_ids
    FROM projects
    GROUP BY workspace_id, key COLLATE NOCASE HAVING count(*) > 1
    ORDER BY workspace_id, normalized_key
  `).all();
  const noncanonical = db.prepare(`
    SELECT id, workspace_id, key, archived_at FROM projects
    WHERE key != upper(key) OR length(key) NOT BETWEEN 1 AND 10
       OR key NOT GLOB '[A-Z]*' OR key GLOB '*[^A-Z0-9]*'
    ORDER BY workspace_id, id
  `).all();
  const indexes = db.prepare('PRAGMA index_list(projects)').all();
  return {
    ready: duplicates.length === 0 && noncanonical.length === 0,
    duplicates,
    noncanonical,
    indexes,
    policy: 'Keys are ASCII case-insensitive per workspace; archived rows reserve keys; physical deletion frees them. Any findings require explicit review, never automatic repair.',
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 3) {
    console.error('Usage: node scripts/project-key-preflight.mjs /path/to/approved-export.sqlite');
    process.exitCode = 2;
  } else {
    let db;
    try {
      db = new DatabaseSync(resolve(process.argv[2]), { readOnly: true });
      db.exec('PRAGMA query_only = ON');
      const report = inspectProjectKeys(db);
      console.log(JSON.stringify(report, null, 2));
      process.exitCode = report.ready ? 0 : 1;
    } catch (error) {
      console.error(`Preflight failed closed: ${error.message}`);
      process.exitCode = 2;
    } finally {
      db?.close();
    }
  }
}
