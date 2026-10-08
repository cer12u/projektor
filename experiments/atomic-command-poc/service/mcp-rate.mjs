import {strictJson} from '../release/strict-json.mjs';
const keys=['workspaceBurst','workspacePerSecond','identityBurst','identityPerSecond'];
export function validMCPRatePolicy(p){return p&&typeof p==='object'&&!Array.isArray(p)&&Object.keys(p).length===keys.length&&keys.every(k=>Number.isSafeInteger(p[k])&&p[k]>=1&&p[k]<=1000)&&p.identityBurst<=p.workspaceBurst&&p.identityPerSecond<=p.workspacePerSecond;}
export function readMCPRatePolicy(serialized){try{if(typeof serialized!=='string'||serialized.length>2048)return null;const p=strictJson(serialized);return validMCPRatePolicy(p)?Object.freeze(p):null;}catch{return null;}}
// Fixed memory bounds, independent principal and credential fairness. These are
// instance-local counters, not durable quotas or proof of production capacity.
export function createMCPRateLimiter(policy,now=Date.now){
 if(!validMCPRatePolicy(policy))return ()=>({allowed:false,code:'MCP_RATE_LIMIT_CONFIG_REQUIRED',status:503});
 const principals=new Map(),credentials=new Map(),ttl=600000,maxKeys=256;
 const fresh=(burst,time)=>({tokens:burst,at:time,seen:time});
 const workspace=fresh(policy.workspaceBurst,now());
 const refill=(b,burst,rate,time)=>{b.tokens=Math.min(burst,b.tokens+Math.max(0,time-b.at)*rate/1000);b.at=Math.max(time,b.at);b.seen=Math.max(time,b.seen);};
 return (identity,time=now())=>{
  for(const map of [principals,credentials])for(const [key,b] of map)if(time-b.seen>=ttl)map.delete(key);
  const pkey=JSON.stringify([identity.workspaceId,identity.principalId]),ckey=JSON.stringify([identity.workspaceId,identity.principalId,identity.credentialId]);
  for(const [map,key] of [[principals,pkey],[credentials,ckey]])if(!map.has(key)&&map.size>=maxKeys)return {allowed:false,code:'RATE_LIMITED',status:429,retryAfter:Math.max(1,Math.ceil((ttl-Math.max(...[...map.values()].map(b=>time-b.seen)))/1000))};
  if(!principals.has(pkey))principals.set(pkey,fresh(policy.identityBurst,time));if(!credentials.has(ckey))credentials.set(ckey,fresh(policy.identityBurst,time));
  const buckets=[[workspace,policy.workspaceBurst,policy.workspacePerSecond],[principals.get(pkey),policy.identityBurst,policy.identityPerSecond],[credentials.get(ckey),policy.identityBurst,policy.identityPerSecond]];
  for(const [bucket,burst,rate] of buckets)refill(bucket,burst,rate,time);
  const wait=Math.max(...buckets.map(([bucket,,rate])=>Math.max(0,1-bucket.tokens)/rate));
  if(wait>0)return {allowed:false,code:'RATE_LIMITED',status:429,retryAfter:Math.max(1,Math.ceil(wait))};
  for(const [bucket] of buckets)bucket.tokens--;return {allowed:true};
 };
}
