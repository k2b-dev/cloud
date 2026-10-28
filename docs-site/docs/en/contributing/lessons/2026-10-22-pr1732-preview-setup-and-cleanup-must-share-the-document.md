### Preview setup and cleanup must share the document

- **What happened:** Notebook attachment-preview setup exhausted the first case deadline and cleanup cascaded into later cases ([#1886](https://github.com/k2b-dev/cloud/issues/1886)).
- **Root cause:** Cold component loading ran inside a multi-preview case; delegated events and portaled lightboxes depend on the document that created them.
- **Error class:** Suite setup and document-bound cleanup are mixed with timed assertions.
- **Guard:** Load modules into the retained suite document in setup, close dialog and lightbox portals after each case, and restore fetch and component ownership in finally blocks. Keep the original assertions and deadlines.
