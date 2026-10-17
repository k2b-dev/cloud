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

## ReferenceChip

Use `ReferenceChip` for an object, place, person, or time inside a sentence,
including a [chat question](/en/ui/ai/chat#questions-and-outcomes). Use
`LabelChip` for the name of a control.

```tsx typecheck
import { ReferenceChip, truncateMiddle } from "@k2b/ui";

export const References = () => <p>
  Open <ReferenceChip kind="object" title="Workshop report.pdf" href="/files/report"
    icon="ti ti-file-type-pdf" accent="var(--k2b-reference-pdf)" /> in
  <ReferenceChip kind="place" title="Workshop" icon="ti ti-folder" href="/files/workshop" /> for
  <ReferenceChip kind="person" name="Lea Berg" href="/contacts/lea" /> on
  <ReferenceChip kind="time" label="Friday" dateTime="2026-10-16" />.
  <ReferenceChip kind="object" title="Old report.pdf" gone />
</p>;

export const shortTitle = truncateMiddle("A long report title for the workshop team.pdf");
```

Chips show at most `REFERENCE_CHIP_MAX_CHARACTERS` (40) user-perceived characters.
`truncateMiddle(text, max = 40)` preserves the start and ending, such as `.pdf`,
and does not split emoji or combining graphemes. Short and exact-length text
stays unchanged; trimming whitespace around the cut may make the result shorter
than `max`. A truncated chip retains the full text in a screen-reader-only span
and its `title` tooltip; the visible shortened text is hidden from assistive
technology. Above 30 visible characters, the chip may wrap within its fill.

A linked object or place uses the optional `accent` as `--k2b-reference-icon`.
Set `gone` when the target no longer exists: it becomes a struck-through span,
without a link even if `href` was supplied. Omit `href` for other noninteractive
references. Person chips show only a display name and a decorative avatar;
addresses belong in a preview. Time chips render a `time` element with the
host-formatted label and optional machine-readable `dateTime`.

These chips render on the server without JavaScript. Link destinations and
access checks remain host-owned.

## API reference

```ts
type ReferenceChipObjectProps = {
  kind: "object" | "place"; title: string; href?: string; icon?: string;
  accent?: string; gone?: boolean; class?: string;
};
type ReferenceChipPersonProps = {
  kind: "person"; name: string; src?: string | null; href?: string; class?: string;
};
type ReferenceChipTimeProps = {
  kind: "time"; label: string; dateTime?: string; class?: string;
};
type ReferenceChipProps = ReferenceChipObjectProps | ReferenceChipPersonProps | ReferenceChipTimeProps;
const REFERENCE_CHIP_MAX_CHARACTERS = 40;
function truncateMiddle(text: string, max?: number): string;
```
