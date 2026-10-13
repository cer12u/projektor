// @module verification
// @role mcp-auth-fixture
// Isolated test entrypoint only; never imported by the product router.
import {createIdentityModule} from "../../src/adapters/d1/identity/assembly";
import {federationConfig,type FederationEnv} from "../../src/apps/mcp/configuration";
import {boundedJwksFetch} from "../../src/adapters/external-identity/access-assertion";
import {ApiError} from "../../src/adapters/protocol-errors";
import {MutationError} from "../../src/adapters/d1/persistence/public";
import {assembleWorkContent} from "../../src/adapters/d1/work/assembly";
import {decodeIssueChange} from "../../src/modules/work/public";
import {readValue,resultValue,changeValue,DeliveryFailure} from "../../src/apps/http/outcomes";
interface TestEnv extends FederationEnv {DB:D1Database}
export default {async fetch(request:Request,env:TestEnv){
 try {
  const config=federationConfig(env);if(!config)return Response.json({disabled:true},{status:404});
  const path=new URL(request.url).pathname,db=env.DB.withSession('first-primary');
  if(path==='/bounded-fetch'){await boundedJwksFetch(config.issuer)(config.issuer+'/cdn-cgi/access/certs',{headers:new Headers(),method:'GET',redirect:'manual',signal:new AbortController().signal});return Response.json({ok:true});}
  if(new URL(request.url).origin!==config.origin)throw new ApiError(403,'origin_rejected');
  const verified=await createIdentityModule(db,Math.floor(Date.now()/1000)).authenticateFederated(request.headers.get('Cf-Access-Jwt-Assertion')??'',config),auth=verified.proof;
  const work=assembleWorkContent(db,auth).api;
  if(auth.authentication!=='federated')throw new Error('fixture authentication mismatch');
  if(path==='/revoke-before-read'||path==='/revoke-before-identity')await db.prepare('UPDATE federated_credentials SET revoked_at=unixepoch(),revision=revision+1 WHERE id=?').bind(auth.federated_credential_id).run();
  if(path==='/scope-before-write')await db.prepare("DELETE FROM federated_grants WHERE credential_id=? AND permission='edit'").bind(auth.federated_credential_id).run();
  if(path==='/member-before-write')await db.prepare("DELETE FROM memberships WHERE principal_id=? AND permission='edit'").bind(auth.id).run();
  if(path==='/expiry-before-write')await db.prepare('UPDATE federated_credentials SET expires_at=unixepoch()-1,revision=revision+1 WHERE id=?').bind(auth.federated_credential_id).run();
  if(path==='/principal-before-write')await db.prepare('UPDATE principals SET auth_version=auth_version+1 WHERE id=?').bind(auth.id).run();
  if(path==='/assertion-before-write')await new Promise(resolve=>setTimeout(resolve,2100));
  if(path.endsWith('before-write')||path==='/write')return Response.json(await changeValue(work.changeIssue(decodeIssueChange('P',undefined,{operationId:path==='/write'?'fed-operation':'race-'+path.slice(1),title:'Federated task',body:'Durable body'}))));
  if(path==='/receipt')return Response.json(await resultValue(work.issueResult({projectId:'P',operationId:'fed-operation'})));
  if(path==='/revoke-before-read'){const id=await db.prepare("SELECT id FROM issues WHERE created_by_id='A' LIMIT 1").first<string>('id');return Response.json(await readValue(work.getIssue({projectId:'P',issueId:id!})));}
  if(path==='/other')return Response.json(await readValue(work.listIssues({projectId:'OTHER',query:{q:'',state:'',mine:true,page:1,pageSize:20,order:'priority'}})));
  if(path==='/issues')return Response.json(await readValue(work.listIssues({projectId:'P',query:{q:'',state:'',mine:true,page:1,pageSize:20,order:'priority'}})));
  return Response.json(await verified.api.current());
 }catch(error){if(error instanceof DeliveryFailure)return Response.json(error.body,{status:error.status});if(error instanceof ApiError||error instanceof MutationError)return Response.json({error:error.code},{status:error.status});return Response.json({error:'test_unavailable'},{status:503});}
}};
