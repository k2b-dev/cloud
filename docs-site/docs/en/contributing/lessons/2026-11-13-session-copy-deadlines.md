### Session replacements keep their existing deadlines

- **What happened:** An open document connection did not close at the shared-workstation idle deadline after the browser session was replaced.
- **Root cause:** The copied session kept its last input time but did not schedule the corresponding event for its new session ID. Consent state changes also needed source events.
- **Error class:** event-based revocation: every end-of-life path of a session needs an event.
- **Guard:** Test: `packages/cloud/src/services/session/session-live.integration.test.ts` exercises real session rotation, the inherited idle deadline, consent changes, and browser sign-out through open shared-text WebSockets. Test: `packages/cloud/src/events/room-access-events.integration.test.ts` covers transactional source events and replacement expiry deadlines. Convention: every session creation or copy must schedule its inherited deadlines in the same transaction; every change to a session validity predicate must publish an identity change from its owning source.
