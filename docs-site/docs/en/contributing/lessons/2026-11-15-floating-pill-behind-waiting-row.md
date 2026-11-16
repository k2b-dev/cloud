### "To the newest message" hid behind "Waiting for you"

- **What happened:** In the fifth Preview tour, a chat scrolled up showed the pill "Zur neuesten Nachricht" half covered by the row "Wartet auf dich" above the field, over a figure of the answer.
- **Root cause:** The pill (`@k2b/ui` Chat.Timeline) floats 8 px above the timeline's end; the row lies on the same free end. Both had their own layer and neither knew the other.
- **Error class:** Two floating elements over the same edge, each placed by its own owner, without one reservation for the stack.
- **Guard:** The Assistant's chat layout names the stack: two layers (`--assistant-layer-waiting`, `--assistant-layer-to-latest`) and a fixed place for the pill above the row's slot, derived from the row's height and offset (`--assistant-to-latest-above-waiting`), whether a row shows or not, so the pill never jumps and never covers a chip. The waiting row's browser test checks at 1440 and 390 that nothing covers the pill, that it overlaps no chip and no "+n", and that it keeps its place without the row.
