// @module deployment
// @role entry
import {resolve} from 'node:path';
import {loadDeploymentConfig} from './deployment-config.mjs';
import {verifyRelease} from './guard.mjs';
import {createCredentialContext} from './credential-context.mjs';
import {createWranglerAdapter} from './wrangler-adapter.mjs';
import {createJournal} from './release-journal.mjs';
import {createReleaseUseCase} from './release-use-case.mjs';

async function main(){
  const [action,input,...rest]=process.argv.slice(2);
  if(!input||!['verify','probe','deployments','upload','deploy','reconcile','status'].includes(action))throw Error('USAGE_ACTION_CANDIDATE');
  const candidate=resolve(input),configuration=await loadDeploymentConfig(candidate),release=await verifyRelease(candidate,configuration);
  const expectedArgs=['probe','upload','deploy'].includes(action)?1:0;
  if(rest.length!==expectedArgs)throw Error('UNEXPECTED_ARGUMENTS');
  if(action==='verify'){console.log(JSON.stringify({verified:true,verificationScope:'Frozen sources and artifacts; installed toolchain is checked separately by the adapter',...release}));return;}
  const port=createWranglerAdapter({candidate,credentials:createCredentialContext(process.env,configuration.target),configuration,release});
  const journal=createJournal(configuration.journalRoot,release);
  const useCase=createReleaseUseCase({port,journal,release});
  const method={deploy:'promote'}[action]||action;
  const result=await useCase[method](...rest);
  console.log(JSON.stringify(result));
  if(result.phase==='RECONCILIATION_REQUIRED')process.exitCode=1;
}
main().catch(error=>{console.error(JSON.stringify({status:'STOP',code:/^[A-Z_]+$/.test(error.code||error.message)?error.code||error.message:'LOCAL_OR_PROTOCOL_FAILURE',rawErrorWithheld:true}));process.exitCode=1;});
