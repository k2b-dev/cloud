### Keep optional chart renderers out of the initial Chat bundle

- **What happened:** Adding chart kinds exceeded the Assistant PWA and workspace JavaScript budgets, even in chats without charts.
- **Root cause:** Chat imported its chart and explorer drawing code eagerly. Stat-tile trends also imported the complete Chart dispatcher through a sparkline; transitive sizing exports and a shared map module kept renderer code eager.
- **Error class:** An optional renderer catalog entered every initial island closure through shared presentation imports.
- **Guard:** The unchanged `island-bundles` limits cover every measured island. A browser build guard excludes the registry and world-map data from its static graph. Chat loads drawing code on first use; browser tests compare exact desktop and phone frames with code and data arriving in either order, failed imports, and server history. A byte-for-byte render test keeps the dedicated stat sparkline equal to the generic Chart output. Deferred mounts preserve server HTML and cancel late resumes after disposal.
