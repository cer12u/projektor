// @module administration
// @role composition
import {usePrincipalRegistrationFormController} from './principal-registration-controller';
import {PrincipalRegistrationFormView} from './principal-registration-view';
import {ManagementClient} from './management-client';
import {type ManagementRecord} from './management-model';
export function PrincipalRegistrationForm({api,projects,onSaved,onError,onLock}:{api:ManagementClient;projects:string[];onSaved:(r:ManagementRecord)=>void;onError:(error:unknown)=>void;onLock:(locked:boolean)=>void}){return <PrincipalRegistrationFormView model={usePrincipalRegistrationFormController({api,projects,onSaved,onError,onLock})}/>;}
