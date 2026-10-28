### Sharing pickers hid supported machine principals

Resource APIs accepted standalone and agent grants, but sharing pickers omitted them
unless each application opted in. Existing-row tests did not exercise discovery.

**Guard:** the shared picker and access CLI include machine principals by default.
Behavior tests search and select both kinds by name; token integration tests grant,
use and revoke Pulse and Venue access. The `principal-picker-kinds` check requires an
explicitly documented identity reason for an excluding shared picker.
