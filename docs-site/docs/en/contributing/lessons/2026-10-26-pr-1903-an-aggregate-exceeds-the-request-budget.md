### An aggregate exceeds the request budget

- **What happened:** A recursive count keeps a request busy without a usable answer.
- **Root cause:** An aggregate exceeds the request budget.
- **Error class:** An aggregate exceeds the request budget
- **Guard:** Test: Chat `service/channels.integration.test.ts` checks overlapping and cyclic groups, a bounded SQL timeout, a visible unavailable response, and restoration of the surrounding transaction.
