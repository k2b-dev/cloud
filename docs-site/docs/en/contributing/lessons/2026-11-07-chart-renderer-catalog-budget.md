### Pure chart renderers use a focused message catalog

- **What happened:** Adding a lazy waterfall renderer exceeded the offline chart-module budget even though it no longer appeared in the app prelude.
- **Root cause:** The area renderer imported the full UI chart catalog for one translated label. The separate module retained all those unrelated messages.
- **Error class:** A broad shared dependency defeats a lazy bundle's size boundary.
- **Guard:** Pure area labels use a small core catalog. The app-asset test retains the 319,900-byte prelude and 53,000-byte chart-module limits, and asserts that the waterfall drawing is present only in the offline module. A browser guard checks the delayed waterfall at desktop and phone widths without moving its frame.
