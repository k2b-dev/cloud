### Retire personal groups with their accounts

- **What happened:** Deleting a provisioned local account removed its mutable identity projection while retaining its personal group, additional memberships and grants.
- **Root cause:** Personal-group classification depended on a join to the surviving account, and account deletion did not own the group's retirement.
- **Error class:** Account deletion loses ownership classification but leaves dependent authority active.
- **Guard:** Cloud `personal-group-retirement.integration.test.ts` covers authorized deletion, self-deletion, expiry jobs, both IPA sync paths, provider deletion, GID reservation and transaction rollback. Core `personal-group-history.integration.test.ts` verifies idempotent live-owner backfill, one-time bounded historical inspection and conservative retirement. Core `migrations.integration.test.ts` holds an application JSON table locked during startup to catch blocking scans. Accounts `personal-group-retirement.integration.test.ts` verifies that an administrator can delete a reviewed orphan through the normal group API without freeing its GID.
