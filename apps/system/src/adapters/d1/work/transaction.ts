// @module work
// @role transaction-spi
/** SQL-time Issue target participant, exclusively for Execution integration. */
import {validateIssueRoute} from "../../../modules/work/rules";
import {issueExists,issueAssigned} from "./recovery-policy";
export const validateIssueIdentity=validateIssueRoute;
export const issueVisibleSql=issueExists;
export const issueAssignedSql=issueAssigned;
