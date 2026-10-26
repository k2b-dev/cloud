### A scrolling panel clipped an avatar's status ring

- **What happened:** The ring around the person working on a Spaces task was cut off at the detail panel's left edge.
- **Root cause:** An outline extended beyond an avatar placed flush with the body's scrollport.
- **Error class:** Paint outside a scrollport.
- **Guard:** `packages/ui/src/layout/detail-panel-sections.browser.test.ts` checks the painted ring bounds, including outside outlines and shadows, and unchanged avatar dimensions in both themes and viewport sizes. The ring and its transparent gap now fit inside the avatar's border box.
