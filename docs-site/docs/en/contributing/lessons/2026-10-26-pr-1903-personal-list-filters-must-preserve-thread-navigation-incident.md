### Personal list filters must preserve thread navigation

- **What happened:** List and directory filters collided, and changing the list filter on a thread overview left the URL pointing to the message view.
- **Root cause:** Independent feature slices reused one query key and rebuilt links without the overview route or directory context.
- **Error class:** Feature merges combine incompatible URL-state assumptions.
- **Guard:** The system-chat Chromium test combines personal Unread with the directory's Done filter through a thread, reload, and Back. Existing v12 cases keep default system URLs unchanged; panel recovery cases retain their selected view.
