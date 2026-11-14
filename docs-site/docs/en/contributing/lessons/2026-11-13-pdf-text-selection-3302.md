### A copied stylesheet rule loses the cascade order it relied on

- **What happened:** Dragging the mouse across text in `PdfViewer` selected nothing in Chromium and WebKit.
- **Root cause:** The text layer copies the `.textLayer` rules of pdf.js. There, `.textLayer > :not(.markedContent)` and `.textLayer .endOfContent` have the same specificity, so the later end-marker rule keeps `z-index: 0`. In the copy, `.k2b-ui .k2b-pdf-viewer__text > :not(.markedContent)` (0,3,0) also matched the end marker and beat `.k2b-ui .k2b-pdf-viewer__text-end` (0,2,0). The marker got `z-index: 1`, covered the spans while a drag was selecting, and is `user-select: none`.
- **Error class:** a ported stylesheet changes selector specificity, so a rule that won by source order in the original loses in the copy.
- **Guard:** Test: `packages/ui/src/content/pdf-viewer.browser.test.ts` drags across three lines of a real PDF and expects their text in the selection. Convention: when a rule of a copied stylesheet gets a new prefix or class name, keep the specificity of every rule pair that overlaps.
