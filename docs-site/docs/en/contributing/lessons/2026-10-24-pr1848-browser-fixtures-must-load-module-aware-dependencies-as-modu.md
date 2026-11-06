### Browser fixtures must load module-aware dependencies as modules

- **What happened:** Three Assistant WebKit fixtures never mounted after map consumers joined their dependency graph.
- **Root cause:** The bundled map worker loader retains `import.meta`, but the fixtures loaded the bundle as a classic script. WebKit rejected it before rendering.
- **Error class:** A browser fixture uses the wrong JavaScript loading mode.
- **Guard:** The activities, sidebar and waiting-strip browser suites load their bundles as modules and retain their rendering and layout assertions without changing timeouts.
