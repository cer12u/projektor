// @module administration
// @role composition
import {useManagementSetupController} from './management-setup-controller';
import {ManagementSetupView} from './management-setup-view';
import {type ManagementClient} from './management-client';
import type {SetupSubmission} from './management-model';
export function ManagementSetup({api,principalId,active,disabled,pendingOperation,onPendingOperation,onError,onLock}:{api:ManagementClient;principalId:string;active:boolean;disabled:boolean;pendingOperation:SetupSubmission|null;onPendingOperation:(value:SetupSubmission|null,expectedOperationId?:string)=>boolean;onError:(error:unknown)=>void;onLock?:(locked:boolean)=>void}){return <ManagementSetupView model={useManagementSetupController({api,principalId,active,disabled,pendingOperation,onPendingOperation,onError,onLock})}/>;}
