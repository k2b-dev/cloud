### Browser print received offline PDF image slots

- **What happened:** Printing a map note showed internal image markers instead of ordinary attachment images.
- **Root cause:** Browser Print used the offline PDF renderer mode without the server image preparation step.
- **Error class:** A rendering mode crossed from server export to browser preview without resolving its assets.
- **Guard:** The Book renderer explicitly retains authorized browser image URLs for Print and preview. Image-form tests preserve the offline default; browser tests verify decoded map and attachment images, cancellation during decoding, and temporary-document cleanup.
