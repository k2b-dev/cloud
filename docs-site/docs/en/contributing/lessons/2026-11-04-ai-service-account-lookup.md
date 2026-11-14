### A shared access dialog needs its target-aware service-account lookup

- **What happened:** AI Skill and Project permissions could edit existing service-account grants but could not add a Code account by its identifier.
- **Root cause:** The administration actions did not supply `findServiceAccount`; their targets also lacked a reader view carrying Manage for the existing entity lookup.
- **Error class:** An optional UI adapter drops an existing principal kind when a consumer moves to a shared editor.
- **Guard:** `packages/core/test/ai-access-admin.behavior.test.tsx` finds and saves a Code row for both targets; `ai-principal-search-target.integration.test.ts` exercises the real entity route with current target grants, exact and unknown identifiers, and names, then saves and reloads the Code grant through the Administration API.
