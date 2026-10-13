// @module persistence
// @role atomic-commit
import type { Permission } from "../../../modules/identity/dto";
import type {AuthDB} from "../primitives";
import type {Authenticated} from "../identity/authorization";
import { guardedBatch } from './guarded-batch';

export type {Json} from "./public";
import {MutationError,type Json} from "./public";
export {MutationError} from "./public";
export type {MutationNonapplication} from "./public";
import {sql,type Sql} from "../primitives";
export {sql} from "../primitives";
export type {Sql,SqlValue} from "../primitives";
export interface MutationTarget { readonly kind: string; readonly targetId: string; readonly projectId: string }
export interface MutationCommand<I extends Json = Json> extends MutationTarget {
  readonly operationId: string;
  /** Already validated, domain-normalized input, including revision and transition intent. */
  readonly input: I;
}
export interface MutationContext<I extends Json = Json> extends MutationCommand<I> {
  readonly principalId: string;
  readonly inputHash: string;
}
export interface MutationReadPolicy {
  /** Trusted server policy, never request input. Global administration is independent of project permissions. */
  readonly authority?: 'project' | 'global-administrator' | 'global-administrator-or-scoped-manager';
  /** Read-only recovery of immutable older receipts; their stored authority is still enforced. */
  readonly legacyAuthorities?: readonly ('project' | 'global-administrator' | 'global-administrator-or-scoped-manager')[];
  /** Must test current target visibility/project relation, including deleted or moved targets. */
  visible(target: MutationTarget): Sql;
}
export type ReadPolicyFor = (kind: string) => MutationReadPolicy | undefined;
export interface MutationCheck { readonly reason: string; readonly valid: Sql }
export interface CheckedWrite { readonly statement: Sql; readonly expectedChanges: number }
export interface MutationCommandPolicy {readonly canonicalMaxBytes:number;readonly certifyPreDispatchDenial?:boolean}
export interface IntentFence {readonly valid:Sql;readonly requiredPermissions:readonly Permission[]}
export interface MutationAdapter<I extends Json = Json> extends MutationReadPolicy {
  readonly commandPolicy?:MutationCommandPolicy;
  readonly permissions: readonly Permission[];
  preconditions(context: MutationContext<I>): readonly MutationCheck[];
  updates(context: MutationContext<I>): readonly CheckedWrite[];
  history(context: MutationContext<I>): readonly CheckedWrite[];
  /** Scalar SQL expression returning one JSON value from the updated DB state. NULL aborts. */
  snapshot(context: MutationContext<I>): Sql;
  /** Scalar current-state JSON expression; exposed only after current authorization/visibility. */
  current(target: MutationTarget): Sql;
}
export interface MutationResult { readonly snapshot: Json; readonly source: 'committed' | 'recovered' }
export interface MutationReceipt { readonly operationId: string; readonly snapshot: Json }
const combine = (parts: readonly Sql[]): Sql => ({
  text: parts.map(p => `(${p.text})`).join(' AND ') || '1', values: parts.flatMap(p => [...p.values]),
});
const prepare = (db: AuthDB, q: Sql) => db.prepare(q.text).bind(...q.values);

/** Deterministic JSON: sorted object keys, ordered arrays, finite numbers, no undefined/holes/prototypes. */
export function canonicalInput(value: Json,maxBytes=16384): string {
  const seen = new Set<object>();
  function visit(v: Json, depth: number): string {
    if (depth > 32) throw new MutationError(400, 'invalid_normalized_input');
    if (v === null || typeof v === 'boolean' || typeof v === 'string') return JSON.stringify(v);
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) throw new MutationError(400, 'invalid_normalized_input');
      return JSON.stringify(v);
    }
    if (typeof v !== 'object' || seen.has(v)) throw new MutationError(400, 'invalid_normalized_input');
    seen.add(v);
    let encoded: string;
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) if (!Object.hasOwn(v, i)) throw new MutationError(400, 'invalid_normalized_input');
      encoded = `[${v.map(x => visit(x, depth + 1)).join(',')}]`;
    } else {
      if (Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null)
        throw new MutationError(400, 'invalid_normalized_input');
      encoded = `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${visit(v[k], depth + 1)}`).join(',')}}`;
    }
    seen.delete(v);
    return encoded;
  }
  const encoded = visit(value, 0);
  if (new TextEncoder().encode(encoded).byteLength > maxBytes) throw new MutationError(400, 'invalid_normalized_input');
  return encoded;
}
function parseSnapshot(value: string): Json {
  const parsed: unknown = JSON.parse(value);
  function json(v: unknown): v is Json {
    return v === null || typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))
      || (Array.isArray(v) && v.every(json)) || (typeof v === 'object' && v !== null && Object.values(v).every(json));
  }
  if (!json(parsed)) throw new MutationError(500, 'invalid_operation_snapshot');
  return parsed;
}
import {credentialValid,authorityValid} from "../identity/authorization";
export {currentCredentialSql,currentPermissionsSql,currentPermissionSetSql,credentialCeilingSql} from "../identity/authorization";
/** Stored intent requirements participate in direct commits and receipt disclosure too. */
function permissionsWithIntent(principalId:string,operationId:string,base:string):Sql {
 return sql(`(SELECT json_group_array(value) FROM (SELECT value FROM json_each(?) UNION SELECT wanted.value FROM operation_intents i,json_each(i.required_permissions) wanted WHERE i.principal_id=? AND i.operation_id=? ORDER BY value))`,base,principalId,operationId);
}
interface StoredOperation {
  operation_id: string; operation_kind: string; target_id: string; project_id: string; input_hash: string;
  required_permissions: string; state: string;
  authority_kind: 'project'|'global-administrator'|'global-administrator-or-scoped-manager';
}
interface ReadOperation { readonly row: StoredOperation; readonly snapshot: Json }
async function readStored(db: AuthDB, auth: Authenticated, operationId: string, policyFor: ReadPolicyFor): Promise<ReadOperation | null> {
  const row = await db.prepare(`SELECT operation_id,operation_kind,target_id,project_id,input_hash,required_permissions,state,authority_kind
    FROM operation_results WHERE principal_id=? AND operation_id=?`).bind(auth.id, operationId).first<StoredOperation>();
  if (!row) {
    const valid = await prepare(db, sql(`SELECT CASE WHEN ${credentialValid(auth).text} THEN 1 ELSE 0 END AS valid`,
      ...credentialValid(auth).values)).first<{ valid: number }>();
    if (!valid?.valid) throw new MutationError(401, 'unauthenticated');
    return null;
  }
  const target = { kind: row.operation_kind, targetId: row.target_id, projectId: row.project_id };
  const policy = policyFor(target.kind);
  // Unknown kinds cannot be read with another target type's visibility predicate.
  if (!policy || ((policy.authority??'project')!==row.authority_kind&&!policy.legacyAuthorities?.includes(row.authority_kind))) throw new MutationError(403, 'forbidden');
  const credential = credentialValid(auth), rights = authorityValid(auth,row.authority_kind,target.projectId,permissionsWithIntent(auth.id,operationId,row.required_permissions));
  const visible = policy.visible(target), allowed = combine([credential, rights, visible]);
  const result = await prepare(db, sql(`SELECT (${credential.text}) AS authenticated, (${rights.text}) AS permitted,
    (${visible.text}) AS visible, CASE WHEN ${allowed.text} THEN snapshot ELSE NULL END AS snapshot, state
    FROM operation_results WHERE principal_id=? AND operation_id=?`,
    ...credential.values, ...rights.values, ...visible.values, ...allowed.values, auth.id, operationId))
    .first<{ authenticated: number; permitted: number; visible: number; snapshot: string | null; state: string }>();
  if (!result) throw new MutationError(503, 'mutation_unavailable');
  if (!result.authenticated) throw new MutationError(401, 'unauthenticated');
  if (!result.permitted || !result.visible) throw new MutationError(403, 'forbidden');
  if (result.state !== 'confirmed' || result.snapshot === null) throw new MutationError(503, 'operation_unconfirmed');
  return { row, snapshot: parseSnapshot(result.snapshot) };
}
async function databaseBoundary<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); } catch (error) {
    if (error instanceof MutationError) throw error;
    throw new MutationError(503, 'mutation_unavailable');
  }
}
export function readMutationResult(db: AuthDB, auth: Authenticated, operationId: string, policyFor: ReadPolicyFor): Promise<Json> {
  return databaseBoundary(async () => (await lookupReceipt(db, auth, operationId, policyFor)).snapshot);
}
/** DB-confirmed identifier and snapshot, using the same current-authorization read boundary. */
export function readMutationReceipt(db: AuthDB, auth: Authenticated, operationId: string, policyFor: ReadPolicyFor): Promise<MutationReceipt> {
  return databaseBoundary(() => lookupReceipt(db, auth, operationId, policyFor));
}
async function lookupReceipt(db: AuthDB, auth: Authenticated, operationId: string, policyFor: ReadPolicyFor): Promise<MutationReceipt> {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(operationId)) throw new MutationError(400, 'invalid_operation_id');
  const stored = await readStored(db, auth, operationId, policyFor);
  if (!stored) throw new MutationError(404, 'operation_not_found');
  return {operationId:stored.row.operation_id,snapshot:stored.snapshot};
}
async function rejected<I extends Json>(db: AuthDB, auth: Authenticated, context: MutationContext<I>,
  adapter: MutationAdapter<I>, permissions: string | Sql, checks: readonly MutationCheck[], error: unknown): Promise<never> {
  const credential = credentialValid(auth), rights = authorityValid(auth,adapter.authority??'project',context.projectId,permissions);
  const visible = adapter.visible(context), allowed = combine([credential, rights, visible]);
  const current = adapter.current(context);
  const row = await prepare(db, sql(`SELECT (${credential.text}) AS authenticated, (${rights.text}) AS permitted,
    (${visible.text}) AS visible${checks.map((c, i) => `, (${c.valid.text}) AS check_${i}`).join('')},
    CASE WHEN ${allowed.text} THEN (${current.text}) ELSE NULL END AS current_snapshot`,
    ...credential.values, ...rights.values, ...visible.values, ...checks.flatMap(c => [...c.valid.values]),
    ...allowed.values, ...current.values)).first<Record<string, number | string | null>>();
  if (!row?.authenticated) throw new MutationError(401, 'unauthenticated');
  if (!row.permitted || !row.visible) throw new MutationError(403, 'forbidden');
  const failed = checks.findIndex((_c, i) => !row[`check_${i}`]);
  if(failed>=0&&checks[failed].reason==='operation_input_mismatch')throw new MutationError(409,'operation_input_mismatch');
  if(failed>=0&&checks[failed].reason==='operation_format_unsupported')throw new MutationError(409,'operation_format_unsupported');
  if (failed >= 0) throw new MutationError(409, 'precondition_conflict', checks[failed].reason,
    typeof row.current_snapshot === 'string' ? parseSnapshot(row.current_snapshot) : undefined);
  // A broken checked write or SQL constraint is not a successful mutation. SQL text is never exposed.
  throw new MutationError(error instanceof Error && /constraint|immutable/i.test(error.message) ? 500 : 503, 'mutation_failed');
}
export function executeMutation<I extends Json>(db: AuthDB, auth: Authenticated, command: MutationCommand<I>,
  adapter: MutationAdapter<I>, policyFor: ReadPolicyFor, intentFence?:IntentFence): Promise<MutationResult> {
  return databaseBoundary(() => commitMutation(db, auth, command, adapter, policyFor,intentFence));
}
async function commitMutation<I extends Json>(db: AuthDB, auth: Authenticated, command: MutationCommand<I>,
  adapter: MutationAdapter<I>, policyFor: ReadPolicyFor,intentFence?:IntentFence): Promise<MutationResult> {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(command.operationId)) throw new MutationError(400, 'invalid_operation_id');
  for (const value of [command.kind, command.targetId, command.projectId])
    if (!value || value.length > 256) throw new MutationError(400, 'invalid_operation_target');
  const policy=policyFor(command.kind);
  if (!policy) throw new MutationError(500, 'unregistered_mutation_kind');
  const authority=adapter.authority??'project';
  if((policy.authority??'project')!==authority)throw new MutationError(500,'invalid_mutation_authority');
  const allowedPermissions: readonly string[] = ['view', 'edit', 'assign', 'transition', 'execute', 'manage'];
  if ((authority!=='global-administrator'&&!adapter.permissions.length)||(authority==='global-administrator'&&adapter.permissions.length!==0)
    || [...adapter.permissions,...(intentFence?.requiredPermissions??[])].some(p => !allowedPermissions.includes(p)))
    throw new MutationError(500, 'invalid_mutation_adapter');
  const basePermissions=authority==='global-administrator'?'[]':JSON.stringify([...new Set<Permission>(['view',...adapter.permissions,...(intentFence?.requiredPermissions??[])])].sort());
  const permissions=permissionsWithIntent(auth.id,command.operationId,basePermissions);
  const {inputHash}=await fingerprintCommand(command,adapter.commandPolicy?.canonicalMaxBytes??16384);
  const context = { ...command, principalId: auth.id, inputHash };
  if (adapter.commandPolicy?.certifyPreDispatchDenial) {
    // A 403 after batch dispatch can hide a committed operation whose receipt is now
    // unreadable. Only this pre-dispatch check can certify rejection of this attempt.
    // Read absence and current authorization together; never expose a stored receipt
    // or derive nonapplication from a failed batch or a later result lookup.
    const credential = credentialValid(auth), rights = authorityValid(auth,authority,context.projectId,permissions);
    const visible = adapter.visible(context);
    const before = await prepare(db, sql(`SELECT (${credential.text}) AS authenticated,
      (${rights.text}) AS permitted, (${visible.text}) AS visible,
      EXISTS(SELECT 1 FROM operation_results WHERE principal_id=? AND operation_id=?) AS stored`,
      ...credential.values, ...rights.values, ...visible.values, auth.id, command.operationId))
      .first<{authenticated:number;permitted:number;visible:number;stored:number}>();
    if (!before) throw new MutationError(503, 'mutation_unavailable');
    if (!before.authenticated) throw new MutationError(401, 'unauthenticated');
    if (!before.stored && (!before.permitted || !before.visible))
      throw new MutationError(403, 'forbidden', undefined, undefined,
        {operationId:command.operationId,status:'not_applied',phase:'pre_dispatch'});
  }
  const sameIntent=sql(`NOT EXISTS(SELECT 1 FROM operation_intents WHERE principal_id=? AND operation_id=? AND (operation_kind<>? OR target_id<>? OR project_id<>? OR input_hash<>?))`,auth.id,command.operationId,command.kind,command.targetId,command.projectId,inputHash);
  // Direct feature routes share the journal's format fence. This guards only a new
  // atomic write; a confirmed receipt is still recovered below under current rights.
  const supportedIntent=sql('NOT EXISTS(SELECT 1 FROM operation_intents WHERE principal_id=? AND operation_id=? AND format_version<>1)',auth.id,command.operationId);
  const checks = [{reason:'operation_input_mismatch',valid:sameIntent},{reason:'operation_format_unsupported',valid:supportedIntent},...adapter.preconditions(context),...(intentFence?[{reason:'operation_intent_changed',valid:intentFence.valid}]:[])];
  const writable=sql("EXISTS(SELECT 1 FROM write_gate WHERE id=1 AND mode='open')");
  const guard = combine([writable,credentialValid(auth), authorityValid(auth,authority,context.projectId,permissions), adapter.visible(context), ...checks.map(c => c.valid)]);
  const prefix: D1PreparedStatement[] = [
    db.prepare(`INSERT INTO operation_results(principal_id,operation_id,operation_kind,target_id,project_id,input_hash,
      required_permissions,state,created_at,authority_kind) VALUES(?,?,?,?,?,?,${permissions.text},'pending',unixepoch(),?)`)
      .bind(auth.id,command.operationId,command.kind,command.targetId,command.projectId,inputHash,...permissions.values,authority),
  ];
  const writes:CheckedWrite[]=[];
  function checked(write:CheckedWrite):void{if(!Number.isSafeInteger(write.expectedChanges)||write.expectedChanges<1)throw new MutationError(500,'invalid_mutation_adapter');writes.push(write);}
  const updates = adapter.updates(context), history = adapter.history(context);
  if (!updates.length || !history.length) throw new MutationError(500, 'invalid_mutation_adapter');
  updates.forEach(checked);
  history.forEach(checked);
  const snapshot = adapter.snapshot(context);
  checked({ statement: sql(`UPDATE operation_results SET state='confirmed',snapshot=(${snapshot.text}),confirmed_at=unixepoch()
    WHERE principal_id=? AND operation_id=? AND state='pending'`, ...snapshot.values, auth.id, command.operationId), expectedChanges: 1 });
  const statements=guardedBatch(db,guard,writes,prefix);
  let failure: unknown = null;
  try { await db.batch(statements); } catch (error) { failure = error; }
  // Also covers a completed batch whose acknowledgement was lost. Always recheck current rights.
  const stored = await readStored(db, auth, command.operationId, policyFor);
  if (stored) {
    const row = stored.row;
    if (row.input_hash !== inputHash || row.operation_kind !== command.kind || row.target_id !== command.targetId || row.project_id !== command.projectId)
      throw new MutationError(409, 'operation_input_mismatch');
    return { snapshot: stored.snapshot, source: failure === null ? 'committed' : 'recovered' };
  }
  const gate=await db.prepare('SELECT mode FROM write_gate WHERE id=1').first<{mode:string}>();
  if(gate?.mode!=='open')throw new MutationError(503,'write_stopped');
  return rejected(db, auth, context, adapter, permissions, checks, failure);
}

/** Canonical command fingerprint shared by direct commits and durable intent preparation. */
export async function fingerprintCommand(command:MutationCommand,canonicalInputLimit=16384):Promise<{inputJson:string;inputHash:string}>{
 if(!Number.isSafeInteger(canonicalInputLimit)||canonicalInputLimit<1)throw new MutationError(500,'invalid_command_policy');
 const inputJson=canonicalInput(command.input,canonicalInputLimit);
 const inputHash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(inputJson)))].map(x=>x.toString(16).padStart(2,'0')).join('');
 return {inputJson,inputHash};
}
/** Receipt-first planning read. Absence is not a nonapplication certificate. */
export function recoverMutation(db:AuthDB,auth:Authenticated,command:MutationCommand,policyFor:ReadPolicyFor,canonicalInputLimit=16384):Promise<MutationResult|null>{
 return databaseBoundary(async()=>{
  if(!/^[A-Za-z0-9_-]{1,128}$/.test(command.operationId))throw new MutationError(400,'invalid_operation_id');
  const stored=await readStored(db,auth,command.operationId,policyFor);
  if(!stored)return null;
  const {inputHash}=await fingerprintCommand(command,canonicalInputLimit),row=stored.row;
  if(row.input_hash!==inputHash||row.operation_kind!==command.kind||row.target_id!==command.targetId||row.project_id!==command.projectId)throw new MutationError(409,'operation_input_mismatch');
  return {snapshot:stored.snapshot,source:'recovered'};
 });
}
