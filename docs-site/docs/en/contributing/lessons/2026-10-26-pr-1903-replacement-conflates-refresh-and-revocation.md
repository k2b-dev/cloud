### Replacement conflates refresh and revocation

- **What happened:** An ordinary refresh drops acknowledged live arrivals, or a delayed refresh restores a revoked window.
- **Root cause:** Replacement conflates refresh and revocation.
- **Error class:** Replacement conflates refresh and revocation
- **Guard:** Tests: Chat store latest-arrival retention, concurrent revocation, and superseded latest-response cases.
