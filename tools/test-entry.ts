// Privileged test composition. These exports never enter the application artifact.

export { createFixture as createA } from "../modules/_fixture_a/internal/factory";
export { createFixture as createB } from "../modules/_fixture_b/internal/factory";
export { createModuleStore, createScopedBucket, createScopedKV } from "../platform/adapters";
export { migrate } from "../platform/migrate";
export { randomIds, systemClock } from "../platform/primitives";
export { PlatformError } from "../platform/public";
