### CLI context options must reflect credential reloads

- **What happened:** A running CLI module still read its old token from `ctx.options` after reloading a newer login.
- **Root cause:** The merge added the CI flag by copying the exposed options object, while credential reload continued updating the original object.
- **Error class:** Copying mutable context state disconnects consumers from later updates.
- **Guard:** The existing `reloadCredentials picks up a login that happened after the command started` test in `packages/cloud-cli/src/index.test.ts` checks the exposed token after reload and after a rejected profile-origin change. Context creation now adds the CI flag to the same options object that reload updates.
