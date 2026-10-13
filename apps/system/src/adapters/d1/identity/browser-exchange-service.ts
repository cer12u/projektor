// @module identity
// @role private-browser-exchange
import { AUTH_STATE_LIMITS,type AuthDB } from './db';
import type {BrowserIssuer,BrowserScopeSource} from '../../../modules/identity/rules';
import type {BrowserContextCommit,BrowserTicketCommit,BrowserSessionCommit} from '../../../modules/identity/ports';
import { ApiError } from "../../protocol-errors";
import { guardedBatch,type BoundSql,type CountedWrite } from "../persistence/guarded-batch";
import {currentCredentialSql} from "./authorization";
const write=(text:string,values:readonly (string|number|null)[]):CountedWrite=>({statement:{text,values},expectedChanges:1});
/** Authorized raw authority sets; the application selects the derived scope. */
export async function readBrowserScope(db:AuthDB,auth:BrowserIssuer):Promise<BrowserScopeSource>{
 const valid=currentCredentialSql(auth);
 const row=await db.prepare(`SELECT
  (SELECT json_group_array(json_object('projectId',project_id,'permission',permission)) FROM memberships WHERE principal_id=?) memberships,
  (SELECT json_group_array(json_object('projectId',project_id,'permission',permission)) FROM api_grants WHERE credential_id=?) grants
  WHERE (${valid.text})`).bind(auth.id,auth.credential_id,...valid.values).first<{memberships:string;grants:string}>();
 if(!row)throw new ApiError(403,'exchange_rejected');
 return{memberships:JSON.parse(row.memberships) as BrowserScopeSource['memberships'],grants:JSON.parse(row.grants) as BrowserScopeSource['grants']};
}
export async function commitBrowserTicket(db:AuthDB,auth:BrowserIssuer,c:BrowserTicketCommit):Promise<{expiresAt:number;principalId:string}>{
 const valid=currentCredentialSql(auth),scope=JSON.stringify(c.scope);
 // Revalidate exactly the authority intersection selected by the application.
 // A concurrent grant change cannot widen or silently replace that ceiling.
 const guard={text:`(${valid.text}) AND EXISTS(SELECT 1 FROM browser_exchange_nonces WHERE nonce_hash=? AND consumed_at IS NULL AND expires_at>unixepoch())
  AND (SELECT json_group_array(json_object('projectId',project_id,'permission',permission)) FROM
   (SELECT m.project_id,m.permission FROM memberships m JOIN api_grants g ON g.project_id=m.project_id AND g.permission=m.permission
    WHERE m.principal_id=? AND g.credential_id=? ORDER BY m.project_id,m.permission))=?`,values:[...valid.values,c.nonceHash,auth.id,auth.credential_id,scope]};
 const writes=[write(`INSERT INTO browser_exchange_tickets(id,token_hash,nonce_hash,principal_id,credential_id,auth_version,scope_json,issued_at,expires_at)
  SELECT ?,?,n.nonce_hash,?,a.id,?,?,unixepoch(),min(unixepoch()+?,n.expires_at,a.expires_at)
  FROM browser_exchange_nonces n JOIN api_credentials a ON a.id=? WHERE n.nonce_hash=?`,
  [c.ticketId,c.ticketHash,auth.id,auth.auth_version,scope,c.lifetimeSeconds,auth.credential_id,c.nonceHash])];
 try{await db.batch(guardedBatch(db,guard,writes));}catch{
  const state=await db.prepare(`SELECT (${guard.text}) AS valid`).bind(...guard.values).first<{valid:number}>();
  throw new ApiError(state?.valid?503:403,state?.valid?'exchange_unavailable':'exchange_rejected');
 }
 const row=await db.prepare(`SELECT expires_at AS expiresAt,principal_id AS principalId FROM browser_exchange_tickets WHERE id=? AND (${valid.text})`).bind(c.ticketId,...valid.values).first<{expiresAt:number;principalId:string}>();
 if(!row)throw new ApiError(403,'exchange_rejected');return row;
}
function redemptionGuard(c:BrowserSessionCommit):BoundSql {
 return {text:`EXISTS(SELECT 1 FROM browser_exchange_tickets t JOIN browser_exchange_nonces n ON n.nonce_hash=t.nonce_hash
  JOIN api_credentials a ON a.id=t.credential_id JOIN principals p ON p.id=t.principal_id
  WHERE t.token_hash=? AND n.nonce_hash=? AND n.cookie_hash=? AND n.csrf_hash=?
   AND t.consumed_at IS NULL AND n.consumed_at IS NULL AND t.expires_at>unixepoch() AND n.expires_at>unixepoch()
   AND a.principal_id=p.id AND a.revoked_at IS NULL AND a.expires_at>unixepoch()
   AND p.kind='agent' AND p.active=1 AND p.auth_version=t.auth_version)`,values:[c.ticketHash,c.nonceHash,c.browserHash,c.csrfHash]};
}
export async function redeemBrowserOnce(db:AuthDB,c:BrowserSessionCommit):Promise<void> {
 const guard=redemptionGuard(c),writes=[
  write(`INSERT INTO sessions(token_hash,principal_id,auth_version,api_credential_id,csrf_token,created_at,last_seen_at,absolute_expires_at,scope_ceiling_json)
   SELECT ?,t.principal_id,t.auth_version,t.credential_id,?,unixepoch(),unixepoch(),min(unixepoch()+?,a.expires_at),t.scope_json
   FROM browser_exchange_tickets t JOIN api_credentials a ON a.id=t.credential_id WHERE t.token_hash=?`,[c.sessionHash,c.sessionCsrf,c.absoluteSeconds,c.ticketHash]),
  write('UPDATE browser_exchange_nonces SET consumed_at=unixepoch() WHERE nonce_hash=? AND consumed_at IS NULL',[c.nonceHash]),
  write('UPDATE browser_exchange_tickets SET consumed_at=unixepoch() WHERE token_hash=? AND consumed_at IS NULL',[c.ticketHash]),
  write('INSERT INTO browser_exchange_audit(ticket_id,principal_id,credential_id,recorded_at) SELECT id,principal_id,credential_id,unixepoch() FROM browser_exchange_tickets WHERE token_hash=?',[c.ticketHash]),
 ];
 try{await db.batch(guardedBatch(db,guard,writes));}catch{
  const valid=await db.prepare(`SELECT (${guard.text}) AS valid`).bind(...guard.values).first<{valid:number}>();
  throw new ApiError(valid?.valid?503:403,valid?.valid?'exchange_unavailable':'exchange_rejected');
 }
}
/** Retain redeemed audit chains; only expired, unredeemed state is reclaimable. */
export async function reserveBrowserContext(db:AuthDB,c:BrowserContextCommit):Promise<{expiresAt:number}> {
 // Cleanup is independently committed, even when capacity remains full.
 await db.batch([
  db.prepare(`DELETE FROM browser_exchange_tickets WHERE id IN
   (SELECT t.id FROM browser_exchange_tickets t WHERE t.consumed_at IS NULL AND t.expires_at<=unixepoch()
    AND NOT EXISTS(SELECT 1 FROM browser_exchange_audit a WHERE a.ticket_id=t.id)
    ORDER BY t.expires_at LIMIT ?)`).bind(AUTH_STATE_LIMITS.cleanup),
  db.prepare(`DELETE FROM browser_exchange_nonces WHERE nonce_hash IN
   (SELECT n.nonce_hash FROM browser_exchange_nonces n WHERE n.consumed_at IS NULL AND n.expires_at<=unixepoch()
    AND NOT EXISTS(SELECT 1 FROM browser_exchange_tickets t WHERE t.nonce_hash=n.nonce_hash)
    ORDER BY n.expires_at LIMIT ?)`).bind(AUTH_STATE_LIMITS.cleanup)
 ]);
 const challenge={text:'EXISTS(SELECT 1 FROM login_challenges WHERE token_hash=? AND csrf_hash=? AND expires_at>unixepoch() AND consumed_at IS NULL)',values:[c.challengeHash,c.csrfHash]};
 const capacity=`(SELECT count(*) FROM (SELECT 1 FROM browser_exchange_nonces WHERE consumed_at IS NULL LIMIT ${AUTH_STATE_LIMITS.pendingNonces}))<${AUTH_STATE_LIMITS.pendingNonces}`;
 try {
  await db.batch(guardedBatch(db,{text:`(${challenge.text}) AND ${capacity}`,values:challenge.values},[
   write('INSERT INTO browser_exchange_nonces(nonce_hash,cookie_hash,csrf_hash,expires_at) VALUES(?,?,?,unixepoch()+?)',[c.nonceHash,c.browserHash,c.csrfHash,c.lifetimeSeconds]),
   write('UPDATE login_challenges SET consumed_at=unixepoch() WHERE token_hash=? AND consumed_at IS NULL AND expires_at>unixepoch()',[c.challengeHash]),
  ]));
 } catch {
  if(!await db.prepare(`SELECT 1 WHERE ${challenge.text}`).bind(...challenge.values).first())throw new ApiError(403,'csrf_rejected');
  const available=await db.prepare(`SELECT 1 WHERE ${capacity}`).first();
  if(!available)throw new ApiError(429,'login_limited');
  throw new ApiError(503,'exchange_unavailable');
 }
 const row=await db.prepare('SELECT expires_at AS expiresAt FROM browser_exchange_nonces WHERE nonce_hash=? AND cookie_hash=? AND csrf_hash=?').bind(c.nonceHash,c.browserHash,c.csrfHash).first<{expiresAt:number}>();
 if(!row)throw new ApiError(503,'exchange_unavailable');return row;
}
