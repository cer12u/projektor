// @module deployment
// @role port
// A release-specific port, not a generic HTTP client or provider registry.
export const CLI_VERSION='4.149.0';
export const RELEASE_ID_PATTERN=/^projektor-modular-[0-9]{8}$/;
export const CANONICAL_BASELINE_MIGRATION_TREE_SHA256='0fdaa1e0f79957cdbf8f36ed0d490c59230a409893fa71a381fad14db7c81b71';
export function assertReleaseIdentity(release){
  if(!RELEASE_ID_PATTERN.test(release?.releaseId||''))fail('RELEASE_ID_MISMATCH');
  if(!/^[a-f0-9]{64}$/.test(release.artifactTreeSha256||'')||release.uploadTag!==release.releaseId+'-'+release.artifactTreeSha256.slice(0,12))fail('RELEASE_UPLOAD_TAG_MISMATCH');
}
export const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const requiredOperations=Object.freeze(['inspectDeployment','inspectVersion','inspectPrerequisites','uploadStaticVersion','promoteVersion']);
/**
 * CloudflareReleasePort:
 * describe() -> {id,operations:{[requiredOperation]:'supported'|'unsupported'},runtimeAvailable:boolean}
 * ready() -> local toolchain/credential-policy validation; no network or new authorization
 * inspectDeployment(target) -> {target,observedAt,deploymentId,versions:[{versionId,percentage}]}
 * inspectPrerequisites(target,currentVersion) -> actual normalized DB/security/service observations;
 *   no caller-authored passed flags, stale file attestation, or version-to-service substitution.
 * inspectVersion(target,versionId) -> normalized metadata only (see wrangler-adapter)
 * uploadStaticVersion(target,release) / promoteVersion(target,versionId) -> MutationOutcome
 * MutationOutcome: {kind:'command-reported'|'outcome-unknown'|'not-started',versionId?,evidence?,error?}
 * Error kind: auth-denied | cancelled | transient | configuration | protocol | safety-stop.
 * A command report is never an observed deployment or remote byte comparison.
 */
export const managedConnector=Object.freeze({
  id:'managed-cloudflare-connector',runtimeAvailable:false,
  operations:Object.freeze({inspectDeployment:'unsupported',inspectVersion:'unsupported',inspectPrerequisites:'unsupported',uploadStaticVersion:'unsupported',promoteVersion:'unsupported'}),
  reason:'NO_SUPPORTED_NODE_TOOL_TRANSPORT',
  externalHostCapabilities:Object.freeze({metadataRead:'supported through existing tool host',d1Query:'supported through existing tool host',fullStaticRelease:'not established: no documented native asset upload or session-JWT header support'}),
});
export function fail(code) { const error=new Error(code); error.code=code; throw error; }
export function assertTarget(actual,expected) {
  if(!/^[a-f0-9]{32}$/.test(actual?.account||'')||!/^[a-z0-9][a-z0-9-]{0,62}$/.test(actual?.worker||''))fail('TARGET_DRIFT');
  if(expected&&(actual.account!==expected.account||actual.worker!==expected.worker))fail('TARGET_DRIFT');
}
export function requireCompletePort(port) {
  const description=port?.describe?.();
  if(!description?.runtimeAvailable || requiredOperations.some(op=>description.operations?.[op]!=='supported'||typeof port[op]!=='function'))fail('INCOMPLETE_STATIC_RELEASE_CAPABILITY');
  if(typeof port.ready!=='function')fail('ADAPTER_READINESS_MISSING');
  return description;
}
