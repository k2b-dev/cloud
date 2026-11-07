### A resize handle painted a second, misplaced shadow beside the column shadow

- **What happened:** In Mail, hovering the edge of the conversation list showed two shadow strips side by side, and hovering the Detail edge showed a shadow on the panel side that was 16 px shorter than the resting shadow on the other side.
- **Root cause:** The resting column shadow and the hover cue were two pseudo-elements with separate geometry. The column shadow ends at the next column's start and spans the workspace height. The handle's own `::after` started at the handle's centre, which sits 6 px earlier in the 12 px space between panes, and the Detail handle inherits the Detail's 0.5 rem top and bottom inset.
- **Error class:** Two paints of one visual edge each derive their own geometry, so they drift apart in some state.
- **Guard:** Column handles no longer paint a shadow; they darken the boundary's single column shadow. `packages/ui/src/layout/workspace-edge-shadow.browser.test.ts` measures the painted box of every column edge at rest and on hover, keyboard focus, and drag, and requires the same top, height, and boundary side.
