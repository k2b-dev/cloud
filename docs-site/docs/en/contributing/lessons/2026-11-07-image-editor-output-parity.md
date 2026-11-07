### Image preview and export must share rendering and resource ownership

- **What happened:** Raw noise made a 400 px image preview differ from the downsampled export by more than the agreed color tolerance. Loading an original for a caller-provided preview also defeats bounded preview memory.
- **Root cause:** Scaling high-frequency texture before blending and downsampling after blending produce different pixels. Source dimensions, preview dimensions, and export dimensions also serve different purposes.
- **Error class:** Independent preview/export behavior and unbounded media resource lifetime.
- **Guard:** `packages/ui/src/inputs/image-editor/image.browser.test.ts` compares fixed natural-photo and transparent-logo renders at 1600 and 400 px, checks alpha and opaque redaction, and verifies deferred original loading, output limits, refused encoders, cancellation, and object URL cleanup. `model.test.ts` covers output dimensions and history identity. The renderer uses one prefiltered seeded tile and one shared Canvas2D pipeline.
