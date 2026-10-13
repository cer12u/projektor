// @module deployment
// @role credentials
import {spawnSync} from 'node:child_process';
import {assertTarget} from './cloudflare-port.mjs';
const fail = code => { throw new Error(code); };

export function guardEnvironment(env,{requireToken=true,target}={}) {
  assertTarget(target);
  const mode=env.PROJEKTOR_DEPLOYMENT_MODE||'network-secret';
  if(!['network-secret','github-actions'].includes(mode))fail('UNKNOWN_CREDENTIAL_MODE');
  if(mode==='github-actions'&&(env.GITHUB_ACTIONS!=='true'||!/^[a-f0-9]{40}$/.test(env.PROJEKTOR_EXPECTED_COMMIT||'')||env.GITHUB_SHA!==env.PROJEKTOR_EXPECTED_COMMIT))fail('GITHUB_COMMIT_CONTEXT_REQUIRED');
  if (requireToken && !env.CLOUDFLARE_API_TOKEN) fail('NETWORK_SECRET_MISSING');
  for (const key of ['CLOUDFLARE_API_BASE_URL','CF_API_BASE_URL','CLOUDFLARE_BASE_URL',
    'CLOUDFLARE_API_KEY','CF_API_KEY','CLOUDFLARE_EMAIL','CF_EMAIL','CF_API_TOKEN',
    'CLOUDFLARE_API_USER_SERVICE_KEY','WRANGLER_API_ENVIRONMENT','WRANGLER_AUTH_DOMAIN',
    'WRANGLER_AUTH_URL','WRANGLER_TOKEN_URL','WRANGLER_REVOKE_URL','WRANGLER_CLIENT_ID',
    'CLOUDFLARE_COMPLIANCE_REGION','CLOUDFLARE_ACCESS_CLIENT_ID','CLOUDFLARE_ACCESS_CLIENT_SECRET',
    'WRANGLER_CF_AUTHORIZATION_TOKEN','CLOUDFLARE_ENV','WRANGLER_CI_OVERRIDE_NAME',
    'WRANGLER_OUTPUT_FILE_PATH','WRANGLER_OUTPUT_FILE_DIRECTORY']) {
    if (env[key]) fail(`FORBIDDEN_ENV_${key}`);
  }
  if (env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_ACCOUNT_ID !== target.account) fail('WRONG_ACCOUNT');
  if (env.CF_ACCOUNT_ID) fail('FORBIDDEN_ACCOUNT_ALIAS');
  if (env.NODE_TLS_REJECT_UNAUTHORIZED === '0') fail('TLS_VERIFICATION_DISABLED');
  if (env.NODE_OPTIONS && !/^\s*(?:(?:--use-system-ca|--use-openssl-ca|--use-bundled-ca)\s*)+$/.test(env.NODE_OPTIONS)) fail('UNREVIEWED_NODE_OPTIONS');
  const httpProxy=env.http_proxy ?? env.HTTP_PROXY;
  const httpsProxy=(env.https_proxy ?? env.HTTPS_PROXY) || httpProxy;
  if (!httpsProxy && mode==='network-secret') fail('PLATFORM_HTTPS_PROXY_MISSING');
  if (httpsProxy) try { if (!['http:','https:'].includes(new URL(httpsProxy).protocol)) fail('INVALID_PROXY_PROTOCOL'); }
  catch { fail('INVALID_PLATFORM_PROXY'); }
  // Do not change the platform proxy or CA trust. Reject a bypass of the secret destination.
  for (const key of ['NO_PROXY','no_proxy']) {
    for (const raw of (env[key] || '').split(/[,\s]/)) {
      if (!raw) continue;
      const parsed=raw.match(/^(.+):(\d+)$/);
      const h=(parsed?parsed[1]:raw).replace(/^\*?\./,'').toLowerCase();
      const port=parsed?Number.parseInt(parsed[2],10):0;
      if (port && port!==443) continue;
      if (mode==='network-secret' && (h === '*' || h === 'api.cloudflare.com' || 'api.cloudflare.com'.endsWith('.'+h))) fail('SECRET_DESTINATION_PROXY_BYPASS');
    }
  }
}

// Only the adapter receives this scoped execution environment. It never reaches
// the use case, the journal, output, or a credential store. No login/refresh fallback.
export function assertGitHubCheckout(env,candidate) {
  if(env.PROJEKTOR_DEPLOYMENT_MODE!=='github-actions')return;
  if(env.GITHUB_ACTIONS!=='true'||!/^[a-f0-9]{40}$/.test(env.PROJEKTOR_EXPECTED_COMMIT||'')||env.GITHUB_SHA!==env.PROJEKTOR_EXPECTED_COMMIT)fail('GITHUB_COMMIT_CONTEXT_REQUIRED');
  const result=spawnSync('git',['-C',candidate,'rev-parse','HEAD'],{encoding:'utf8',env:{PATH:env.PATH},timeout:5000});
  if(result.status!==0||result.stdout.trim()!==env.PROJEKTOR_EXPECTED_COMMIT)fail('GITHUB_CHECKOUT_MISMATCH');
}

export function createCredentialContext(env,target,candidate) {
  assertGitHubCheckout(env,candidate);
  const check=()=>{assertGitHubCheckout(env,candidate);guardEnvironment(env,{target});};
  return Object.freeze({
    check,
    async run(operation) { check(); return operation(env); }
  });
}
