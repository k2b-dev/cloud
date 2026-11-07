### A default application filter hid platform settings

- **What happened:** `cld admin settings show logs.trace_retention_days` reported an unknown setting without `--app`.
- **Root cause:** The catalog treated an omitted application as an explicit Core-only filter, excluding registered platform settings used by list, show and set.
- **Error class:** Conflating an omitted scope with an explicit owner.
- **Guard:** `api/admin-settings-env.test.ts` checks the real catalog through the authenticated API, including hidden platform keys, secret stripping and explicit Core scoping. `cli/admin/settings.test.ts` covers platform list, show and set routing.
