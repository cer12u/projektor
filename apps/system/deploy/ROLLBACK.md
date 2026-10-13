# Recovery and rollback limits

1. Read the saved journal and provider outcome before any retry. Unknown, cancelled, denied or stopped operations must not be replayed blindly. A local empty directory is not proof of no prior operation on another executor.
2. Upload and promotion are separate. An uploaded version without verified traffic does not mean production changed. Never promote without the matching local artifact/upload receipt and fresh permitted version/prerequisite observations.
3. The journal blocks truncated, corrupt, mismatched-release and explicit-stop states. It supports read-only reconciliation when a trustworthy version ID exists. No version ID means no guessed search match or mutation replay.
4. Re-promoting an older Worker requires compatibility review against the actual schema and committed state. Additive0018/0019 do not prove an older Worker understands the new owner/recipient recovery protocol.
5. Do not drop new context tables, erase ledger entries, discard receipts/intents/history, restore an old snapshot over later writes, reissue setup credentials or change access policy to imitate rollback. Preserve stopped writes and prefer a reviewed forward correction.
6. The kit does not supply a destructive database down migration or automatic rollback. Production actions require the appropriate approved scope and existing authorized execution route.
