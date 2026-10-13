// @module tooling.schema
// @role preflight
// Public compatibility exports and executable CLI composition only.
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {runPreflight} from "./preflight-cli.mjs";
export {ledgerSQL} from "./ledger.mjs";
export {sqlTokens} from "./sql-tokens.mjs";
export {snapshot} from "./snapshot.mjs";
export {expectedChain} from "./chain.mjs";
export {assess} from "./assessment.mjs";
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) await runPreflight();
