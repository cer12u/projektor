// @module tooling.contracts
// @role public-schema
export function addDirectoryContract(doc){
 const S=doc.components.schemas,ref=n=>({$ref:'#/components/schemas/'+n}),str={type:'string'},id={type:'string',pattern:'^[A-Za-z0-9_-]{1,128}$'},revision={type:'integer',minimum:1,maximum:Number.MAX_SAFE_INTEGER-1},obj=(properties,required=Object.keys(properties))=>({type:'object',properties,required,additionalProperties:false}),arr=items=>({type:'array',items}),nullable=x=>({anyOf:[x,{type:'null'}]});
 S.DirectoryProject.properties.revision=revision;S.DirectoryProject.required.push('revision');
 S.DirectoryWorkspace.properties.revision=revision;S.DirectoryWorkspace.required.push('revision');
 S.ManagedProject=obj({kind:{const:'project'},id,workspaceId:id,key:str,slug:str,name:str,description:str,revision});
 S.ManagedWorkspace=obj({kind:{const:'workspace'},id,scopeId:str,name:str,revision});
 S.DirectoryEntity={oneOf:[ref('ManagedProject'),ref('ManagedWorkspace')]};
 S.DirectoryManagement=obj({canCreate:{type:'boolean'},projects:arr(ref('ManagedProject')),workspaces:arr(ref('ManagedWorkspace'))});
 const directory=doc.paths['/api/directory'].get.responses['200'].content['application/json'].schema;
 directory.properties.management=ref('DirectoryManagement');directory.required.push('management');
 doc.paths['/api/directory'].get['x-permissions']={authority:'current Identity',disclosure:'Display collections require current view. Management collections require global administration or scoped view+manage; canCreate requires global administration. No membership is granted.'};
 S.DirectoryHistory=obj({history:arr(obj({revision,operationId:id,actorId:id,recordedAt:str,before:nullable(ref('DirectoryEntity')),after:ref('DirectoryEntity')})),nextAfterRevision:nullable(revision)});
 S.DirectoryReceipt=obj({operationId:id,snapshot:ref('DirectoryEntity')});
 S.DirectoryError={anyOf:[ref('PublicError'),obj({error:{const:'forbidden'},mutationOutcome:obj({operationId:id,status:{const:'not_applied'},phase:{const:'pre_dispatch'}})})]};
 S.DirectoryMutationReceipt=obj({operationId:id,snapshot:ref('DirectoryEntity'),source:{enum:['committed','recovered']}});
 const name={type:'string',minLength:1,maxLength:200,pattern:'\\S'},description={type:'string',maxLength:4000};
 S.CreateWorkspaceInput=obj({operationId:id,name});S.EditWorkspaceInput=obj({operationId:id,revision,name});
 S.CreateProjectInput=obj({operationId:id,workspaceId:id,key:{type:'string',maxLength:128,pattern:'^[A-Za-z0-9][A-Za-z0-9_-]*$'},slug:{type:'string',maxLength:128,pattern:'^[a-z0-9][a-z0-9-]*$'},name,description});
 S.EditProjectInput={...obj({operationId:id,revision,name,description},['operationId','revision']),anyOf:[{required:['name']},{required:['description']}]};
 const response=(schema,description='JSON; Cache-Control: no-store')=>({description,content:{'application/json':{schema}}});
 function route(path,method,operationId,schema,body){doc.paths[path]??={};const result=doc.paths[path][method]={operationId,security:[{sessionCookie:[]},{individualApiBearer:[]}],parameters:[...path.matchAll(/\{([^}]+)\}/g)].map(v=>({name:v[1],in:'path',required:true,schema:id})),responses:{200:response(ref(schema)),400:response(ref('PublicError')),401:response(ref('PublicError')),403:response(ref('DirectoryError')),404:response(ref('PublicError')),409:response(ref('PublicError')),500:response(ref('PublicError')),503:response(ref('PublicError'))},'x-response-policy':{cacheControl:'no-store',contentType:'application/json',redirects:false}};
 if(body){result.requestBody={required:true,content:{'application/json':{schema:ref(body)}},'x-max-utf8-bytes':32768};result.parameters.push({name:'Origin',in:'header',required:false,schema:str,description:'Exact configured Origin required for session authentication.'},{name:'X-CSRF-Token',in:'header',required:false,schema:str,description:'Current CSRF token required for session authentication.'});}
 return result;}
 for(const [plural,singular] of [['projects','Project'],['workspaces','Workspace']]){
  const base='/api/'+plural,path=base+'/{id}';
  route(base,'post','create'+singular,'DirectoryMutationReceipt','Create'+singular+'Input').description='Global administrator only. Deterministic actor/operation-bound identifier. Atomic current authority, business insert, history and receipt; never grants membership. Same-ID replay recovers identical input only.';
  route(path,'patch','edit'+singular,'DirectoryMutationReceipt','Edit'+singular+'Input').description='Current global administrator or scoped view+manage, including credential ceiling. Revision checked atomically. IDs, project workspace, key and slug are immutable. Response disclosure rechecks current authority.';
  route(path,'get','getManaged'+singular,'Managed'+singular);
  const history=route(path+'/history','get','get'+singular+'History','DirectoryHistory');history.parameters.push({name:'afterRevision',in:'query',schema:{type:'integer',minimum:0,default:0}},{name:'limit',in:'query',schema:{type:'integer',minimum:1,maximum:50,default:20}});
 }
 route('/api/directory-operations/{operationId}','get','getDirectoryOperation','DirectoryReceipt').description='Current-authorized immutable receipt lookup. Missing or denied receipt keeps application unknown and cannot authorize a new operation ID.';
}
