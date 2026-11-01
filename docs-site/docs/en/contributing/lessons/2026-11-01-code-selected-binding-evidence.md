### Separate checked source evidence from selected metadata

- **What happened:** A checked Code submission with a selected secret binding did not match a fresh check.
- **Root cause:** The comparison included version metadata that the source checker does not produce.
- **Error class:** Comparing values from different contract layers without projecting their shared evidence.
- **Guard:** The binding server-check cases in `packages/core/src/code/scheduling.integration.test.ts` accept selected binding metadata independently of source-derived evidence and refuse changed bundle, operation evidence, or internet origins; the submission service still validates immutable binding evidence separately.
