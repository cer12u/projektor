# Canonical migration chain

The active app uses only `migrations/0001` through `0019`, in filename order, on one D1 database. `0018_owner_setup_contexts.sql` and `0019_recipient_setup_contexts.sql` add the pre-established, hash-only owner and ordinary-recipient setup contexts. The retained monorepo database lineage is reference source and must not be mixed with this chain.

Run `npm run test:deploy` for synthetic 17→19 preservation and schema-contract checks. The exact SQL hashes and eight setup schema definitions are pinned in `deploy/schema-contract.json`. Local runtime fixtures apply every canonical migration through the official pinned CLI with `--local`; they do not modify a hosted database.

Use the private deployment configuration and review `deploy/DATA-PRESERVATION.md` before any separately authorized hosted upgrade. Preserve existing rows, identifiers, operation receipts and history. Rollback selects compatible code; it does not drop the additive setup tables or undo committed data. Build and CI do not apply hosted migrations.
