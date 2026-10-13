// @module administration
// @role storage
import {readManagementState} from './management-session-storage';
import {HttpError} from '../platform/index';
import {restoreManagementEdit} from './management-model';
export function savedEdit(owner:string){try{const raw=readManagementState('edit',owner);const saved=raw?restoreManagementEdit(JSON.parse(raw)):null;if(saved?.setupPending&&saved.setupPending.actorId!==owner)throw new Error('setup_actor_mismatch');return saved;}catch{throw new HttpError(409,'saved_management_edit_unavailable');}}
