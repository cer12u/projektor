// @module deployment
// @role process
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, symlink, readdir, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {assertTarget} from './cloudflare-port.mjs';

// No HTTP implementation or credential store: only the pinned official CLI.
// Synthetic tests call this runner with an isolated fake environment and loopback API.
// Production reaches it exclusively after guardEnvironment().
export async function officialCli(candidate, args, suppliedEnv,target) {
  assertTarget(target);
  if(process.platform!=='linux')throw Error('LINUX_PROCESS_GROUP_SUPPORT_REQUIRED');
  const scratch = await mkdtemp(resolve(tmpdir(), 'projektor-cli-'));
  await mkdir(resolve(scratch, 'home'));
  await mkdir(resolve(scratch, 'config'));
  await mkdir(resolve(scratch, 'work'));
  await symlink('/dev/null', resolve(scratch, 'discard.log'));
  const passKeys = ['PATH','LANG','LC_ALL','HTTPS_PROXY','HTTP_PROXY','ALL_PROXY','NO_PROXY',
    'https_proxy','http_proxy','all_proxy','no_proxy','NODE_EXTRA_CA_CERTS','NODE_OPTIONS',
    'SSL_CERT_FILE','SSL_CERT_DIR','CLOUDFLARE_API_TOKEN',
    // Only synthetic tests can supply this; the production entrypoint rejects it.
    'CLOUDFLARE_API_BASE_URL'];
  const env = { ...Object.fromEntries(passKeys.filter(k=>suppliedEnv[k]!==undefined).map(k=>[k,suppliedEnv[k]])), HOME: resolve(scratch, 'home'), XDG_CONFIG_HOME: resolve(scratch, 'config'),
    CLOUDFLARE_ACCOUNT_ID: target.account, CI: 'true', WRANGLER_SEND_METRICS: 'false',
    WRANGLER_WRITE_LOGS: 'false', WRANGLER_LOG: 'log', WRANGLER_LOG_PATH: resolve(scratch, 'discard.log'),
    CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false', WRANGLER_SEND_ERROR_REPORTS:'false',
    WRANGLER_NO_SKILLS_UPDATE_PROMPTS:'true', WRANGLER_HIDE_BANNER:'true', NO_COLOR: '1' };
  // Never inherit any caller-selected profile path.
  delete env.WRANGLER_HOME; delete env.WRANGLER_PROFILE;
  const start = new Date().toISOString();
  let stdout = '', stderr = '', overflow = false, stopReason=null, retryDiagnosticTail='', forceKillTimer;
  const child = spawn(process.execPath, [resolve(candidate, 'node_modules/wrangler/bin/wrangler.js'), ...args],
    { cwd: resolve(scratch, 'work'), env, detached:true, stdio: ['ignore','pipe','pipe'] });
  function signalGroup(signal){if(!child.pid)return;try{process.kill(-child.pid,signal);}catch(error){if(error.code!=='ESRCH')throw error;}}
  function stopGroup(reason){if(stopReason)return;stopReason=reason;signalGroup('SIGTERM');forceKillTimer=setTimeout(()=>signalGroup('SIGKILL'),250);}
  const capture = which => chunk => {
    if (stdout.length + stderr.length + chunk.length > 2_000_000) { overflow = true; stopGroup('OUTPUT_LIMIT'); return; }
    if (which === 'stdout') stdout += chunk; else stderr += chunk;
    retryDiagnosticTail=(retryDiagnosticTail+chunk.toString()).slice(-8192).replace(/\x1b\[[0-9;]*m/g,'');
    // Pinned 4.149.0 emits this before its minimum 1-second retry wait.
    // Stop on every internal asset retry, including transient errors: no status guess.
    if(retryDiagnosticTail.includes('Asset upload failed. Retrying...'))stopGroup('ASSET_RETRY_SUPPRESSED');
  };
  child.stdout.on('data', capture('stdout')); child.stderr.on('data', capture('stderr'));
  const timer = setTimeout(() => stopGroup('TIMEOUT'), 300_000);
  let exitCode;
  try { exitCode = await new Promise((done, reject) => { child.once('error', reject); child.once('close', done); }); }
  finally { clearTimeout(timer); }
  if(forceKillTimer){await new Promise(r=>setTimeout(r,300));clearTimeout(forceKillTimer);}
  const liveProcessGroupMembers=[];
  for(const pid of await readdir('/proc')){
    if(!/^\d+$/.test(pid))continue;
    try{const stat=await readFile('/proc/'+pid+'/stat','utf8');const fields=stat.slice(stat.lastIndexOf(')')+2).split(' ');
      if(Number(fields[2])===child.pid&&!['Z','X'].includes(fields[0]))liveProcessGroupMembers.push(Number(pid));
    }catch{}
  }
  if(liveProcessGroupMembers.length)signalGroup('SIGKILL');
  const persistedFiles = [];
  async function walk(dir, prefix) {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = prefix + e.name;
      if (e.isDirectory()) await walk(resolve(dir, e.name), p + '/');
      else persistedFiles.push(p);
    }
  }
  await walk(resolve(scratch, 'home'), 'home/'); await walk(resolve(scratch, 'config'), 'config/');
  const credentialFileCreated = persistedFiles.some(p => /(?:default|profile).*\.(?:toml|enc)$|oauth|credential/i.test(p));
  // These are noncredential temporary process files, not a persistent auth profile.
  await rm(scratch, { recursive: true, force: true });
  const effectiveExitCode=stopReason||liveProcessGroupMembers.length?1:(exitCode??1);
  return { start, end: new Date().toISOString(), exitCode, effectiveExitCode, overflow, credentialFileCreated, persistedFiles, stopReason, liveProcessGroupMembers, stdout, stderr };
}

export function safeFailure(result) {
  const text = result.stdout + '\n' + result.stderr;
  return { exitCode: result.exitCode, effectiveExitCode:result.effectiveExitCode, overflow: result.overflow, credentialFileCreated: result.credentialFileCreated,stopReason:result.stopReason,liveProcessGroupMembers:result.liveProcessGroupMembers,
    apiErrorCodes: [...new Set([...text.matchAll(/\[code:\s*(\d+)\]/g)].map(m => Number(m[1])))],
    rawOutputWithheld: true };
}

export function safeVersion(raw) {
  return { id: raw.id, createdOn: raw.metadata?.created_on,
    compatibilityDate: raw.resources?.script_runtime?.compatibility_date,
    compatibilityFlags: raw.resources?.script_runtime?.compatibility_flags,
    bindings: (raw.resources?.bindings || []).map(b => ({name:b.name,type:b.type})),
    scriptEtag: raw.resources?.script?.etag };
}

export function safeUploadSummary(stdout) {
  return (stdout.match(/Uploaded\s+\d+\s+of\s+\d+\s+assets?|Uploaded\s+\d+\s+files?|No updated asset files to upload/gi)||[]).slice(-4);
}
