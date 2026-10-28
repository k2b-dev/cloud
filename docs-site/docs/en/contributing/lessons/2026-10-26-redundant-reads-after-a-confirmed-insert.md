### Redundant reads after a confirmed insert

- **What happened:** First sync repeats content updates and queries state that cannot exist for a newly inserted message, multiplying database latency.
- **Root cause:** Newly inserted messages followed the existing-copy update and lookup path.
- **Error class:** Redundant reads after a confirmed insert
- **Guard:** Test: Mail `lifecycle.integration.test.ts` counts PostgreSQL commands for a 200-envelope import and replays it to check canonical IDs, conversations and read state. Only a confirmed insert skips these reads; existing and raced copies keep the full path ([#1487](https://github.com/k2b-dev/cloud/issues/1487)).
