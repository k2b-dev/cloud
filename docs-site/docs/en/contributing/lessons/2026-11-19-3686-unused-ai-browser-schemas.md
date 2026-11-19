### Let browser bundles omit unused AI validators

- **What happened:** Adding alarm provenance and its chat chip exceeded the Assistant PWA JavaScript budget.
- **Root cause:** The shared AI browser entry constructed queue and task validators even when the island did not import them.
- **Error class:** Unused schema initialization survives tree shaking through a shared browser entry.
- **Guard:** Keep schema construction in pure factories so unused validators can be omitted without changing their exports or validation rules. The existing `island-bundles` rule measures the production static closure; explicit schema consumers still receive the complete validators.
