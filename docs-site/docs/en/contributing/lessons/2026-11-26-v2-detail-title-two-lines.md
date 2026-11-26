### A long title in a detail's head was cut to one line with no way to read it

- **What happened:** Spaces opened a task with a 96-sign title beside its list. On a wide screen, the detail's head cut the title to one line ending in "…", and nothing showed the rest: v2 `Text` had no `title` for a tooltip.
- **Root cause:** Only on the phone did the detail's head let its title take a second line. On wider screens, the head kept the fixed height of its place, and the title stayed on one line like any text in a bar.
- **Error class:** A rule for text of free length that held at one width only, and a primitive without a way to carry the full words of cut text.
- **Guard:** The detail's head grows from its height (56, or 52 beside a list) for a second line of title at every width, and cuts with "…" after two lines. `Text title` carries the full words as the tooltip. `packages/ui/src/v2/detail-title.browser.test.ts` checks at 1440 and 390 px, in Chromium and WebKit, that a 99-sign title takes two lines with its tooltip and leaves the actions their place. A short title keeps 52 px beside the list.
