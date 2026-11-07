### Credential kinds can share an application name

- **What happened:** The Chat provider-discovery rule rejected comparisons with the OAuth credential kind.
- **Root cause:** The rule treated every uncommon application name literal as a provider reference.
- **Error class:** Static analysis false positive across distinct platform concepts.
- **Guard:** Rule tests allow only strict OAuth credential-kind comparisons and continue to reject OAuth app IDs, resource types, and routes.
