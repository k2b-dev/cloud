### Ask for diagnostics access again after changing servers

- **What happened:** Changing the NATS diagnostics server list kept its saved system access.
- **Root cause:** The endpoint and access were independent settings with no stored association; changing or importing one left the other available.
- **Error class:** Related configuration values saved independently.
- **Guard:** NATS settings integration tests cover discarded access through the per-key admin settings API, unchanged servers, endpoint bindings, missing-row environment import, and diagnostics that never connect without replacement access; form behavior tests require re-entry and save servers before access.
