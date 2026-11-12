### Schema documentation must not duplicate SDK types

- **What happened:** Adding file-generation operations pushed the SDK index plus two apps above the unchanged chat tool budget.
- **Root cause:** Type pooling compared rendered JSDoc, so the same chart structure with different field descriptions was emitted twice. Long field summaries also consumed the tool budget.
- **Error class:** Presentation metadata prevents structural deduplication of a generated public contract.
- **Guard:** The unchanged real-catalog chat SDK budget test and generator tests for documentation-independent pooling, comment-like string literals, stable names, and standalone declaration compilation.
