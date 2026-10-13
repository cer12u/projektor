// @module administration
// @role composition
import {useManagementController} from './management-controller';
import {ManagementView} from './management-view';
import type {ManagementProps} from './administration-contracts';
export function Management({identity,identityChanged}:ManagementProps){return <ManagementView model={useManagementController({identity,identityChanged})}/>;}
