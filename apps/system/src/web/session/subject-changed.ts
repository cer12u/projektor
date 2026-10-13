// @module browser-session
// @role model
import type {Identity} from "../../modules/identity/dto";
export class SubjectChanged extends Error{constructor(public identity:Identity){super('subject_changed');}}
