// @module tooling.schema
// @role shape
import {sqlTokens} from './sql-tokens.mjs';
export function appShape(s) {
 return {
  objects:s.objects.filter(x=>!['d1_migrations','_cf_METADATA','_cf_KV'].includes(x.name) && !['d1_migrations','_cf_METADATA','_cf_KV'].includes(x.tbl_name)).map(x=>({...x,sql:sqlTokens(x.sql)})),
  tables:Object.fromEntries(Object.entries(s.tables).filter(([name])=>!['d1_migrations','_cf_METADATA','_cf_KV'].includes(name))),
 };
}
export function differences(actual,expected) {
 const a=new Map(actual.objects.map(o=>[o.type+':'+o.name,o]));
 const e=new Map(expected.objects.map(o=>[o.type+':'+o.name,o]));
 const result=[];
 for(const [key,obj] of e) {if(!a.has(key))result.push('missing '+key);else if(JSON.stringify(a.get(key))!==JSON.stringify(obj))result.push('definition differs '+key);}
 for(const key of a.keys()) if(!e.has(key))result.push('unexpected '+key);
 for(const [name,table] of Object.entries(expected.tables)) if(actual.tables[name] && JSON.stringify(actual.tables[name])!==JSON.stringify(table))result.push('columns/keys/indexes differ table:'+name);
 return result;
}
