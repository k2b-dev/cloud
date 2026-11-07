### Saved map blocks validate geometry and provider identifiers

- **What happened:** Source review found that saved map JSON could bypass live route validation; a map-only export mode also bypassed ordinary image readiness and link handling.
- **Root cause:** Presentation code treated stored geometry as trusted and reused only part of the document renderer's print behavior. A separate pin-ID limit also rejected valid provider IDs.
- **Error class:** Saved presentation bypasses live validation.
- **Guard:** Cloud `geo-document.test.ts` and Notebook `map-blocks.test.ts` cover complete coordinate pairs, public provider IDs, images and internal links. `notebook-maps.browser.test.ts` holds an ordinary image pending, requires all images before printing, and checks cancellation cleanup. Snapshot uploads remain bound to the caller's export text and complete map fingerprints, with bounded PNG decoding and explicit source-list recovery.
