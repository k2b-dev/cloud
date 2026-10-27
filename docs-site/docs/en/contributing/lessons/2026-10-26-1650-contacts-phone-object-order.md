### Contacts checked the old phone navigation order

- **What happened:** The Contacts workspace browser suite failed after adopting the current shared workspace layout: the phone's object row appeared above its view tabs.
- **Root cause:** The Contacts assertion still required objects below the views, although #1661 intentionally moved stacked objects before the head in an outer flush phone workspace.
- **Error class:** Application layout assertion outlives an intentional shared contract change.
- **Guard:** The Contacts shell browser suite checks both all-contacts and book pages for object row, head title, views and filters in the supported order, while retaining German label-fit checks. The shared phone object-row tests cover the layout contract itself.
