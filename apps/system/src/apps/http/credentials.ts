// @module delivery
// @role credential-input
import {readCookie,SESSION_COOKIE} from "./security";
import {ApiError} from "../../adapters/protocol-errors";
/** HTTP credential grammar only; Identity alone verifies the resulting evidence. */
export function parseCredentialEvidence(request:Request):{kind:'session'|'api';token:string}{
 const session=readCookie(request,SESSION_COOKIE),authorization=request.headers.get('Authorization');
 if(session&&authorization)throw new ApiError(400,'ambiguous_authentication');
 if(authorization){const match=authorization.match(/^Bearer ([A-Za-z0-9_-]{43})$/);if(!match)throw new ApiError(401,'unauthenticated');return{kind:'api',token:match[1]};}
 if(session)return{kind:'session',token:session};
 throw new ApiError(401,'unauthenticated');
}
