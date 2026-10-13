// @module tooling.schema
// @role cli
import {DatabaseSync} from 'node:sqlite';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {snapshot} from './snapshot.mjs';
import {assess} from './assessment.mjs';
export async function runPreflight() {
 const args=process.argv.slice(2);
 if(args.length!==2 || !['--database','--snapshot'].includes(args[0])) throw new Error('Usage: node scripts/schema/db-schema-preflight.mjs --database OFFLINE.sqlite | --snapshot snapshot.json');
 let s;
 if(args[0]==='--database') {const db=new DatabaseSync(resolve(args[1]),{readOnly:true});try{s=snapshot(db);}finally{db.close();}}
 else s=JSON.parse(await readFile(resolve(args[1]),'utf8'));
 const report=await assess(s);console.log(JSON.stringify(report,null,2));
 if(!['ready','current'].includes(report.status)) process.exitCode=2;
}
