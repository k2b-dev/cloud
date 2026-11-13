### Match directory users by their directory identity, not by email

- **What happened:** The FreeIPA synchronization could attach a new directory user to an existing Cloud account that had the same email. When two directory users shared an email, the whole synchronization stopped with a uniqueness error.
- **Root cause:** To follow username changes, the synchronization looked up existing FreeIPA accounts by email before the username, and **Migrate matching local account** linked a local account by email alone. An email address can change or be reused, so it does not identify a directory user.
- **Error class:** A mutable or reusable attribute is used as the identity key when matching accounts across systems.
- **Guard:** Accounts store FreeIPA's unchanging entry ID (`ipaUniqueID`) and match by it, or once by username before the ID is stored. Email conflicts are logged and skipped. `packages/cloud/src/services/ipa/sync-identity.integration.test.ts` covers a new user with a known email, a rename, a reused username, an email collision and the proposal-only migrate mode. `sync-planning.test.ts` covers the matching rules.
