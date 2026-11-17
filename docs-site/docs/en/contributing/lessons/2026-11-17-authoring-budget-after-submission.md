### Completed authoring must not become a pause

- **What happened:** Gustav showed a pause after a version had been submitted and its examples had passed.
- **Root cause:** The provider wrapper checked the turn budget before the closing model response and always exposed a stop receipt, even when its own tool-result snapshot confirmed every draft was submitted.
- **Error class:** A terminal guard overwrites an already completed domain outcome.
- **Guard:** `code-authoring-turn.test.ts` simulates a build with testing, repair and submission; regression cases assert that call, input and repeated-error bounds produce no pause after submission, while later edits and unfinished drafts still do.
