// @module work
// @role transaction-spi
/** Bounded SQL-time Work participants for atomic Identity and Execution integration. */
import {sql,type Sql} from "../primitives";
import {validateIssueRoute} from "../../../modules/work/rules";
import {issueExists,issueAssigned} from "./recovery-policy";
export const validateIssueIdentity=validateIssueRoute;
export const issueVisibleSql=issueExists;
export const issueAssignedSql=issueAssigned;

/** A first Identity relation may name only a current Work-owned project/workspace.
 * This projection grants no authority and discloses no content; callers include it
 * in their own current-authorized atomic transaction, never a preauthorization read.
 */
export function scopeExistsSql(scope:Sql):Sql {
 return sql(`EXISTS(SELECT 1 FROM projects WHERE id=${scope.text}) OR EXISTS(SELECT 1 FROM workspaces WHERE 'workspace:'||id=${scope.text} AND length(id)=36 AND id NOT GLOB '*[^a-fA-F0-9-]*')`,...scope.values,...scope.values);
}
