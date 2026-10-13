// @module tooling.schema
// @role ledger
export const ledgerSQL = `CREATE TABLE "d1_migrations"(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 name TEXT UNIQUE,
 applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);`;
