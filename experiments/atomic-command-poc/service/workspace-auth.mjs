// Selection is deployment-owned and runs independently at ingress and Store.
// No caller-supplied identity, actor object or trusted-verifier callback exists.
import { authenticate } from './auth.mjs';
import { createLegacyApiTokenVerifier, legacyApiTokenMode } from './legacy-bearer.mjs';
export async function authenticateWorkspace(request, env, kind, workspaceId) {
 const enabled = legacyApiTokenMode(env);
 if (!enabled || kind !== 'machine') return authenticate(request, env, kind);
 const authorization = request.headers.get('authorization') ?? '';
 // Access JWTs retain their original signature/audience verifier. Invalid JWTs
 // never fall back to a second authentication strategy after verification fails.
 if (/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/i.test(authorization)) return authenticate(request, env, kind);
 return createLegacyApiTokenVerifier({ sourceDb: env.DB, providerConfig: env.PROVIDER_CONFIG })(request, workspaceId);
}
