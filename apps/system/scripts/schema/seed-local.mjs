// @module tooling.schema
// @role seed
// P1a synthetic fixtures only. NEVER imported by the Worker.
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { argon2id } from 'hash-wasm';
const root=resolve(dirname(fileURLToPath(import.meta.url)),"../..");
const args=process.argv.slice(2),settings={};
for(let i=0;i<args.length;i++) {
  if(args[i]==='--help'){console.log('Local synthetic auth fixtures only. First apply canonical migrations with npm run db:migrate. Options: --persist-to <directory> --fixture-dir <directory>. Never remote.');process.exit(0);}
  if(!['--persist-to','--fixture-dir'].includes(args[i])||!args[i+1]||args[i+1].startsWith('--'))throw new Error('Only --persist-to <directory> and --fixture-dir <directory> are accepted');
  if(settings[args[i]])throw new Error('Duplicate seed option');
  settings[args[i]]=args[++i];
}
const persistence=resolve(settings['--persist-to']??join(root,'.wrangler/state'));
const fixtures=resolve(settings['--fixture-dir']??join(root,'.local'));
const config=join(root,'wrangler.jsonc'),configValue=JSON.parse(await readFile(config,'utf8'));
assert.deepEqual(configValue.d1_databases.map(({binding,database_name,database_id,remote})=>({binding,database_name,database_id,remote})),[
  {binding:'DB',database_name:'projektor-p1a-local',database_id:'00000000-0000-0000-0000-000000000001',remote:false}],
  'Refuse a non-synthetic local database configuration');
await mkdir(fixtures,{recursive:true});
const home=join(fixtures,'wrangler-home');await mkdir(home,{recursive:true});
const env={PATH:process.env.PATH,HOME:home,XDG_CONFIG_HOME:home,CI:'true',WRANGLER_SEND_METRICS:'false',WRANGLER_LOG_PATH:join(home,'wrangler.log')};
const cli=join(root,'node_modules/wrangler/bin/wrangler.js');
const execute=args=>spawnSync(process.execPath,[cli,'d1','execute','projektor-p1a-local','--local','--config',config,'--persist-to',persistence,...args],{cwd:root,encoding:'utf8',env,timeout:90000,maxBuffer:4*1024*1024});
// Do not synthesize schema or silently seed a stale database. Wrangler owns migrations.
const ledger=execute(['--command','SELECT name FROM d1_migrations ORDER BY id','--json']);
if(ledger.status!==0)throw new Error('Canonical local migrations are required before seeding; run npm run db:migrate with the same --persist-to directory');
const expected=(await readdir(join(root,'migrations'))).filter(n=>n.endsWith('.sql')).sort();
assert.deepEqual(JSON.parse(ledger.stdout).flatMap(item=>item.results.map(row=>row.name)),expected,'Local migration ledger must match the complete canonical chain');
const fixturePath=join(fixtures,'synthetic-fixture.json'),sqlPath=join(fixtures,'seed.sql');
let fixture;
try { fixture=JSON.parse(await readFile(fixturePath,'utf8')); }
catch(error){ if(error.code!=='ENOENT')throw error;fixture={loginId:'p1a-human',password:`Synthetic-${randomUUID()}!`,agentToken:randomBytes(32).toString('base64url'),secondAgentToken:randomBytes(32).toString('base64url')};await writeFile(fixturePath,JSON.stringify(fixture),{mode:0o600}); }
const q=value=>`'${String(value).replaceAll("'","''")}'`;
const hash=value=>createHash('sha256').update(value).digest('hex');
const options={memorySize:19456,iterations:2,parallelism:1,hashLength:32,outputType:'encoded'};
const encoded=await argon2id({...options,password:fixture.password,salt:randomBytes(16)});
const dummy=await argon2id({...options,password:randomBytes(32),salt:randomBytes(16)});
const expiration=Math.floor(Date.now()/1000)+90*86400;
const sql=`
INSERT OR IGNORE INTO principals VALUES('test-human','human','P1a テスト利用者','p1a-human',1,1);
INSERT OR IGNORE INTO principals VALUES('test-agent','agent','P1a テストエージェント',NULL,1,1);
INSERT OR IGNORE INTO principals VALUES('test-agent-2','agent','P1a 別主体',NULL,1,1);
INSERT OR IGNORE INTO passwords VALUES('test-human',${q(encoded)});
INSERT OR IGNORE INTO auth_settings VALUES('dummy_password_hash',${q(dummy)});
INSERT OR IGNORE INTO api_credentials VALUES('test-key','test-agent',${q(hash(fixture.agentToken))},${expiration},NULL);
INSERT OR IGNORE INTO api_credentials VALUES('test-key-2','test-agent-2',${q(hash(fixture.secondAgentToken))},${expiration},NULL);
INSERT OR IGNORE INTO memberships VALUES('test-human','PTORDEV','view');
INSERT OR IGNORE INTO memberships VALUES('test-human','PTORDEV','edit');
INSERT OR IGNORE INTO memberships VALUES('test-agent','PTORDEV','view');
INSERT OR IGNORE INTO memberships VALUES('test-agent','PTORDEV','edit');
INSERT OR IGNORE INTO memberships VALUES('test-agent-2','OTHER','view');
INSERT OR IGNORE INTO api_grants VALUES('test-key','PTORDEV','view');
INSERT OR IGNORE INTO api_grants VALUES('test-key-2','OTHER','view');
`;
await writeFile(sqlPath,sql,{mode:0o600});
const result=execute(['--file',sqlPath]);
if(result.status!==0){console.error('Local synthetic seed failed');process.exit(result.status??1);}
console.log('P1a synthetic principals and scoped credentials seeded into local D1. Values are not logged.');
