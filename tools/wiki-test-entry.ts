// Wiki's isolated test composition intentionally imports no Issues implementation.

export { fakeAccess } from "../modules/projects/tests/access-fake";
export { createWiki } from "../modules/wiki/internal/factory";
export * as wikiRules from "../modules/wiki/internal/rules";
export { createModuleStore } from "../platform/adapters";
export { catalogs } from "../platform/generated/catalogs";
export { migrate } from "../platform/migrate";
export { PlatformError } from "../platform/public";
