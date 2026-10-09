// Selection is deployment-owned and runs independently at ingress and Store.
// No caller-supplied identity, actor object or trusted-verifier callback exists.
import { authenticate,AuthError } from './auth.mjs';
import {configuration} from './config.mjs';
import { createLegacyApiTokenVerifier, legacyApiTokenMode } from './legacy-bearer.mjs';
export async function authenticateWorkspace(request, env, kind, workspaceId) {
 const enabled = legacyApiTokenMode(env);
 if(env.APP_AUTH_CONFIG!==undefined){
  if(!configuration(env).appAuth)throw new AuthError('SERVICE_CONFIG_INVALID',503);
  if(kind!=='machine')throw new AuthError('APP_SESSION_STORE_REQUIRED',401);
  if(!enabled)throw new AuthError('MACHINE_CREDENTIAL_REQUIRED',401);
  return createLegacyApiTokenVerifier({sourceDb:env.DB,accessPerimeter:'none'})(request,workspaceId);
 }
 if (!enabled || kind !== 'machine') return authenticate(request, env, kind);
 const authorization = request.headers.get('authorization') ?? '';
 // Access JWTs retain their original signature/audience verifier. Invalid JWTs
 // never fall back to a second authentication strategy after verification fails.
 if (/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/i.test(authorization)) return authenticate(request, env, kind);
 return createLegacyApiTokenVerifier({ sourceDb: env.DB, providerConfig: env.PROVIDER_CONFIG })(request, workspaceId);
}
