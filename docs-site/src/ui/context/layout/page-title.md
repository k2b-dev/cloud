# PageTitle

`PageTitle` shows a page's title with its way up to the pages above it. The
number of pages above decides the form, so the same depth looks the same
everywhere:

| Pages above | Form |
| --- | --- |
| 0 | The title alone. |
| 1 | `‹ Parent` above the title. |
| 2 or more | A path row with every page above, each a link, above the title. |

The row above the title is 1 rem high with 12 px text, the title 1.25 rem
with 14 px text, so a 46 px header keeps its height at every depth and two
headers side by side stay aligned. Below 48 rem (768 px) a back arrow left of
the title replaces the row; its accessible name names the parent, for example
"Back to Users". Every depth takes the height of the deepest form, 2.25 rem
from 48 rem and the arrow's 2 rem below, so a header around the title keeps
its height when the depth changes, also one without a height of its own.
Nothing moves on hover.

When the path does not fit its row, its middle collapses into `…`, from the
second level towards the parent, and then the first level too; the parent
always stays. `…` opens a menu with the hidden levels in order, each indented
one step below the one before; arrow keys move between them and Escape
returns to `…`. The collapse is measured, not a fixed width, and the row grows
back when it widens. It changes no geometry.

## Import

```tsx
import { PageTitle, type PageTrailState } from "@k2b/ui";
```

## Use PageTitle

```tsx
const trail: PageTrailState = {
  title: "jdoe",
  ancestors: [{ title: "Users", href: "/accounts/users" }],
};

<header class="flex min-h-[2.875rem] items-center gap-2 px-2">
  <PageTitle trail={trail} subtitle="Jordan Doe" />
  <Button>Edit</Button>
</header>
```

`ancestors` lists the pages above, nearest last. Each has an `href`: only a
page someone can go back to is a level. The title takes the room its row gives
it.

| Prop | Default | Meaning |
| --- | --- | --- |
| `trail` | required | `{ title, ancestors }` |
| `subtitle` | none | Quiet text after the title, such as a count |
| `as` | `"h1"` | The title's element; chrome that repeats a heading uses `"p"` |
| `fallback` | `false` | Marks a title drawn by surrounding chrome; it steps back while the page renders its own `PageTitle` |

Links are real anchors with the page's `href`, so they work before any script
and open in a new tab. They carry `data-k2b-page-trail-link`, and the link to
the parent `data-k2b-page-trail-up`, for a host that adds behavior such as
returning to the page as the tab left it. The path's focus rings are drawn
inside the row, which clips.

## Give a host's trail to a whole page

A host, such as an application shell, names the page once and lets workspace
heads and page titles read it:

```tsx
<PageTrailProvider trail={{ title: "Quotes", ancestors }}>
  <Page />
</PageTrailProvider>
```

During server rendering the provider's context carries the trail. It also
publishes the trail into the document, where parts rendered in the browser,
such as islands, read it with `usePageTrail()`. After an in-page navigation,
call `setPageTrail(next)`; every reader outside a provider follows.
`readPageTrail()` returns the published trail, and `window` receives
`PAGE_TRAIL_EVENT` each time `setPageTrail()` publishes one. In an app that renders the
provider itself in the browser, its `trail` prop is the source: pass a signal's
value, and the readers below follow the prop.

`AppWorkspace` shows the host's trail in its [head](/en/ui/layout/workspace)
when the page has a page above it. The workspace head renders the page title
as an `h1`. From 64 rem (1024 px), a visible, non-collapsed workspace sidebar
that marks the exact current page with `aria-current="page"` hides the head
and its back link. `AppWorkspace.SidebarItem active` supplies that attribute.
The title remains a visually hidden heading for assistive technology. Deeper
pages without an exact-current sidebar item keep their back link, as do
compact layouts and phones. Mark only the exact page, never its ancestor.
The host's document title and Alt+Up shortcut remain available.

Once the host runs `followPageTrail()`, a
server-rendered title of the host's trail that never hydrates follows
`setPageTrail()`: a workspace head and a page's own header title alike. The
live title takes the same place, element, class, and subtitle.

## Collapse paths outside components

A `PageTitle` measures its own path. A host whose page titles are rendered on
the server and never hydrate runs `installPageTitleController(document)` once.
A controller owns the titles whose nearest controller is its own: a title that
mounts later uses the document's, and one that mounted first keeps its own.
It fits a path again only when the path or its size changes, so a busy page
costs no extra layout. Both return a disposer.

## Accessibility

- The row above the title is a `nav` named "Path" ("Pfad").
- `‹ Parent` and the phone arrow are named "Back to Parent" ("Zurück zu
  Parent"); the visible name is part of it.
- `…` is a button named "More levels" ("Weitere Ebenen") that opens a native
  popover; it closes with Escape or a click elsewhere.
- On touch screens, the small links and `…` get a larger tap area that takes
  no space.

## Runtime

`PageTitle` renders on the server, and its links work without JavaScript.
Collapsing a path that does not fit needs a hydrated `PageTitle` or
`installPageTitleController()`. The phone arrow and the row above the title
switch with CSS at 48 rem, so a page arrives in its final form. A trail
published with `PageTrailProvider` travels as JSON in a
`script[data-k2b-page-trail]` element; `setPageTrail()` replaces it in place.

## Example

```tsx
import { PageTitle, PageTrailProvider, type PageTrailState } from "@k2b/ui";

const trail: PageTrailState = {
  title: "Supplier A",
  ancestors: [
    { title: "Projects", href: "/files?path=Projects" },
    { title: "2026", href: "/files?path=Projects%2F2026" },
  ],
};

<PageTrailProvider trail={trail}>
  <header class="flex min-h-[2.875rem] items-center gap-2 px-2">
    <PageTitle trail={trail} subtitle="6 items" />
  </header>
  <FolderRows />
</PageTrailProvider>
```
