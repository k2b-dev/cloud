### A status row lead ran under its neighbours, and the figures went first

- **What happened:** With a detail open, the list's status row cut its lead mid-word under the chip at its end
  ("…zugeord", "…gesp") in ipa-hosts and proxy-auth at 1440 px, and `measureV2Layout` passed. In Tools, a long lead
  pushed the key figures to no width at all, also beside the filters at 1024 px.
- **Root cause:** The lead did not shrink (`flex: none`), so in a narrower column it ran out of the start of the row
  and the chip painted over the rest; `measureV2Layout` only looked for boxes that clip their own text, not for text
  that runs out of a box that does not clip it. The fix for that (#4221) let the figures start from no width, so a long
  lead took all the room and the figures folded before the lead was cut.
- **Error class:** Text that leaves a box which does not clip it and runs under a neighbour, which a check of clipped
  boxes cannot see; and a give-way order that lets the least important part keep its width at the cost of the parts
  beside it.
- **Guard:** `measureV2Layout` reports a text that runs out of a box that does not clip it ("runs N px out of …"),
  tested in `measure-v2-layout.browser.test.ts`. `status-table.browser.test.ts` opens an entry beside the list at 1440
  and 1024 px (the lead ends in "…" before the chip, keeps its words as `title`, nothing cut) and measures a long lead
  beside three figures and the filters at 1440, 1024 and 390 px (the lead gives way first and keeps about 40 %, the
  figures keep their width).
