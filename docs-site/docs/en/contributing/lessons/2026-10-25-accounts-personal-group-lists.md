### Personal Linux groups appeared as account memberships

- **What happened:** Accounts offered a personal-groups filter and included personal groups in a person's membership list.
- **Root cause:** Human-facing lists opted into internal identity groups, and exact membership hydration bypassed the default discovery filter.
- **Error class:** An implementation detail is presented as a team membership.
- **Guard:** Accounts personal-groups behavior and page render tests keep the filter absent, drop the old list flag, and show only ordinary direct and indirect memberships. The personal-groups integration test keeps dashboard and widget counts aligned with normal group discovery.
