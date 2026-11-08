### Base and detailed renderers import shared primitives

- **What happened:** The lazy line split passed its bundle-size checks but failed the runtime import-cycle check.
- **Root cause:** The detailed renderer imported the base renderer, which imported its geometry from the detailed renderer's module.
- **Error class:** Extracting a renderer without moving its shared dependencies creates a circular runtime graph.
- **Guard:** Both renderers import unchanged SVG primitives from a module that imports no renderer at runtime. Public SVG exports remain available. The existing repository cycle check, strict ordinary-line SVG comparisons and prelude feature-absence assertions cover the graph and rendering boundaries.
