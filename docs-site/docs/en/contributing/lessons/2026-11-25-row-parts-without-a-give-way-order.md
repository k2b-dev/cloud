### Parts of a row kept their full width and ran into each other

- **What happened:** In a v2 `StatusRow` narrower than about 600 px, a long lead ran under two filter buttons with
  words (#4166). In the v1 `SegmentedControl`, a long label such as "Members" touched the edge of its segment or ran
  past it, while short labels had room to spare (#4165).
- **Root cause:** The lead of `StatusRow` did not shrink (`flex: none`, no ellipsis), and nothing folded the worded
  end controls, so both kept their full width; only `ListOrder` folded its buttons below 480 px. `SegmentedControl`
  gave every option the same share (`flex: 1`, `min-width: 0`), so in a control as wide as its content the share of
  the longest label was smaller than that label.
- **Error class:** A row or group whose parts all keep their own width, or all get the same share, without a stated
  order of who gives way first and how (cut with "…" down to about a word, fold to a symbol, or take only the content
  width).
- **Guard:** `packages/ui/src/v2/status-table.browser.test.ts` measures the status row at 760, 600, 400 and 320 px
  with a short and a long lead: no control overlaps the lead, a cut lead ends in "…" and keeps about a word, and below
  480 px the controls keep only their symbols with their words as names.
  `packages/ui/src/actions/segmented-widths.browser.test.ts` checks options of mixed length at 390 and 1440 px: every
  label stays whole with at least 8 px to its edges, and only `stretch` fills the width with equal shares.
