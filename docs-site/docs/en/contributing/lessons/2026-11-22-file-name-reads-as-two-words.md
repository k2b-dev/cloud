### A file name read as two words to screen readers

- **What happened:** A heading that showed a file name through `FileName` had the accessible name "Notes .txt" instead of "Notes.txt", so Files could not find its detail heading by role and name (#3965), and every screen reader read a pause before the ending.
- **Root cause:** `FileName` splits the name into a shortening stem and a fixed ending, two flex items of an inline flex box. The accessible name computation joins flex items, which are block-level, with a space.
- **Error class:** Visible text split into flex or grid items for layout, where the parts form one word for assistive technology.
- **Guard:** `packages/ui/src/content/file-name.browser.test.ts` finds a short, a shortened, and an ending-less name as headings by their exact names and checks that the screen-reader text adds no width; it fails against the old component. `file-name.render.test.tsx` pins the markup: the whole name once as `k2b-sr-only` text, both visible parts `aria-hidden`.
