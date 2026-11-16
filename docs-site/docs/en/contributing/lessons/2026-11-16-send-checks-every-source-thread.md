### A message send checked every quoted thread before refusing a mix

- **What happened:** A send with quotes or a reply checked read access once per source thread, up to eleven thread lookups and provider reads under the conversation lock, and only then refused sources from several threads (#3587).
- **Root cause:** The thread rule ran after the read checks, so that its 400 could not reveal an unreadable message. Keeping that guarantee forced every check to run first.
- **Error class:** Per-message work that the answer never needs, ordered for a guarantee that a cheaper answer also gives (DATA-13).
- **Guard:** Sources from several threads now get the answer of a missing message before any read check, so a send checks read access at most once. `packages/chat/src/api/message-quotes.integration.test.ts` meters the statements of a mixed send and requires them to equal those of a send with an unknown message.
