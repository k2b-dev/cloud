### A "Full access" machine key had no scopes, and every application denied it

- **What happened:** An API key created for an agent or standalone account under **Accounts → Service accounts** looked active, but every application answered `403 app_access_denied`, also those open to every signed-in account (#2367).
- **Root cause:** The dialog sends `access: "full"` and no scopes, and `createStandaloneApiToken` stored the empty list. `credentialAllows` accepts an empty list only for user-delegated keys, because scopes on a machine key are its ceiling.
- **Error class:** One value means different things on the two sides of a contract: the writer stored an empty list for "full", and the reader treats it as "nothing allowed".
- **Guard:** The administrator route refuses a general key with missing or empty scopes, and the dialog names its scopes. `admin-identity.test.ts` covers the refusals, `machine-key.behavior.test.tsx` the dialog payload, `admin-identity-api-keys.integration.test.ts` real app entry, and `book-permission.integration.test.ts` allowed and denied book operations with such a key.
