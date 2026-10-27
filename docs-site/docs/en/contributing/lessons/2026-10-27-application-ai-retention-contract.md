### Application AI release must preserve active inference and exact identities

- **What happened:** An overly narrow release rule could leave abandoned active tasks unreleased, and prefix deletion exceeded the intended exact owner selector.
- **Root cause:** Release was confused with terminal completion instead of marking that the domain no longer needs replay. Late workers also need to settle tasks created after an earlier release found none.
- **Error class:** Conflating result retention, work cancellation and owner identity.
- **Guard:** Application AI integration tests release queued and running tasks without cancellation, preserve both 24-hour retention clocks and dormant replay, and isolate exact source deletion. Mail integration tests cover transactional release, late obsolete workers, mailbox deletion, exact orphan reconciliation and stable heartbeat recovery.
