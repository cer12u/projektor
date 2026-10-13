// @module tooling.build
// @role worker-cli
// Build-only official CLI invocation. There is no credential provider or remote command mode.
import {readFile,mkdir} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';

const root=resolve(dirname(fileURLToPath(import.meta.url)),"../..");
const expected=JSON.parse(await readFile(resolve(root,'package.json'),'utf8')).devDependencies.wrangler;
const installed=JSON.parse(await readFile(resolve(root,'node_modules/wrangler/package.json'),'utf8')).version;
if(installed!==expected)throw new Error('Pinned Wrangler version mismatch');
const home=resolve(root,'.local/build-home'),config=resolve(root,'.local/build-config'),logs=resolve(root,'.local/build-logs');
await Promise.all([home,config,resolve(config,'.wrangler'),logs].map(path=>mkdir(path,{recursive:true})));
const passKeys=['PATH','LANG','LC_ALL','TMPDIR','HTTPS_PROXY','HTTP_PROXY','ALL_PROXY','NO_PROXY','https_proxy','http_proxy','all_proxy','no_proxy','NODE_EXTRA_CA_CERTS','NODE_OPTIONS','SSL_CERT_FILE','SSL_CERT_DIR'];
const env={...Object.fromEntries(passKeys.filter(key=>process.env[key]!==undefined).map(key=>[key,process.env[key]])),HOME:home,XDG_CONFIG_HOME:config,WRANGLER_LOG_PATH:resolve(logs,'worker-build.log'),WRANGLER_SEND_METRICS:'false',WRANGLER_SEND_ERROR_REPORTS:'false',WRANGLER_WRITE_LOGS:'false',WRANGLER_NO_SKILLS_UPDATE_PROMPTS:'true',WRANGLER_HIDE_BANNER:'true',CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV:'false',NO_COLOR:'1',CI:'true'};
const child=spawn(process.execPath,[resolve(root,'node_modules/wrangler/bin/wrangler.js'),'deploy','--dry-run','--config',resolve(root,'wrangler.jsonc'),'--outdir',resolve(root,'dist/worker')],{cwd:root,env,stdio:'inherit'});
child.on('error',error=>{console.error(error.message);process.exitCode=1;});
child.on('exit',(code,signal)=>{process.exitCode=signal?1:code??1;});
