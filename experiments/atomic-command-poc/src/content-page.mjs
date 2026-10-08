import {createHash,createHmac,timingSafeEqual} from 'node:crypto';
import {Buffer} from 'node:buffer';
import {canonical,failure} from './shared-core.mjs';
const TTL=15*60*1000;
export function contentPage(db,actor,rows,args,kind,project,now=Date.now(),options={}){
 const state=db.prepare('SELECT * FROM query_state WHERE id=1').get(),seq=db.prepare('SELECT change_seq FROM workspace WHERE id=?').get(args.workspaceId).change_seq;
 if(!state||!/^[0-9a-f]{64}$/.test(state.cursor_key))return failure('UNAVAILABLE');
 const limit=args.limit??50,fp=createHash('sha256').update(canonical({kind,limit,workspaceId:args.workspaceId,workspaceEpoch:args.workspaceEpoch,entityId:args.entityId,actorId:actor.principalId,credentialId:actor.credentialId,querySchemaVersion:1,storeSchemaVersion:3,filters:options.filters??null})).digest('hex');
 const sign=p=>createHmac('sha256',Buffer.from(state.cursor_key,'hex')).update(p).digest('base64url');
 let cursor=null;
 if(args.cursor!==undefined){try{const[p,s,...rest]=args.cursor.split('.');if(rest.length||!p||!/^[A-Za-z0-9_-]{43}$/.test(s)||Buffer.from(s,'base64url').toString('base64url')!==s||!timingSafeEqual(Buffer.from(s,'base64url'),Buffer.from(sign(p),'base64url')))throw Error();cursor=JSON.parse(Buffer.from(p,'base64url').toString());if(cursor.v!==1||cursor.fp!==fp||cursor.exp-cursor.issued!==TTL||now<cursor.issued||now>=cursor.exp||!Array.isArray(cursor.last)||cursor.last.length!==2||!(Number.isSafeInteger(cursor.last[0])||typeof cursor.last[0]==='string')||typeof cursor.last[1]!=='string')throw Error();}catch{return failure('CURSOR_INVALID');}}
 const tuple=options.tuple??(r=>[kind==='entries'?r.created_at:r.recorded_at,r.id]);
 const after=r=>!cursor||tuple(r)[0]>cursor.last[0]||tuple(r)[0]===cursor.last[0]&&tuple(r)[1]>cursor.last[1];
 const eligible=rows.filter(after),items=[];let bytes=1024,index=0;
 for(;index<eligible.length&&items.length<limit;index++){const item=project(eligible[index]),size=Buffer.byteLength(JSON.stringify(item));if(bytes+size>1900*1024){if(!items.length)return failure('RECORD_TOO_LARGE');break;}bytes+=size;items.push(item);}
 let nextCursor=null;if(index<eligible.length&&items.length){const payload=Buffer.from(canonical({v:1,fp,seq:cursor?.seq??seq,revision:cursor?.revision??state.revision,issued:cursor?.issued??now,exp:cursor?.exp??now+TTL,last:tuple(eligible[index-1])})).toString('base64url');nextCursor=`${payload}.${sign(payload)}`;}
 return {data:{items,nextCursor},meta:{workspaceId:args.workspaceId,workspaceEpoch:args.workspaceEpoch,actorId:actor.principalId,changeSeq:seq,visibilityVersion:state.revision,refreshRequired:Boolean(cursor&&(cursor.seq!==seq||cursor.revision!==state.revision)),queryFingerprint:fp}};
}
