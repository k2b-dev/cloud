# Task row

`TaskRow` shows one task that only has a date. It has a symbol for the kind of
task, the count as a chip, one sentence, and the action word at the end. The
whole row is one link or one button.

## Use TaskRow

Use it in the "to do" section of a dense detail page, such as a customer
record, a data record, or a contact. An example is "3 unsold items are ready
for pickup, until Dec 12".

Choose the form with one question: does something need a person now, and does
waiting have a consequence? If yes, use a notice cell: the whole cell takes the
tone of the state and has a button that names the deed. If the task only has a
date, use a task row. Do not put task rows in a rounded box. They are rows of
their section.

## Import

```tsx
import { TaskRow } from "@k2b/ui";
```

## Contracts

| Prop | Type | Purpose |
| --- | --- | --- |
| `icon` | `string` | Tabler icon class for the kind of task. It is decorative. |
| `count` | `number` | How many things the task covers, as a chip before the sentence. Zero shows no chip. |
| `text` | `string` | The task in one sentence. |
| `detail` | `JSX.Element` | A quiet second line, such as the due date. |
| `action` | `string` | The action word at the end, such as "Prepare handover". |
| `href` | `string` | Where the row leads. With it, the row is a link. |
| `onClick` | `(event) => void` | What the row does. Without `href`, the row is a button. |
| `disabled` | `boolean` | The task cannot start now. The row stays in place and does nothing. |
| `label` | `string` | The accessible name, when the visible text does not say enough. |
| `class` | `string` | An extra class on the row. |

## Layout

- A row is 40 px high, or 52 px with `detail`. Below 768 px it is at least
  60 px high.
- In a column narrower than 480 px, the action word moves below the text and
  starts on the text edge of the sentence. The row grows.
- The symbol starts on the text edge of the column (`--k2b-gutter`), and the
  sentence starts after exactly one symbol.
- The action word ends on the right text edge.
- The row draws no line of its own. The list that holds the rows divides them
  with `k2b-divided`, so the line has one owner and the last row has none.
- The row is square, has no shadow, and has no surface of its own. Pointing at
  it tints it. Keyboard focus draws the ring inside the row, so nothing moves.

## Overflow

The sentence stays on one line and ends with an ellipsis. While it is cut, the
full sentence shows as a tooltip when you point at the row or move to it with
the keyboard. The detail line wraps and is never cut; the row grows. The action
word never wraps and is never cut. The sentence gives way first.

## Accessibility

The row is one native link or button. Its accessible name is its visible text:
the count, the sentence, the detail, and the action word. Pass `label` when that
text alone does not say what happens; start it with the visible words, so
voice control still finds the row. A disabled link has no `href`, keeps
`role="link"`, and carries `aria-disabled="true"`. A disabled button uses the
native `disabled`.

## Example

```tsx
<section class="k2b-divided">
  <TaskRow
    icon="ti ti-package-export"
    count={3}
    text="Unsold items are ready for pickup"
    detail="until Dec 12, 2026"
    action="Prepare handover"
    href="/handover/2611"
  />
  <TaskRow icon="ti ti-file-invoice" text="Send the October statement" action="Open statement" onClick={openStatement} />
</section>
```

## Runtime

The row renders on the server. Without JavaScript, the full sentence is the
native title of the row. After hydration, the shared tooltip replaces it.
