### Audit projection must notify readers after the entry commits

- **What happened:** A rule effect could refresh the reader before its audit entry existed. A skipped rule could create an entry without any conversation change to trigger another refresh.
- **Root cause:** Audit projection wrote its derived row without queuing a conversation invalidation in the same transaction. The daily AI total also counted unrelated rules in the mailbox.
- **Error class:** Derived state misses its own publication boundary; aggregates use a broader scope than their label.
- **Guard:** `automation-log.integration.test.ts` checks transactional live updates, silent unchanged recovery, undo detail reloads, and AI counts across two rules and multiple versions with assigned-only visibility. `workspace-detail.integration.test.ts` checks public trace IDs and consistent detail, refresh, and SSR payloads.
