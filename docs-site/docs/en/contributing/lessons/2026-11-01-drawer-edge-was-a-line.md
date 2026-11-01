### The workspace drawer marked its edge with a line

- **What happened:** An open bottom drawer drew a 1px line along its top edge. On hover, its resize handle added a second line and its own shadow, which also ran across the Detail column beside the drawer.
- **Root cause:** The drawer kept a top border and a handle cue of its own after column edges moved to one shade per boundary. The muted surface alone cannot replace the border: a navigation pane above the drawer has the same surface, so the edge disappears there.
- **Error class:** A shared component separates groups or regions with a decorative line instead of space or a surface step; a state cue paints a second geometry beside the resting one.
- **Guard:** `packages/ui/src/layout/resize-cue.browser.test.ts` checks that the drawer has no top border, its handle stays centred on the edge and draws no line or shadow of its own, and the drawer's one edge shade keeps its place and size while it darkens on hover, focus, and drag; under forced colours the drawer keeps a system-coloured line.
