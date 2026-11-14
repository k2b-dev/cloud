### The app launcher showed pinned apps twice and smaller

- **What happened:** The app launcher showed app bar shortcuts in an extra row of small tiles above the app grid, and a pinned app appeared again among the large tiles.
- **Root cause:** `AppLaunchpadPanel` rendered the rail projection's shortcuts in their own section and the full app catalog unchanged below it, while the app bar removes a pinned app from its ordinary list.
- **Error class:** Two surfaces project the same ordered navigation with different rules, so one of them keeps duplicates or a special form.
- **Guard:** The launcher builds one tile list (Start on phones, pinned entries in app bar order, then the remaining apps); `app-badges.behavior.test.tsx` checks the order, that every entry is the same tile, and that a pinned app appears once.
