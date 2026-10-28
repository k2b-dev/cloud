### Pulse pending retries, cleared usage and open settings

- **What happened:** A keyed batch that failed after its samples could not be retried once nightly retention sealed its hours; a cleared base kept refusing ingest as full; open base settings kept showing a running operation after it failed again.
- **Root cause:** Sealing looked only at the raw cutoff, not at pending reservations; the clear kept the measured usage; the dialog copied the base status once and only sources refreshed.
- **Error class:** A seal outruns a pending retry; a clear keeps the measured usage; status derived only once.
- **Guard:** Pulse's pending-seal retention test, the over-threshold clear in the lifecycle suite, and the settings browser test that follows a running clear to Retry.
