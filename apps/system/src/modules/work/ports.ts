// @module work
// @role application-contract
import type {StoredOperationFence} from "../prepared-operations";
import type {IssueChangeState,IssueChangePlan,ContentChangePlan} from "./decisions";
export type {IssueChangeState,IssueChangePlan,ContentChangePlan} from "./decisions";
import type {ChangeOutcome} from "../change-outcomes";
import type {WorkContent,IssueChange,IssueView,ContentChange,ContentView} from './public';
/** Fixed feature operations, bound to the verified actor by composition. No get/save or callbacks. */
export interface WorkContentPort extends Omit<WorkContent,'changeIssue'|'changeContent'|'changeDirectory'> {
 commitDirectoryChange(command:import('./directory-contracts').DirectoryChange,fence?:StoredOperationFence):Promise<ChangeOutcome<import('./directory-contracts').DirectoryEntity>>;
 inspectIssueChange(command:Extract<IssueChange,{kind:'edit'}>):Promise<{kind:'state';state:IssueChangeState}|{kind:'outcome';outcome:ChangeOutcome<IssueView>}>;
 rejectIssueChange(command:IssueChange,reason:string):Promise<ChangeOutcome<IssueView>>;
 commitIssueChange(command:IssueChange,plan:IssueChangePlan,fence?:StoredOperationFence):Promise<ChangeOutcome<IssueView>>;
 commitContentChange(command:ContentChange,plan:ContentChangePlan,fence?:StoredOperationFence):Promise<ChangeOutcome<ContentView>>;
}
