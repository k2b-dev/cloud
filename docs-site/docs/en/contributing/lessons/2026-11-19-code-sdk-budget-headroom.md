### SDK discovery used nearly the entire tool result budget

- **What happened:** New capabilities pushed the Code chat SDK index plus two large apps against the 256000-byte tool result budget.
- **Root cause:** Discovery included descriptions for every installed method and event, even when the agent needed declarations from only two apps. The budget test allowed the catalog to consume the entire allowance; measuring only a compact index also misses descriptions loaded later.
- **Error class:** A growing catalog exhausts a shared response budget without reserved headroom.
- **Guard:** The real-catalog `chat-sdk.test.ts` budgets the compact index, the two largest apps' described rows and their declarations together at 90% of the unchanged allowance, using serialized UTF-8 bytes. Both conservative and combined totals must fit. Schema and service tests require an explicit selection of at most two apps for descriptions; compaction tests preserve literals and documentation and parse the resulting declarations.
