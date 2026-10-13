import { catalogs } from "./generated/catalogs";
import { PlatformError } from "./public";

/** Operator/test entry only; not a capability available to runtime modules.
 * Each migration + its receipt is one transaction. No runtime SQL input.
 * Concurrent runners are intentionally unsupported: the operator serializes them.
 */
export async function migrate(
  db: D1Database,
  owners: readonly (keyof typeof catalogs)[],
): Promise<void> {
  const ledger = catalogs.platform;
  // Bootstrap only the fixed bookkeeping schema, without hiding later schema drift.
  await db.prepare(ledger.migrations[0].statements[0]).run();
  const applied = await db
    .prepare(ledger.queries.versions)
    .all<{ owner: string; version: string; checksum: string }>();
  for (const owner of ["platform" as const, ...owners]) {
    if (!Object.hasOwn(catalogs, owner))
      throw new PlatformError("validation", "Invalid migration owner");
    const migrations = catalogs[owner].migrations;
    const recorded = applied.results.filter((row) => row.owner === owner);
    for (const row of recorded) {
      if (
        !migrations.some(
          (migration) => migration.version === row.version && migration.checksum === row.checksum,
        )
      ) {
        throw new PlatformError("conflict", `Migration drift: ${owner}/${row.version}`);
      }
    }
    for (const migration of migrations) {
      if (recorded.some((row) => row.version === migration.version)) continue;
      await db.batch([
        ...migration.statements.map((sql) => db.prepare(sql)),
        db.prepare(ledger.queries.record).bind(owner, migration.version, migration.checksum),
      ]);
    }
  }
}
