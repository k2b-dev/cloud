### A PWA view can lose newly merged web navigation

- **What happened:** Merging the expanded Chat workspace into its PWA view conflicted on routes, list sections, conversation rendering, and read-all behavior.
- **Root cause:** The PWA branch extracted the conversation into a shared view while main added channel, archive, resource, and recovery behavior to the original inline view.
- **Error class:** Parallel workspace changes lose navigation or authorized snapshot state
- **Guard:** The combined workspace renders the same conversation and list sections on both surfaces. PWA route and render tests cover archive reload, channel search, caller metadata, and separate system-thread filters; main's paginated read-all implementation stays intact.
