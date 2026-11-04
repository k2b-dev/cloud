### Automatic runtime activity floods administrator lists

- **What happened:** Rotating app runtime keys and their audit entries displaced keys and changes that administrators needed to inspect.
- **Root cause:** Administrator pages listed automatic workload credentials and system app-workload audit events alongside human activity without a default visibility filter.
- **Error class:** Machine-generated rows drown human-relevant rows in administrator lists.
- **Guard:** `packages/cloud/src/services/automatic-admin-rows.integration.test.ts` verifies runtime-key membership, overlapping and revoked generations, ordinary keys with runtime-like names, and audit visibility with counts inside the selected filters and time window; `packages/accounts/src/frontend/automatic-admin-rows.render.test.tsx` verifies translated counts and URL toggles.
