### The StatGrid header drew its edge twice

- **What happened:** A titled `StatGrid` showed a line under its muted header, although the header's grey surface already set it apart from the white cells.
- **Root cause:** The header kept a 1px bottom border from an earlier framed design after it gained the muted surface.
- **Error class:** A shared component separates groups or regions with a decorative line instead of space or a surface step.
- **Guard:** `packages/ui/src/surfaces/single-frame.browser.test.ts` checks in light and dark, on desktop and phone, that the header draws no rule, meets the first cell directly, and differs from it in surface; under forced colours, where both surfaces become Canvas, it keeps a system-coloured line.
