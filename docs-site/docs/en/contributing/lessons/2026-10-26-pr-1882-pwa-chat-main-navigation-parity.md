### A PWA view can lose newly merged web navigation

- **What happened:** Merging the expanded Chat workspace into its PWA view conflicted on routes, list sections, conversation rendering, and read-all behavior.
- **Root cause:** The PWA branch extracted the conversation into a shared view while main added channel, archive, resource, and recovery behavior to the original inline view.
- **Error class:** Parallel workspace changes lose navigation or authorized snapshot state
- **Guard:** Both surfaces share conversation and list rendering. PWA guards cover archive reload, channel search, caller metadata, separate system-thread filters, responsive no-access recovery, and private unread totals beside system chats. Main's paginated read-all stays intact.
