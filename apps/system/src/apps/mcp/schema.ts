// @module delivery
// @role protocol-schema
import { z } from 'zod';
import { contentIdPattern } from "../../modules/work/content-contracts";
import { ISSUE_STATES } from "../../modules/work/planning-contracts";
export const identifier=z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
export const scope=z.string().regex(/^(?:workspace:)?[A-Za-z0-9_-]{1,128}$/);
export const issueId=z.string().regex(new RegExp('^'+contentIdPattern({kind:'issue'})+'$'));
export const wikiId=z.string().regex(new RegExp('^'+contentIdPattern({kind:'wiki'})+'$'));
export const commentId=z.string().regex(new RegExp('^'+contentIdPattern({kind:'comment'})+'$'));
export const attemptId=z.string().regex(/^A_[a-f0-9]{64}$/);
export const natural=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const revision=z.number().int().min(1).max(Number.MAX_SAFE_INTEGER-1);
export const text=z.string();
export const nullableText=text.nullable();
// Opaque imported records and metadata retain their source fields; surrounding contracts are closed.
export const jsonValue=z.json();
export const record=z.record(z.string(),jsonValue);
export const reference=z.discriminatedUnion('kind',[
  z.strictObject({kind:z.literal('link'),url:text.max(2048),label:text.max(512).optional()}),
  z.strictObject({kind:z.literal('library'),libraryFileId:text.regex(/^libfile_[A-Za-z0-9_-]+$/).max(256),versionId:text.regex(/^[A-Za-z0-9_.:-]+$/).max(128),fileId:text.regex(/^[A-Za-z0-9_.:-]+$/).max(256).optional(),url:text.max(2048).optional(),label:text.max(512).optional()})
]);
export const references=z.array(reference).max(32);
export const time=z.discriminatedUnion('kind',[
  z.strictObject({kind:z.literal('date'),date:text}),
  z.strictObject({kind:z.literal('instant'),at:text}),
  z.strictObject({kind:z.literal('unknown')})
]);
export const schedule=z.strictObject({start:time.nullable(),end:time.nullable(),due:time.nullable()});
export const principal=z.strictObject({id:text,kind:z.enum(['human','agent']),displayName:text});
export const issue=z.strictObject({
  id:text,projectId:text,workspaceId:nullableText,number:natural.nullable(),parentId:nullableText,typeId:nullableText,statusId:nullableText,
  createdById:nullableText,priorityKey:nullableText,metadata:record.nullable(),title:text,body:text,references,
  revision,revisionOrigin:z.enum(['native','new-import-baseline']),createdAt:text,updatedAt:text,
  priority:z.number().int().min(1).max(5).nullable(),assigneeId:nullableText,assignee:principal.extend({active:z.boolean()}).nullable(),
  state:z.enum(ISSUE_STATES),resolvedAt:nullableText,resolution:time.nullable(),schedule
});
export const document=z.strictObject({id:text,kind:z.enum(['wiki','comment']),projectId:nullableText,workspaceId:nullableText,scopeId:text,
  metadata:record.nullable(),parentKind:z.enum(['issue','wiki']).nullable(),parentId:nullableText,title:text,body:text,references,
  revision,revisionOrigin:z.enum(['native','source-version','new-import-baseline']),createdAt:text,updatedAt:text});
export const execution=z.strictObject({attemptId:text,issueId:text,projectId:text,principalId:text,startOperationId:text,
  startedAt:natural,updatedAt:natural,expiresAt:natural,leaseVersion:revision,storedState:z.enum(['running','ended','interrupted']),
  state:z.enum(['running','ended','interrupted']),endedAt:natural.nullable(),endReason:nullableText,renewIntervalSeconds:z.literal(60),leaseSeconds:z.literal(300)});
export const report=z.strictObject({sequence:natural,principalId:text,operationId:text,issueId:text,projectId:text,attemptId:text,
  kind:z.enum(['progress','failed','completed','imported']),message:text,failureReason:nullableText,references,recordedAt:natural});
export const confirmation=z.strictObject({sequence:natural,principalId:text,operationId:text,issueId:text,projectId:text,attemptId:text,
  leaseVersion:revision,outcome:z.enum(['not_performed','applied','unknown']),externalOperationId:nullableText,references,message:text,
  recordedAt:natural,newAttemptId:nullableText});
export const reports=z.strictObject({execution:execution.nullable(),reports:z.array(report),confirmations:z.array(confirmation)});
export const reconciled=z.strictObject({confirmation,importedReport:report.nullable(),nextAction:z.enum(['restart','existing_result_imported','remain_interrupted']),execution:execution.nullable()});
export const restarted=z.strictObject({attempt:execution,confirmation,nextAction:z.literal('execute_new_attempt')});
export const reportSnapshot=z.union([report,reconciled,restarted]);
export const directoryEntity=z.discriminatedUnion('kind',[
 z.strictObject({kind:z.literal('workspace'),id:identifier,scopeId:scope,name:text,revision}),
 z.strictObject({kind:z.literal('project'),id:identifier,workspaceId:identifier,key:text,slug:text,name:text,description:text,revision})
]);
export const workspaceCreate=z.strictObject({operationId:identifier,name:text.min(1).max(200)});
export const workspaceUpdate=workspaceCreate.extend({revision});
export const projectCreate=workspaceCreate.extend({workspaceId:identifier,key:text.regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/).max(128),slug:text.regex(/^[a-z0-9][a-z0-9-]*$/).max(128),description:text.max(4000)});
export const projectUpdate=z.strictObject({operationId:identifier,revision,name:text.min(1).max(200).optional(),description:text.max(4000).optional()}).refine(x=>x.name!==undefined||x.description!==undefined);
export const snapshot=z.union([issue,document,execution,reportSnapshot,directoryEntity]);
export const receipt=z.strictObject({operationId:text,snapshot});
export const mutationReceipt=receipt.extend({source:z.enum(['committed','recovered'])});
export const errorResult=z.strictObject({error:text,status:z.number().int(),fields:z.record(text,text).optional(),reason:text.optional(),current:jsonValue.optional(),
  operationId:text.optional(),application:z.literal('unknown').optional(),mutationOutcome:z.strictObject({operationId:text,status:z.literal('not_applied'),phase:z.literal('pre_dispatch')}).optional()});
export const pageInput={page:z.number().int().min(1).max(999999).default(1),pageSize:z.number().int().min(1).max(50).default(20)};
export const historyInput={afterRevision:natural.default(0),limit:z.number().int().min(1).max(50).default(20)};
export const historyEntry={revision,operationId:text,actorName:text,kind:text,beforeBody:nullableText,afterBody:text,beforeTitle:nullableText,afterTitle:text,
  beforeReferences:references.nullable(),afterReferences:references.nullable(),createdAt:text};
export const resolutionEvent=z.strictObject({revision,kind:text,time,recordedAt:text});
export const historyTail={nextAfterRevision:natural.nullable(),resolutionEvents:z.array(resolutionEvent),nextResolutionAfterRevision:natural.nullable()};
export const issueHistory=z.strictObject({history:z.array(z.strictObject({...historyEntry,issueId:text,projectId:text,actorId:text,changedFields:z.array(text),before:issue.partial().nullable(),after:issue.partial().nullable()})),...historyTail});
export const contentHistoryOutput=z.strictObject({history:z.array(z.strictObject(historyEntry)),...historyTail});
export const issueCreate=z.strictObject({operationId:identifier,body:text.max(8192),title:text.max(4096).optional(),references:references.optional()});
export const issueUpdate=z.strictObject({operationId:identifier,revision,body:text.max(8192).optional(),title:text.max(4096).optional(),references:references.optional(),
  parentId:identifier.nullable().optional(),typeId:identifier.nullable().optional(),priority:z.number().int().min(1).max(5).nullable().optional(),
  assigneeId:identifier.nullable().optional(),state:z.enum(ISSUE_STATES).optional(),schedule:schedule.optional()});
export const wikiCreate=z.strictObject({operationId:identifier,body:text.max(32768),title:text.max(4096).optional(),references:references.optional()});
export const wikiUpdate=z.strictObject({operationId:identifier,revision,body:text.max(32768).optional(),title:text.max(4096).optional(),references:references.optional()});
export const commentCreate=z.strictObject({operationId:identifier,body:text.max(8192)});
export const commentUpdate=commentCreate.extend({revision});
export const commentContext={scopeId:scope,parentKind:z.enum(['issue','wiki']),parentId:z.union([issueId,wikiId])};
export const executionChange=z.discriminatedUnion('action',[
  z.strictObject({action:z.literal('acquire'),operationId:identifier}),
  ...(['renew','end','interrupt'] as const).map(action=>z.strictObject({action:z.literal(action),operationId:identifier,attemptId,leaseVersion:revision}))
]);
export const reportInput={operationId:identifier,attemptId,leaseVersion:revision,message:text.min(1).max(4096),references:references.optional()};
export const executionReport=z.discriminatedUnion('action',[
  z.strictObject({action:z.literal('progress'),...reportInput}),
  z.strictObject({action:z.literal('completed'),...reportInput}),
  z.strictObject({action:z.literal('failed'),...reportInput,failureReason:text.min(1).max(2048)}),
  z.strictObject({action:z.literal('reconcile'),...reportInput,outcome:z.enum(['not_performed','applied','unknown']),externalOperationId:text.min(1).max(256).optional()}),
  z.strictObject({action:z.literal('restart'),operationId:identifier,attemptId,leaseVersion:revision,confirmationOperationId:identifier})
]);
export const operationResource=z.discriminatedUnion('kind',[
  z.strictObject({kind:z.literal('issue')}),
  z.strictObject({kind:z.literal('wiki')}),
  z.strictObject({kind:z.literal('execution')}),
  z.strictObject({kind:z.literal('report')}),
  z.strictObject({kind:z.literal('comment'),parentKind:z.enum(['issue','wiki']),parentId:z.union([issueId,wikiId])})
]);

export const operationRoute=z.discriminatedUnion('kind',[
  z.strictObject({kind:z.literal('project'),id:identifier.optional()}),
  z.strictObject({kind:z.literal('workspace'),id:identifier.optional()}),
  z.strictObject({kind:z.literal('issue'),projectId:identifier,id:issueId.optional()}),
  z.strictObject({kind:z.literal('wiki'),projectId:scope,id:wikiId.optional()}),
  z.strictObject({kind:z.literal('comment'),projectId:scope,parentKind:z.enum(['issue','wiki']),parentId:z.union([issueId,wikiId]),id:commentId.optional()}),
  z.strictObject({kind:z.literal('execution'),projectId:identifier,issueId,action:z.enum(['acquire','renew','end','interrupt'])}),
  z.strictObject({kind:z.literal('report'),projectId:identifier,issueId,action:z.enum(['progress','failed','completed','reconcile','restart'])})
]);
export const storedInput=z.union([
  issueCreate,issueUpdate,wikiCreate,wikiUpdate,commentCreate,commentUpdate,workspaceCreate,workspaceUpdate,projectCreate,projectUpdate,
  z.strictObject({operationId:identifier}),
  z.strictObject({operationId:identifier,attemptId,leaseVersion:revision}),
  z.strictObject(reportInput),
  z.strictObject({...reportInput,failureReason:text.min(1).max(2048)}),
  z.strictObject({...reportInput,outcome:z.enum(['not_performed','applied','unknown']),externalOperationId:text.min(1).max(256).optional()}),
  z.strictObject({operationId:identifier,attemptId,leaseVersion:revision,confirmationOperationId:identifier})
]);
const durableFields={sequence:revision,operationId:identifier,recorded:z.literal(true),
  inputHash:text.regex(/^[a-f0-9]{64}$/),route:operationRoute,
  target:z.strictObject({kind:text,targetId:text,projectId:scope}),requiredPermissions:z.array(z.enum(['view','edit','assign','transition','execute','manage'])),
  preparedAt:natural,result:z.discriminatedUnion('status',[z.strictObject({status:z.literal('unknown')}),z.strictObject({status:z.literal('confirmed'),snapshot})])};

/** Preparation remains strict. Retained pre-fencing reports are readable data, never new commands. */
const retainedReportInput={operationId:identifier,attemptId,message:text.min(1).max(4096),references:references.optional()};
const retainedUnversionedReport=z.strictObject({...durableFields,formatVersion:z.literal(1),
 route:z.strictObject({kind:z.literal('report'),projectId:identifier,issueId,action:z.enum(['progress','failed','completed'])}),
 input:z.union([z.strictObject(retainedReportInput),z.strictObject({...retainedReportInput,failureReason:text.min(1).max(2048)})])});
export const currentDurableOperation=z.strictObject({...durableFields,formatVersion:z.literal(1),input:storedInput});
export const durableOperation=z.union([currentDurableOperation,retainedUnversionedReport,z.strictObject({...durableFields,
 formatVersion:z.number().int().min(2).max(Number.MAX_SAFE_INTEGER),input:record.refine(value=>new TextEncoder().encode(JSON.stringify(value)).byteLength<=65536,'stored input exceeds 65536 UTF-8 bytes')})]);

export const operationSummary=z.strictObject({sequence:revision,operationId:identifier,formatVersion:z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),inputHash:text.regex(/^[a-f0-9]{64}$/),
  target:z.strictObject({kind:text.max(64),targetId:text.max(256),projectId:scope}),preparedAt:natural,
  result:z.strictObject({status:z.enum(['unknown','confirmed'])})});

