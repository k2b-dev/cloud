# MatchText

`MatchText` shows text with its search matches marked.

## Use MatchText

Use it for the name or path of a search result, so the reader sees why the
result matched. Keep the full text: the marks add a soft fill and never hide,
shorten, or reorder the text.

## Import

```tsx
import { MatchText, matchParts, type MatchRange } from "@k2b/ui";
```

## Example

```tsx
<MatchText text="Rechnung Oktober.pdf" ranges={[[0, 8]]} />
<MatchText text="Kunden/Bäckerei/Rechnung.pdf" ranges={[[0, 6], [16, 24]]} />
```

`ranges` holds half-open `[start, end)` offsets in Unicode code points, as
search engines such as Filegate return them. They are not JavaScript UTF-16
offsets: an emoji counts as one. Ranges may arrive unsorted, overlap, touch, or
reach past the text; `MatchText` clips, sorts, and merges them. Without ranges,
it renders the plain text.

`matchParts(text, ranges)` returns the same split as
`{ text, hit }[]` for hosts that render matches in their own markup.

## Appearance

A match takes the soft selection fill (`--k2b-selected`) and the regular text
color, also inside muted text such as a folder path. The fill has no padding,
so marked and plain text keep the same width and a list row does not move.
Place `MatchText` inside an element that truncates, such as a list cell; the
marks wrap and truncate with the text.

## Accessibility

Matches are `mark` elements. Screen readers read the whole text unchanged;
some also announce the marked parts.

## Runtime

`MatchText` renders on the server and needs no JavaScript.

## API reference

```ts
type MatchRange = readonly [number, number];
type MatchTextProps = { text: string; ranges?: readonly MatchRange[]; class?: string };
function matchParts(text: string, ranges?: readonly MatchRange[]): { text: string; hit: boolean }[];
```
