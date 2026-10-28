### Output limits hide unbounded state queries

- **What happened:** A short response groups unread state for the whole directory before selecting candidates.
- **Root cause:** Output limits hide unbounded state queries.
- **Error class:** Output limits hide unbounded state queries
- **Guard:** Tests: Chat thread service requires explicit bounded IDs on every state query and preserves selected and recent candidates.
