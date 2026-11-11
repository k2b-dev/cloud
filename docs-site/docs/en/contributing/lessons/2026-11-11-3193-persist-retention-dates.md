### Keep published retention dates in durable state

- **What happened:** A retention-setting change recalculated a previously displayed date from the original unused start.
- **Root cause:** Reads and maintenance derived the date independently from a mutable setting instead of storing the published date and its visible start.
- **Error class:** Recomputing a published lifecycle promise from mutable configuration.
- **Guard:** Frozen-clock retention unit and integration tests cover shortening, disabling, re-enabling, reset between sweeps, all owner kinds and expiry after the shared reminder period.
