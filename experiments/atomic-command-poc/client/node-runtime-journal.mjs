import {DatabaseSync} from 'node:sqlite';
import {openSync, closeSync} from 'node:fs';
const fail = code => Object.assign(new Error(code), {code});
const identity = r => JSON.stringify([r.envelope, r.principalId, r.runtimeInstanceId, r.machineBinding]);

/** Private local durable state. A host must provide a private directory; no tokens are stored. */
export class NodeRuntimeJournal {
  constructor(path, {maxRecords = 128, maxRecordBytes = 3 * 1024 * 1024} = {}) {
    // Creation modes apply to a new file only; we do not change existing permissions.
    closeSync(openSync(path, 'a', 0o600));
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS runtime_operation (id TEXT PRIMARY KEY, record TEXT NOT NULL, created_at INTEGER NOT NULL, checks INTEGER NOT NULL DEFAULT 0, deadline INTEGER, next_allowed_at INTEGER NOT NULL DEFAULT 0)');
    this.maxRecords = Math.min(128, maxRecords); this.maxRecordBytes = Math.min(3 * 1024 * 1024, maxRecordBytes);
  }
  async load(id) { const row = this.db.prepare('SELECT record FROM runtime_operation WHERE id=?').get(id); return row ? JSON.parse(row.record) : null; }
  async listUnresolved() { return this.db.prepare('SELECT record FROM runtime_operation').all().map(row => JSON.parse(row.record)).filter(r => !['committed', 'rejected'].includes(r.state)); }
  async save(record) {
    // Whitelist prevents token/session/provider objects from entering the journal.
    const safe = Object.fromEntries(['envelope','principalId','runtimeInstanceId','resends','state','result','machineBinding'].filter(k => Object.hasOwn(record,k)).map(k => [k,record[k]]));
    const bytes = JSON.stringify(safe), id = safe.envelope?.operationId;
    if (!id || Buffer.byteLength(bytes) > this.maxRecordBytes) throw fail('JOURNAL_RECORD_LIMIT');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare('SELECT record FROM runtime_operation WHERE id=?').get(id);
      if (row && identity(JSON.parse(row.record)) !== identity(safe)) throw fail('JOURNAL_BINDING_CHANGED');
      if (!row && this.db.prepare('SELECT count(*) AS n FROM runtime_operation').get().n >= this.maxRecords) throw fail('JOURNAL_CAPACITY');
      this.db.prepare('INSERT INTO runtime_operation(id,record,created_at) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record').run(id,bytes,Date.now());
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  async takeRecoveryAttempt(id, {now, deadlineMs, maxChecks}) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare('SELECT checks,deadline,next_allowed_at FROM runtime_operation WHERE id=?').get(id);
      if (!row) throw fail('JOURNAL_MISSING');
      const deadline = row.deadline ?? now + deadlineMs;
      let result;
      if (now >= deadline || row.next_allowed_at >= deadline) result = {allowed:false,code:'RECOVERY_DEADLINE_EXHAUSTED'};
      else if (row.checks >= maxChecks) result = {allowed:false,code:'RECOVERY_CHECKS_EXHAUSTED'};
      else {
        this.db.prepare('UPDATE runtime_operation SET checks=checks+1,deadline=? WHERE id=?').run(deadline,id);
        result = {allowed:true,checks:row.checks+1,nextAllowedAt:row.next_allowed_at,deadline};
      }
      this.db.exec('COMMIT'); return result;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  async deferRecovery(id, nextAllowedAt) { this.db.prepare('UPDATE runtime_operation SET next_allowed_at=max(next_allowed_at,?) WHERE id=?').run(nextAllowedAt,id); }
  close() { this.db.close(); }
}
