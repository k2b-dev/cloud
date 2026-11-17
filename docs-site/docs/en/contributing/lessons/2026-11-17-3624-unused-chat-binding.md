### Require a bound chat only when the Code uses it

- **What happened:** Archiving the originating chat made a page or an automation that posts through the Chat application appear to need a chat in Code attention and Waiting for you.
- **Root cause:** The missing-chat predicate treated any stored binding as a dependency, although chat initialization also binds Code that never uses `chat.send`.
- **Error class:** Stored context was mistaken for an active dependency.
- **Guard:** Chat-binding integration tests initialize both a page and a Chat-application sender from a chat, archive it, and verify that version notices, both attention Queries and Waiting for you remain clear. SSR and browser regressions also verify that the Code page follows Core's notice, including the normal state and absence of recovery controls in both languages on desktop and phone. The SQL meter verifies that unused bindings require no chat lookup and keeps the bound sender's three/four-statement budget.
