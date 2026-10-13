// @module work
// @role public-value-policy
import type {EditingResource} from './content-model';
export const bodyLimit=(r:Pick<EditingResource,'kind'>)=>r.kind==='wiki'?32768:8192;
export const blankBodyAllowed=(r:Pick<EditingResource,'kind'>)=>r.kind==='wiki';
