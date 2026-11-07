### Group list filters became member filters when opening a group

- **What happened:** Opening a group from a filtered list passed the list search into the group's member search and lost the list context on return.
- **Root cause:** The group-detail URL builder defaulted to list query keys instead of the existing `list_*` context keys.
- **Error class:** List navigation and detail filtering share query keys.
- **Guard:** `personal-group-lists.render.test.tsx` renders the real group list and checks that generated group links preserve the list context while dropping the obsolete personal-group filter. Existing group-detail URL tests cover the separate member filters and pagination.
