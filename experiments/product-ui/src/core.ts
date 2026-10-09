/** Reviewed shared modules: frozen I2 plus the separately reviewed manual-recovery patch and human-workflow extension. These casts stop inferred legacy JS
 * constructor defaults from redefining the UI port types. No core edits here. */
import {HumanWorkflowController as Content} from '../vendor/session-ports/human-workflow.mjs';
import {MyIssuesController as List} from '../vendor/browser/my-issues.mjs';
export const IssueContentController:any=Content;
export const MyIssuesController:any=List;
export {preserveMarkdownInput} from './markdown.ts';
