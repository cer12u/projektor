/** TEST ONLY: adapt the selected-workspace I5 client contract to the frozen I2
 * harness, whose real synthetic authenticated session endpoint rejects queries.
 * This is not an I5 server implementation, issuer, authorization substitute or
 * production fallback. Real I5 session-ports ingress/provider acceptance remains
 * a separate unpassed gate. The browser always sends the selected workspace. */
const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const fail=(status,code)=>({status,body:{error:{code}}});
export async function selectedFixtureSession({url,method,workspaceId,readVerifiedSession}){
  const parsed=new URL(url);
  if(method!=='GET')return fail(405,'METHOD_NOT_ALLOWED');
  const values=parsed.searchParams.getAll('workspaceId');
  if(values.length===0)return fail(400,'WORKSPACE_SELECTION_REQUIRED');
  if(values.length!==1||[...parsed.searchParams.keys()].some(k=>k!=='workspaceId'))return fail(400,'VALIDATION');
  const selected=values[0];
  if(!uuid(selected))return fail(400,'VALIDATION');
  if(selected!==workspaceId)return fail(403,'WORKSPACE_MISMATCH');
  // The old endpoint still verifies the current HttpOnly fixture credential and
  // current membership/scopes. Nothing here creates or repairs those grants.
  const verified=await readVerifiedSession();
  if(verified.status!==200)return verified;
  if(!verified.body||verified.body.workspaceId!==selected)return fail(502,'FIXTURE_SESSION_BINDING_MISMATCH');
  return {status:200,body:structuredClone(verified.body)};
}
