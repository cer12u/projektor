// A bounded, read-only page port. Caller supplies an authenticated MCP transport;
// this helper creates no credentials, retry loop, journal or hidden pagination.
const paged=new Set(['my_issues','issue_entries_list','content_revision_list','resolution_records_list','wiki_list','wiki_revision_list','links_list','backlinks_list']);
export function createMCPQueryPort({callTool,textOnly=false}){
 if(typeof callTool!=='function'||typeof textOnly!=='boolean')throw Error('MCP_QUERY_PORT_CONFIG');
 return Object.freeze({async readPage(name,args){
  if(!paged.has(name)||!args||typeof args!=='object'||Array.isArray(args))throw Error('MCP_QUERY_PAGE_ARGUMENTS');
  const request={...args,...(textOnly?{limit:1}:{})};
  const r=await callTool({name,arguments:request});
  if(!textOnly&&r&&Object.hasOwn(r,'structuredContent'))return r.structuredContent;
  if(r?.content?.length!==1||r.content[0].type!=='text')throw Error('MCP_STRUCTURED_CONTENT_REQUIRED');
  try{return JSON.parse(r.content[0].text);}catch{throw Error('MCP_STRUCTURED_CONTENT_REQUIRED');}
 }});
}
