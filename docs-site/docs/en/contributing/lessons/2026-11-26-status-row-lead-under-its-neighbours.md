### A status row lead ran under its neighbours, and the figures went first

- **What happened:** With a detail open, the list's status row cut its lead mid-word under the chip at its end
  ("…zugeord", "…gesp") in ipa-hosts and proxy-auth at 1440 px, and `measureV2Layout` passed. In Tools, a long lead
  pushed the key figures to no width at all, also beside the filters at 1024 px. A first fix capped the figures at
  60 % of the row, which could hide Mail's one long figure beside its short lead although it fit.
- **Root cause:** The lead did not shrink (`flex: none`), so in a narrower column it ran out of the start of the row
  and the chip painted over the rest; `measureV2Layout` only looked for boxes that clip their own text, not for text
  that runs out of a box that does not clip it. The fix for that (#4221) let the figures start from no width, so a long
  lead took all the room. A fixed cap for the figures then took room from them even where the lead did not need it.
- **Error class:** Text that leaves a box which does not clip it and runs under a neighbour, which a check of clipped
  boxes cannot see; and a give-way order between parts that does not depend on what each part needs (a part that
  starts from nothing, or a fixed cap).
- **Guard:** The lead and the figures now share the room, each up to its own width; where both are long the lead
  keeps 40 % (60 % below 600 px, where the controls fold). `measureV2Layout` reports a text that runs out of a box
  that does not clip it ("runs N px out of …"). A box that scrolls its text counts as cut at its own edges, and a box
  moved on purpose (a transform, a negative margin, a hanging indent) may stand out only as far as it was moved; both
  are tested red and green in `measure-v2-layout.browser.test.ts`. `status-table.browser.test.ts`
  opens an entry beside the list at 1440 and 1024 px, measures a long lead beside three figures and the filters at
  rows of 1440, 1024, 700, 560 and 390 px (the lead is cut first; at 700 px it keeps 40 % and the later figures fold,
  at 560 px 60 %), Mail's row at 432 and 520 px, where its one long figure takes all the rest, and a row with
  `marks={false}`, which must equal the row without marks (no empty group that would move the lead when an exception
  comes or goes; `describe.test.ts` checks the same for `filters`).
