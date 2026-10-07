import { DurableObject } from 'cloudflare:workers';
import schema from '../src/schema.sql';
import { StorageFailure, executeCommand, operationGet, queryIssues, failure } from '../src/shared-core.mjs';

// A statement adapter, not a database mock: every operation calls workerd SQLite.
export function sqliteStore(storage) {
 return {
  prepare(sql) { return {
   get(...args) { return storage.sql.exec(sql,...args).toArray()[0]; },
   all(...args) { return storage.sql.exec(sql,...args).toArray(); },
   // rowsWritten counts index/FTS work; SQL changes() is the logical DML count.
   run(...args) { const cursor=storage.sql.exec(sql,...args); cursor.toArray(); return {changes:storage.sql.exec('SELECT changes() AS count').one().count}; }
  }; },
  transactionSync(fn) {
   let callbackError;
   try { return storage.transactionSync(()=>{try{return fn();}catch(error){callbackError=error;throw error;}}); }
   catch { // Only a thrown callback has the API's explicit rollback guarantee.
    throw new StorageFailure(callbackError?'not_committed':'unknown');
   }
  }
 };
}
export class AtomicWorkspace extends DurableObject {
 constructor(ctx,env) {
  super(ctx,env);
  this.db=sqliteStore(ctx.storage);
  ctx.blockConcurrencyWhile(async()=>{
   if(!ctx.storage.sql.exec("SELECT name FROM sqlite_master WHERE name='workspace'").toArray().length)
    ctx.storage.transactionSync(()=>ctx.storage.sql.exec(schema));
  });
 }
 // Actor must come from a trusted authentication boundary. There is deliberately
 // no public fetch handler, auth stub, production binding, or deployment config.
 updateTitle(actor,command,options) {
  try{return executeCommand(this.db,actor,command,options);}
  catch(error){return {...failure('UNAVAILABLE','unknown'),attemptOutcome:error instanceof StorageFailure?error.outcome:'unknown'};}
 }
 getOperation(actor,args,now) {
  try{return operationGet(this.db,actor,args,now);}catch{return failure('UNAVAILABLE','unknown');}
 }
 getIssues(actor,args,now) {
  try{return queryIssues(this.db,actor,args,now);}catch{return failure('UNAVAILABLE','unknown');}
 }
}
