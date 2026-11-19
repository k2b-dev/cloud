### Activity rows need the shared list geometry

- **What happened:** Activity rows reached past their content column, with a crowded icon and metadata layout and native hover hints.
- **Root cause:** The mailbox Events tab used its own VirtualFeed row, so changing the conversation activity dialog did not reach the reported surface. The timeline used negative row margins, literal corner sizes, and `title` attributes independently of the list surfaces around it.
- **Error class:** Shared component presentation drift.
- **Guard:** The mailbox Events tab composes the public ActivityList.Row. Its browser suite checks real feed rows, all three URL filters, hydration and keyboard opening. ActivityList browser tests compare its inset, radius and padding with shared list rows, reject native titles, preserve geometry during hover, focus and filtering, and check phone overflow. The hydration test checks the same avatar and time markup before and after mounting.

The Mail hydration guard also caught a classic-scrollbar width change in
WebKit: VirtualFeed’s more specific SSR `overflow-y: hidden` rule overrode
the shared always-present scroll track. The classic-scrollbar fallback now
also matches the SSR viewport, keeping the same track before and after mount.

An actor separator changes the grammar contract: each application must supply a
standalone event phrase, not a predicate continuing the person's name. The
cross-application render guard in `scripts/activity-sentences.render.test.tsx`
checks the activity phrases of Mail, Spaces, Notebooks, Pulse, and Grids in both
German and English. Compact names may ellipsize visually, but their complete
text stays available to assistive technology. A timeline's avatar aligns with
its section title; a virtual feed keeps its own inset and grouping.
