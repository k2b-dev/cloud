### Reading a note no longer hid its participants

- **What happened:** People who only opened a note were absent from its participant list and saw nobody else until they edited it.
- **Root cause:** Making collaboration lazy left note presence on the collaboration socket, which readers never opened.
- **Error class:** A feature carried only by a session that an optimization made lazy disappears for users who never start it.
- **Guard:** `packages/notebooks/src/ws-reader-presence.integration.test.ts` opens a reader workspace socket and an editing collaboration session, checks mutual visibility, switching, leaving, access boundaries and one tab during collaboration. `WorkspaceEventBridge.behavior.test.tsx` checks delivery to the detail panel, late panel mounts and stale messages after navigation or reconnect.
