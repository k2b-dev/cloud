### Count PDF work before allocating merge inputs

- **What happened:** PDF merging checked each response's size but accepted source files whose combined size exceeded the configured PDF budget.
- **Root cause:** The merge helper copied every source into multipart blobs before calculating an aggregate input size.
- **Error class:** Per-item limits omit aggregate work and allocations.
- **Guard:** `packages/cloud/src/services/pdf/tools.test.ts` rejects aggregate merge input before renderer admission and bounds repeated source uploads and retained intermediate PDFs across a whole operation. `tools.integration.test.ts` checks actual page text order when Gotenberg test infrastructure is configured.
