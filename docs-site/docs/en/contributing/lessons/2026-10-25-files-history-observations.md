### External change missed on contact

- **What happened:** Targeted history reads skip comparison with current storage, or a refused write still suppresses observation of another writer.
- **Root cause:** Missing contact wiring and incorrect ordering of a definite refusal and its follow-up comparison.
- **Error class:** Missing contact wiring and incorrect ordering of a definite refusal and its follow-up comparison.
- **Guard:** Files `service/activity-observations.integration.test.ts` exercises local Cloud item and missing-path history contacts, deduplication, and a real Filegate Office write race that must return 412, settle the failed activity, and record the external difference. POSIX contacts return `history_unavailable` without recording observations.
