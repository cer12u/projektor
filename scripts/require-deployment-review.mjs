// @module repository.integration
// @role deployment-stop
console.error('No deployment was executed. Build with npm run release:build; configure a private deployment target and review migrations/authentication separately. See apps/system/docs/deployment.md.');
process.exitCode = 1;
