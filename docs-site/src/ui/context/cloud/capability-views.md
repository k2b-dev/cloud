# Cloud capability views

`BlockTree` draws the checked, bound blocks of a
[capability view](/en/docs/platform/capability-views): a capability result in the
conversation, the details of an approval, and the preview of a search hit. Code
pages share its panel description, so a table, a chart, or key figures look the
same everywhere. An app never draws these blocks itself; it returns them, and
Cloud checks, binds, and draws them.

## Use the renderer

Cloud mounts the renderer in its own places. Use it directly only in Cloud
surfaces that show a view Cloud already checked and bound:

```ts
import { BlockTree } from "@k2b/cloud/blocks/ui";
```

```tsx
<BlockTree blocks={view.blocks} host="result" locale={locale} timeZone={timeZone} />
```

- `host`: `result` in the conversation, `review` inside an approval, `preview` in
  search. The host decides the depth of frames and which interactive blocks may
  appear.
- `choice`: the state of the view's open choice, from the server (`open`,
  `busy`, `answered`, or `superseded`, with the chosen ids and the time).
- `draft`: the editable or locked values of an approval's draft.

## Depth

A view has no hull. Depth comes from the kind of block, never from the app:

| Block | Look |
| --- | --- |
| `Chart`, `Table` | A framed island, as on dashboards |
| `Detail` | A framed island in a result; plain rows inside an approval |
| `Cards` with `image` | Each card is an island in a grid, however many there are |
| `Cards` without `image` | A flat text list |
| `Stats` | Flat key-figure tiles |
| `Choice` options | Flat controls with the 2 px edge; no shadow |

Inside a side panel the islands are flat, as every island there. Blocks take
`width` as a share of a six-column row; below 40 rem every block takes the whole
row.

## Choices

A `Choice` is a question with its options and one answer button. With
`mode: "one"` the options are a radio group; with `mode: "many"` a group of
checkbox cards. Cards with `choose` are the options themselves: the whole card
chooses, a round mark in its corner (square for `many`) shows the choice, and a
chosen card takes the edge and fill of the place's primary colour.

The foot under the choice has one fixed place for its state:

- open: "Nothing chosen yet" or "1 chosen", and the answer button;
- busy: "Gustav is still answering. You can choose afterwards." with the button
  turned off;
- answered: "Chosen by you · 14:32", read-only, after a reload too;
- superseded: "No longer open. A newer answer replaced this question."

A choice that did not go through says so in the same place and keeps the
selection.

## Drafts

A `Draft` lives only inside an approval. Read-only context rows come first, such
as "To" with person chips; then the fields, each with its label above it. While
the approval edits, the fields are ordinary text fields and text areas with the
2 px edge. While it asks for approval, the same fields keep their size and
padding and lose only their edge, so switching moves nothing; they are
read-only. A select field shows its chosen label. People, places, and files are
never fields; the review offers a link to change them in the app.

## Images and links

Images load only from the answering app's own routes and fall back to the title
as their text alternative. External links open in a new tab and show their
host; Cloud links open in place.

## Accessibility

Cards are a list; a card that is an option is one label with a native radio or
checkbox. A choice is a radio group or a group named by its question. Chart
frames keep their data table. The "before" value of a detail row is announced
as "before:" and struck through visibly.
