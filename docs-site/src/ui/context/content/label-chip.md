# LabelChip

`LabelChip` names a control inside a sentence.

## Use LabelChip

Use it to identify the label a reader should select. It is inline text and does not perform an action.

## Import

```tsx
import { LabelChip } from "@k2b/ui";
```

## Example

```tsx
<p>Select <LabelChip icon="ti ti-share">Share</LabelChip>.</p>
<p><LabelChip>Settings</LabelChip> › <LabelChip>Profile</LabelChip></p>
```

Pass an optional full icon class string, such as `ti ti-share`.
The chip stays within the paragraph's text line. It uses neutral surface and text tokens.

## Accessibility

The label remains ordinary readable text. The optional icon is decorative and hidden from screen readers.

## Runtime

The chip renders on the server and needs no JavaScript.
