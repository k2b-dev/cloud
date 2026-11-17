### Completed authoring must not become a pause

- **What happened:** Gustav showed a pause after a version had been submitted and its examples had passed.
- **Root cause:** The provider wrapper checked the turn budget before the closing model response and always exposed a stop receipt, even when its own tool-result snapshot confirmed every draft was submitted.
- **Error class:** A terminal guard overwrites an already completed domain outcome.
- **Guard:** `code-authoring-turn.test.ts` simulates a build with testing, repair and submission; regression cases assert that completed submissions get exactly one tool-free closing answer naming unfinished or unstarted requests. Only that successful answer suppresses the pause. Later edits, unfinished drafts and an exhausted closing allowance retain the receipt. Cost-admission tests cover disabled, unlimited and bypassed quotas; these keep the token guard.
