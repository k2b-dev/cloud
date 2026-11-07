### Administration detail projections diverged from their source contracts

- **What happened:** App details included retired sent events and hid new subscriptions when the application clock lagged behind the database. The apps CLI rendered a table for JSONL and left some human-facing text untranslated.
- **Root cause:** The detail read omitted the catalog's retirement filter and compared database timestamps with the application clock. The CLI bypassed the shared list output helper and localized only part of its text.
- **Error class:** Divergent administration projections and output modes.
- **Guard:** `packages/cloud/src/services/app-details.integration.test.ts` checks retirement, exact database-time boundaries and clock skew; `packages/cloud/src/cli/apps.test.ts` checks every output mode, German text and omitted-entry counts.
