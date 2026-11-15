### Read models must preserve reader evidence and response parity

- **What happened:** A Code owner could see anonymous targets, activity counters used Action titles, and a deployed CLI refused additive fields in successful responses.
- **Root cause:** Owner checks and target naming separately spent a single child Query; counter text ignored saved outcome wording. The current CLI already shares the server schemas; the deployed bundle or module resolution is suspected to differ and must be checked during preview integration.
- **Error class:** Repeated authority-dependent reads, lost presentation evidence, and stale client contracts.
- **Guard:** Core owner/name reuse and denial tests, persisted counter integration tests, cron range tests, and CLI lifecycle tests with current server-validated additive fields. The larger reader-batch question is tracked in #3423; complete fixture examples in #3424. Stale served bundles still require deployment verification; this PR does not guard a mismatched deployed revision.
