### Personal API keys disagreed with browser sessions in Chat

- **What happened:** A personal API key could send a Chat message but received 403 when editing, deleting or reacting, even when the same person's browser session could perform the operation.
- **Root cause:** Edit/delete and reaction services applied a blanket scope ceiling, while sending used the shared conversation access decision that exempts personal keys.
- **Error class:** Duplicated credential checks drift from the shared authorization contract.
- **Guard:** `packages/chat/src/api/credential-mutations.integration.test.ts` checks regular empty-scope and read-marked personal keys, current read/write grants, reader reactions, real OAuth tokens and machine credentials. `packages/chat/src/api/oauth-scope.integration.test.ts` inventories every protected mutation against a real read-only OAuth token. `packages/chat/src/service/access.test.ts` checks the shared mutation-scope decision.
