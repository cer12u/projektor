// Privileged test composition. These exports never enter the application artifact.

export { createFixture as createA } from "../modules/_fixture_a/internal/factory";
export { createFixture as createB } from "../modules/_fixture_b/internal/factory";
export { createAccess } from "../modules/access/internal/factory";
export * as oauthRules from "../modules/access/internal/oauth-rules";
export * as accessRules from "../modules/access/internal/rules";
export { membershipContract } from "../modules/access/tests/contract";
export { createProjects } from "../modules/projects/internal/factory";
export { accessConsumerContract, fakeAccess } from "../modules/projects/tests/access-fake";
export { createModuleStore, createScopedBucket, createScopedKV } from "../platform/adapters";
export { migrate } from "../platform/migrate";
export { randomIds, systemClock } from "../platform/primitives";
export { PlatformError } from "../platform/public";
