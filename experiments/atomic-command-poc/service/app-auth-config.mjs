// Deployment-owned selection. This module performs no KDF or credential work.
const id=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const invalid=()=>{throw Object.assign(new Error('APP_AUTH_CONFIG_INVALID'),{code:'APP_AUTH_CONFIG_INVALID',status:503});};
export function readAppAuthConfig(env,workspaces){
 if(env.APP_AUTH_CONFIG===undefined)return null;
 if(typeof env.APP_AUTH_CONFIG!=='string'||env.APP_AUTH_CONFIG.length>8192)invalid();
 let value;try{value=JSON.parse(env.APP_AUTH_CONFIG);}catch{invalid();}
 const keys=['version','workspaceId','humanPrincipalId','authEpoch','policy'];
 if(!value||Array.isArray(value)||Object.keys(value).some(key=>!keys.includes(key)&&key!=='nativeMachine')||keys.some(key=>!Object.hasOwn(value,key))||value.version!==1||!id(value.workspaceId)||!id(value.humanPrincipalId)||!id(value.authEpoch))invalid();
 // These IDs select the initial enrollment/login and management targets.
 // Normal verifiers use registered Store session/credential principals; this
 // single-workspace deployment does not create or admit new accounts.
 if(!Array.isArray(workspaces)||workspaces.length!==1||workspaces[0]!==value.workspaceId)invalid();
 if(!value.policy||Array.isArray(value.policy)||typeof value.policy!=='object')invalid();
 if(value.nativeMachine!==undefined){const machine=value.nativeMachine;if(!machine||Array.isArray(machine)||Object.keys(machine).some(key=>!['principalId','maxLifetimeMs','maxRedeemLifetimeMs','deviceSession'].includes(key))||!id(machine.principalId)||machine.principalId===value.humanPrincipalId||!Number.isSafeInteger(machine.maxLifetimeMs)||machine.maxLifetimeMs<1||machine.maxLifetimeMs>366*86400000||machine.maxRedeemLifetimeMs!==undefined&&(!Number.isSafeInteger(machine.maxRedeemLifetimeMs)||machine.maxRedeemLifetimeMs<1||machine.maxRedeemLifetimeMs>3600000))invalid();}
 if(value.nativeMachine?.deviceSession!==undefined){const d=value.nativeMachine.deviceSession;if(!d||Array.isArray(d)||Object.keys(d).sort().join(',')!=='accessLeaseMs,receiptRetentionMs,refreshGraceMs'||!Number.isSafeInteger(d.accessLeaseMs)||d.accessLeaseMs<1000||d.accessLeaseMs>3600000||!Number.isSafeInteger(d.refreshGraceMs)||d.refreshGraceMs<0||d.refreshGraceMs>d.accessLeaseMs||!Number.isSafeInteger(d.receiptRetentionMs)||d.receiptRetentionMs<d.accessLeaseMs||d.receiptRetentionMs>86400000)invalid();}
 // The Store applies validatePolicy's complete ranges. No password hash is ever
 // run in the ingress Worker, including when configuration is invalid.
 return Object.freeze({...value,policy:Object.freeze({...value.policy}),...(value.nativeMachine?{nativeMachine:Object.freeze({...value.nativeMachine})}:{})});
}
