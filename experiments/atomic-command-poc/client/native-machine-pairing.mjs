// Run only in the explicitly approved stable Harness. Public pairing output is
// safe for owner approval; preimages/tokens never become this API's result.
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {lstat} from 'node:fs/promises';
import {openSync,closeSync,fstatSync,readFileSync,writeFileSync,fsyncSync,renameSync,unlinkSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {AsyncLocalStorage} from 'node:async_hooks';
import {constants} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
const fail=code=>Object.assign(new Error(code),{code});
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const leases=new AsyncLocalStorage();
export class FileMachineCredentialProvider {
 constructor(path){this.path=resolve(path);}
 async guard(){const d=await lstat(dirname(this.path));if(!d.isDirectory()||d.isSymbolicLink()||(d.mode&0o077)!==0||d.uid!==process.getuid())throw fail('PRIVATE_PROVIDER_DIRECTORY_REQUIRED');}
 readUnlocked(){let fd;try{fd=openSync(this.path,constants.O_RDONLY|constants.O_NOFOLLOW);const s=fstatSync(fd);if(!s.isFile()||s.size>16384||(s.mode&0o077)!==0||s.uid!==process.getuid())throw fail('PRIVATE_PROVIDER_FILE_REQUIRED');const record=JSON.parse(readFileSync(fd,'utf8'));if(record.revision!==undefined&&(!Number.isSafeInteger(record.revision)||record.revision<0))throw fail('PRIVATE_PROVIDER_UNAVAILABLE');return record;}catch(error){if(error.code==='ENOENT')return null;if(error.code?.startsWith('PRIVATE_'))throw error;throw fail('PRIVATE_PROVIDER_UNAVAILABLE');}finally{if(fd!==undefined)closeSync(fd);}}
 async load(){await this.guard();return this.readUnlocked();}
 async withExclusive(fn){
  const lock=this.path+'.lock.sqlite';if(leases.getStore()?.has(lock))return fn();await this.guard();
  let fd,db,active=false;
  try{
   fd=openSync(lock,constants.O_RDWR|constants.O_CREAT|constants.O_NOFOLLOW,0o600);const stat=fstatSync(fd);if(!stat.isFile()||(stat.mode&0o077)!==0||stat.uid!==process.getuid())throw fail('PRIVATE_PROVIDER_LOCK_REQUIRED');closeSync(fd);fd=undefined;
   db=new DatabaseSync(lock);db.exec('PRAGMA busy_timeout=0');const deadline=Date.now()+10000;
   for(;;){try{db.exec('BEGIN EXCLUSIVE');active=true;break;}catch(error){if(!/locked|busy/i.test(error.message))throw error;if(Date.now()>=deadline)throw fail('PRIVATE_PROVIDER_BUSY');await new Promise(r=>setTimeout(r,20));}}
   db.exec('CREATE TABLE IF NOT EXISTS provider_lock(id INTEGER PRIMARY KEY)');
   const result=await leases.run(new Set([...(leases.getStore()??[]),lock]),fn);db.exec('COMMIT');active=false;return result;
  }catch(error){if(active){try{db.exec('ROLLBACK');}catch{}}if(typeof error.code==='string'&&/^[A-Z_]+$/.test(error.code))throw error;throw fail('PRIVATE_PROVIDER_LOCK_UNAVAILABLE');}
  finally{if(fd!==undefined)closeSync(fd);db?.close();}
 }
 syncDirectory(){const fd=openSync(dirname(this.path),'r');try{fsyncSync(fd);}finally{closeSync(fd);}}
 async create(record){return this.withExclusive(()=>{const fd=openSync(this.path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);try{writeFileSync(fd,JSON.stringify({...record,revision:0}));fsyncSync(fd);}finally{closeSync(fd);}this.syncDirectory();});}
 async install(record){return this.withExclusive(()=>{
  // This whole CAS/write section is synchronous while holding the same lock all
  // pairing and refresh writers use. Stale snapshots cannot erase newer access.
  const current=this.readUnlocked();if(!current||!same(current.approval,record.approval)||current.secret!==record.secret||current.origin!==record.origin||current.principalId!==record.principalId)throw fail('PRIVATE_PROVIDER_BINDING_CHANGED');
  if((current.revision??0)!==(record.revision??0))throw fail('PRIVATE_PROVIDER_WRITE_CONFLICT');if((current.revision??0)>=Number.MAX_SAFE_INTEGER)throw fail('PRIVATE_PROVIDER_REVISION_EXHAUSTED');
  const path=join(dirname(this.path),'.pairing-'+randomUUID());let fd;
  try{fd=openSync(path,'wx',0o600);writeFileSync(fd,JSON.stringify({...record,revision:(current.revision??0)+1}));fsyncSync(fd);closeSync(fd);fd=undefined;renameSync(path,this.path);this.syncDirectory();}finally{if(fd!==undefined)closeSync(fd);try{unlinkSync(path);}catch(error){if(error.code!=='ENOENT')throw error;}}
 });}
 async getToken(){const record=await this.load();if(record?.state!=='installed'||record.approval.expiresAt<=Date.now())throw fail('MACHINE_CREDENTIAL_UNAVAILABLE');return 'pn1_'+record.approval.credentialId+'_'+record.secret;}
}
export function createNativePairingClient({provider,origin,principalId,fetchImpl=globalThis.fetch,deadlineMs=10000}){
 const url=new URL(origin);if(url.protocol!=='https:'||url.origin!==origin||typeof principalId!=='string'||typeof provider?.create!=='function'||typeof provider?.install!=='function'||typeof provider?.load!=='function')throw fail('NATIVE_PAIRING_CONFIG_INVALID');
 const publicRecord=record=>({origin:record.origin,principalId:record.principalId,approval:structuredClone(record.approval)});
 return Object.freeze({
  async prepare({scopes,expiresAt,redeemExpiresAt,expectedGeneration}){
   if(!Array.isArray(scopes)||!scopes.length||scopes.some(s=>typeof s!=='string')||!Number.isSafeInteger(expiresAt)||expiresAt<=Date.now()||!Number.isSafeInteger(redeemExpiresAt)||redeemExpiresAt<=Date.now()||redeemExpiresAt>expiresAt||!Number.isSafeInteger(expectedGeneration)||expectedGeneration<0)throw fail('NATIVE_PAIRING_INPUT_INVALID');
   const existing=await provider.load();if(existing){if(existing.origin!==origin||existing.principalId!==principalId||!same(existing.approval.scopes,[...scopes].sort())||existing.approval.expiresAt!==expiresAt||existing.approval.redeemExpiresAt!==redeemExpiresAt||existing.approval.expectedGeneration!==expectedGeneration)throw fail('PAIRING_ALREADY_PREPARED');return publicRecord(existing);}
   const raw=randomBytes(32),secret=raw.toString('base64url'),approval={grantId:randomUUID(),credentialId:randomUUID(),secretDigest:createHash('sha256').update(raw).digest('hex'),scopes:[...scopes].sort(),expiresAt,redeemExpiresAt,expectedGeneration};
   const record={version:1,origin,principalId,approval,secret,state:'prepared'};await provider.create(record);return publicRecord(record);
  },
  async redeem(){
   const record=await provider.load();if(!record||record.origin!==origin||record.principalId!==principalId)throw fail('PRIVATE_PROVIDER_BINDING_CHANGED');
   const controller=new AbortController();let timer;let response;
   try{response=await Promise.race([(async()=>{const r=await fetchImpl(origin+'/v1/auth/machine-credentials/pairing/redeem',{method:'POST',headers:{'content-type':'application/json',accept:'application/json'},credentials:'omit',redirect:'manual',cache:'no-store',signal:controller.signal,body:JSON.stringify({grantId:record.approval.grantId,secret:record.secret})});const body=await r.json();if(!r.ok)throw fail(body.error?.code??'PAIRING_REDEEM_UNAVAILABLE');return body.data??body;})(),new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(fail('PAIRING_REDEEM_TIMEOUT'));},Math.min(10000,Math.max(1,deadlineMs)));})]);}catch(error){if(typeof error.code==='string'&&/^[A-Z_]+$/.test(error.code))throw error;throw fail('PAIRING_REDEEM_UNAVAILABLE');}finally{clearTimeout(timer);}
   const c=response?.credential;if(!c||c.credentialId!==record.approval.credentialId||c.principalId!==principalId||c.expiresAt!==record.approval.expiresAt||!same(c.scopes,record.approval.scopes)||c.revoked)throw fail('PAIRING_RECEIPT_BINDING_MISMATCH');
   await provider.install({...record,state:'installed'});return {credential:structuredClone(c),replayed:response.replayed===true};
  },
 });
}
