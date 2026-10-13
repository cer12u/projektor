// @module verification
// @role local-verification-entry
// Fixed local-only verification entry. No arbitrary command or provider mode.
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
const root=fileURLToPath(new URL('../../',import.meta.url));
const [mode,...extra]=process.argv.slice(2);
if(extra.length||!['local','ci'].includes(mode)||!process.env.npm_execpath)throw Error('Use npm run verify:local or npm run verify:ci');
const guard=resolve(root,'tests/support/local-network-guard.cjs');
const env={...process.env,NODE_OPTIONS:'--require='+JSON.stringify(guard),CLOUDFLARE_CF_FETCH_ENABLED:'false',WRANGLER_SEND_METRICS:'false',WRANGLER_HIDE_BANNER:'true',WRANGLER_SEND_ERROR_REPORTS:'false',npm_config_update_notifier:'false',npm_config_audit:'false',npm_config_fund:'false',npm_config_offline:'true'};
const child=spawn(process.execPath,[process.env.npm_execpath,'run','verify:'+mode+':checks'],{cwd:root,env,stdio:'inherit'});
child.once('error',error=>{console.error(error.message);process.exitCode=1;});
child.once('exit',(code,signal)=>{process.exitCode=signal?1:code??1;});
