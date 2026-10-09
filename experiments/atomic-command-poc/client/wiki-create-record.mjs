const canonical=x=>JSON.stringify(x,Object.keys(x??{}).sort());
const fail=()=>{throw Object.assign(Error('WIKI_CREATE_BINDING_MISMATCH'),{code:'WIKI_CREATE_BINDING_MISMATCH'});};
export function validateWikiCreateRecord(record,{pageId,scope,session}){
 if(!record||record.pageId!==pageId||canonical(record.createScope)!==canonical(scope)||record.active!=='create'||!record.drafts||Object.keys(record.drafts).length!==1||!record.drafts.create)fail();
 const d=record.drafts.create;if(d.mode!=='create'||d.value?.pageId!==pageId||canonical(d.value.scope)!==canonical(scope))fail();
 const j=record.journal;if(j){const c=j.command;if(session&&(c?.workspaceId!==session.workspaceId||c?.workspaceEpoch!==session.workspaceEpoch))fail();if(j.key!=='create'||c?.commandType!=='Wiki.Create'||c.entityId!==pageId||c.payload?.pageId!==pageId||canonical(c.payload.scope)!==canonical(scope)||c.expectedVersion!==0)fail();}
 return record;
}
