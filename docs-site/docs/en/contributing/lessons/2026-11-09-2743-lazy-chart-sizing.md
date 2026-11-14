### Keep drawing out of synchronous frame sizing

- **What happened:** Dot matrices pushed the Assistant workspace's static island closure 427 bytes over its unchanged budget, even though Chat loads chart drawing on first use.
- **Root cause:** Bar sizing and drawing shared one module, and category-label math shared the series painter's module. Bun placed the drawing dependencies in chunks needed by synchronous frame sizing.
- **Error class:** A lazy feature leaks into initial JavaScript through a shared sizing module.
- **Guard:** The dot-matrix test builds published sizing and lazy drawing entries together and checks that the static closure contains neither dot marks nor series legend painting. The production `island-bundles` rule keeps the existing byte ceilings; SVG parity and frozen 0.69 fixtures guard the unchanged rendering.
