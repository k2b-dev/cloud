### v2 primitives drew one shape and showed another

- **What happened:** Four `@k2b/ui` v2 primitives changed shape after their first render. `Pane.Split` drew a second
  line for a `{open && <Pane …/>}` child that was `false` (#4147). A multi-line `Input` sent an empty textarea from
  the server, and its value appeared only on hydration (#4148). The phone's `Dialog` sheet stood one frame or more
  above the bottom when its content got shorter, so a tap there hit the backdrop and closed it (#4141). `StatusRow`
  figures ran under the filters when more figures than fit stood in a row of 760 px or more (#4149).
- **Root cause:** `Pane.Split` filtered `undefined`, `null` and `""`, but not booleans, so `false` received its own
  seam. The textarea received its value only as a property, which a server does not render. The ui-sdk sheet answers
  a change of its content's height with a spring that starts at the old height and moves the whole sheet. The
  `StatusRow` start shrank below its figures, which do not shrink, and nothing clipped them.
- **Error class:** A v2 primitive whose server markup differs from its first client render, or whose layout moves
  after the first layout: children that render nothing, form values in properties, motion that follows a resize, or
  content that does not yield before the end controls.
- **Guard:** `packages/ui/src/v2/server-markup.test.ts` checks the server markup of the split and the textarea. The
  hydration test checks the value of the textarea that the server sent. The overlays browser test reads the sheet's
  place in the frames after its content gets shorter. The status-table browser test checks that every figure in
  sight is whole and stands clear of the controls, from 400 px to 1440 px.
