// @module tooling.schema
// @role chain
import {DatabaseSync} from 'node:sqlite';
import {readFile,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {snapshot} from './snapshot.mjs';
import {appShape} from './shape.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
export async function expectedChain(migrationsDir=resolve(root,'migrations')) {
 const files=(await readdir(migrationsDir)).filter(n=>n.endsWith('.sql')).sort();
 const db=new DatabaseSync(':memory:'), states=[appShape(snapshot(db))], migrations=[];
 try { for(const name of files) {const sql=await readFile(resolve(migrationsDir,name),'utf8');db.exec(sql);migrations.push({name,sha256:createHash('sha256').update(sql).digest('hex')});states.push(appShape(snapshot(db)));} }
 finally {db.close();}
 return {states,migrations};
}
