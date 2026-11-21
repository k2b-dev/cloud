### Reuse SDK types behind local schema references

- **What happened:** Adding alarm provenance exceeded the two-app SDK tool-result budget by 440 characters.
- **Root cause:** The manifest reused its named origin schema, but each SDK operation emitted a separate local reference alias. Those aliases also prevented the existing type pool from sharing surrounding shapes.
- **Error class:** Local schema references defeat shared SDK type declarations.
- **Guard:** Reuse pooled types for non-recursive reference targets and exported results already declared as nested fields. Keep local aliases for recursive targets. Focused projection tests cover these cases, and the complete catalog test retains the unchanged 256,000-character budget.
