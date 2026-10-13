# TableOfContents

`TableOfContents` links to sections and marks the current section as content scrolls.

## Use TableOfContents

Use it beside a page or a scrollable article. Each item identifies an existing heading.

## Import

```tsx
import { TableOfContents } from "@k2b/ui";
```

## Example

```tsx
const [root, setRoot] = createSignal<HTMLElement>();
const items = [{ id: "sharing", label: "Sharing" }];

<TableOfContents items={items} scrollRoot={root} sticky />
<article ref={setRoot} style={{ height: "20rem", overflow: "auto" }}>
  <h2 id="sharing">Sharing</h2>
</article>
```

Items have an `id` and a text `label`. Empty items render nothing.
The visible title and navigation name default to “On this page” or
“Auf dieser Seite” from the inherited locale. Pass `title` to replace it.

Without `scrollRoot`, the window decides the active section. Pass an element
or accessor for a content scroller. The last heading above a line one quarter
down its visible box becomes active. Before the first heading reaches that
line, the first item stays active. At the end of scrolling, a visible last
heading becomes active. `onActiveChange` receives the new ID, or `undefined`
when the list becomes empty, once per change.

`sticky` keeps the navigation in view within the caller's layout.
Links use normal browser anchor navigation. Changing the active section does
not change the list's geometry. Server markup marks the first item current.

## Accessibility

The visible heading names the `nav`. Native links remain keyboard accessible.
Only the active link has `aria-current="location"`.

## Runtime

Native links work without JavaScript. The scroll spy starts in the browser and removes its listeners when disposed.
