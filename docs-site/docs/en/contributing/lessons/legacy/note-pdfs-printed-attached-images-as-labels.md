### Note PDFs printed attached images as labels

- **What happened:** A note's PDF showed attached images only as "Image: <alt>" ([#1280](https://github.com/k2b-dev/cloud/issues/1280)).
- **Root cause:** Book writes attachment images as session-authenticated app URLs, which Gotenberg cannot load, so print mode replaced them with labels.
- **Error class:** Session URL in a server-side export.
- **Guard:** `book-renderer.test.ts` checks that every documented image form prints without an app, API, or `attach://` URL; `note-pdf-images.integration.test.ts` checks the embedded images with `pdfimages` and zero Gotenberg requests with the request trap.
