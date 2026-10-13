// @module workbench
// @role model
import {HttpError} from '../platform/index';
// Only a direct creation response with the exact server-authored pre-dispatch proof may produce this error.
export class CreationNotApplied extends HttpError{constructor(readonly operationId:string,error:HttpError){super(error.status,error.code,error.fields,error.current);}}
