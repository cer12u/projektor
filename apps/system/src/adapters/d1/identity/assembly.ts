// @module identity
// @role composition-entry
import type {AuthDB} from "../primitives";
import {identityCrypto} from "../../crypto/identity";
import {createIdentityApplication} from "../../../modules/identity/application";
import {createIdentityPersistence} from "./persistence";
import {assertionVerifier} from "../../external-identity/assertion";
export function createIdentityModule(db:AuthDB,now:number){
 return createIdentityApplication(createIdentityPersistence(db),identityCrypto,assertionVerifier,now);
}
