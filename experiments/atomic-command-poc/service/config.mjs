import {readAppAuthConfig} from './app-auth-config.mjs';
// Deployment-owned values only; request headers never supply configuration.
export function configuration(env) {
 const fail=()=>{throw Object.assign(new Error('SERVICE_CONFIG_INVALID'),{code:'SERVICE_CONFIG_INVALID',status:503});};
 // Removed capabilities have no disabled/compatibility switch: even 'none' is rejected.
 if (Object.keys(env).some(key => /auto.?join|auto.?provision|trash.?purge|purge.?trash|cron|scheduled/i.test(key))) fail();
 let origin;try{origin=new URL(env.APP_ORIGIN);}catch{fail();}
 if(origin.protocol!=='https:'||origin.origin!==env.APP_ORIGIN||origin.username||origin.password)fail();
 const deadline=Number(env.REQUEST_TIMEOUT_MS),bodyDeadline=Number(env.BODY_TIMEOUT_MS);
 if(!Number.isSafeInteger(deadline)||deadline<1000||deadline>30000||!Number.isSafeInteger(bodyDeadline)||bodyDeadline<100||bodyDeadline>deadline)fail();
 if(!env.WORKSPACE||typeof env.WORKSPACE.idFromName!=='function'||typeof env.WORKSPACE.get!=='function')fail();
 let workspaces;try{workspaces=JSON.parse(env.WORKSPACE_IDS);}catch{fail();}
 if(!Array.isArray(workspaces)||workspaces.length<1||workspaces.length>10||new Set(workspaces).size!==workspaces.length||workspaces.some(id=>typeof id!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)))fail();
 const appAuth=readAppAuthConfig(env,workspaces);
 if(!appAuth&&typeof env.PROVIDER_CONFIG!=='string')fail();
 return {origin:origin.origin,deadline,bodyDeadline,workspaces,appAuth};
}
