# ScrollArea

`ScrollArea` creates one bounded scrollport whose content width stays stable
when growing content starts or stops overflowing.

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

Pass `scrollPreserveKey` when enhanced navigation should restore this
scrollport's position. Use a stable purpose-based key rather than an item id.

Keep one scroll owner for a full-height region. Do not wrap an existing
scrolling component such as `DetailPanel.Body` in another `ScrollArea`.
`DetailPanel` also integrates its gutter with the surrounding workspace inset;
that panel-specific geometry is not part of `ScrollArea`.

## Accessibility

`ScrollArea` renders a normal `div` and does not add a landmark, accessible
name, or tab stop. Keep a visible heading near the region. When a standalone
scrollport needs to be announced as a region, pass `role="region"` together
with `aria-label` or `aria-labelledby`. Add `tabIndex={0}` only when keyboard
users otherwise have no focusable content through which to reach the
scrollport.

## Runtime

The component is server-renderable and needs no client JavaScript. Native
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
