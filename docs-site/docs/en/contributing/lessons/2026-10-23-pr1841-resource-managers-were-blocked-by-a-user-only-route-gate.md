### Resource managers were blocked by a user-only route gate

- **What happened:** A standalone account or agent could hold a resource's admin permission but could not manage its access through the API.
- **Root cause:** The route required a user before reaching its permission-aware service.
- **Error class:** Applying an identity-kind gate to resource authority.
- **Guard:** Spaces, Notebooks, and Contacts token tests grant both account kinds management access, use it within scopes, preserve the last manager, and deny access after revocation. Personal credential-management routes retain their separate contract.
