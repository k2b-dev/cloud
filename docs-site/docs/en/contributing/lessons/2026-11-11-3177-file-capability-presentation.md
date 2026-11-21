### New Core file Queries lacked German input descriptions

- **What happened:** The six file-generation Queries compiled, but their German input descriptions were missing and the Core catalog expectation still rejected their publication.
- **Root cause:** The implementation added German titles and summaries without the input-field maps used by Core's presentation catalog. Focused generator tests did not cover the complete built-in presentation or published catalog.
- **Error class:** Incomplete capability registration across presentation and catalog contracts.
- **Guard:** `tests/capability-presentation.test.ts` checks German registry and input-field coverage, including every file-helper schema variant. `packages/core/src/capabilities.test.ts` checks the exact published Query list. Run both files when adding a Core capability.
