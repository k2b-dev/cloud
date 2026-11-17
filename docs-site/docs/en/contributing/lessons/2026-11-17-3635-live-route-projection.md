### Reconcile live identities and preserve uncertainty in page evidence

- **What happened:** Foreign live runs did not update their automation row. Nested page callbacks could lose Open, while shadowed routes could gain it. A start toast guessed that another run would block it.
- **Root cause:** Payload-free hints were treated as full run metadata; missing static evidence was treated as false; page selection ignored first-match hosting; a stale browser state was treated as scheduler evidence.
- **Error class:** Incomplete projections treated as facts across event, static-analysis and routing boundaries.
- **Guard:** CodePage behavior tests validate the real event schema and batch unknown IDs through the authorized metadata list, preserve newer states, deduplicate replays, and check recovery after refusal. Checker tests cover Promise and forwarding callbacks and unknown handlers. Page-link tests cover ALL, parameters, trailing slashes, declared titles and neutral root metadata. Chromium requires a neutral start toast even with another active run.
