# ChoiceTiles

`ChoiceTiles` picks one value from choices that are easiest to compare by looking at them, such as a face shape, a frame, or the kind of a profile picture. Each tile shows a preview and its label. The parent owns the value and the previews.

## Use ChoiceTiles

Use it when the choices differ in how something looks and a small preview decides faster than words. Use `ChoiceChips` for short text choices, `ColorChoices` for a palette of named colours, and `SegmentedControl` to switch views or modes.

## Import

```tsx
import { ChoiceTiles, type ChoiceTileOption } from "@k2b/ui";
```

## Options and layouts

`options` contain `value`, `label`, a decorative `visual` (any element, usually a small image), and an optional `status`. The controlled `value` is one option's value or `null`, which selects no tile.

- `layout="grid"` (default) puts the preview over the label in as many columns as fit, at least 4.75 rem wide.
- `layout="row"` puts the preview beside the label in one row, with a status line under every label, such as "Active". On phones the tiles share the width evenly and stack preview over label.

`dimmed` dims every preview while keeping the choice usable, for a part that is currently hidden by another choice. Say why in `description`.

Choosing changes only the tile's fill and label colour: the label weight and the tile size stay, so nothing moves. See [shared field props](/en/ui/getting-started#shared-field-props) for labels, descriptions, errors, disabled state, and value accessors.

## Runtime

Selection and focus movement require browser code. Without it the tiles render with their checked state and previews.

## Example

```tsx
const [frame, setFrame] = createSignal<string | null>("round");

<ChoiceTiles
  label="Frame"
  value={frame}
  onValueChange={setFrame}
  options={[
    { value: "round", label: "Round", visual: <img src="/frames/round.svg" alt="" width="48" height="48" /> },
    { value: "square", label: "Square", visual: <img src="/frames/square.svg" alt="" width="48" height="48" /> },
  ]}
/>
```

## API reference

```ts
type ChoiceTileOption<T extends string = string> = { value: T; label: string; visual: JSX.Element; status?: string };

type ChoiceTilesProps<T extends string = string> = Omit<ValueFieldProps<T | null>, "onValueChange" | "onValueCommit"> & {
  options: readonly ChoiceTileOption<T>[];
  layout?: "grid" | "row";
  dimmed?: boolean;
  onValueChange?: (value: T) => void;
  onValueCommit?: (value: T) => void;
};
```

## Accessibility

The tiles are a radio group named by `label`, or by `aria-label` without a visible label, and described by `description`. The preview is hidden from assistive technology; the label names the choice. Only the chosen tile is in the tab order; with no selection the first tile is. Arrow keys move and select with wrapping, Home and End select the first and last tile.
