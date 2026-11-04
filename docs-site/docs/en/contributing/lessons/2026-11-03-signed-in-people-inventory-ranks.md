### An upgrade inventory hid partial permission losses

- **What happened:** The signed-in-people inventory omitted machines that retained only a weaker grant, and omitted resource-bound accounts. Chat audience previews still included machines.
- **Root cause:** The inventory checked whether an alternative row existed without comparing permission ranks. Its machine list omitted one affected account kind. Chat retained its earlier machine-count term.
- **Error class:** Updating audience matching without updating migration diagnostics and audience counts.
- **Guard:** `signed-in-people-inventory.integration.test.ts` reads the documented SQL and checks weaker, equal, stronger, denied and nested-group alternatives, lost permissions and resource-bound accounts. `channels.integration.test.ts` checks that authenticated audience counts include only people. `signed-in-people.integration.test.ts` checks user identity and delegation separately after invocation resolution.
