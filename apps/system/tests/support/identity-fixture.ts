// @module verification
// @role identity-fixture
/** Test composition only: exercise the production credential grammar and Identity implementation. */
import {createIdentityModule} from "../../src/adapters/d1/identity/assembly";
import {parseCredentialEvidence} from "../../src/apps/http/credentials";
import type {AuthDB} from "../../src/adapters/d1/primitives";
export async function authenticate(request:Request,db:AuthDB,now:number){
 return (await createIdentityModule(db,now).authenticate(parseCredentialEvidence(request))).proof;
}
