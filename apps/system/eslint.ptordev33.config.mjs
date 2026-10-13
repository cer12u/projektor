// @module project.configuration
// @role configuration
import ts from 'typescript-eslint';
export default ts.config(...ts.configs.recommended,{files:["src/agent/public.ts","src/agent/execution-client.ts","src/agent/execution.ts","src/agent/operations.ts","src/agent/http.ts","src/agent/routes.ts","src/adapters/credentials/cloudflare-admission.ts","src/adapters/credentials/file-providers.ts"],languageOptions:{parserOptions:{project:'./tsconfig.ptordev33.json',tsconfigRootDir:import.meta.dirname}}});
