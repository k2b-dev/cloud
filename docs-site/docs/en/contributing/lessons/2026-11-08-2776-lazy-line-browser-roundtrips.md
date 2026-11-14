### Read lazy line phases in one browser call

- **What happened:** The desktop first-use line test exhausted its unchanged five-second deadline while handing the delayed renderer back to the browser.
- **Root cause:** The case fetched each phase's pending count, load count and geometry in separate browser calls, unlike the existing distribution tests. Those serial transport waits consumed the deadline before the drawing assertions ran.
- **Error class:** Browser transport overhead dominates a bounded interaction test.
- **Guard:** The same first-use test retains all assertions for eager ordinary lines, one lazy forecast load, unchanged geometry, cleared placeholders and no network requests. It now reads each phase together and releases the module after capturing the loading box. The deadline stays unchanged; geometry reads still follow `settled(page)`.
