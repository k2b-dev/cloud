### A Grids table page sent its rows twice and loaded barcode code it did not draw

- **What happened:** A Grids table page carried its rows in the HTML twice (2 × 170 KB of island props for 100 rows)
  and loaded the barcode drawing library (about 190 KB Brotli) on every table, also on tables without a barcode.
- **Root cause:** `GridsSidebar` passed the whole workspace state to the `GridsNavigation` island, which reads only the
  route's kind, active entry and table. `@bwip-js/generic` reached the route island twice through static imports:
  the table's display helpers imported two pure functions from the module that draws, and Custom App form validation
  reached the document Liquid filters, which draw barcodes on the server.
- **Error class:** An island receives a whole server state, or a light helper shares a module with heavy code, so the
  page ships data or code it does not use.
- **Guard:** `GridsWorkspace.render.test.ts` expects the rows in one island's props only, and
  `GridsRoute.bundle.test.ts` keeps the route island within its eager Brotli budget with the barcode code on demand.
