// @module deployment
// @role platform
import {resolve} from 'node:path';
import {loadDeploymentConfig} from './deployment-config.mjs';
import {verifyRelease} from './guard.mjs';
import {guardEnvironment} from './credential-context.mjs';
import {CLI_VERSION} from './cloudflare-port.mjs';
import {officialCli,safeFailure} from './official-cli.mjs';
import {verifyToolchain} from './wrangler-toolchain.mjs';

async function main(){
  const candidate=resolve(process.argv[2]||'candidate');
  if(process.env.CLOUDFLARE_API_TOKEN)throw Error('RUN_BEFORE_SECRET_ENTRY');
  if(process.platform!=='linux'||process.arch!=='x64'||Number(process.versions.node.split('.')[0])!==24)throw Error('UNTESTED_PLATFORM_RUNTIME');
  const configuration=await loadDeploymentConfig(candidate),release=await verifyRelease(candidate,configuration);
  await verifyToolchain(candidate);
  guardEnvironment(process.env,{requireToken:false,target:configuration.target});
  const result=await officialCli(candidate,['--version'],process.env,configuration.target);
  if((result.effectiveExitCode??result.exitCode)!==0||result.credentialFileCreated||!result.stdout.includes(CLI_VERSION))throw Error('OFFICIAL_CLI_START_FAILED');
  console.log(JSON.stringify({status:'NO_SECRET_PLATFORM_CHECK_PASSED',runtime:{node:process.versions.node,platform:process.platform,arch:process.arch},
    release,proxyEnvironmentCompatible:true,extraCaConfigured:Boolean(process.env.NODE_EXTRA_CA_CERTS||process.env.SSL_CERT_FILE||process.env.SSL_CERT_DIR),
    officialCli:safeFailure(result),externalRequestMadeByThisCheck:false,
    limitations:['Checks local process/proxy/CA configuration compatibility only','Does not prove HTTPS network reachability or Vault substitution','No token or grant was requested']}));
}
main().catch(error=>{console.error(JSON.stringify({status:'STOP_BEFORE_TOKEN_CREATION',code:/^[A-Z_]+$/.test(error.message)?error.message:'LOCAL_CHECK_FAILED',rawErrorWithheld:true}));process.exitCode=1;});
