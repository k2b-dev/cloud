### Group recipients stopped at user-only consumers

- **What happened:** Local machine members could inherit a group grant while application contexts and assignee lists still omitted their groups.
- **Root cause:** Group-ID lookups accepted only users, and machine recipient queries required a direct grant.
- **Error class:** Incomplete propagation of a shared identity contract.
- **Guard:** Cloud owns authoritative machine group SQL; focused tests cover both account kinds through group resolution and Spaces eligibility, including revocation and binding limits.
