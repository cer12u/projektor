// Node SQLite entrypoint; business/receipt/ACL logic is shared with workerd.
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
export * from './shared-core.mjs';
export function openStore(path){const db=new DatabaseSync(path);db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=15000; PRAGMA synchronous=FULL;');return db;}
export function migrate(db){db.exec('PRAGMA journal_mode=WAL;');db.exec(readFileSync(new URL('./schema.sql',import.meta.url),'utf8'));db.prepare('INSERT INTO query_state VALUES(1,0,?)').run(randomBytes(32).toString('hex'));db.exec('PRAGMA user_version=3;');}
