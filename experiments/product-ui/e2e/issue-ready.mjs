// Read-only browser predicate. A generic Markdown textarea also exists on the
// old create form while guarded navigation awaits its latest encrypted flush.
export function issueBodyReady({href=globalThis.location.href,editorMode=globalThis.document.querySelector('select[aria-label="Editor"]')?.value}={}){
  const url=new URL(href),id=url.searchParams.get('issueId');
  return url.searchParams.get('view')==='issue'&&url.searchParams.get('projectId')===null&&typeof id==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)&&editorMode==='body';
}
