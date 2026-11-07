### Mail backfill activity depended on diagnostic spans

- **What happened:** A successful backfill completed durably but its activity projection waited for a diagnostic span that no longer closed under problem-only tracing.
- **Root cause:** Mail treated the automatic Sync observer's span as its user-facing backfill history.
- **Error class:** Domain activity depends on optional diagnostics and inherits their sampling and retention policy.
- **Guard:** `incoming-automations.integration.test.ts` checks that an empty successful backfill has zero trace rows and exactly one activity entry after replay, trace cleanup, and rule deletion. A frozen-time upgrade test imports legacy activity twice without the unique index, deletes its trace, and still reads its original completed result. `migrate.integration.test.ts` holds an old writer during the concurrent index build and verifies that another activity insert can acquire its lock with NOWAIT. `automation-activity.test.ts` projects successful, failed, and canceled durable operations without trace fixtures.
