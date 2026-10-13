// @module workbench
// @role composition
import {useIssueExecutionController,type ExecutionPanelProps} from './issue-execution-controller';
import {IssueExecutionView} from './issue-execution-view';
export function IssueExecutionPanel(props:ExecutionPanelProps){return <IssueExecutionView model={useIssueExecutionController(props)}/>;}
