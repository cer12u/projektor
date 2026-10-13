// @module identity
// @role composition-entry
import type {AuthDB} from "../primitives";
import {identityCrypto} from "../../crypto/identity";
import {createIdentityApplication} from "../../../modules/identity/application";
import {createIdentityPersistence} from "./persistence";
import {assertionVerifier} from "../../external-identity/assertion";
import {unavailableScopeProjection,type IdentityScopeProjection} from './scope-projection';
export type {IdentityScopeProjection} from './scope-projection';
export function createIdentityModule(db:AuthDB,now:number,scopes:IdentityScopeProjection=unavailableScopeProjection){
 return createIdentityApplication(createIdentityPersistence(db,scopes),identityCrypto,assertionVerifier,now);
}
