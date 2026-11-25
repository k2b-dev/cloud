### v2 primitives drew one shape and showed another

- **What happened:** Several `@k2b/ui` v2 primitives changed shape after their first render, or lost content that
  had room. `Pane.Split` drew a second line for a `{open && <Pane …/>}` child that was `false` (#4147). A multi-line
  `Input` sent an empty textarea from the server, and its value appeared only on hydration (#4148). The phone's
  `Dialog` sheet stood above the bottom for a few frames when its content got shorter, so a tap there hit the backdrop
  and closed it (#4141). `StatusRow` figures ran under the filters when there were more figures than could fit
  (#4149). They also disappeared in Mail's 432 px list column, which has no filters and enough room. The open search
  of a phone head drew a second line on the head's line. The third line of a row without marks stopped short of the
  row's end.
- **Root cause:** `Pane.Split` filtered `undefined`, `null` and `""`, but not booleans, so `false` got its own seam.
  The textarea got its value only as a property, which a server does not render, and the HTML parser drops one
  leading newline of a textarea's text. The ui-sdk sheet answers a change of its content's height with a spring that
  starts at the old height and moves the whole sheet. A first fix ended that spring from an observer made one frame
  later, which assumed that ui-sdk's observer existed first; a sheet module that loads late breaks that assumption. The `StatusRow` figures
  did not shrink, and nothing clipped them. A container query removed them by width alone, and did not check whether
  the end controls needed the room. The cover of the open search drew its own bottom border over the bar's border.
  Line 3 of a row kept its middle column while nothing stood beside it.
- **Error class:** A v2 primitive whose server markup differs from its first client render, or whose layout moves
  after the first layout or yields without a real lack of space. Examples: children that render nothing, form values
  in properties, motion that follows a resize, fixes that depend on the order or timing of a dependency's setup,
  rules keyed to width instead of to the room that is free, and a part that draws a line that its host already
  draws.
- **Guard:** `packages/ui/src/v2/server-markup.test.ts` checks the server markup of the split and the textarea,
  including values with leading blank lines. The hydration test checks the textarea value that the server sent, and
  that line 3 of a row without marks reaches the row's end. The overlays browser test reads the sheet's place in the
  frames after its content gets shorter, also when ui-sdk's sheet module loads after the dialog is open. The
  status-table browser test checks that every visible figure is whole and clear of the controls from 400 px to
  1440 px, that a 432 px row without filters keeps its figures, and that the open phone search passes
  `measureV2Layout` without a double line.
