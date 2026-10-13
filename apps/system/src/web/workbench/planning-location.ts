// @module workbench
// @role adapter

export function currentZone(){const z=new URL(location.href).searchParams.get('tz')??'UTC';try{new Intl.DateTimeFormat('en',{timeZone:z});return z;}catch{return'UTC';}}

export function urlState(){const p=new URL(location.href).searchParams;return {q:p.get('q')??'',state:p.get('state')??'',mine:p.get('mine')??'1',page:p.get('page')??'1',pageSize:p.get('pageSize')??'20',zone:currentZone(),month:/^\d{4}-(0[1-9]|1[0-2])$/.test(p.get('month')??'')?p.get('month')!:new Date().toISOString().slice(0,7),view:p.get('view')??'list'};}

export function changeIssueQuery(project:string,query:ReturnType<typeof urlState>,change:Partial<ReturnType<typeof urlState>>){
 const u=new URL(location.href),next={...query,...change};
 for(const [k,v] of Object.entries(next))u.searchParams.set(k==='zone'?'tz':k,v);
 u.searchParams.set('order','priority');u.searchParams.set('project',project);history.pushState(null,'',u);
 return next;
}
