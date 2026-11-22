### The drag preview covered the words of the drop target under the pointer

- **What happened:** Over a drop overlay, the preview of a dragged mail hung 16 px below and beside the pointer as a pill of about 44 × 38 px and covered the description of the tile under it, such as "Ist schon zuständig".
- **Root cause:** Over the overlay the preview only hid its label; it kept its padding and its offset from the pointer, which are meant for a preview that floats over a list, not over targets that carry text.
- **Error class:** A floating element sized and placed for one context covers content in another context it also appears in.
- **Guard:** `drop-overlay.browser.test.ts` measures the preview over the overlay: a 24 × 24 px badge within 12 px of the pointer's tip.
