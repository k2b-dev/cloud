### "To the newest message" hid behind "Waiting for you"

- **What happened:** In the fifth Preview tour, a chat scrolled up showed the pill "Zur neuesten Nachricht" half covered by the row "Wartet auf dich" above the field, over a figure of the answer.
- **Root cause:** The pill (`@k2b/ui` Chat.Timeline) floats 8 px above the timeline's end; the row lies on the same free end. Both had their own layer and neither knew the other.
- **Error class:** Two floating elements over the same edge, each placed by its own owner, without one reservation for the stack.
- **Guard:** The Assistant's chat layout reserves the row's height for the floating stack (`--assistant-waiting-reserve`) while the row shows, and the pill stands on top of it. The waiting row's browser test scrolls up at 1440 and 390 and checks that the pill stands fully above the row and nothing covers it.
