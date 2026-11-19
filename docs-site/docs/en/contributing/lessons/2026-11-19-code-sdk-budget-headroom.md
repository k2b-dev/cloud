### SDK discovery used nearly the entire tool result budget

- **What happened:** New capabilities pushed the Code chat SDK index plus two large apps against the 256000-byte tool result budget.
- **Root cause:** Discovery included descriptions for every installed method and event, even when the agent needed declarations from only two apps. The budget test allowed the catalog to consume the entire allowance.
- **Error class:** A growing catalog exhausts a shared response budget without reserved headroom.
- **Guard:** The real-catalog `chat-sdk.test.ts` requires both the conservative estimate and the combined index plus two largest app declarations to stay within 90% of the unchanged budget, measuring serialized UTF-8 bytes. It also checks that descriptions remain available on demand and that the compact index preserves every method, policy and event.
