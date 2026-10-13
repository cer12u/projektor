// @module maintenance
// @role composition
/** Administrative composition only. Each state owner supplies its controlled import step. */
import type {AuthDB} from "../primitives";
import {ApiError} from "../../protocol-errors";
import type {ImportDataset} from './import-contract';
import {beginWorkImport,importDatasetChunk,finishDatasetImport} from "../work/import-participant";
import {importIdentityDataset} from "../identity/import-participant";
export async function beginDatasetImport(db:AuthDB,data:ImportDataset){
 const start=await beginWorkImport(db,data);
 if(start.phase!=='verified')await importIdentityDataset(db,data);
 return start;
}
export async function importDataset(db:AuthDB,data:ImportDataset){
 const start=await beginDatasetImport(db,data);if(start.phase==='verified')return start;
 for(;;){const next=await importDatasetChunk(db,data);if(!next.remaining)break;if(!next.processed)throw new ApiError(409,'import_chunk_no_progress');}
 return finishDatasetImport(db,data);
}
export {importDatasetChunk,finishDatasetImport};
export {canonicalImportRow,identifier,noCredentials,priorityFromSource,sourceFromState,sourceScope,stateFromSource,supported,text,time,validateImportDataset,wikiRevision} from './import-contract';
export type {ImportDataset,ImportPermission,ImportSubject,SourceEntity,SourceTable} from './import-contract';
export {setWriteMode} from './write-gate';
/** Separate additive audit dataset; never alters the original core migration's receipt identity. */
export {importLegacyGateAudit} from '../work/legacy-audit-import';
