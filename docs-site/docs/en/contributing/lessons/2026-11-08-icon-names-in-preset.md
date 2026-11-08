### Check every icon name against the icon preset

- **What happened:** Featured tools, pinned chats, weather widgets, mail drafts, and more than twenty other places showed an empty box instead of an icon (#2940).
- **Root cause:** Tabler 3 moved filled glyphs such as `ti-star-filled` into a separate font, and some names, such as `ti-clock-send`, never existed. A class the preset does not ship renders nothing and raises no error.
- **Error class:** A string reference to an asset that the shipped catalog does not contain fails silently.
- **Guard:** The `icon-names` rule (`bun scripts/check.ts icon-names`) fails on any literal `ti ti-*` name in source or Markdown outside tests that the `@k2b/ui` preset does not ship. The preset draws the filled glyphs that Cloud uses, and `tabler.browser.test.ts` checks that each one paints on the box and centre of its outline glyph.
