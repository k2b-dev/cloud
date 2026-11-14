# ScrollArea

`ScrollArea` creates one bounded scrollport whose content width stays stable
when growing content starts or stops overflowing.

Top and bottom overflow hints are enabled by default. They use a subtle 16 px
fade only where more content remains. Set `scrollFade={false}` when a
specialized view needs an unmasked surface. Scrolling, resizing, and content
changes update the hint; forced-color mode leaves content unmasked.

Components with browser code initialize themselves. Server-rendered scroll areas
inside a workspace are also initialized by `installAppWorkspaceController`; Cloud
already installs that controller. Arbitrary elements with `overflow: auto`
are not modified.

## Import

```tsx
import { ScrollArea } from "@k2b/ui";
```

## Use ScrollArea

Use `ScrollArea` when a region can cross its overflow boundary after loading
more results, expanding a disclosure, or changing filters. It reserves a
stable scrollbar gutter, so controls and text do not move horizontally when a
classic scrollbar appears or disappears. Platforms with overlay scrollbars
retain their native appearance and do not need reserved space.

The surrounding layout still owns the scroll area's height, flex growth,
padding, and spacing. Give the component a bounded height or place it in a
correctly sized grid or flex region. `ScrollArea` accepts normal `div`
attributes and an optional `class`.

For compact asynchronous catalogs, use `viewportSize="compact"` instead of a
custom height. It reserves 18.75rem (300 px at the default font size), capped
at 60dvh, including any padding. Loading, empty, error, and populated states
keep the same height; longer content scrolls within it. Sidebar previews expose
the same setting as `preview.viewportSize`. Omit it for layout-owned sizing.

Set `inset` when the scroll area fills a workspace column with rows, such as a
message list in a `MainPane`. It then keeps 0.5 rem inside both side edges,
like a level body: with a mouse, the end space is a fixed 0.5 rem scroll
track that is there before anything overflows, so a classic scrollbar never
makes one side wider than the other and nothing moves when the list grows. Do not
add your own horizontal padding next to it.

Pass `scrollPreserveKey` when enhanced navigation should restore this
scrollport's position. Use a stable purpose-based key rather than an item id.

Keep one scroll owner for a full-height region. Do not wrap an existing
scrolling component such as `DetailPanel.Body` in another `ScrollArea`.
An editor can use `ScrollArea` as its outer scroll owner when the editor
content grows naturally. Keep its toolbar outside the scroll area so controls
remain fully visible. Notebooks uses this arrangement for its CodeMirror
editor; its book view inherits the fade from `AppWorkspace.Main`.

The fades cover the edges of the scrollport. An editor that scrolls its own
cursor into view must keep the cursor line out of them: Notebooks declares
the fades as `scroll-padding-block` on the scroll area and passes the computed
padding to CodeMirror's `EditorView.scrollMargins`. Do not add spacer lines or
scroll manually.

Scrolling updates the fades at once; changes of the content update them once
per frame, so a list that changes many rows does not lay the page out for each
one. A reader that needs the current fades in the same frame as a content
change, such as those scroll margins, calls `measureScrollFade(element)` from
`@k2b/ui` first.

`DetailPanel` also integrates its gutter with the surrounding workspace inset;
that panel-specific geometry is not part of `ScrollArea`.

## Quiet scrollbars

Add the `k2b-quiet-scrollbar` class when many scrollers sit side by side, such
as the columns of a board, and permanent scrollbars would make the view
busy. The class works on a `ScrollArea` and on any other element that scrolls.
With a mouse, the scrollbar stays invisible until the pointer is over the
scroller or the keyboard focus is inside it. Only its color changes, so the
content never moves. Touch devices keep their native scrollbars, and forced
colors mode always shows them. The workspace sidebar and the chat timeline
already behave this way.

```tsx
<ScrollArea class="k2b-quiet-scrollbar">
  <BoardColumnCards />
</ScrollArea>
```

## Scrollbars

Cloud draws one scrollbar everywhere, from one rule in `@k2b/ui`: no track,
no corner, and no arrows, only a fully round thumb. With a mouse, the
scrollbar is a fixed 0.5 rem. Its thumb is 4 px wide at rest and 6 px under
the pointer or while dragged. The thumb widens inside the same 0.5 rem, so
nothing moves. Its colors are `--k2b-scrollbar-thumb` and
`--k2b-scrollbar-thumb-hover`. Chromium and Safari draw it exactly. Firefox
draws its thin scrollbar in the same color. Touch screens keep their native
overlay scrollbars, and forced colors mode keeps the system scrollbars.

Applications do not style scrollbars. Do not set `scrollbar-width`,
`scrollbar-color`, or `::-webkit-scrollbar` rules of your own. Chromium
ignores the shared rule for an element that has either property, so one
local value draws a different scrollbar. The `scrollbars` repository check
reports such rules. The only allowed change is to hide a scrollbar, for a
strip that fades at its edges and scrolls by wheel, touch, or keyboard:

```css
.k2b-ui .my-chip-strip {
  overflow-x: auto;
  scrollbar-width: none;
}
```

In markup, `[scrollbar-width:none]` does the same. A rare justified exception
names its reason in a comment on the line above the declaration or its selector
(`scrollbars: allow <reason>`).

A scrollbar never moves content when it appears. `ScrollArea`, level bodies,
the workspace sidebar, `Main`, `MainPane`, `DetailPanel.Body`,
`ChatTimeline`, `VirtualFeed`, and `PdfViewer` keep the scrollbar's room from
the start. Chromium and Firefox reserve it with `scrollbar-gutter: stable`.
Safari reserves no gutter before content overflows, so with a mouse these
scrollers always show the empty 0.5 rem track. Where a column already has an
end inset, the track takes that inset instead of adding room: an inset
`ScrollArea`, a level body, and the sidebar keep 0.5 rem on both sides. An
application scroller with its own end padding does the same and subtracts
the track from its padding:

```css
/* The reader pads 1.25rem; the shared track takes 0.5rem of it. */
@media (pointer: fine) and (forced-colors: none) {
  @supports selector(::-webkit-scrollbar) {
    .k2b-ui .reader-scroll {
      overflow-y: scroll;
      padding-inline-end: 0.75rem;
    }
  }
}
```

`DataTable` and the tabs of `Panes` draw the same thumb as an overlay that
takes no room.

## Horizontal strips

Use `orientation="horizontal"` for a bounded row of wider content. It uses
left/right overflow hints on the same scrollport and supports right-to-left
content. The default `orientation="vertical"` retains top/bottom hints.
Hints disappear at the corresponding edge or when content fits. Resizing and
content changes update both orientations. Keep fixed actions outside the port.

```tsx
<ScrollArea orientation="horizontal" role="region" aria-label="Recent documents" tabIndex={0}>
  <div style={{ display: "flex", gap: "1rem", width: "max-content" }}>
    <DocumentCards />
  </div>
</ScrollArea>
```

`Tabs` already applies horizontal fades to its existing list; do not wrap it in
another `ScrollArea`. `PanelDialog.Body` also owns its own vertical fades.

## Accessibility

`ScrollArea` renders a normal `div` and does not add a landmark, accessible
name, or tab stop. Keep a visible heading near the region. When a standalone
scrollport needs to be announced as a region, pass `role="region"` together
with `aria-label` or `aria-labelledby`. Add `tabIndex={0}` only when keyboard
users otherwise have no focusable content through which to reach the
scrollport.

## Runtime

The scrollport is server-renderable and native scrolling works without client
JavaScript. Overflow hints require browser code or the workspace controller. Native
disclosures inside it continue to work before mount.

## Example

```tsx
<ScrollArea
  role="region"
  aria-label="Order activity"
  scrollPreserveKey="order-activity"
  style={{ height: "18rem" }}
>
  <OrderSummary />
  <details>
    <summary>Show all processing events</summary>
    <OrderEvents />
  </details>
</ScrollArea>
```
