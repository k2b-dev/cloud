### Sidebar section chevrons stood at different places

- **What happened:** In Chat's sidebar the chevrons of Chats, Channels and Discussions stood at three different horizontal places, so the collapsible headers looked unaligned.
- **Root cause:** `AppWorkspace.SidebarSection` drew the chevron inside the heading button and placed the section actions after it, so a section with actions or a count pushed its chevron away from the right edge, and Chat's own count styles moved it further.
- **Error class:** A trailing control whose position depends on optional siblings instead of a fixed column.
- **Guard:** `packages/ui/src/layout/sidebar-section-chevron.browser.test.ts` measures that every collapsible header ends in one chevron column with and without actions and counts; Chat's channel test measures the same right edge for its sections.
