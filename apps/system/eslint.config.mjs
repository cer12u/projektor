// @module project.configuration
// @role configuration
import tseslint from 'typescript-eslint';
export default tseslint.config(
  { ignores: ['node_modules/**', 'dist/**', 'src/adapters/crypto/generated/**', 'worker-configuration.d.ts', '.wrangler/**'] },
  ...tseslint.configs.recommendedTypeChecked,
  { files: ['src/**/*.{ts,tsx}', 'tests/support/mcp-*.ts', 'tests/support/identity-fixture.ts', 'tests/support/p2-fixture/**/*.ts', 'tests/support/p2-02-fixture/**/*.ts', 'tests/support/p2-03-fixture/**/*.ts', 'scripts/p3-26-27-fixture/**/*.ts', 'scripts/access3-fixture/**/*.ts', 'scripts/compat-fixture/**/*.ts', 'src/agent/public.ts', 'scripts/ptordev35-convert.ts', 'scripts/ptordev37-bulk-sql.ts'], languageOptions: { parserOptions: { project: './tsconfig.json' } },
    rules: { '@typescript-eslint/no-floating-promises': 'error', '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: false }] } },
);
