### Resolve server imports through published entry points

- **What happened:** Runner typechecking failed on the Code read model's schedule import after Core and Cloud typechecks had passed.
- **Root cause:** Their broad SSR path aliases resolved an unpublished path. Runner resolves package exports and could not find it; its required typecheck had been omitted locally.
- **Error class:** Workspace aliases conceal an invalid public import and an incorrect layer dependency.
- **Guard:** Pure schedule wording lives behind the portable `@k2b/cloud/code/schedule` export. Its unit test imports the public entry and pins parity with the existing SSR entry. Run Runner, Core, Cloud and Assistant typechecks for this shared path; Core and Cloud alone cannot verify package resolution.
