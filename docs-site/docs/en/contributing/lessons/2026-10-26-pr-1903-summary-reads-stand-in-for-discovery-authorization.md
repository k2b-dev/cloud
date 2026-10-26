### Summary reads stand in for discovery authorization

- **What happened:** An ID-ordered summary page never reaches a newly active item beyond its candidate boundary.
- **Root cause:** Summary reads stand in for discovery authorization.
- **Error class:** Summary reads stand in for discovery authorization
- **Guard:** Tests: Chat store sidebar discovery requires the authorized short thread read before renewal and rejects failed discovery.
