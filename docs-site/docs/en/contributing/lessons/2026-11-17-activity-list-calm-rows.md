### Activity rows need the shared list geometry

- **What happened:** Activity rows reached past their content column, with a crowded icon and metadata layout and native hover hints.
- **Root cause:** The timeline used negative row margins, literal corner sizes, and `title` attributes independently of the list surfaces around it.
- **Error class:** Shared component presentation drift.
- **Guard:** ActivityList browser tests compare its inset, radius and padding with shared list rows, reject native titles, preserve geometry during hover, focus and filtering, and check phone overflow. The hydration test checks the same avatar and time markup before and after mounting.
