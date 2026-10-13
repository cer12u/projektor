// @module workbench
// @role composition
import {useWorkspaceController} from './workspace-controller';
import {WorkspaceView} from './workspace-view';
import type {WorkspaceProps} from './workspace-contracts';
export function Workspace({identity,reauth,identityChanged,onEditor}:WorkspaceProps){return <WorkspaceView model={useWorkspaceController({identity,reauth,identityChanged,onEditor})}/>;}
