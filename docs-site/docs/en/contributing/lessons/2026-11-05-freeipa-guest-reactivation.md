### A demoted guest could not regain its existing directory identity

- **What happened:** Approving a FreeIPA request for a demoted local guest failed because its username still existed. Deleting and recreating the directory entry changed the numeric owner of its files.
- **Root cause:** Promotion always called `user_add` and treated a local guest as proof that the remote username was available.
- **Error class:** Confusing local provider state with remote identity lifecycle state.
- **Guard:** `packages/cloud/src/services/ipa/users-reactivation.integration.test.ts` exercises real account services against a gated test database and a stateful FreeIPA fake: preserved POSIX IDs, disabled accounts, identity conflicts, interrupted reactivation and compensation, missing former directory identities, normal creation, and the approval audit/password path. `reactivation.test.ts` checks the identity decision separately.
