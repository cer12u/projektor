// @module identity
// @role private-credentials
import { type AuthDB,type Authenticated,type LegacyAuthenticated,type PasswordRow } from './auth-types';
import { IDLE_SECONDS } from "../../../modules/identity/session-policy";
import type {PasswordLoginCommit} from '../../../modules/identity/ports';
export function passwordRow(db: AuthDB, login: string) {
  return db.prepare(`SELECT p.id,p.kind,p.display_name,p.auth_version,p.active,w.encoded_hash
    FROM principals p JOIN passwords w ON w.principal_id=p.id WHERE p.login_id=? AND p.kind='human'`).bind(login).first<PasswordRow>();
}
export async function createSession(db: AuthDB, command:PasswordLoginCommit): Promise<void> {
  const {principal,sessionHash,sessionCsrf:csrf,challengeHash,csrfHash:challengeCsrfHash,absoluteSeconds}=command;
  const guard = crypto.randomUUID();
  await db.batch([
    db.prepare(`INSERT INTO auth_guards(id,valid) VALUES(?,CASE WHEN
      EXISTS(SELECT 1 FROM principals p JOIN passwords w ON w.principal_id=p.id
        WHERE p.id=? AND p.kind='human' AND p.active=1 AND p.auth_version=? AND w.encoded_hash=?)
      AND EXISTS(SELECT 1 FROM login_challenges WHERE token_hash=? AND csrf_hash=? AND expires_at>unixepoch() AND consumed_at IS NULL)
      THEN 1 ELSE 0 END)`).bind(guard,principal.id,principal.auth_version,principal.encoded_hash,challengeHash,challengeCsrfHash),
    db.prepare(`INSERT INTO sessions(token_hash,principal_id,auth_version,csrf_token,created_at,last_seen_at,absolute_expires_at)
      VALUES(?,?,?,?,unixepoch(),unixepoch(),unixepoch()+?)`).bind(sessionHash,principal.id,principal.auth_version,csrf,absoluteSeconds),
    db.prepare(`UPDATE login_challenges SET consumed_at=unixepoch() WHERE token_hash=? AND csrf_hash=?
      AND consumed_at IS NULL AND expires_at>unixepoch()`).bind(challengeHash,challengeCsrfHash),
    // Recheck at consumption, after the session insert; late expiry rolls it back.
    db.prepare('UPDATE auth_guards SET valid=CASE WHEN changes()=1 THEN 1 ELSE 0 END WHERE id=?').bind(guard),
    db.prepare('DELETE FROM auth_guards WHERE id=?').bind(guard)
  ]);
}
export async function session(db: AuthDB, hash: string, now: number): Promise<Authenticated | null> {
  const valid = `s.revoked_at IS NULL AND s.absolute_expires_at>max(?,unixepoch()) AND s.last_seen_at>max(?,unixepoch())-?
    AND p.active=1 AND p.auth_version=s.auth_version
    AND (s.api_credential_id IS NULL OR (c.revoked_at IS NULL AND c.expires_at>max(?,unixepoch()) AND c.principal_id=p.id))`;
  // The SQL-time check and final read are in one transaction. Same-second reads
  // change zero rows; later reads preserve exact idle expiry and monotonic time.
  const results=await db.batch<Omit<LegacyAuthenticated,'authentication'|'token_hash'>>([
    db.prepare(`UPDATE sessions SET last_seen_at=max(?,unixepoch()) WHERE token_hash=? AND revoked_at IS NULL
      AND absolute_expires_at>max(?,unixepoch()) AND last_seen_at>max(?,unixepoch())-? AND last_seen_at<max(?,unixepoch())
      AND EXISTS(SELECT 1 FROM principals WHERE id=sessions.principal_id AND active=1 AND auth_version=sessions.auth_version)
      AND (api_credential_id IS NULL OR EXISTS(SELECT 1 FROM api_credentials WHERE id=sessions.api_credential_id AND revoked_at IS NULL AND expires_at>max(?,unixepoch()) AND principal_id=sessions.principal_id))`)
      .bind(now,hash,now,now,IDLE_SECONDS,now,now),
    db.prepare(`SELECT p.id,p.kind,p.display_name,p.auth_version,s.csrf_token,s.api_credential_id AS credential_id
      FROM sessions s JOIN principals p ON p.id=s.principal_id
      LEFT JOIN api_credentials c ON c.id=s.api_credential_id WHERE s.token_hash=? AND ${valid}`)
      .bind(hash,now,now,IDLE_SECONDS,now)
  ]);
  const row=results[1].results[0];
  return row ? {...row,authentication:'session',token_hash:hash} : null;
}
export async function apiCredential(db: AuthDB, hash: string, now: number): Promise<Authenticated | null> {
  const row = await db.prepare(`SELECT p.id,p.kind,p.display_name,p.auth_version,c.id AS credential_id
    FROM api_credentials c JOIN principals p ON p.id=c.principal_id
    WHERE c.token_hash=? AND c.revoked_at IS NULL AND c.expires_at>max(?,unixepoch()) AND p.active=1 AND p.kind='agent'`)
    .bind(hash,now).first<Omit<LegacyAuthenticated,'authentication'|'token_hash'|'csrf_token'>>();
  return row ? {...row,authentication:'api',token_hash:hash,csrf_token:null} : null;
}

/** Revoke the exact already-authenticated legacy browser session. */
export async function revokeSession(db:AuthDB,tokenHash:string,now:number):Promise<void>{
 await db.prepare('UPDATE sessions SET revoked_at=? WHERE token_hash=? AND revoked_at IS NULL').bind(now,tokenHash).run();
}
