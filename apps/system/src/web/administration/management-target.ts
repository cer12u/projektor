// @module administration
// @role model
import {type ManagementRecord} from './management-contracts';
export function project(record:ManagementRecord){return 'projectId'in record.snapshot?record.snapshot.projectId:undefined;}
