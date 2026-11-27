### A long record name took three rows of the head on the phone

- **What happened:** On the phone, Weather showed a place with a long name in a `RecordHead`. The avatar, the name and the "…" of the head each took a row of their own, and the head was about 140 px high.
- **Root cause:** The phone rules let the head bar and its start wrap (`flex-wrap: wrap`). The name kept its full width and pushed the avatar and the actions to other rows instead of being cut.
- **Error class:** A wrap rule without an order. The whole row was allowed to wrap, but only the parts that are allowed to move (the kinds) should go to a second row.
- **Guard:** On the phone the head bar no longer wraps. Only the start wraps, and the name takes the room left beside the kinds. `packages/ui/src/v2/record-head.browser.test.ts` renders a very long name at 390 px with and without kinds. It checks that the head has at most two rows, that the avatar and the actions stand on the name's row, and that the name is cut. The demo screens keep the mockup's 57 px head.
