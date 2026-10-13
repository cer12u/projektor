// @module identity
// @role private-identity
import type { Identity,Permission } from "../../../modules/identity/dto";
import * as store from './db';
export async function identity(db: store.AuthDB, auth: store.Authenticated, now: number): Promise<Identity> {
  const rows = await store.grants(db,auth,now);
  const projects = new Map<string,Permission[]>();
  for (const row of rows) { const permissions = projects.get(row.project_id) ?? []; permissions.push(row.permission); projects.set(row.project_id,permissions); }
  return {principal:{id:auth.id,kind:auth.kind,displayName:auth.display_name},authentication:auth.authentication,
    projects:[...projects].map(([id,permissions])=>({id,permissions})), ...(auth.authentication==='session' && auth.csrf_token ? {csrfToken:auth.csrf_token} : {})};
}
