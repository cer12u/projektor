// @module deployment
// @role private-configuration
/** Noncredential target and release evidence live only in the explicitly ignored private directory. */
import {readFile,lstat} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {assertTarget,UUID,fail} from './cloudflare-port.mjs';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const keys=(v,names)=>object(v)&&Object.keys(v).length===names.length&&Object.keys(v).every(k=>names.includes(k));
export function validateDeploymentTarget(value){
 if(!keys(value,['format','account','worker','databaseId','hostname','gate'])||value.format!==1)fail('INVALID_PRIVATE_TARGET');
 assertTarget(value);
 if(!UUID.test(value.databaseId||'')||typeof value.hostname!=='string'||!/^([a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(value.hostname)||value.hostname.endsWith('.invalid'))fail('INVALID_PRIVATE_DESTINATION');
 if(!keys(value.gate,['mode','epoch'])||value.gate.mode!=='stopped'||!Number.isSafeInteger(value.gate.epoch)||value.gate.epoch<0)fail('STOPPED_GATE_EXPECTATION_REQUIRED');
 return value;
}
export function validateApprovedState(value){
 const names=['accessPoliciesHash','domainsHash','workerSettingsHash','ownerBootstrapHash'];
 if(!object(value)||!keys(value.security,names)||names.some(k=>!/^[a-f0-9]{64}$/.test(value.security[k]||'')))fail('PRIVATE_SECURITY_BASELINE_REQUIRED');
 return value;
}
async function bytes(path){
 try{const stat=await lstat(path);if(!stat.isFile()||stat.isSymbolicLink())fail('PRIVATE_CONFIG_NOT_REGULAR');return await readFile(path);}
 catch(error){if(error.code==='ENOENT')fail('PRIVATE_DEPLOYMENT_NOT_CONFIGURED');throw error;}
}
export async function loadDeploymentConfig(candidate){
 const root=resolve(candidate,'.local/deployment');
 // No environment-selected config, credential file, parent-directory fallback, or automatic creation.
 let directory;try{directory=await lstat(root);}catch{fail('PRIVATE_DEPLOYMENT_NOT_CONFIGURED');}
 if(!directory.isDirectory()||directory.isSymbolicLink())fail('PRIVATE_CONFIG_NOT_REGULAR');
 const targetBytes=await bytes(resolve(root,'target.json')),approvedStateBytes=await bytes(resolve(root,'approved-state.json')),configBytes=await bytes(resolve(root,'wrangler.jsonc'));
 let target,approvedState;try{target=JSON.parse(targetBytes);approvedState=JSON.parse(approvedStateBytes);}catch{fail('INVALID_PRIVATE_CONFIG_JSON');}
 validateDeploymentTarget(target);validateApprovedState(approvedState);
 return Object.freeze({target:Object.freeze({account:target.account,worker:target.worker}),databaseId:target.databaseId,hostname:target.hostname,gate:Object.freeze({...target.gate}),approvedState:Object.freeze({...approvedState,security:Object.freeze({...approvedState.security})}),
  targetConfigSha256:hash(targetBytes),approvedStateSha256:hash(approvedStateBytes),productionConfigSha256:hash(configBytes),configPath:resolve(root,'wrangler.jsonc'),verificationRoot:root,journalRoot:resolve(root,'journals')});
}

/** Check again immediately before official CLI dispatch, not only before the longer provider preflight. */
export async function assertPrivateConfigurationUnchanged(configuration){
 for(const [name,expected]of [['target.json',configuration.targetConfigSha256],['approved-state.json',configuration.approvedStateSha256],['wrangler.jsonc',configuration.productionConfigSha256]]){
  if(!/^[a-f0-9]{64}$/.test(expected||'')||hash(await bytes(resolve(configuration.verificationRoot,name)))!==expected)fail('PRIVATE_CONFIGURATION_DRIFT');
 }
}
