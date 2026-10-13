// @module identity
// @role private-challenges
import type { AuthDB } from './auth-types';
import type {LoginContextCommit,LoginAttemptCommit} from '../../../modules/identity/ports';
// Authentication ingress uses bounded state, not the business write gate. These are
// deployment-wide caps; no isolate-local identity cache or external limiter is needed.
export const AUTH_STATE_LIMITS = {challenges:1024,limitKeys:4096,pendingNonces:1024,cleanup:32} as const;
function cleanLimits(db: AuthDB,windowSeconds:number): D1PreparedStatement {
  return db.prepare(`DELETE FROM login_limits WHERE key_hash IN
    (SELECT key_hash FROM login_limits WHERE window_start<=unixepoch()-? ORDER BY window_start LIMIT ?)`)
    .bind(windowSeconds,AUTH_STATE_LIMITS.cleanup);
}
/** A saturated key is a no-op. A missing key is inserted only while capacity remains. */
function attempt(db: AuthDB, key: string, maximum: number, windowSeconds:number,afterAdmission=false): D1PreparedStatement {
  return db.prepare(`INSERT INTO login_limits(key_hash,window_start,attempts)
    SELECT ?,unixepoch(),1 WHERE ${afterAdmission?'changes()=1 AND ':''}
      (EXISTS(SELECT 1 FROM login_limits WHERE key_hash=?) OR
       (SELECT count(*) FROM (SELECT 1 FROM login_limits LIMIT ?))<?)
    ON CONFLICT(key_hash) DO UPDATE SET
      window_start=CASE WHEN window_start<=unixepoch()-? THEN unixepoch() ELSE window_start END,
      attempts=CASE WHEN window_start<=unixepoch()-? THEN 1 ELSE attempts+1 END
    WHERE window_start<=unixepoch()-? OR attempts<?`)
    .bind(key,key,AUTH_STATE_LIMITS.limitKeys,AUTH_STATE_LIMITS.limitKeys,windowSeconds,windowSeconds,windowSeconds,maximum);
}
export async function reserveLoginContext(db: AuthDB,c:LoginContextCommit): Promise<boolean> {
  const results=await db.batch([
    db.prepare(`DELETE FROM login_challenges WHERE token_hash IN
      (SELECT token_hash FROM login_challenges WHERE expires_at<=unixepoch() ORDER BY expires_at LIMIT ?)`)
      .bind(AUTH_STATE_LIMITS.cleanup),
    cleanLimits(db,c.windowSeconds), attempt(db,c.sourceHash,c.maximum,c.windowSeconds),
    db.prepare(`INSERT INTO login_challenges(token_hash,csrf_hash,expires_at)
      SELECT ?,?,unixepoch()+? WHERE changes()=1
      AND (SELECT count(*) FROM (SELECT 1 FROM login_challenges LIMIT ?))<?`)
      .bind(c.tokenHash,c.csrfHash,c.lifetimeSeconds,AUTH_STATE_LIMITS.challenges,AUTH_STATE_LIMITS.challenges)
  ]);
  return results[3].meta.changes===1;
}
export async function challengeValid(db: AuthDB, hash: string, csrfHash: string, now: number): Promise<boolean> {
  return !!await db.prepare(`SELECT 1 FROM login_challenges WHERE token_hash=? AND csrf_hash=? AND expires_at>max(?,unixepoch()) AND consumed_at IS NULL`).bind(hash,csrfHash,now).first();
}
export async function countAttempts(db: AuthDB,c:LoginAttemptCommit): Promise<boolean> {
  // Source must be admitted first. changes() ties account admission to that exact
  // write inside the same transaction, including parallel requests and full tables.
  const results=await db.batch([cleanLimits(db,c.windowSeconds),attempt(db,c.sourceHash,c.sourceMaximum,c.windowSeconds),attempt(db,c.accountHash,c.accountMaximum,c.windowSeconds,true)]);
  return results[1].meta.changes===1 && results[2].meta.changes===1;
}
