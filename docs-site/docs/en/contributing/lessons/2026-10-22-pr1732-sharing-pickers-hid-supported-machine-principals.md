### Sharing pickers hid supported machine principals

- **What happened:** Resource APIs accepted standalone and agent grants, but sharing pickers omitted them unless each application opted in.
- **Root cause:** Service accounts were opt-in in the shared picker, and existing-row tests did not exercise discovery.
- **Error class:** A shared control's default hides recipients the service accepts.
- **Guard:** The shared picker and access CLI include machine principals by default. Behavior tests search and select both kinds by name; token integration tests grant, use and revoke Pulse and Venue access. The `principal-picker-kinds` check requires an explicitly documented identity reason for an excluding shared picker.
