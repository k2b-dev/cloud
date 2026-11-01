### Separate checked source evidence from selected metadata

- **What happened:** A checked Code submission with a selected secret binding did not match a fresh check.
- **Root cause:** The comparison included version metadata that the source checker does not produce.
- **Error class:** Comparing values from different contract layers without projecting their shared evidence.
- **Guard:** The real-checker secret acceptance case in `packages/core/src/code/acceptance.integration.test.ts` submits selected binding metadata and completes the approved run; the submission service still validates immutable binding evidence separately.
