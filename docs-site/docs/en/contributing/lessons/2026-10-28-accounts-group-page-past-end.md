### A group detail past its last members page said the group had no members

- **What happened:** The Accounts group detail with a `page` past the last page of members said "This group has no members", although the group had members. A stale link, or removing the last members of a page, reached it, and people read it as "everyone was removed" (#2033). The group list behaved the same way after a group was deleted.
- **Root cause:** Both pages passed the requested `page` to the service unchecked. The service answers a page past the end with no entries, and the members tab chose its empty state from that empty page instead of from the total.
- **Error class:** A paged view that trusts the requested page number and derives "empty" from the current page instead of the total count.
- **Guard:** The group list and the group detail tabs redirect a page past the end to the last page with the same filters, and the tabs pick their empty state from the total. `groups/page.render.test.tsx` and `groups/detail/page.render.test.tsx` cover the redirects, the empty group, the full first page opened from page 2 of the list, and the list state that the detail links carry only as `list_*` context.
