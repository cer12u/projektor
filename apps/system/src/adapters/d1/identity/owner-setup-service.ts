// @module identity
// @role private-d1
import type {AuthDB} from './auth-types';
export const OWNER_BOOTSTRAP_CONFIG='owner_web_bootstrap';
export function readOwnerSetupConfiguration(db:AuthDB):Promise<string|null>{
 return db.prepare('SELECT value FROM auth_settings WHERE key=?').bind(OWNER_BOOTSTRAP_CONFIG).first<string>('value');
}

export function readOwnerBrowserBinding(db:AuthDB,rightHash:string):Promise<string|null>{
 return db.prepare('SELECT value FROM auth_settings WHERE key=?').bind('owner_web_right:'+rightHash).first<string>('value');
}
