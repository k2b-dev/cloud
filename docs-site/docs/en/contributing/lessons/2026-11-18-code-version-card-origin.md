### Submitted chat versions failed to load their cards

- **What happened:** A submitted Code version showed a retryable load error instead of its approval state, without a diagnostic.
- **Root cause:** The compact version-card snapshot reused a stored chat origin containing `cardAnchor`. Its strict origin schema rejected that internal field, and the shared loader discarded the parsing error.
- **Error class:** A compact transport projection rejects valid internal metadata, while a recovery fallback hides the cause.
- **Guard:** `packages/core/src/code/version-card-origin.test.ts` checks every stored origin against the strict public snapshot schema. `packages/assistant/src/code-version-cards.integration.test.ts` covers a submitted chat version in the real batch read. Core contract tests distinguish input errors from output errors; Assistant loader and store tests check data-free diagnostics and one browser retry after a failed server snapshot.
