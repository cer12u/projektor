// @module identity
// @role d1-projection-port
import {sql,type Sql} from '../primitives';
/** Adapter-only Work existence projection, injected by composition into the same SQL snapshot/batch.
 * It never decides Identity authority, grants rights, or crosses the business use-case boundary.
 */
export interface IdentityScopeProjection {exists(scope:Sql):Sql}
/** Narrow fixtures without Work composition cannot bootstrap previously unseen relationships. */
export const unavailableScopeProjection:IdentityScopeProjection={exists:()=>sql('0')};
