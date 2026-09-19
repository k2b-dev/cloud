# ScrollArea

`ScrollArea` creates one bounded scrollport whose content width stays stable
when growing content starts or stops overflowing.

Top and bottom overflow hints are enabled by default. They use a subtle 16 px
fade only where more content remains. Set `scrollFade={false}` when a
specialized view needs an unmasked surface. Scrolling, resizing, and content
changes update the hint; forced-color mode leaves content unmasked.

Hydrated components initialize themselves. Server-rendered scroll areas inside
a workspace are also initialized by `installAppWorkspaceController`; Cloud
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

Pass `scrollPreserveKey` when enhanced navigation should restore this
scrollport's position. Use a stable purpose-based key rather than an item id.

Keep one scroll owner for a full-height region. Do not wrap an existing
scrolling component such as `DetailPanel.Body` in another `ScrollArea`.
An editor can use `ScrollArea` as its outer scroll owner when the editor
content grows naturally. Keep its toolbar outside the scroll area so controls
remain fully visible. Notebooks uses this arrangement for its CodeMirror
editor; its book view inherits the fade from `AppWorkspace.Main`.

`DetailPanel` also integrates its gutter with the surrounding workspace inset;
that panel-specific geometry is not part of `ScrollArea`.

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
JavaScript. Overflow hints require hydration or the workspace controller. Native
disclosures inside it continue to work before hydration.

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
