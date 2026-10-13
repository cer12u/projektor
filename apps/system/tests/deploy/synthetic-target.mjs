// @module verification
// @role deployment-contract
/** Synthetic noncredential identities used only by local deterministic contract checks. */
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
export const ACCOUNT='a'.repeat(32),WORKER='fixture-worker',DATABASE='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
export const target={account:ACCOUNT,worker:WORKER};
export const candidate=fileURLToPath(new URL('../../',import.meta.url));
export const configuration={target,databaseId:DATABASE,hostname:'fixture.example.test',gate:{mode:'stopped',epoch:4},approvedState:{security:{accessPoliciesHash:'a'.repeat(64),domainsHash:'b'.repeat(64),workerSettingsHash:'c'.repeat(64),ownerBootstrapHash:'d'.repeat(64)}},configPath:resolve(candidate,'.local/deployment/wrangler.jsonc')};
