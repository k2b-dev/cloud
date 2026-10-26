### Sized notebook images disappear in the editor

- **What happened:** Documented image size suffixes rendered in Book but produced no editor image, and Book did not accept a title after the size ([#1278](https://github.com/k2b-dev/cloud/issues/1278)).
- **Root cause:** CommonMark parsed only the image label when the destination contained a size suffix; Book and editor decorations also used separate size patterns.
- **Error class:** One Markdown dialect parsed differently by editor and renderer.
- **Guard:** Book and the editor's Lezer extension use `parseSizedMarkdownImage`. Their tests iterate the same `DOCUMENTED_IMAGE_FORMS` matrix for attachment and HTTPS images, dimensions, and titles; parser tests reject invalid forms and verify offsets.
