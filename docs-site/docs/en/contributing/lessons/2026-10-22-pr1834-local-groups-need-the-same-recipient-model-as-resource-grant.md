### Local groups need the same recipient model as resource grants

- **What happened:** Local groups could not contain standalone or agent accounts, although resource grants already accepted them.
- **Root cause:** Membership storage, selection and resolution represented only people and groups.
- **Error class:** Incomplete propagation of a shared identity contract.
- **Guard:** The canonical membership migration and authoritative group resolver cover both machine kinds. Tests check grant use and revocation, recursive relations, named rows, and eligible choices before pagination.
