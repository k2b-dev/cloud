### Derive handover instructions from authoritative state

- **What happened:** Gustav asked an author to switch on a version while administrator approval was still pending, and used a task-list method on the wrong SDK receiver.
- **Root cause:** Submit returned a saved version without an authoritative next step. Generic handover guidance always suggested switching on. Unknown-method diagnostics did not name the bad call and listed unrelated methods before the exact match.
- **Error class:** Model guidance diverges from authoritative state and generated contracts.
- **Guard:** The authoring integration test compares a member's submit next step with the card's approval readiness. Skill and tool tests require that guidance; SDK index and checker tests pin the real paginated query and the named correction in both languages.
