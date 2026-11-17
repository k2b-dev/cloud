### Activity rows need the shared list geometry

- **What happened:** Activity rows reached past their content column, with a crowded icon and metadata layout and native hover hints.
- **Root cause:** The mailbox Events tab used its own VirtualFeed row, so changing the conversation activity dialog did not reach the reported surface. The timeline used negative row margins, literal corner sizes, and `title` attributes independently of the list surfaces around it.
- **Error class:** Shared component presentation drift.
- **Guard:** The mailbox Events tab composes the public ActivityList.Row. Its browser suite checks real feed rows, all three URL filters, hydration and keyboard opening. ActivityList browser tests compare its inset, radius and padding with shared list rows, reject native titles, preserve geometry during hover, focus and filtering, and check phone overflow. The hydration test checks the same avatar and time markup before and after mounting.
