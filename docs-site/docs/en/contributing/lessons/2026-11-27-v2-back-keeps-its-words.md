### An endless name left the way back without words

- **What happened:** On the phone, a detail without a head names itself after its way back ("‹ Werkstatt  Notizen.md", #4296). With a file name far longer than the bar and no breaks, the way back shrank to 0 px and only "‹" was left. The layout measure reported the back's label as gone.
- **Root cause:** The way back is cut first (`flex-shrink: 999`), and nothing held a minimum for it. The name took the whole bar.
- **Error class:** A shrink order without a floor: "cut this first" became "remove this" once the other part was long enough.
- **Guard:** The name never takes the last 6em of the bar, so the way back keeps a few letters and "…". The fixture `namedBackLong` (an endless name after a long back) runs through the layout rules at 1440 and 390 px. A test in `packages/ui/src/v2/primitives.browser.test.ts` checks that the back keeps at least 40 px of its words while the name is cut.
