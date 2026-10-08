import { StorageFailure } from '../src/shared-core.mjs';
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
