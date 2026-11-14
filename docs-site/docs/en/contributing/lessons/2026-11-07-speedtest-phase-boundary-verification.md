### Verify the server budget after the last transfer phase

- **What happened:** A server capacity refusal arriving at the phase deadline could lose the race to normal cancellation and leave a successful-looking result.
- **Root cause:** A phase boundary settled the request race before the server's budget state was checked.
- **Error class:** Failure hidden by cancellation at a deadline boundary.
- **Guard:** The shared engine reserves at most 250 ms inside its existing total deadline for a bounded final status check. Fixed-clock engine tests reject a boundary capacity refusal and a hanging verification without extending the 14-second limit.
