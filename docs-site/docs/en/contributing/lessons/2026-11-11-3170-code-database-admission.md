### Conditional upserts can block database admission

- **What happened:** A concurrent first database call waited for namespace provisioning instead of returning the retryable busy result. The owner capacity setting also lacked its CLI coverage mapping.
- **Root cause:** PostgreSQL locks a conflicting row before evaluating an upsert's update condition. Namespace creation held that row while waiting for RSQL. The new setting was registered in Core but omitted from the structured CLI mapping.
- **Error class:** Conditional writes mistaken for lock-free reads, and missing registration at a checked CLI boundary.
- **Guard:** The unchanged runner bridge integration test checks heartbeat and Code admission during provisioning. The owner-capacity integration test also covers a quota increase during unfinished provisioning. The `admin-cli-settings` rule checks the existing `settings apply` command mapping.
